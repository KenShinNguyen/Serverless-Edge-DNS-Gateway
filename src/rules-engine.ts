import {
  ALLOW_FLAG,
  OFFSET_MASK,
  validateEdnsV1Buffer,
  type ValidatedBinaryView,
} from "./rules-binary-format.ts";
import {
  RULE_SHARD_ALGORITHM,
  RULE_SHARD_COUNT,
  isRuleShardId,
  shardIdForQuery,
} from "./rules-sharding.ts";

const DOT_BYTE = 0x2e;
const REVALIDATE_MS = 5 * 60 * 1000;
const ERROR_COOLDOWN_MS = 60 * 1000;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

export type RuleDecision = "ALLOW" | "BLOCK" | "PASS";

export interface RuleMatch {
  decision: Exclude<RuleDecision, "PASS">;
  matchedLength: number;
}

export class ZeroCopyRuleTable {
  private readonly count: number;
  private readonly index: Uint32Array;
  private readonly pool: Uint8Array;
  private readonly scratch = new Uint8Array(255);

  constructor(input: ArrayBuffer | ArrayBufferView | ValidatedBinaryView) {
    const validated = isValidatedBinaryView(input)
      ? input
      : validateEdnsV1Buffer(input);
    this.count = validated.count;
    this.index = validated.index;
    this.pool = validated.pool;
  }

  public get ruleCount(): number {
    return this.count;
  }

  public evaluate(qname: string): RuleDecision {
    return this.findMatch(qname)?.decision ?? "PASS";
  }

