export const EDNS_MAGIC = 0x534e4445;
export const EDNS_FORMAT_VERSION = 1;
export const EDNS_HEADER_BYTES = 16;
export const OFFSET_MASK = 0x3fffffff;
export const ALLOW_FLAG = 0x40000000;

export interface NormalizedBinaryInput {
  readonly buffer: ArrayBuffer;
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly bytes: Uint8Array;
}

export interface ValidatedBinaryView {
  readonly count: number;
  readonly poolBytes: number;
  readonly index: Uint32Array;
  readonly pool: Uint8Array;
  readonly bytes: Uint8Array;
}

export function normalizeBinaryInput(
  input: ArrayBuffer | ArrayBufferView
): NormalizedBinaryInput {
  if (input instanceof ArrayBuffer) {
    return {
      buffer: input,
      byteOffset: 0,
      byteLength: input.byteLength,
      bytes: new Uint8Array(input, 0, input.byteLength),
    };
  }

  if (!ArrayBuffer.isView(input)) {
    throw new Error("EDNS-v1 input must be an ArrayBuffer or ArrayBufferView");
  }

  const { buffer, byteOffset, byteLength } = input;

  if (
    buffer instanceof ArrayBuffer &&
    (byteOffset + EDNS_HEADER_BYTES) % 4 === 0
  ) {
    const bytes = new Uint8Array(buffer, byteOffset, byteLength);
    return { buffer, byteOffset, byteLength, bytes };
  }

  const sourceBytes = new Uint8Array(buffer, byteOffset, byteLength);
  const copy = new Uint8Array(byteLength);
  copy.set(sourceBytes);
  return {
    buffer: copy.buffer,
    byteOffset: 0,
    byteLength,
    bytes: copy,
  };
}

export function validateEdnsV1Buffer(
  input: ArrayBuffer | ArrayBufferView
): ValidatedBinaryView {
  const { buffer, byteOffset, byteLength, bytes } = normalizeBinaryInput(input);

  if (byteLength < EDNS_HEADER_BYTES + 4) {
    throw new Error("EDNS-v1 buffer too small for header and sentinel");
  }

  const header = new DataView(buffer, byteOffset, EDNS_HEADER_BYTES);
  if (header.getUint32(0, true) !== EDNS_MAGIC) {
    throw new Error("Invalid EDNS-v1 magic bytes");
  }

  const version = header.getUint16(4, true);
  if (version !== EDNS_FORMAT_VERSION) {
    throw new Error(`Unsupported EDNS-v1 version: ${version}`);
  }

  const count = header.getUint32(8, true);
  if (count > OFFSET_MASK) {
    throw new Error(`EDNS-v1 rule count exceeds 30-bit limit: ${count}`);
  }

  const poolBytes = header.getUint32(12, true);
  const indexByteLen = (count + 1) * 4;
  const expectedTotal = EDNS_HEADER_BYTES + indexByteLen + poolBytes;

  if (expectedTotal !== byteLength) {
    throw new Error(
      `EDNS-v1 byte length mismatch: expected ${expectedTotal}, got ${byteLength}`
    );
  }

  const index = new Uint32Array(
    buffer,
    byteOffset + EDNS_HEADER_BYTES,
    count + 1
  );
  const sentinelOffset = index[count] & OFFSET_MASK;
  if (sentinelOffset !== poolBytes) {
    throw new Error(
      `EDNS-v1 sentinel mismatch: expected ${poolBytes}, got ${sentinelOffset}`
    );
  }

  let prevOffset = 0;
  for (let i = 0; i <= count; i++) {
    const currOffset = index[i] & OFFSET_MASK;
    if (currOffset < prevOffset) {
      throw new Error(`EDNS-v1 non-monotonic offset at entry ${i}`);
    }
    prevOffset = currOffset;
  }

  const pool = new Uint8Array(
    buffer,
    byteOffset + EDNS_HEADER_BYTES + indexByteLen,
    poolBytes
  );

  return { count, poolBytes, index, pool, bytes };
}
