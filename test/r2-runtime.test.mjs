import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.ts';
import { shardIdForRuleDomain } from '../src/rules-sharding.ts';
import { RuleSnapshotManager } from '../src/rules-engine.ts';
import { query, response, record, counts, rcodeOf } from './helpers.mjs';

function buildRuleBinary(entries) {
  const sorted = [...entries].sort((a, b) => Buffer.from(a[0]).compare(Buffer.from(b[0])));
  const pool = Buffer.concat(sorted.map(([domain]) => Buffer.from(domain, 'ascii')));
  const count = sorted.length;
  const bytes = new Uint8Array(16 + (count + 1) * 4 + pool.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x534e4445, true);
  view.setUint16(4, 1, true);
  view.setUint32(8, count, true);
  view.setUint32(12, pool.length, true);
  let offset = 0;
  for (let i = 0; i < count; i++) {
    const [domain, action] = sorted[i];
    view.setUint32(16 + i * 4, offset | (action === 'ALLOW' ? 0x40000000 : 0), true);
    bytes.set(Buffer.from(domain, 'ascii'), 16 + (count + 1) * 4 + offset);
    offset += domain.length;
  }
  view.setUint32(16 + count * 4, offset, true);
  return bytes.buffer;
}

async function makeBucket(entries) {
  const binary = buildRuleBinary(entries);
  const digest = await crypto.subtle.digest('SHA-256', binary);
  const sha256 = Buffer.from(digest).toString('hex');
  const key = `compiled/rules-${sha256}.bin`;
  const manifest = {
    version: sha256,
    sha256,
    key,
    rules: entries.length,
    generatedAt: '2026-11-27T00:00:00.000Z'
  };
  const objects = new Map([
    ['compiled/latest.json', { json: async () => manifest }],
    [key, { arrayBuffer: async () => binary }]
  ]);
  return {
    get: async (requestedKey) => objects.get(requestedKey) ?? null
  };
}

async function makeShardedBucket(entries) {
  const monolith = buildRuleBinary(entries);
  const monolithBytes = Buffer.from(monolith);
  const monolithSha = Buffer.from(
    await crypto.subtle.digest('SHA-256', monolithBytes)
  ).toString('hex');
  const groups = new Map();
  const globalEntries = [];

  for (const entry of entries) {
    const shardId = shardIdForRuleDomain(entry[0]);
    if (shardId === 'global') globalEntries.push(entry);
    else {
      const group = groups.get(shardId) ?? [];
      group.push(entry);
      groups.set(shardId, group);
    }
  }

  const objects = new Map();
  const metadata = {
    format: 'EDNS-v1-sharded',
    algorithm: 'fnv1a32-last-two-labels-v1',
    shardCount: 256,
    global: null,
    entries: {}
  };

  const add = async (id, shardEntries) => {
    const buffer = buildRuleBinary(shardEntries);
    const bytes = Buffer.from(buffer);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const sha256 = Buffer.from(digest).toString('hex');
    const key = `compiled/shards/${monolithSha}/${id}-${sha256}.bin`;
    const descriptor = {
      key,
      sha256,
      rules: shardEntries.length,
      binaryBytes: bytes.byteLength
    };
    objects.set(key, bytes);
    if (id === 'global') metadata.global = descriptor;
    else metadata.entries[id] = descriptor;
  };

  if (globalEntries.length) await add('global', globalEntries);
  for (const [id, shardEntries] of groups) await add(id, shardEntries);

  objects.set(`compiled/rules-${monolithSha}.bin`, monolithBytes);
  const manifest = {
    version: monolithSha,
    sha256: monolithSha,
    key: `compiled/rules-${monolithSha}.bin`,
    rules: entries.length,
    generatedAt: '2026-11-28T00:00:00.000Z',
    shards: metadata
  };
  objects.set('compiled/latest.json', manifest);

  const gets = [];
  return {
    objects,
    gets,
    manifest,
    get: async (requestedKey) => {
      gets.push(requestedKey);
      if (requestedKey === 'compiled/latest.json') {
        return { json: async () => manifest };
      }
      const value = objects.get(requestedKey);
      if (!value) return null;
      return {
        arrayBuffer: async () => value.buffer.slice(
          value.byteOffset,
          value.byteOffset + value.byteLength
        )
      };
    }
  };
}

function ctx() {
  return { waitUntil() {} };
}

test('Workers entrypoint loads an R2 snapshot and blocks a rule without text-list fallback', async () => {
  const bucket = await makeBucket([
    ['ads.example', 'BLOCK'],
    ['good.ads.example', 'ALLOW']
  ]);
  const calls = [];
  globalThis.fetch = async (input) => {
    calls.push(typeof input === 'string' ? input : input.url);
    return new Response(response({ answers: [record({ ttl: 60, rdata: [93, 184, 216, 34] })] }), { status: 200 });
  };

  const blocked = await worker.fetch(
    new Request('https://dns.example.workers.dev/dns-query', {
      method: 'POST',
      body: query({ questions: [{ name: 'ads.example', type: 1 }] }),
      headers: { 'CF-Connecting-IP': '203.0.113.9' }
    }),
    { RULES_BUCKET: bucket },
    ctx()
  );

  const blockedBody = await blocked.arrayBuffer();
  assert.equal(blocked.status, 200);
  assert.equal(blocked.headers.get('x-blocked'), 'ads.example');
  assert.equal(rcodeOf(blockedBody), 3);
  assert.deepEqual(counts(blockedBody), { qd: 1, an: 0, ns: 0, ar: 0 });
  assert.equal(calls.length, 0, 'R2 BLOCK decision must short-circuit upstream resolution');
});

