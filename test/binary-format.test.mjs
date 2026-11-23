import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  ALLOW_FLAG,
  EDNS_HEADER_BYTES,
  normalizeBinaryInput,
  validateEdnsV1Buffer,
} from "../src/rules-binary-format.ts";

function buildBinary(entries = [["example.com", "BLOCK"]]) {
  const sorted = [...entries].sort((a, b) => Buffer.from(a[0]).compare(Buffer.from(b[0])));
  const pool = Buffer.concat(sorted.map(([domain]) => Buffer.from(domain)));
  const buffer = new ArrayBuffer(EDNS_HEADER_BYTES + (sorted.length + 1) * 4 + pool.length);
  const view = new DataView(buffer);
  view.setUint32(0, 0x534e4445, true);
  view.setUint16(4, 1, true);
  view.setUint16(6, 0, true);
  view.setUint32(8, sorted.length, true);
  view.setUint32(12, pool.length, true);

  let offset = 0;
  for (let i = 0; i < sorted.length; i++) {
    const [domain, action] = sorted[i];
    view.setUint32(EDNS_HEADER_BYTES + i * 4, (action === "ALLOW" ? ALLOW_FLAG : 0) | offset, true);
    new Uint8Array(buffer, EDNS_HEADER_BYTES + (sorted.length + 1) * 4 + offset, domain.length)
      .set(Buffer.from(domain));
    offset += domain.length;
  }
  view.setUint32(EDNS_HEADER_BYTES + sorted.length * 4, offset, true);
  return buffer;
}

function placeInSlab(buffer, offset) {
  const slab = new ArrayBuffer(offset + buffer.byteLength + 17);
  new Uint8Array(slab, offset, buffer.byteLength).set(new Uint8Array(buffer));
  return slab;
}

test("ArrayBuffer input is zero-copy and validates", () => {
  const buffer = buildBinary();
  const normalized = normalizeBinaryInput(buffer);
  assert.strictEqual(normalized.buffer, buffer);
  assert.strictEqual(normalized.byteOffset, 0);
  assert.strictEqual(normalized.bytes.byteLength, buffer.byteLength);
  assert.equal(validateEdnsV1Buffer(buffer).count, 1);
});

test("aligned byteOffset 24 stays zero-copy", () => {
  const binary = buildBinary();
  const slab = placeInSlab(binary, 24);
  const view = new Uint8Array(slab, 24, binary.byteLength);
  const normalized = normalizeBinaryInput(view);

  assert.strictEqual(normalized.buffer, slab);
  assert.strictEqual(normalized.byteOffset, 24);
  assert.deepEqual([...normalized.bytes], [...new Uint8Array(binary)]);
});

test("unaligned byteOffset 3 is copied into an aligned ArrayBuffer", () => {
  const binary = buildBinary();
  const slab = placeInSlab(binary, 3);
  const view = new Uint8Array(slab, 3, binary.byteLength);
  const normalized = normalizeBinaryInput(view);

  assert.notStrictEqual(normalized.buffer, slab);
  assert.strictEqual(normalized.byteOffset, 0);
  assert.deepEqual([...normalized.bytes], [...new Uint8Array(binary)]);
  assert.equal(validateEdnsV1Buffer(view).count, 1);
});

test("DataView and Uint16Array are consumed as raw bytes", () => {
  const binary = buildBinary([["ads.example.com", "BLOCK"], ["example.com", "ALLOW"]]);
  assert.equal(binary.byteLength % 2, 0);

  const slab = placeInSlab(binary, 24);
  const dataView = new DataView(slab, 24, binary.byteLength);
  const uint16View = new Uint16Array(slab, 24, binary.byteLength / 2);

  assert.equal(validateEdnsV1Buffer(dataView).count, 2);
  assert.equal(validateEdnsV1Buffer(uint16View).count, 2);
});

test("normalized bytes hash exactly the view, not the backing buffer", () => {
  const binary = buildBinary();
  const slab = placeInSlab(binary, 24);
  const view = new Uint8Array(slab, 24, binary.byteLength);
  const normalized = normalizeBinaryInput(view);

  const expected = createHash("sha256").update(Buffer.from(binary)).digest("hex");
  const actual = createHash("sha256").update(normalized.bytes).digest("hex");
  assert.equal(actual, expected);
});

test("SharedArrayBuffer view is copied into an ordinary ArrayBuffer", () => {
  const binary = buildBinary();
  const shared = new SharedArrayBuffer(binary.byteLength + 32);
  new Uint8Array(shared, 8, binary.byteLength).set(new Uint8Array(binary));
  const view = new Uint8Array(shared, 8, binary.byteLength);
  const normalized = normalizeBinaryInput(view);

  assert.notStrictEqual(normalized.buffer, shared);
  assert.equal(normalized.byteOffset, 0);
  assert.equal(validateEdnsV1Buffer(view).count, 1);
});
