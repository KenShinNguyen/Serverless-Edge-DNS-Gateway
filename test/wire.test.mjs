import test from 'node:test';
import assert from 'node:assert/strict';
import { __internals as w } from '../functions/[[path]].js';
import { query, response, record, opt, encodeName, u16, u32, counts, rcodeOf } from './helpers.mjs';

test('skipName walks a plain name and stops after the root label', () => {
  const v = new Uint8Array([...encodeName('a.example.com'), 0xff]);
  assert.equal(w.skipName(v, 0), v.length - 1);
});

test('skipName consumes exactly two bytes for a compression pointer', () => {
  const v = new Uint8Array([0xc0, 0x0c, 0xff]);
  assert.equal(w.skipName(v, 0), 2);
});

test('skipName reports truncation instead of running past the buffer', () => {
  assert.equal(w.skipName(new Uint8Array([5, 97, 98]), 0), -1, 'label longer than the buffer');
  assert.equal(w.skipName(new Uint8Array([0xc0]), 0), -1, 'pointer missing its second byte');
});

test('skipQuestions accounts for QTYPE and QCLASS of every question', () => {
  const q = new Uint8Array(query({ questions: [{ name: 'a.com', type: 1 }, { name: 'b.org', type: 28 }] }));
  const expected = 12 + (encodeName('a.com').length + 4) + (encodeName('b.org').length + 4);
  assert.equal(w.skipQuestions(q, 2), expected);
});

test('skipQuestions rejects a question whose QTYPE/QCLASS is cut off', () => {
  const q = new Uint8Array([...new Uint8Array(12), ...encodeName('a.com'), 0x00]);
  q[5] = 1;
  assert.equal(w.skipQuestions(q, 1), -1);
});

test('extractQtype reads the first question type', () => {
  assert.equal(w.extractQtype(query({ questions: [{ name: 'example.com', type: 65 }] })), 65);
});

test('extractQtype returns null for a header-only message', () => {
  assert.equal(w.extractQtype(new Uint8Array(12).buffer), null);
});

test('extractAllDomains lowercases and returns every question name', () => {
  const q = query({ questions: [{ name: 'Ads.Example.COM', type: 1 }, { name: 'b.test', type: 1 }] });
  assert.deepEqual(w.extractAllDomains(q), ['ads.example.com', 'b.test']);
});

test('extractAllDomains drops a question truncated before QTYPE', () => {
  const raw = new Uint8Array([...new Uint8Array(12), ...encodeName('a.com')]);
  raw[5] = 1; // QDCOUNT=1
  assert.deepEqual(w.extractAllDomains(raw.buffer), []);
});

test('hasLoopbackInAnswer detects an A record pointing at 127.0.0.1', () => {
  const r = response({ answers: [record({ rdata: [127, 0, 0, 1] })] });
  assert.equal(w.hasLoopbackInAnswer(r), true);
});

test('hasLoopbackInAnswer ignores a normal address and a loopback-shaped AAAA', () => {
  assert.equal(w.hasLoopbackInAnswer(response({ answers: [record({ rdata: [93, 184, 216, 34] })] })), false);
  const aaaa = response({ answers: [record({ type: 28, rdata: [...Array(15).fill(0), 1] })] });
  assert.equal(w.hasLoopbackInAnswer(aaaa), false);
});

test('hasLoopbackInAnswer skips a leading CNAME to reach the A record', () => {
  const r = response({
    answers: [
      record({ type: 5, rdata: encodeName('cdn.example.net') }),
      record({ name: 'cdn.example.net', rdata: [127, 0, 0, 1] })
    ]
  });
  assert.equal(w.hasLoopbackInAnswer(r), true);
});

test('hasLoopbackInAnswer does not read past rdata that overruns the buffer', () => {
  const r = new Uint8Array(response({ answers: [record({ rdata: [127, 0, 0, 1] })] }));
  const truncated = r.subarray(0, r.length - 2); // rdlen still claims 4 bytes
  assert.equal(w.hasLoopbackInAnswer(truncated.buffer.slice(0, truncated.length)), false);
});

test('buildEmptyResponse echoes the question and sets QR, RA and the RCODE', () => {
  const q = query({ id: 0xbeef, questions: [{ name: 'blocked.example', type: 1 }] });
  const r = new Uint8Array(w.buildNxdomain(q));
  assert.equal((r[0] << 8) | r[1], 0xbeef, 'query ID is mirrored');
  assert.equal(r[2] & 0x80, 0x80, 'QR=1');
  assert.equal(r[3] & 0x80, 0x80, 'RA=1');
  assert.equal(rcodeOf(r.buffer), 3);
  assert.deepEqual(counts(r.buffer), { qd: 1, an: 0, ns: 0, ar: 0 });
  assert.equal(r.length, 12 + encodeName('blocked.example').length + 4);
});

test('buildNodata and buildServfail differ only in RCODE', () => {
  const q = query();
  assert.equal(rcodeOf(w.buildNodata(q)), 0);
  assert.equal(rcodeOf(w.buildServfail(q)), 2);
});

test('buildEmptyResponse preserves RD so a resolver does not see a flag flip', () => {
  const r = new Uint8Array(w.buildNxdomain(query({ flags: 0x0100 })));
  assert.equal(r[2] & 0x01, 0x01, 'RD survives');
});

test('buildEmptyResponse answers an unparseable query with a bare SERVFAIL header', () => {
  const r = new Uint8Array(w.buildNxdomain(new Uint8Array([0xab, 0xcd, 0x01]).buffer));
  assert.equal(r.length, 12);
  assert.equal((r[0] << 8) | r[1], 0xabcd, 'query ID is kept when present');
  assert.equal(rcodeOf(r.buffer), 2);
  assert.deepEqual(counts(r.buffer), { qd: 0, an: 0, ns: 0, ar: 0 });
});

test('buildEmptyResponse does not emit a padded body when the question is truncated', () => {
  const raw = new Uint8Array([...new Uint8Array(12), ...encodeName('a.com')]);
  raw[5] = 1;
  const r = new Uint8Array(w.buildNxdomain(raw.buffer));
  assert.equal(r.length, 12);
  assert.equal(rcodeOf(r.buffer), 2);
});