test('Workers entrypoint honors an R2 ALLOW rule over a broader blocked apex', async () => {
  const bucket = await makeBucket([
    ['ads.example', 'BLOCK'],
    ['good.ads.example', 'ALLOW']
  ]);
  globalThis.fetch = async () => new Response(
    response({ answers: [record({ ttl: 60, rdata: [93, 184, 216, 34] })] }),
    { status: 200 }
  );

  const allowed = await worker.fetch(
    new Request('https://dns.example.workers.dev/dns-query', {
      method: 'POST',
      body: query({ questions: [{ name: 'good.ads.example', type: 1 }] }),
      headers: { 'CF-Connecting-IP': '203.0.113.9' }
    }),
    { RULES_BUCKET: bucket },
    ctx()
  );

  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('x-blocked'), null);
  assert.equal(rcodeOf(await allowed.arrayBuffer()), 0);
});


test('debug exposes a ready R2 snapshot health contract after the snapshot loads', async () => {
  const worker = (await import(`../src/index.ts?debug-r2-ready=${Date.now()}-${Math.random()}`)).default;
  const bucket = await makeBucket([
    ['ads.example', 'BLOCK'],
    ['good.ads.example', 'ALLOW']
  ]);

  globalThis.fetch = async () => new Response(
    response({ answers: [record({ ttl: 60, rdata: [93, 184, 216, 34] })] }),
    { status: 200 }
  );

  const res = await worker.fetch(
    new Request('https://dns.example.workers.dev/debug', { method: 'GET' }),
    { RULES_BUCKET: bucket, DEBUG_ENABLED: 'true' },
    ctx()
  );
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.r2Snapshot.status, 'ready');
  assert.equal(body.r2Snapshot.source, 'r2');
  assert.equal(body.r2Snapshot.active, true);
  assert.equal(body.r2Snapshot.ruleCount, 2);
  assert.match(body.r2Snapshot.sha256, /^[0-9a-f]{64}$/);
  assert.equal(body.r2Snapshot.error, null);
});

test('debug exposes degraded R2 snapshot health when the manifest is invalid', async () => {
  const worker = (await import(`../src/index.ts?debug-r2-bad=${Date.now()}-${Math.random()}`)).default;
  const bucket = {
    get: async (key) => key === 'compiled/latest.json'
      ? { json: async () => ({
          version: '',
          sha256: '0'.repeat(64),
          key: 'compiled/rules-deadbeef.bin',
          rules: 2,
          generatedAt: '2026-11-27T00:00:00.000Z'
        }) }
      : null
  };

  const res = await worker.fetch(
    new Request('https://dns.example.workers.dev/debug', { method: 'GET' }),
    { RULES_BUCKET: bucket, DEBUG_ENABLED: 'true' },
    ctx()
  );
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.r2Snapshot.status, 'degraded');
  assert.equal(body.r2Snapshot.source, 'embedded-fallback');
  assert.equal(body.r2Snapshot.active, false);
  assert.equal(body.r2Snapshot.ruleCount, 0);
  assert.equal(body.r2Snapshot.error, 'Invalid latest.json schema');
});


test('sharded Worker loads only the global table and the query-selected shard', async () => {
  const worker = (await import(`../src/index.ts?sharded-runtime=${Date.now()}-${Math.random()}`)).default;
  const bucket = await makeShardedBucket([
    ['com', 'BLOCK'],
    ['example.com', 'BLOCK'],
    ['ads.example.com', 'ALLOW'],
    ['tracker.ads.example.com', 'BLOCK'],
    ['other.net', 'BLOCK']
  ]);
  globalThis.fetch = async () => new Response(
    response({ answers: [record({ ttl: 60, rdata: [93, 184, 216, 34] })] }),
    { status: 200 }
  );

  const send = async (name) => worker.fetch(
    new Request('https://dns.example.workers.dev/dns-query', {
      method: 'POST',
      body: query({ questions: [{ name, type: 1 }] }),
      headers: { 'CF-Connecting-IP': '203.0.113.9' }
    }),
    { RULES_BUCKET: bucket },
    ctx()
  );

  const deepBlocked = await send('tracker.ads.example.com');
  assert.equal(deepBlocked.headers.get('x-blocked'), 'tracker.ads.example.com');
  const allowed = await send('img.ads.example.com');
  assert.equal(allowed.headers.get('x-blocked'), null);
  const apexBlocked = await send('www.example.com');
  assert.equal(apexBlocked.headers.get('x-blocked'), 'www.example.com');
  const unrelated = await send('unrelated.test');
  assert.equal(unrelated.headers.get('x-blocked'), null);

  const fetchedKeys = new Set(bucket.gets);
  assert.ok(fetchedKeys.has('compiled/latest.json'));
  assert.ok(fetchedKeys.has(bucket.manifest.shards.global.key));
  const selectedShardIds = new Set([shardIdForRuleDomain('example.com')]);
  for (const id of selectedShardIds) {
    const descriptor = bucket.manifest.shards.entries[id];
    if (descriptor) assert.ok(fetchedKeys.has(descriptor.key));
  }
  assert.equal(
    [...fetchedKeys].filter((key) => key === bucket.manifest.key).length,
    0,
    'new runtime must not fetch the full compatibility binary',
  );
});

