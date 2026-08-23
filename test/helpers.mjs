// Minimal DNS wire-format builders for the test suite. Kept independent of the
// worker's own encoders so a bug there cannot make a test agree with itself.

export function encodeName(name) {
  if (!name || name === '.') return [0];
  const out = [];
  for (const label of name.replace(/\.$/, '').split('.')) {
    out.push(label.length);
    for (const ch of label) out.push(ch.charCodeAt(0));
  }
  out.push(0);
  return out;
}

export function u16(n) { return [(n >> 8) & 0xff, n & 0xff]; }
export function u32(n) { return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]; }

/** Build a DNS query message. */
export function query({ id = 0x1234, flags = 0x0100, questions = [{ name: 'example.com', type: 1 }], additional = [] } = {}) {
  const bytes = [
    ...u16(id), ...u16(flags),
    ...u16(questions.length), ...u16(0), ...u16(0), ...u16(additional.length)
  ];
  for (const q of questions) bytes.push(...encodeName(q.name), ...u16(q.type), ...u16(q.cls ?? 1));
  for (const rr of additional) bytes.push(...wire(rr));
  return new Uint8Array(bytes).buffer;
}

/** Build a DNS response message. */
export function response({ id = 0x1234, flags = 0x8180, questions = [{ name: 'example.com', type: 1 }], answers = [], authority = [], additional = [] } = {}) {
  const bytes = [
    ...u16(id), ...u16(flags),
    ...u16(questions.length), ...u16(answers.length), ...u16(authority.length), ...u16(additional.length)
  ];
  for (const q of questions) bytes.push(...encodeName(q.name), ...u16(q.type), ...u16(q.cls ?? 1));
  for (const rr of [...answers, ...authority, ...additional]) bytes.push(...wire(rr));
  return new Uint8Array(bytes).buffer;
}

// Records may be given as a descriptor object or as pre-encoded bytes (what
// record()/opt() return), so a test can mix the two in one section.
function wire(rr) { return Array.isArray(rr) ? rr : record(rr); }

export function record({ name = 'example.com', type = 1, cls = 1, ttl = 300, rdata = [127, 0, 0, 1] }) {
  return [...encodeName(name), ...u16(type), ...u16(cls), ...u32(ttl), ...u16(rdata.length), ...rdata];
}

/** An OPT pseudo-record. Its "TTL" field carries flags, not a lifetime. */
export function opt({ udpSize = 4096, ttlField = 0x8000, rdata = [] } = {}) {
  return [0, ...u16(41), ...u16(udpSize), ...u32(ttlField), ...u16(rdata.length), ...rdata];
}

export const bytes = (buf) => Array.from(new Uint8Array(buf));
export const rcodeOf = (buf) => new Uint8Array(buf)[3] & 0x0f;
export const counts = (buf) => {
  const v = new Uint8Array(buf);
  return { qd: (v[4] << 8) | v[5], an: (v[6] << 8) | v[7], ns: (v[8] << 8) | v[9], ar: (v[10] << 8) | v[11] };
};
