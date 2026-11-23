const MAGIC = 0x534e4445; // "EDNS" little-endian
const VERSION = 1;
const OFFSET_MASK = 0x3fffffff;
const ALLOW_FLAG = 0x40000000;
const DOT_BYTE = 0x2e;

export type RuleDecision = "ALLOW" | "BLOCK" | "PASS";

export class ZeroCopyRuleTable {
  private readonly count: number;
  private readonly index: Uint32Array;
  private readonly pool: Uint8Array;
  private readonly scratch = new Uint8Array(255);

  constructor(buffer: ArrayBuffer) {
    if (buffer.byteLength < 20) {
      throw new Error("Invalid binary rule buffer: too small");
    }

    const header = new DataView(buffer, 0, 16);
    if (header.getUint32(0, true) !== MAGIC) {
      throw new Error("Invalid binary rule magic");
    }

    if (header.getUint16(4, true) !== VERSION) {
      throw new Error(`Unsupported binary rule version: ${header.getUint16(4, true)}`);
    }

    const count = header.getUint32(8, true);
    const poolBytes = header.getUint32(12, true);
    const indexBytes = (count + 1) * 4;
    const poolOffset = 16 + indexBytes;

    if (count > OFFSET_MASK) {
      throw new Error("Rule count exceeds binary format limit");
    }
    if (poolOffset < 16 || poolOffset + poolBytes > buffer.byteLength) {
      throw new Error("Corrupted binary rule buffer bounds");
    }

    this.count = count;
    this.index = new Uint32Array(buffer, 16, count + 1);
    this.pool = new Uint8Array(buffer, poolOffset, poolBytes);

    const sentinel = this.index[count] & OFFSET_MASK;
    if (sentinel !== poolBytes) {
      throw new Error("Corrupted binary rule sentinel");
    }

    for (let i = 0; i < count; i++) {
      const start = this.index[i] & OFFSET_MASK;
      const end = this.index[i + 1] & OFFSET_MASK;
      if (start > end || end > poolBytes) {
        throw new Error("Corrupted binary rule offsets");
      }
    }
  }

  public evaluate(qname: string): RuleDecision {
    if (this.count === 0) return "PASS";

    let len = qname.length;
    if (len > 0 && qname.charCodeAt(len - 1) === DOT_BYTE) len--;
    if (len === 0 || len > 253) return "PASS";

    for (let i = 0; i < len; i++) {
      const code = qname.charCodeAt(i);
      if (code > 127) return "PASS";
      this.scratch[i] = code >= 65 && code <= 90 ? code + 32 : code;
    }

    let cursor = 0;
    while (cursor < len) {
      const hit = this.binarySearchSlice(cursor, len);
      if (hit !== -1) {
        return (this.index[hit] & ALLOW_FLAG) !== 0 ? "ALLOW" : "BLOCK";
      }

      while (cursor < len && this.scratch[cursor] !== DOT_BYTE) cursor++;
      if (cursor >= len) break;
      cursor++;
    }

    return "PASS";
  }

  private binarySearchSlice(start: number, end: number): number {
    const targetLen = end - start;
    let low = 0;
    let high = this.count - 1;

    while (low <= high) {
      const mid = (low + high) >>> 1;
      const entryStart = this.index[mid] & OFFSET_MASK;
      const entryEnd = this.index[mid + 1] & OFFSET_MASK;
      const entryLen = entryEnd - entryStart;

      const minLen = targetLen < entryLen ? targetLen : entryLen;
      let cmp = 0;

      for (let i = 0; i < minLen; i++) {
        const diff = this.scratch[start + i] - this.pool[entryStart + i];
        if (diff !== 0) {
          cmp = diff;
          break;
        }
      }

      if (cmp === 0) cmp = targetLen - entryLen;
      if (cmp === 0) return mid;
      if (cmp < 0) high = mid - 1;
      else low = mid + 1;
    }

    return -1;
  }
}
