import test from 'node:test';
import assert from 'node:assert/strict';
import { __internals as w } from '../functions/[[path]].js';
import { response, record, opt } from './helpers.mjs';

test('minResponseTtl returns the smallest TTL across all sections', () => {
  const r = response({
    answers: [record({ ttl: 600 }), record({ ttl: 120 })],
    authority: [record({ type: 2, ttl: 900, rdata: [0] })]
  });
  assert.equal(w.minResponseTtl(r), 120);
});

test('minResponseTtl ignores the OPT pseudo-record TTL field', () => {
  // OPT reuses TTL for flags; 0x8000 (the DO bit) would otherwise read as a
  // 32768-second lifetime, or a small flag word would pin max-age near zero.
  const r = response({ answers: [record({ ttl: 300 })], additional: [opt({ ttlField: 0 })] });
  assert.equal(w.minResponseTtl(r), 300);
});

test('minResponseTtl returns null when the response carries no records', () => {
  assert.equal(w.minResponseTtl(response({ answers: [] })), null);
});

test('minResponseTtl handles a large TTL without sign overflow', () => {
  const r = response({ answers: [record({ ttl: 0x8000000A })] });
  assert.equal(w.minResponseTtl(r), 0x8000000A);
});

test('minResponseTtl bails out on a truncated response instead of throwing', () => {
  const full = new Uint8Array(response({ answers: [record({ ttl: 300 })] }));
  const cut = full.slice(0, full.length - 3);
  assert.doesNotThrow(() => w.minResponseTtl(cut.buffer));
});

test('dnsHeaders derives max-age from the response TTL', () => {
  const r = response({ answers: [record({ ttl: 120 })] });
  const h = w.dnsHeaders({}, r);
  assert.equal(h['Content-Type'], 'application/dns-message');
  assert.equal(h['Cache-Control'], 'max-age=120');
});

test('dnsHeaders caps max-age so a multi-day upstream TTL cannot pin a client', () => {
  const r = response({ answers: [record({ ttl: 86400 })] });
  assert.equal(w.dnsHeaders({}, r)['Cache-Control'], `max-age=${w.MAX_RESPONSE_TTL}`);
});

test('dnsHeaders says no-store when no TTL can be determined', () => {
  assert.equal(w.dnsHeaders({}, response({ answers: [] }))['Cache-Control'], 'no-store');
});

test('dnsHeaders accepts an explicit TTL for locally synthesised answers', () => {
  assert.equal(w.dnsHeaders({}, w.LOCAL_RESPONSE_TTL)['Cache-Control'], `max-age=${w.LOCAL_RESPONSE_TTL}`);
  assert.equal(w.dnsHeaders({}, 0)['Cache-Control'], 'max-age=0', 'an explicit zero TTL is honoured');
  assert.equal(w.dnsHeaders({}, null)['Cache-Control'], 'no-store', 'null means the answer must not be reused');
});

test('dnsHeaders merges CORS and extra headers without letting them shadow Content-Type', () => {
  const h = w.dnsHeaders({ 'Access-Control-Allow-Origin': '*' }, 0, { 'X-Blocked': 'ads.example', 'Content-Type': 'text/plain' });
  assert.equal(h['Access-Control-Allow-Origin'], '*');
  assert.equal(h['X-Blocked'], 'ads.example');
  assert.equal(h['Content-Type'], 'application/dns-message');
});