test('a corrupt replacement shard keeps the previous verified snapshot active', async () => {
  const manager = new RuleSnapshotManager();
  const oldBucket = await makeBucket([['ads.example.com', 'BLOCK']]);
  assert.equal(await manager.evaluate('ads.example.com', oldBucket, ctx()), 'BLOCK');
  const oldVersion = manager.getLoadedVersion();

  const replacement = await makeShardedBucket([['ads.example.com', 'ALLOW']]);
  const shardId = shardIdForRuleDomain('ads.example.com');
  const shard = replacement.manifest.shards.entries[shardId];
  const corrupt = replacement.objects.get(shard.key);
  corrupt[corrupt.length - 1] ^= 0xff;
  manager.nextCheckAt = 0;

  const refreshTasks = [];
  const refreshContext = {
    waitUntil(promise) {
      refreshTasks.push(promise);
    },
  };
  assert.equal(
    await manager.evaluate('ads.example.com', replacement, refreshContext),
    'BLOCK',
    'the currently active snapshot remains usable while the replacement manifest loads',
  );
  assert.equal(refreshTasks.length, 1);
  await Promise.all(refreshTasks);

  assert.equal(
    await manager.evaluate('ads.example.com', replacement, ctx()),
    'BLOCK',
    'a corrupt replacement shard must fall back to the previous verified rule table',
  );
  assert.equal(manager.getLoadedVersion(), oldVersion);
  assert.equal(manager.getHealth().status, 'stale');

  const failedShardReads = replacement.gets.filter((key) => key === shard.key).length;
  assert.equal(failedShardReads, 1);
  assert.equal(
    await manager.evaluate('ads.example.com', replacement, ctx()),
    'BLOCK',
    'the previous verified snapshot keeps serving during the failed-shard cooldown',
  );
  assert.equal(
    replacement.gets.filter((key) => key === shard.key).length,
    failedShardReads,
    'the corrupt shard must not be fetched and hashed again on every DNS request',
  );
});


test('same-SHA legacy-to-sharded manifest migration activates the shard layout', async () => {
  const entries = [['ads.example.com', 'BLOCK']];
  const legacyBucket = await makeBucket(entries);
  const shardedBucket = await makeShardedBucket(entries);
  const manager = new RuleSnapshotManager();

  assert.equal(
    await manager.evaluate('ads.example.com', legacyBucket, ctx()),
    'BLOCK',
  );
  const sharedSha = manager.getLoadedVersion();
  assert.equal(sharedSha, shardedBucket.manifest.sha256);
  assert.equal(manager.getHealth().loadedShardCount, 1);

  manager.nextCheckAt = 0;
  const refreshTasks = [];
  const refreshContext = {
    waitUntil(promise) {
      refreshTasks.push(promise);
    },
  };

  assert.equal(
    await manager.evaluate('ads.example.com', shardedBucket, refreshContext),
    'BLOCK',
    'the active legacy table remains available while the metadata refresh runs',
  );
  assert.equal(refreshTasks.length, 1);
  await Promise.all(refreshTasks);

  assert.equal(
    await manager.evaluate('ads.example.com', shardedBucket, ctx()),
    'BLOCK',
  );
  assert.ok(
    shardedBucket.gets.some((key) => key === shardedBucket.manifest.shards.entries[
      shardIdForRuleDomain('ads.example.com')
    ].key),
    'same-SHA metadata change must load the selected shard rather than treating the manifest as unchanged',
  );
  const monolithFetchesAfterAdoption = shardedBucket.gets.filter(
    (key) => key === shardedBucket.manifest.key,
  ).length;
  assert.equal(
    monolithFetchesAfterAdoption,
    0,
    'the already loaded legacy table is reused during refresh; no compatibility monolith refetch is needed',
  );
  await manager.evaluate('ads.example.com', shardedBucket, ctx());
  assert.equal(
    shardedBucket.gets.filter((key) => key === shardedBucket.manifest.key).length,
    monolithFetchesAfterAdoption,
    'subsequent queries must stay on shards and stop fetching the legacy monolith',
  );
  assert.equal(manager.getHealth().status, 'ready');
});
