import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import worker from '../src/index.ts';
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

  assert.equal(blocked.status, 200);
  assert.equal(blocked.headers.get('x-blocked'), 'ads.example');
  assert.equal(rcodeOf(await blocked.arrayBuffer()), 3);
  assert.deepEqual(counts(await blocked.clone().arrayBuffer()), { qd: 1, an: 0, ns: 0, ar: 0 });
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
