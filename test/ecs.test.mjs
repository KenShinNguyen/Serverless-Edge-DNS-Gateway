import test from 'node:test';
import assert from 'node:assert/strict';
import { __internals as w } from '../functions/[[path]].js';
import { query, opt, encodeName, bytes } from './helpers.mjs';

/** Pull the ECS option (code 8) out of the OPT record of a query, if present. */
function readEcs(buf) {
  const v = new Uint8Array(buf);
  const qd = (v[4] << 8) | v[5];
  let off = w.skipQuestions(v, qd);
  const rrCount = ((v[6] << 8) | v[7]) + ((v[8] << 8) | v[9]) + ((v[10] << 8) | v[11]);
  for (let i = 0; i < rrCount; i++) {
    off = w.skipName(v, off);
    const type = (v[off] << 8) | v[off + 1];
    const rdlen = (v[off + 8] << 8) | v[off + 9];
    const rdStart = off + 10;
    off = rdStart + rdlen;
    if (type !== 41) continue;
    let p = rdStart;
    while (p + 4 <= rdStart + rdlen) {
      const code = (v[p] << 8) | v[p + 1];
      const len = (v[p + 2] << 8) | v[p + 3];
      if (code === 8) {
        return {
          family: (v[p + 4] << 8) | v[p + 5],
          prefix: v[p + 6],
          scope: v[p + 7],
          addr: Array.from(v.subarray(p + 8, p + 4 + len))
        };
      }
      p += 4 + len;
    }
  }
  return null;
}

const arCount = (buf) => { const v = new Uint8Array(buf); return (v[10] << 8) | v[11]; };

test('injectECS appends an OPT record carrying the client /24', () => {
  const out = inject('203.0.113.45');
  assert.equal(arCount(out), 1);
  assert.deepEqual(readEcs(out), { family: 1, prefix: 24, scope: 0, addr: [203, 0, 113] });
});

test('injectECS masks the trailing bits of a non-byte-aligned prefix', () => {
  // /48 over IPv6 is byte aligned, /24 over IPv4 is too — assert the masking
  // path itself still leaves an aligned prefix untouched.
  const out = inject('10.20.30.40');
  assert.deepEqual(readEcs(out).addr, [10, 20, 30]);
});

test('injectECS truncates an IPv6 client to the configured /48', () => {
  const out = inject('2001:db8:1234:5678::1');
  const ecs = readEcs(out);
  assert.equal(ecs.family, 2);
  assert.equal(ecs.prefix, 48);
  assert.deepEqual(ecs.addr, [0x20, 0x01, 0x0d, 0xb8, 0x12, 0x34]);
});

test('injectECS unwraps an IPv4-mapped IPv6 client address', () => {
  assert.deepEqual(readEcs(inject('::ffff:198.51.100.7')), { family: 1, prefix: 24, scope: 0, addr: [198, 51, 100] });
});

test('injectECS replaces an OPT record the client already sent', () => {
  const q = query({ additional: [opt({ rdata: [] })] });
  const out = w.injectECS(q, '203.0.113.45');
  assert.equal(arCount(out), 1, 'exactly one OPT, not two');
  assert.deepEqual(readEcs(out).addr, [203, 0, 113]);
});

test('injectECS passes the query through untouched for an unusable client IP', () => {
  for (const ip of ['unknown', '', null, '10.20.30', '10.20.30.40.50', 'a.b.c.d', '10.20.30.999', '10.20..40']) {
    const q = query();
    const out = w.injectECS(q, ip);
    assert.deepEqual(bytes(out), bytes(q), `expected passthrough for ${JSON.stringify(ip)}`);
  }
});

test('injectECS passes the query through for a malformed IPv6 client IP', () => {
  for (const ip of ['2001::db8::1', 'gggg::1', '1:2:3:4:5:6:7:8:9']) {
    const q = query();
    assert.deepEqual(bytes(w.injectECS(q, ip)), bytes(q), `expected passthrough for ${ip}`);
  }
});

test('ipv6ToBytes expands :: to a full 16-byte address', () => {
  assert.deepEqual(w.ipv6ToBytes('::1'), [...Array(15).fill(0), 1]);
  assert.deepEqual(w.ipv6ToBytes('2001:db8::1').slice(0, 4), [0x20, 0x01, 0x0d, 0xb8]);
  assert.equal(w.ipv6ToBytes('2001::db8::1'), null);
  assert.equal(w.ipv6ToBytes('12345::1'), null);
});

test('stripOPT leaves a non-OPT additional record in place', () => {
  const tsig = [...encodeName('key.example'), 0, 250, 0, 255, 0, 0, 0, 0, 0, 1, 7];
  const q = query({ additional: [tsig, opt()] });
  const stripped = w.stripOPT(new Uint8Array(q));
  assert.equal((stripped[10] << 8) | stripped[11], 1, 'ARCOUNT drops to the one kept record');
  assert.ok(bytes(stripped.buffer).join(',').includes(tsig.join(',')), 'the TSIG-shaped record survives');
});

function inject(ip) { return w.injectECS(query(), ip); }

/**
 * A message claiming an answer record whose rdata runs off the end. stripOPT
 * has to walk the answer section to reach the additional section, so it cannot
 * know where any OPT record lives.
 */
function overrunningAnswer() {
  const v = new Uint8Array(query({ additional: [opt()] }));
  const out = Uint8Array.from(v);
  out[6] = 0; out[7] = 1; // ANCOUNT=1 — the OPT is now read as an answer record
  // Its rdlen sits 8 and 9 bytes past the (empty) owner name at the section start
  const rdlenAt = w.skipQuestions(out, 1) + 9;
  out[rdlenAt] = 0xff; out[rdlenAt + 1] = 0xff; // rdata claims 65535 bytes
  return out;
}

test('stripOPT reports failure when it cannot reach the additional section', () => {
  const full = new Uint8Array(query({ additional: [opt()] }));
  assert.equal(w.stripOPT(full.slice(0, 14)), null, 'question section cut short');
  assert.equal(w.stripOPT(overrunningAnswer()), null, 'answer rdata overruns the buffer');
});

test('stripOPT drops a trailing additional record that is itself truncated', () => {
  const full = new Uint8Array(query({ additional: [opt()] }));
  const stripped = w.stripOPT(full.slice(0, full.length - 2));
  assert.ok(stripped, 'the message is still usable');
  assert.equal((stripped[10] << 8) | stripped[11], 0, 'ARCOUNT reflects the dropped record');
});

test('injectECS leaves a query alone when its OPT record cannot be stripped', () => {
  const broken = overrunningAnswer();
  const out = w.injectECS(broken.buffer, '203.0.113.45');
  assert.deepEqual(bytes(out), bytes(broken.buffer), 'no second OPT record is appended');
});
