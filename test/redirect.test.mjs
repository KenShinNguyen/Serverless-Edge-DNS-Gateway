import test from 'node:test';
import assert from 'node:assert/strict';
import { __internals as w } from '../functions/[[path]].js';
import { query, response, record, encodeName, counts, rcodeOf } from './helpers.mjs';

test('encodeDomainName round-trips through decodeName', () => {
  const wire = w.encodeDomainName('cdn.example.net');
  assert.equal(w.decodeName(wire, 0).name, 'cdn.example.net');
  assert.deepEqual(Array.from(w.encodeDomainName('.')), [0]);
  assert.equal(w.decodeName(w.encodeDomainName('a.b.'), 0).name, 'a.b', 'trailing dot is dropped');
});

test('decodeName follows a compression pointer and reports the offset after it', () => {
  const target = encodeName('example.com');
  const v = new Uint8Array([...new Array(12).fill(0), ...target, 0xc0, 0x0c, 0xff]);
  const at = 12 + target.length;
  const got = w.decodeName(v, at);
  assert.equal(got.name, 'example.com');
  assert.equal(got.nextOff, at + 2, 'consumes the pointer, not the name it points at');
});

test('decodeName stops instead of looping on a self-referential pointer', () => {
  const v = new Uint8Array([...new Array(12).fill(0), 0xc0, 0x0c]);
  assert.doesNotThrow(() => w.decodeName(v, 12));
});

test('rewriteQname swaps the question name and keeps QTYPE, QCLASS and the header', () => {
  const q = query({ id: 0x4242, questions: [{ name: 'www.bilibili.tv', type: 1 }] });
  const out = new Uint8Array(w.rewriteQname(q, 'www.bilibili.tv.w.cdngslb.com'));
  assert.equal((out[0] << 8) | out[1], 0x4242);
  assert.deepEqual(w.extractAllDomains(out.buffer), ['www.bilibili.tv.w.cdngslb.com']);
  assert.equal(w.extractQtype(out.buffer), 1);
  assert.deepEqual(counts(out.buffer), { qd: 1, an: 0, ns: 0, ar: 0 });
});

test('buildRedirectResponse prepends a CNAME from the original name to the target', () => {
  const original = query({ id: 0x0007, questions: [{ name: 'www.bilibili.tv', type: 1 }] });
  const upstream = response({
    questions: [{ name: 'www.bilibili.tv.w.cdngslb.com', type: 1 }],
    answers: [record({ name: 'www.bilibili.tv.w.cdngslb.com', ttl: 60, rdata: [1, 2, 3, 4] })]
  });
  const out = w.buildRedirectResponse(original, upstream, 'www.bilibili.tv.w.cdngslb.com');
  const v = new Uint8Array(out);

  assert.equal((v[0] << 8) | v[1], 0x0007, 'the client sees its own query ID');
  assert.equal(v[2] & 0x80, 0x80, 'QR=1');
  assert.equal(rcodeOf(out), 0);
  assert.deepEqual(counts(out), { qd: 1, an: 2, ns: 0, ar: 0 }, 'synthesised CNAME plus the upstream answer');
  assert.deepEqual(w.extractAllDomains(out), ['www.bilibili.tv'], 'the question echoes what the client asked');

  // First answer: CNAME owned by the queried name, pointing at the target.
  let off = w.skipQuestions(v, 1);
  assert.deepEqual(Array.from(v.subarray(off, off + 2)), [0xc0, 0x0c], 'owner compresses to the question name');
  assert.equal((v[off + 2] << 8) | v[off + 3], 5, 'TYPE=CNAME');
  const rdlen = (v[off + 10] << 8) | v[off + 11];
  assert.equal(w.decodeName(v, off + 12).name, 'www.bilibili.tv.w.cdngslb.com');

  // Second answer: the upstream A record, re-owned by the target name.
  off += 12 + rdlen;
  const owner = w.decodeName(v, off);
  assert.equal(owner.name, 'www.bilibili.tv.w.cdngslb.com');
  assert.equal((v[owner.nextOff] << 8) | v[owner.nextOff + 1], 1, 'TYPE=A');
  assert.deepEqual(Array.from(v.subarray(owner.nextOff + 10, owner.nextOff + 14)), [1, 2, 3, 4]);
});

test('buildRedirectResponse still emits the CNAME when the upstream has no answers', () => {
  const original = query({ questions: [{ name: 'a.example', type: 1 }] });
  const upstream = response({ questions: [{ name: 'b.example', type: 1 }], answers: [] });
  const out = w.buildRedirectResponse(original, upstream, 'b.example');
  assert.deepEqual(counts(out), { qd: 1, an: 1, ns: 0, ar: 0 });
});

test('buildRedirectResponse propagates a non-zero upstream RCODE', () => {
  const original = query({ questions: [{ name: 'a.example', type: 1 }] });
  const upstream = response({ flags: 0x8183, questions: [{ name: 'b.example', type: 1 }], answers: [] });
  assert.equal(rcodeOf(w.buildRedirectResponse(original, upstream, 'b.example')), 3);
});

test('buildRedirectResponse returns the upstream message untouched for a stub input', () => {
  const upstream = new Uint8Array([1, 2, 3]).buffer;
  assert.equal(w.buildRedirectResponse(query(), upstream, 'b.example'), upstream);
});