  /**
   * Return the most-specific matching suffix and its byte length.
   * The length lets the sharded runtime preserve the original most-specific
   * rule-wins behavior when comparing the global table with one data shard.
   */
  public findMatch(qname: string): RuleMatch | null {
    if (this.count === 0) return null;

    let len = qname.length;
    if (len > 0 && qname.charCodeAt(len - 1) === DOT_BYTE) len--;
    if (len === 0 || len > 253) return null;

    for (let i = 0; i < len; i++) {
      const code = qname.charCodeAt(i);
      if (code > 127) return null;
      this.scratch[i] = code >= 65 && code <= 90 ? code + 32 : code;
    }

    let cursor = 0;
    while (cursor < len) {
      const hit = this.binarySearchSlice(cursor, len);
      if (hit !== -1) {
        return {
          decision: (this.index[hit] & ALLOW_FLAG) !== 0 ? "ALLOW" : "BLOCK",
          matchedLength: len - cursor,
        };
      }

      while (cursor < len && this.scratch[cursor] !== DOT_BYTE) cursor++;
      if (cursor >= len) break;
      cursor++;
    }

    return null;
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

function isValidatedBinaryView(
  input: ArrayBuffer | ArrayBufferView | ValidatedBinaryView,
): input is ValidatedBinaryView {
  return typeof input === "object"
    && input !== null
    && "count" in input
    && "index" in input
    && "pool" in input
    && "bytes" in input;
}

export interface RuleShardDescriptor {
  key: string;
  sha256: string;
  rules: number;
  binaryBytes: number;
  object?: string;
}

export interface ShardedRuleManifest {
  format: "EDNS-v1-sharded";
  algorithm: string;
  shardCount: number;
  global: RuleShardDescriptor | null;
  entries: Record<string, RuleShardDescriptor>;
}

export interface RuleManifest {
  version: string;
  sha256: string;
  key: string;
  rules: number;
  generatedAt: string;
  shards?: ShardedRuleManifest;
}

interface SnapshotState {
  version: string;
  sha256: string;
  ruleCount: number;
  mode: "legacy" | "sharded";
  legacy?: RuleShardDescriptor;
  shards?: ShardedRuleManifest;
  tables: Map<string, ZeroCopyRuleTable>;
  inFlight: Map<string, Promise<ZeroCopyRuleTable>>;
  failedUntil: Map<string, number>;
}

export interface RuleSnapshotHealth {
  status: "uninitialized" | "ready" | "stale" | "degraded";
  sha256: string | null;
  ruleCount: number;
  source: "r2" | "embedded-fallback";
  active: boolean;
  loadedShardCount: number;
  error: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateDescriptor(
  value: unknown,
  expectedKeyPrefix: string,
  label: string,
): RuleShardDescriptor {
  if (!isRecord(value)) throw new Error(`Invalid ${label} descriptor`);
  const { key, sha256, rules, binaryBytes } = value;
  if (
    typeof sha256 !== "string"
    || !SHA256_HEX_RE.test(sha256)
    || typeof key !== "string"
    || key !== `${expectedKeyPrefix}${sha256}.bin`
    || !Number.isSafeInteger(rules)
    || (rules as number) <= 0
    || !Number.isSafeInteger(binaryBytes)
    || (binaryBytes as number) <= 0
  ) {
    throw new Error(`Invalid ${label} descriptor`);
  }
  if (value.object !== undefined && (
    typeof value.object !== "string"
    || value.object.startsWith("/")
    || value.object.split("/").includes("..")
  )) {
    throw new Error(`Invalid ${label} local object path`);
  }
  return {
    key,
    sha256,
    rules: rules as number,
    binaryBytes: binaryBytes as number,
    ...(typeof value.object === "string" ? { object: value.object } : {}),
  };
}

function parseManifest(raw: unknown): SnapshotState {
  if (!isRecord(raw)) throw new Error("Invalid latest.json schema");
  const { version, sha256, key, rules, shards } = raw;
  if (
    typeof version !== "string"
    || version.length === 0
    || typeof sha256 !== "string"
    || !SHA256_HEX_RE.test(sha256)
    || typeof key !== "string"
    || key !== `compiled/rules-${sha256}.bin`
    || !Number.isSafeInteger(rules)
    || (rules as number) < 0
  ) {
    throw new Error("Invalid latest.json schema");
  }

  const state: SnapshotState = {
    version,
    sha256,
    ruleCount: rules as number,
    mode: "legacy",
    legacy: { key, sha256, rules: rules as number, binaryBytes: 0 },
    tables: new Map(),
    inFlight: new Map(),
    failedUntil: new Map(),
  };

  if (shards === undefined || shards === null) return state;
  if (
    !isRecord(shards)
    || shards.format !== "EDNS-v1-sharded"
    || shards.algorithm !== RULE_SHARD_ALGORITHM
    || shards.shardCount !== RULE_SHARD_COUNT
    || !isRecord(shards.entries)
  ) {
    throw new Error("Invalid latest.json shard metadata");
  }

  let shardedRules = 0;
  let global: RuleShardDescriptor | null = null;
  if (shards.global !== null && shards.global !== undefined) {
    global = validateDescriptor(
      shards.global,
      `compiled/shards/${sha256}/global-`,
      "global shard",
    );
    shardedRules += global.rules;
  }

  const entries: Record<string, RuleShardDescriptor> = {};
  for (const [shardId, value] of Object.entries(shards.entries)) {
    if (!isRuleShardId(shardId)) throw new Error(`Invalid rule shard id: ${shardId}`);
    const descriptor = validateDescriptor(
      value,
      `compiled/shards/${sha256}/${shardId}-`,
      `shard ${shardId}`,
    );
    entries[shardId] = descriptor;
    shardedRules += descriptor.rules;
  }
  if (shardedRules !== rules) {
    throw new Error(`Shard rule count mismatch: manifest=${rules}, shards=${shardedRules}`);
  }

  state.mode = "sharded";
  state.legacy = undefined;
  state.shards = {
    format: "EDNS-v1-sharded",
    algorithm: RULE_SHARD_ALGORITHM,
    shardCount: RULE_SHARD_COUNT,
    global,
    entries,
  };
  return state;
}

export class RuleSnapshotManager {
  private active: SnapshotState | null = null;
  private pending: SnapshotState | null = null;
  private nextCheckAt = 0;
  private manifestInFlight: Promise<void> | null = null;
  private lastError: string | null = null;

  public async evaluate(
    qname: string,
    bucket: R2Bucket | undefined,
    ctx: ExecutionContext,
  ): Promise<RuleDecision> {
    if (!bucket) {
      if (!this.active) {
        this.lastError = "R2 bucket binding unavailable";
        return "PASS";
      }
      return this.evaluateCached(this.active, qname);
    }

    const now = Date.now();
    if (!this.active && !this.pending) {
      if (this.manifestInFlight) {
        await this.manifestInFlight;
      } else if (now >= this.nextCheckAt) {
        await this.triggerManifestReload(bucket);
      }
    } else if (now >= this.nextCheckAt && !this.manifestInFlight) {
      ctx.waitUntil(this.triggerManifestReload(bucket));
    }

    const candidate = this.pending ?? this.active;
    if (!candidate) return "PASS";

    try {
      const result = await this.evaluateSnapshot(candidate, qname, bucket);
      if (this.pending === candidate) {
        this.active = candidate;
        this.pending = null;
        this.lastError = null;
      }
      return result;
    } catch (error) {
      this.lastError = error instanceof Error
        ? error.message.slice(0, 160)
        : "R2 snapshot shard load failed";

      // A partially published or corrupt replacement must not displace the
      // last working snapshot. Continue using its already verified tables,
      // or load the corresponding old shard before returning PASS.
      if (candidate !== this.active && this.active) {
        try {
          return await this.evaluateSnapshot(this.active, qname, bucket);
        } catch (fallbackError) {
          this.lastError = fallbackError instanceof Error
            ? fallbackError.message.slice(0, 160)
            : this.lastError;
        }
      }
      return "PASS";
    }
  }

  public getLoadedVersion(): string | null {
    return this.active?.version ?? null;
  }

  public getLoadedRuleCount(): number | null {
    return this.active?.ruleCount ?? null;
  }

  public getHealth(): RuleSnapshotHealth {
    const snapshot = this.active;
    const loadedShardCount = snapshot?.tables.size ?? 0;
    // A valid manifest with no matching shard is still an authoritative
    // snapshot decision (PASS). A failed manifest/shard load is not.
    const active = snapshot !== null && this.lastError === null;
    const hasVerifiedTables = loadedShardCount > 0;
    return {
      status: snapshot
        ? (this.lastError
          ? (hasVerifiedTables ? "stale" : "degraded")
          : "ready")
        : (this.lastError ? "degraded" : "uninitialized"),
      sha256: snapshot?.sha256 ?? null,
      ruleCount: snapshot?.ruleCount ?? 0,
      source: active ? "r2" : "embedded-fallback",
      active,
      loadedShardCount,
      error: this.lastError,
    };
  }

  private triggerManifestReload(bucket: R2Bucket): Promise<void> {
    if (this.manifestInFlight) return this.manifestInFlight;
    this.manifestInFlight = this.reloadManifest(bucket).finally(() => {
      this.manifestInFlight = null;
    });
    return this.manifestInFlight;
  }

  private async reloadManifest(bucket: R2Bucket): Promise<void> {
    try {
      const manifestObject = await bucket.get("compiled/latest.json");
      if (!manifestObject) {
        throw new Error("R2 latest manifest missing");
      }
      const parsed = parseManifest(await manifestObject.json());

      const sameSnapshotLayout = this.active?.sha256 === parsed.sha256
        && this.active.mode === parsed.mode
        && (
          parsed.mode === "legacy"
          || JSON.stringify(this.active.shards ?? null) === JSON.stringify(parsed.shards ?? null)
        );

      if (sameSnapshotLayout) {
        this.pending = null;
      } else if (this.active === null) {
        this.active = parsed;
      } else {
        // The monolithic compatibility binary and a sharded layout can share
        // the same snapshot SHA. Compare layout metadata as well as content SHA
        // so a dual-reader Worker can switch to shards after a same-SHA publish.
        this.pending = parsed;
      }

      this.lastError = null;
      this.nextCheckAt = Date.now() + REVALIDATE_MS;
    } catch (error) {
      this.lastError = error instanceof Error
        ? error.message.slice(0, 160)
        : "R2 snapshot manifest load failed";
      this.nextCheckAt = Date.now() + ERROR_COOLDOWN_MS;
      // An unavailable or malformed initial manifest is a degraded snapshot,
      // not an exception that should fail the Worker request handler.
    }
  }

  private async evaluateSnapshot(
    snapshot: SnapshotState,
    qname: string,
    bucket: R2Bucket,
  ): Promise<RuleDecision> {
    if (snapshot.mode === "legacy" && snapshot.legacy) {
      const table = await this.loadTable(snapshot, "legacy", snapshot.legacy, bucket);
      return table.evaluate(qname);
    }

    const shards = snapshot.shards;
    if (!shards) throw new Error("Sharded snapshot metadata missing");

    let requestedShard: string;
    try {
      requestedShard = shardIdForQuery(qname);
    } catch {
      return "PASS";
    }
    const descriptors: Array<[string, RuleShardDescriptor]> = [];
    if (shards.global) descriptors.push(["global", shards.global]);
    const requested = requestedShard === "global" ? undefined : shards.entries[requestedShard];
    if (requested) descriptors.push([requestedShard, requested]);

    const tables = await Promise.all(
      descriptors.map(([slot, descriptor]) => this.loadTable(snapshot, slot, descriptor, bucket)),
    );
    return this.combineMatches(tables.map((table) => table.findMatch(qname)));
  }

  private evaluateCached(snapshot: SnapshotState, qname: string): RuleDecision {
    if (snapshot.mode === "legacy") {
      return snapshot.tables.get("legacy")?.evaluate(qname) ?? "PASS";
    }

    const shards = snapshot.shards;
    if (!shards) return "PASS";
    let requestedShard: string;
    try {
      requestedShard = shardIdForQuery(qname);
    } catch {
      return "PASS";
    }
    const tables: ZeroCopyRuleTable[] = [];
    const global = snapshot.tables.get("global");
    if (global) tables.push(global);
    if (requestedShard !== "global") {
      const requested = snapshot.tables.get(requestedShard);
      if (requested) tables.push(requested);
    }
    return this.combineMatches(tables.map((table) => table.findMatch(qname)));
  }

  private combineMatches(matches: Array<RuleMatch | null>): RuleDecision {
    let best: RuleMatch | null = null;
    for (const match of matches) {
      if (match && (!best || match.matchedLength > best.matchedLength)) best = match;
    }
    return best?.decision ?? "PASS";
  }

  private loadTable(
    snapshot: SnapshotState,
    slot: string,
    descriptor: RuleShardDescriptor,
    bucket: R2Bucket,
  ): Promise<ZeroCopyRuleTable> {
    const cached = snapshot.tables.get(slot);
    if (cached) return Promise.resolve(cached);
    const inFlight = snapshot.inFlight.get(slot);
    if (inFlight) return inFlight;

    const retryAt = snapshot.failedUntil.get(slot) ?? 0;
    if (Date.now() < retryAt) {
      return Promise.reject(new Error(`Rule shard ${slot} is in retry cooldown`));
    }

    const promise = this.fetchImmutableBinary(bucket, descriptor)
      .then((validated) => {
        if (validated.count !== descriptor.rules) {
          throw new Error(
            `Rule count mismatch for ${slot}: manifest=${descriptor.rules}, binary=${validated.count}`,
          );
        }
        const table = new ZeroCopyRuleTable(validated);
        snapshot.tables.set(slot, table);
        snapshot.failedUntil.delete(slot);
        return table;
      })
      .catch((error) => {
        // Avoid re-hashing/refetching one bad shard on every DNS request.
        // The previously active snapshot remains the serving fallback.
        snapshot.failedUntil.set(slot, Date.now() + ERROR_COOLDOWN_MS);
        throw error;
      })
      .finally(() => {
        snapshot.inFlight.delete(slot);
      });

    snapshot.inFlight.set(slot, promise);
    return promise;
  }

  private async verifySnapshot(
    buffer: ArrayBuffer,
    descriptor: RuleShardDescriptor,
  ): Promise<ValidatedBinaryView> {
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    const actualHex = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    if (actualHex !== descriptor.sha256) {
      throw new Error(`Rule shard SHA-256 mismatch: ${descriptor.key}`);
    }

    const validated = validateEdnsV1Buffer(buffer);
    if (validated.count !== descriptor.rules) {
      throw new Error(
        `Rule shard count mismatch: manifest=${descriptor.rules}, binary=${validated.count}`,
      );
    }
    if (descriptor.binaryBytes > 0 && validated.bytes.byteLength !== descriptor.binaryBytes) {
      throw new Error(
        `Rule shard byte length mismatch: manifest=${descriptor.binaryBytes}, binary=${validated.bytes.byteLength}`,
      );
    }
    return validated;
  }

  private async fetchImmutableBinary(
    bucket: R2Bucket,
    descriptor: RuleShardDescriptor,
  ): Promise<ValidatedBinaryView> {
    const cacheKey = new Request(`https://r2-rules.internal/compiled/${descriptor.sha256}.bin`);
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
          return await this.verifySnapshot(cachedBuffer, descriptor);
        } catch {
          try {
            await edgeCache.delete(cacheKey);
          } catch {
            // Best-effort cache repair.
          }
        }
      }
    }

    const object = await bucket.get(descriptor.key);
    if (!object) throw new Error(`Missing R2 rule shard: ${descriptor.key}`);
    const buffer = await object.arrayBuffer();
    const validated = await this.verifySnapshot(buffer, descriptor);

    if (edgeCache) {
      await edgeCache.put(
        cacheKey,
        new Response(buffer.slice(0), {
          headers: {
            "Content-Type": "application/octet-stream",
            "Cache-Control": "public, max-age=31536000, immutable",
          },
        }),
      );
    }

    return validated;
  }
}
