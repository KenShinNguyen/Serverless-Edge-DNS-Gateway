#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { validateEdnsV1Buffer } from "../src/rules-binary-format.ts";
import { ZeroCopyRuleTable } from "../src/rules-engine.ts";

function memorySnapshot() {
  global.gc?.();
  const usage = process.memoryUsage();
  return {
    rssBytes: usage.rss,
    heapUsedBytes: usage.heapUsed,
    externalBytes: usage.external,
    arrayBuffersBytes: usage.arrayBuffers,
  };
}

function delta(after, before) {
  return Object.fromEntries(
    Object.keys(after).map((key) => [key, after[key] - before[key]]),
  );
}

function artifactPath(outDir, relativePath, label) {
  if (
    typeof relativePath !== "string"
    || relativePath.length === 0
    || relativePath.startsWith("/")
    || relativePath.split("/").includes("..")
  ) {
    throw new Error("Invalid " + label + " artifact path");
  }
  return resolve(outDir, relativePath);
}

export async function measureRuleSnapshotMemory(outDir = resolve("dist/rules")) {
  if (typeof global.gc !== "function") {
    throw new Error("Run with --expose-gc so memory snapshots can be compared after GC");
  }

  const latest = JSON.parse(
    await readFile(resolve(outDir, "latest.json"), "utf8"),
  );
  if (
    latest.format !== "EDNS-v1"
    || typeof latest.sha256 !== "string"
    || !latest.shards
    || latest.shards.format !== "EDNS-v1-sharded"
    || latest.shards.algorithm !== "fnv1a32-last-two-labels-v1"
    || latest.shards.shardCount !== 256
    || !latest.shards.entries
  ) {
    throw new Error("Expected a compiled EDNS-v1 snapshot with 256-way shard metadata");
  }

  const baseline = memorySnapshot();

  // Model the retained previous legacy snapshot using the same zero-copy
  // table wrapper as the Worker. The table's typed-array views retain its bytes.
  const legacyPath = artifactPath(
    outDir,
    latest.object ?? ("rules-" + latest.sha256 + ".bin"),
    "legacy binary",
  );
  const legacyBytes = await readFile(legacyPath);
  const legacyValidated = validateEdnsV1Buffer(legacyBytes);
  if (legacyValidated.count !== latest.rules) {
    throw new Error("Legacy binary rule count differs from latest.json");
  }
  const previousLegacyTable = new ZeroCopyRuleTable(legacyValidated);
  const previousLoaded = memorySnapshot();

  // Conservative active-snapshot upper bound: load every non-empty shard,
  // although one query normally loads only its selected shard (plus global).
  const descriptors = [
    ...(latest.shards.global ? [{ id: "global", ...latest.shards.global }] : []),
    ...Object.entries(latest.shards.entries).map(([id, descriptor]) => ({
      id,
      ...descriptor,
    })),
  ];
  if (descriptors.length === 0) {
    throw new Error("Sharded snapshot contains no non-empty table descriptors");
  }

  let totalShardBytes = 0;
  let maxShardBytes = 0;
  let totalShardRules = 0;
  const activeTables = new Map();

  for (const descriptor of descriptors) {
    const filePath = artifactPath(outDir, descriptor.object, "shard");
    const bytes = await readFile(filePath);
    const validated = validateEdnsV1Buffer(bytes);
    if (
      validated.count !== descriptor.rules
      || validated.bytes.byteLength !== descriptor.binaryBytes
    ) {
      throw new Error("Shard artifact metadata mismatch for " + descriptor.id);
    }

    activeTables.set(descriptor.id, new ZeroCopyRuleTable(validated));
    totalShardBytes += validated.bytes.byteLength;
    maxShardBytes = Math.max(maxShardBytes, validated.bytes.byteLength);
    totalShardRules += validated.count;
  }

  if (totalShardRules !== latest.rules) {
    throw new Error("Shard rule total differs from latest.json");
  }

  const previousPlusAllShards = memorySnapshot();
  const expectedRetainedTableBytes = legacyValidated.bytes.byteLength + totalShardBytes;

  // Keep references live until after sampling; explicit use prevents a future
  // refactor or optimizer from making the model appear smaller than it is.
  if (
    previousLegacyTable.ruleCount !== latest.rules
    || activeTables.size !== descriptors.length
  ) {
    throw new Error("Memory model did not retain every requested table");
  }

  return {
    reportType: "Node-only zero-copy table memory estimate; not Cloudflare isolate evidence",
    generatedAt: new Date().toISOString(),
    runtime: process.version,
    snapshot: {
      sha256: latest.sha256,
      rules: latest.rules,
      shardObjectCount: descriptors.length,
      nonEmptyDataShardCount: Object.keys(latest.shards.entries).length,
      globalRules: latest.shards.global?.rules ?? 0,
      legacyBinaryBytes: legacyValidated.bytes.byteLength,
      totalShardBinaryBytes: totalShardBytes,
      maxShardBinaryBytes: maxShardBytes,
      expectedRetainedTableBytes,
    },
    memory: {
      baseline,
      previousLegacyTableLoaded: previousLoaded,
      previousLegacyTableDelta: delta(previousLoaded, baseline),
      previousLegacyPlusAllActiveShardsLoaded: previousPlusAllShards,
      previousLegacyPlusAllActiveShardsDelta: delta(previousPlusAllShards, baseline),
    },
    model: {
      previousSnapshot: "one full legacy monolith table retained",
      activeSnapshot: "all non-empty shard tables retained as a conservative upper bound",
      normalFirstQuery: "one selected data shard plus optional global table",
      caveat: "Node V8 allocator, Buffer alignment and process RSS differ from Cloudflare Workers isolate accounting",
    },
  };
}

async function main() {
  const report = await measureRuleSnapshotMemory();
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(JSON.stringify({
      status: "MEMORY_MEASUREMENT_ERROR",
      error: error instanceof Error ? error.message : "Unknown memory measurement error",
    }, null, 2) + "\n");
    process.exitCode = 1;
  });
}
