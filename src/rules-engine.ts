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

    let previousOffset = 0;
    for (let i = 0; i < count; i++) {
      const start = this.index[i] & OFFSET_MASK;
      const end = this.index[i + 1] & OFFSET_MASK;
      if (start < previousOffset || start > end || end > poolBytes) {
        throw new Error("Corrupted binary rule offsets");
      }
      previousOffset = start;
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


export interface RuleManifest {
  version: string;
  sha256: string;
  key: string;
  ruleCount: number;
  generatedAt: string;
}

interface SnapshotState {
  version: string;
  sha256: string;
  table: ZeroCopyRuleTable;
}

const REVALIDATE_MS = 5 * 60 * 1000;
const ERROR_COOLDOWN_MS = 60 * 1000;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

export class RuleSnapshotManager {
  private active: SnapshotState | null = null;
  private nextCheckAt = 0;
  private inFlight: Promise<void> | null = null;

  public async evaluate(
    qname: string,
    bucket: R2Bucket | undefined,
    ctx: ExecutionContext
  ): Promise<RuleDecision> {
    if (!bucket) return "PASS";

    const now = Date.now();

    if (!this.active) {
      if (now >= this.nextCheckAt) {
        await this.triggerReload(bucket);
      }
    } else if (now >= this.nextCheckAt && !this.inFlight) {
      ctx.waitUntil(this.triggerReload(bucket));
    }

    return this.active ? this.active.table.evaluate(qname) : "PASS";
  }

  public getLoadedVersion(): string | null {
    return this.active ? this.active.version : null;
  }

  private triggerReload(bucket: R2Bucket): Promise<void> {
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.reloadInternal(bucket).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async reloadInternal(bucket: R2Bucket): Promise<void> {
    try {
      const manifestObj = await bucket.get("compiled/latest.json");
      if (!manifestObj) {
        this.nextCheckAt = Date.now() + ERROR_COOLDOWN_MS;
        return;
      }

      const manifest = (await manifestObj.json()) as Partial<RuleManifest>;
      if (
        !manifest ||
        typeof manifest.version !== "string" ||
        typeof manifest.key !== "string" ||
        typeof manifest.sha256 !== "string" ||
        !SHA256_HEX_RE.test(manifest.sha256) ||
        !/^compiled\/rules-[0-9a-f]{64}\.bin$/.test(manifest.key)
      ) {
        throw new Error("Invalid latest.json schema");
      }

      if (this.active && this.active.sha256 === manifest.sha256) {
        this.nextCheckAt = Date.now() + REVALIDATE_MS;
        return;
      }

      const buffer = await this.fetchImmutableBinary(bucket, manifest.key, manifest.sha256);
      const digest = await crypto.subtle.digest("SHA-256", buffer);
      const actualHex = Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

      if (actualHex !== manifest.sha256) {
        throw new Error("Rule binary SHA-256 mismatch");
      }

      const nextTable = new ZeroCopyRuleTable(buffer);

      this.active = {
        version: manifest.version,
        sha256: manifest.sha256,
        table: nextTable,
      };
      this.nextCheckAt = Date.now() + REVALIDATE_MS;
    } catch {
      this.nextCheckAt = Date.now() + ERROR_COOLDOWN_MS;
    }
  }

  private async fetchImmutableBinary(
    bucket: R2Bucket,
    key: string,
    sha256: string
  ): Promise<ArrayBuffer> {
    const cacheKey = new Request(`https://r2-rules.internal/compiled/rules-${sha256}.bin`);
    const edgeCache =
      typeof caches !== "undefined" &&
      "default" in caches &&
      caches.default;

    if (edgeCache) {
      const cached = await edgeCache.match(cacheKey);
      if (cached) return cached.arrayBuffer();
    }

    const object = await bucket.get(key);
    if (!object) throw new Error(`Missing R2 rule binary: ${key}`);

    const buffer = await object.arrayBuffer();

    if (edgeCache) {
      await edgeCache.put(
        cacheKey,
        new Response(buffer.slice(0), {
          headers: {
            "Content-Type": "application/octet-stream",
            "Cache-Control": "public, max-age=31536000, immutable",
          },
        })
      );
    }

    return buffer;
  }
}
