import {
  ALLOW_FLAG,
  OFFSET_MASK,
  validateEdnsV1Buffer,
} from "./rules-binary-format.ts";

const DOT_BYTE = 0x2e;

export type RuleDecision = "ALLOW" | "BLOCK" | "PASS";

export class ZeroCopyRuleTable {
  private readonly count: number;
  private readonly index: Uint32Array;
  private readonly pool: Uint8Array;
  private readonly scratch = new Uint8Array(255);

  constructor(input: ArrayBuffer | ArrayBufferView) {
    const validated = validateEdnsV1Buffer(input);
    this.count = validated.count;
    this.index = validated.index;
    this.pool = validated.pool;
  }

  public get ruleCount(): number {
    return this.count;
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
  rules: number;
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

export interface RuleSnapshotHealth {
  status: "uninitialized" | "ready" | "stale" | "degraded";
  sha256: string | null;
  ruleCount: number;
  source: "r2" | "embedded-fallback";
  active: boolean;
  error: string | null;
}

export class RuleSnapshotManager {
  private active: SnapshotState | null = null;
  private nextCheckAt = 0;
  private inFlight: Promise<void> | null = null;
  private lastError: string | null = null;

  public async evaluate(
    qname: string,
    bucket: R2Bucket | undefined,
    ctx: ExecutionContext
  ): Promise<RuleDecision> {
    if (!bucket) {
      if (!this.active) this.lastError = "R2 bucket binding unavailable";
      return this.active ? this.active.table.evaluate(qname) : "PASS";
    }

    const now = Date.now();
    if (!this.active) {
      if (now >= this.nextCheckAt) await this.triggerReload(bucket);
    } else if (now >= this.nextCheckAt && !this.inFlight) {
      ctx.waitUntil(this.triggerReload(bucket));
    }

    return this.active ? this.active.table.evaluate(qname) : "PASS";
  }

  public getLoadedVersion(): string | null {
    return this.active ? this.active.version : null;
  }

  public getLoadedRuleCount(): number | null {
    return this.active ? this.active.table.ruleCount : null;
  }

  public getHealth(): RuleSnapshotHealth {
    const active = this.active !== null;
    return {
      status: active ? (this.lastError ? "stale" : "ready") : (this.lastError ? "degraded" : "uninitialized"),
      sha256: this.active?.sha256 ?? null,
      ruleCount: this.active?.table.ruleCount ?? 0,
      source: active ? "r2" : "embedded-fallback",
      active,
      error: this.lastError
    };
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
        this.lastError = "R2 latest manifest missing";
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
        !/^compiled\/rules-[0-9a-f]{64}\.bin$/.test(manifest.key) ||
        !Number.isInteger(manifest.rules) ||
        (manifest.rules ?? -1) < 0
      ) {
        throw new Error("Invalid latest.json schema");
      }

      if (this.active && this.active.sha256 === manifest.sha256) {
        if (this.active.table.ruleCount !== manifest.rules) {
          throw new Error(
            `Rule count mismatch: manifest=${manifest.rules}, active=${this.active.table.ruleCount}`
          );
        }
        this.lastError = null;
        this.nextCheckAt = Date.now() + REVALIDATE_MS;
        return;
      }

      const buffer = await this.fetchImmutableBinary(bucket, manifest.key, manifest.sha256, manifest.rules);
      const validated = validateEdnsV1Buffer(buffer);
      const nextTable = new ZeroCopyRuleTable(validated.bytes);
      this.active = {
        version: manifest.version,
        sha256: manifest.sha256,
        table: nextTable,
      };
      this.lastError = null;
      this.nextCheckAt = Date.now() + REVALIDATE_MS;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message.slice(0, 160) : "R2 snapshot load failed";
      this.nextCheckAt = Date.now() + ERROR_COOLDOWN_MS;
    }
  }

  private async verifySnapshot(
    buffer: ArrayBuffer,
    sha256: string,
    expectedRules: number
  ): Promise<void> {
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    const actualHex = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    if (actualHex !== sha256) throw new Error("Rule binary SHA-256 mismatch");

    const validated = validateEdnsV1Buffer(buffer);
    if (validated.count !== expectedRules) {
      throw new Error(`Rule count mismatch: manifest=${expectedRules}, binary=${validated.count}`);
    }
  }

  private async fetchImmutableBinary(
    bucket: R2Bucket,
    key: string,
    sha256: string,
    expectedRules: number
  ): Promise<ArrayBuffer> {
    const cacheKey = new Request(`https://r2-rules.internal/compiled/rules-${sha256}.bin`);
    const cacheStorage =
      typeof caches !== "undefined"
        ? (caches as CacheStorage & { default?: Cache })
        : undefined;
    const edgeCache = cacheStorage?.default;

    if (edgeCache) {
      const cached = await edgeCache.match(cacheKey);
      if (cached) {
        const cachedBuffer = await cached.arrayBuffer();
        try {
          await this.verifySnapshot(cachedBuffer, sha256, expectedRules);
          return cachedBuffer;
        } catch {
          try { await edgeCache.delete(cacheKey); } catch { /* best-effort cache repair */ }
        }
      }
    }

    const object = await bucket.get(key);
    if (!object) throw new Error(`Missing R2 rule binary: ${key}`);
    const buffer = await object.arrayBuffer();
    // Digest, format and count are verified BEFORE cache.put.
    await this.verifySnapshot(buffer, sha256, expectedRules);

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
