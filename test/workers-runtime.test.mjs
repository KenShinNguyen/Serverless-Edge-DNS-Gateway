import test from 'node:test';
import assert from 'node:assert/strict';
import { query, response, record, rcodeOf } from './helpers.mjs';

let instance = 0;
async function loadWorker() {
  return import(`../src/index.ts?worker-case=${instance++}`);
}

function context(env = {}) {
  return { env, waitUntil() {} };
}

async function call(worker, path, { method = 'POST', body, env = {} } = {}) {
  const request = new Request(`https://gateway.example.workers.dev${path}`, {
    method,
    body,
    headers: { 'CF-Connecting-IP': '203.0.113.9' }
  });
  return worker.default.fetch(request, env, context(env));
}

test('Worker bundles private-TLD, redirect and geo-bypass rules without fetching /rules assets', async () => {
  const worker = await loadWorker();
  const counts = worker.__internals.getBundledRuleCounts();
  assert.equal(counts.privateTld, 3);
  assert.equal(counts.redirect, 16);
  assert.equal(counts.geoBypass, 1);

  const requested = [];
  globalThis.fetch = async (input) => {
    requested.push(new URL(typeof input === 'string' ? input : input.url).pathname);
    throw new Error('no upstream or static asset fetch is expected for router.lan');
  };
  const res = await call(worker, '/dns-query', {
    body: query({ questions: [{ name: 'router.lan', type: 1 }] }),
    env: { RULES_BUCKET: { async get() { throw new Error('private-TLD request must not read R2'); } } }
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-blocked-private'), 'router.lan');
  assert.equal(rcodeOf(await res.arrayBuffer()), 3);
  assert.deepEqual(requested, []);
});

test('x.com uses Quad9 no-ECS and falls back when the primary geo resolver fails', async () => {
  const worker = await loadWorker();
  const original = query({ id: 0x2345, questions: [{ name: 'x.com', type: 1 }] });
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url).toString();
    calls.push({ url, body: new Uint8Array(init.body) });
    if (url === 'https://dns10.quad9.net/dns-query') throw new Error('primary no-ECS resolver unavailable');
    if (url === 'https://dns.quad9.net/dns-query') {
      return new Response(response({
        id: 0x2345,
        questions: [{ name: 'x.com', type: 1 }],
        answers: [record({ name: 'x.com', rdata: [104, 244, 42, 1] })]
      }), { status: 200 });
    }
    throw new Error(`unexpected upstream ${url}`);
  };

  const res = await call(worker, '/dns-query', {
    body: original,
    env: { RULES_BUCKET: { async get() { throw new Error('R2 not used for dedicated geo-bypass'); } } }
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-upstream'), 'Fallback-NonECS');
  assert.equal(rcodeOf(await res.arrayBuffer()), 0);
  assert.deepEqual(calls.map(x => x.url), [
    'https://dns10.quad9.net/dns-query',
    'https://dns.quad9.net/dns-query'
  ]);
  assert.deepEqual(Array.from(calls[0].body), Array.from(new Uint8Array(original)));
  assert.deepEqual(Array.from(calls[1].body), Array.from(new Uint8Array(original)));
});

test('missing R2 snapshot activates emergency blocklist and token-gated debug exposes degraded state', async () => {
  const worker = await loadWorker();
  const bucket = { async get() { return null; } };
  const env = { RULES_BUCKET: bucket, DEBUG_ENABLED: 'true', DOH_TOKEN: 'unit-token' };

  const blocked = await call(worker, '/dns-query/unit-token', {
    body: query({ questions: [{ name: 'doubleclick.net', type: 1 }] }),
    env
  });
  assert.equal(blocked.status, 200);
  assert.equal(blocked.headers.get('x-blocked'), 'doubleclick.net');
  assert.equal(rcodeOf(await blocked.arrayBuffer()), 3);

  const denied = await call(worker, '/debug/wrong-token', { method: 'GET', env });
  assert.equal(denied.status, 404);

  const debug = await call(worker, '/debug/unit-token', { method: 'GET', env });
  assert.equal(debug.status, 200);
  const body = await debug.json();
  assert.equal(body.r2Snapshot.status, 'degraded');
  assert.equal(body.r2Snapshot.sha256, null);
  assert.equal(body.r2Snapshot.ruleCount, 0);
  assert.equal(body.r2Snapshot.source, 'embedded-fallback');
  assert.equal(body.r2Snapshot.active, false);
  assert.equal(body.r2Snapshot.fallbackRuleCount, 5);
});

test('CRLF bytes in a QNAME cannot crash blocked-response header construction', async () => {
  const worker = await loadWorker();
  const bucket = { async get() { return null; } };
  const name = 'bad\r\n.doubleclick.net';
  const res = await call(worker, '/dns-query', {
    body: query({ questions: [{ name, type: 1 }] }),
    env: { RULES_BUCKET: bucket }
  });
  assert.equal(res.status, 200);
  assert.equal(rcodeOf(await res.arrayBuffer()), 3);
  assert.equal(res.headers.get('x-blocked'), null);
});

test('a bad R2 digest is rejected before Cache API put', async () => {
  const { RuleSnapshotManager } = await import('../src/rules-engine.ts');
  const sha = '0'.repeat(64);
  const invalid = new Uint8Array([1, 2, 3]).buffer;
  let putCalls = 0;
  const previousCaches = Object.getOwnPropertyDescriptor(globalThis, 'caches');
  Object.defineProperty(globalThis, 'caches', {
    configurable: true,
    value: {
      default: {
        async match() { return undefined; },
        async delete() { return true; },
        async put() { putCalls++; }
      }
    }
  });
  try {
    const bucket = {
      async get(key) {
        if (key === 'compiled/latest.json') {
          return { async json() { return {
            version: sha,
            sha256: sha,
            key: `compiled/rules-${sha}.bin`,
            rules: 0
          }; } };
        }
        if (key === `compiled/rules-${sha}.bin`) {
          return { async arrayBuffer() { return invalid; } };
        }
        return null;
      }
    };
    const manager = new RuleSnapshotManager();
    const decision = await manager.evaluate('example.com', bucket, { waitUntil() {} });
    assert.equal(decision, 'UNAVAILABLE');
    assert.equal(putCalls, 0);
    assert.equal(manager.getHealth().status, 'degraded');
    assert.match(manager.getHealth().error, /SHA-256 mismatch/);
  } finally {
    if (previousCaches) Object.defineProperty(globalThis, 'caches', previousCaches);
    else delete globalThis.caches;
  }
});
