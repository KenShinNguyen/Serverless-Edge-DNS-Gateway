import {
  S3Client,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { validateEdnsV1Buffer } from "../src/rules-binary-format.ts";
import { assertManifestInvariants, projectManifestFromHistory, rollbackSnapshot, unrevokeSha } from "./r2-state.mjs";

const DEFAULT_BUCKET = "dns-compiled-rules";
const LATEST_KEY = "compiled/latest.json";
const DEFAULT_RETENTION_LIMIT = 5;
const SHA_RE = /^[0-9a-f]{64}$/;

export function resolveRetentionLimit(envVal = process.env.RETENTION_LIMIT) {
  if (envVal === undefined || envVal === "") return DEFAULT_RETENTION_LIMIT;

  const trimmed = String(envVal).trim();
  if (!/^[1-9]\d*$/.test(trimmed)) {
    throw new Error(`Invalid RETENTION_LIMIT: "${envVal}" (must be a positive integer)`);
  }

  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 50) {
    throw new Error(`RETENTION_LIMIT out of range [1..50]: ${parsed}`);
  }
  return parsed;
}

export function isMissingObjectError(error) {
  const status = error?.$metadata?.httpStatusCode;
  if (status === 404) return true;
  if (typeof status === "number" && status !== 404) return false;
  const name = error?.name ?? error?.Code;
  return name === "NotFound" || name === "NoSuchKey";
}

function assertRulesCount(rules, label) {
  if (!Number.isInteger(rules) || rules < 0) {
    throw new Error(`Invalid rule count in ${label}: ${rules}`);
  }
}

function normalizeHistoryEntry(entry, label = "history entry") {
  if (!entry || !SHA_RE.test(entry.sha256)) {
    throw new Error(`Invalid SHA-256 in ${label}`);
  }
  assertRulesCount(entry.rules, label);
  return {
    sha256: entry.sha256,
    version: String(entry.version ?? "unknown"),
    generatedAt: entry.generatedAt ?? null,
    key: `compiled/rules-${entry.sha256}.bin`,
    stats: `compiled/stats-${entry.sha256}.json`,
    rules: entry.rules,
    ...(entry.shards ? { shards: entry.shards } : {}),
  };
}

export function buildRetainedVersions(currentManifest, newEntry, retentionLimit = DEFAULT_RETENTION_LIMIT) {
  if (!Number.isSafeInteger(retentionLimit) || retentionLimit < 1) {
    throw new Error(`Invalid retentionLimit: ${retentionLimit}`);
  }

  const candidates = [
    normalizeHistoryEntry(newEntry, "new entry"),
    ...(Array.isArray(currentManifest?.history)
      ? currentManifest.history.map((entry, i) => normalizeHistoryEntry(entry, `history[${i}]`))
      : []),
  ];

  if (currentManifest?.sha256) {
    validateSha(currentManifest.sha256);
    assertRulesCount(currentManifest.rules, "current manifest");
    candidates.push({
      sha256: currentManifest.sha256,
      version: String(currentManifest.version ?? "legacy"),
      generatedAt: currentManifest.generatedAt ?? null,
      key: `compiled/rules-${currentManifest.sha256}.bin`,
      stats: `compiled/stats-${currentManifest.sha256}.json`,
      rules: currentManifest.rules,
    });
  }

  const seen = new Set();
  const retained = [];

  for (const entry of candidates) {
    if (seen.has(entry.sha256)) continue;
    seen.add(entry.sha256);
    retained.push(entry);
    if (retained.length === retentionLimit) break;
  }

  return retained;
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function validateSha(sha) {
  if (!SHA_RE.test(sha)) throw new Error(`Invalid SHA-256: ${sha}`);
}

function validateKey(key, sha) {
  const expected = `compiled/rules-${sha}.bin`;
  if (key !== expected) {
    throw new Error(`Manifest key mismatch: expected ${expected}, got ${key}`);
  }
}

async function bodyToString(body) {
  if (!body) return "";
  return body.transformToString();
}

async function readCurrentManifest(s3, bucket) {
  try {
    const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: LATEST_KEY }));
    return JSON.parse(await bodyToString(response.Body));
  } catch (error) {
    if (isMissingObjectError(error)) return null;
    throw error;
  }
}

async function headObject(s3, bucket, key) {
  return s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
}

export async function verifyAndHealHistory(s3, bucket, entries) {
  const healed = [];

  for (const entry of entries) {
    const shardDescriptors = [
      ...(entry.shards?.global ? [entry.shards.global] : []),
      ...Object.values(entry.shards?.entries ?? {}),
    ];
    const results = await Promise.allSettled([
      headObject(s3, bucket, entry.key),
      headObject(s3, bucket, entry.stats),
      ...shardDescriptors.map((descriptor) => headObject(s3, bucket, descriptor.key)),
    ]);

    const fatalErrors = [];
    let drop = false;

    for (const result of results) {
      if (result.status === "rejected") {
        if (isMissingObjectError(result.reason)) {
          drop = true;
        } else {
          fatalErrors.push(result.reason);
        }
        continue;
      }

      const expectedShard = results.indexOf(result) >= 2
        ? shardDescriptors[results.indexOf(result) - 2]
        : null;
      if (
        !Number.isInteger(result.value.ContentLength)
        || result.value.ContentLength <= 0
        || (expectedShard && result.value.ContentLength !== expectedShard.binaryBytes)
      ) {
        drop = true;
      }
    }

    if (fatalErrors.length) throw fatalErrors[0];
    if (drop) {
      console.warn(`Dropping stale history entry with missing/empty object pair: ${entry.sha256}`);
      continue;
    }

    healed.push(entry);
  }

  return healed;
}

export async function verifyNewlyPublishedPair(
  s3,
  bucket,
  binaryKey,
  statsKey,
  expectedBinaryBytes,
  expectedStatsBytes,
  shardArtifacts = [],
) {
  const expected = [
    { key: binaryKey, bytes: expectedBinaryBytes, label: "Binary" },
    { key: statsKey, bytes: expectedStatsBytes, label: "Stats" },
    ...shardArtifacts.map(({ descriptor, bytes }) => ({
      key: descriptor.key,
      bytes: bytes.byteLength,
      label: `Shard ${descriptor.key}`,
    })),
  ];
  const results = await Promise.allSettled(
    expected.map(({ key }) => headObject(s3, bucket, key)),
  );

  for (const result of results) {
    if (result.status === "rejected") {
      throw result.reason;
    }
  }

  for (let index = 0; index < expected.length; index++) {
    const head = results[index].value;
    const item = expected[index];
    if (head.ContentLength !== item.bytes || head.ContentLength <= 0) {
      throw new Error(
        `${item.label} ContentLength mismatch: expected ${item.bytes}, got ${head.ContentLength}`,
      );
    }
  }
}

async function putObject(s3, bucket, key, body, contentType) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const md5 = createHash("md5").update(buffer).digest("base64");

  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: buffer,
    ContentType: contentType,
    ContentMD5: md5,
    CacheControl: key === LATEST_KEY
      ? "no-cache, no-store, must-revalidate"
      : "public, max-age=31536000, immutable",
  }));
}

async function listCompiledObjects(s3, bucket) {
  const keys = [];
  let ContinuationToken;

  do {
    const response = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: "compiled/",
      ContinuationToken,
      MaxKeys: 1000,
    }));

    for (const item of response.Contents ?? []) {
      if (item.Key) keys.push(item.Key);
    }
    ContinuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (ContinuationToken);

  return keys;
}

function shaFromRuleKey(key) {
  const match = /^compiled\/rules-([0-9a-f]{64})\.bin$/.exec(key);
  return match?.[1] ?? null;
}

function shaFromStatsKey(key) {
  const match = /^compiled\/stats-([0-9a-f]{64})\.json$/.exec(key);
  return match?.[1] ?? null;
}

function snapshotShaFromShardKey(key) {
  const match = /^compiled\/shards\/([0-9a-f]{64})\//.exec(key);
  return match?.[1] ?? null;
}

async function pruneUnpinned(s3, bucket, pinnedSet) {
  const keys = await listCompiledObjects(s3, bucket);
  const deletions = [];

  for (const key of keys) {
    const sha = shaFromRuleKey(key) ?? shaFromStatsKey(key) ?? snapshotShaFromShardKey(key);
    if (sha && !pinnedSet.has(sha)) deletions.push({ Key: key });
  }

  if (!deletions.length) return 0;

  let deleted = 0;
  for (let i = 0; i < deletions.length; i += 1000) {
    const batch = deletions.slice(i, i + 1000);
    await s3.send(new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: { Objects: batch, Quiet: true },
    }));
    deleted += batch.length;
  }

  return deleted;
}

async function readLocalShardArtifacts(outDir, snapshotSha, expectedRules, shards) {
  if (shards === undefined || shards === null) return [];
  if (
    typeof shards !== "object"
    || shards.format !== "EDNS-v1-sharded"
    || shards.algorithm !== "fnv1a32-last-two-labels-v1"
    || shards.shardCount !== 256
    || !shards.entries
    || typeof shards.entries !== "object"
    || Array.isArray(shards.entries)
  ) {
    throw new Error("Invalid local shard metadata");
  }

  const descriptors = [
    ...(shards.global ? [{ id: "global", ...shards.global }] : []),
    ...Object.entries(shards.entries).map(([id, descriptor]) => ({ id, ...descriptor })),
  ];
  const artifacts = [];
  let totalRules = 0;

  for (const descriptor of descriptors) {
    if (
      !/^(?:global|[0-9a-f]{2})$/.test(descriptor.id)
      || !SHA_RE.test(descriptor.sha256)
      || descriptor.key !== `compiled/shards/${snapshotSha}/${descriptor.id}-${descriptor.sha256}.bin`
      || !Number.isSafeInteger(descriptor.rules)
      || descriptor.rules <= 0
      || !Number.isSafeInteger(descriptor.binaryBytes)
      || descriptor.binaryBytes <= 0
      || typeof descriptor.object !== "string"
      || descriptor.object.startsWith("/")
      || descriptor.object.split("/").includes("..")
    ) {
      throw new Error(`Invalid local shard descriptor: ${descriptor.id}`);
    }

    const bytes = await readFile(resolve(outDir, descriptor.object));
    const validatedShard = validateEdnsV1Buffer(bytes);
    const actualSha = createHash("sha256").update(validatedShard.bytes).digest("hex");
    if (actualSha !== descriptor.sha256) {
      throw new Error(`Local shard SHA mismatch: ${descriptor.id}`);
    }
    if (validatedShard.count !== descriptor.rules) {
      throw new Error(`Local shard rule count mismatch: ${descriptor.id}`);
    }
    if (validatedShard.bytes.byteLength !== descriptor.binaryBytes) {
      throw new Error(`Local shard byte length mismatch: ${descriptor.id}`);
    }

    totalRules += validatedShard.count;
    artifacts.push({ descriptor, bytes: validatedShard.bytes });
  }

  if (totalRules !== expectedRules) {
    throw new Error(`Local shard rule total mismatch: expected ${expectedRules}, got ${totalRules}`);
  }
  if (artifacts.length === 0 && expectedRules !== 0) {
    throw new Error("Sharded snapshot has rules but no shard objects");
  }
  return artifacts;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const bucket = process.env.R2_BUCKET_NAME || DEFAULT_BUCKET;
  const retentionLimit = resolveRetentionLimit();

  // FIX 2: source-independent dispatch. Rollback/unrevoke branch before any local artifact read.
  if (process.argv[2] === "--rollback") {
    const targetSha = process.argv[3] && !process.argv[3].startsWith("--") ? process.argv[3] : "previous";
    const reasonIndex = process.argv.indexOf("--reason");
    const reason = reasonIndex >= 0 ? process.argv[reasonIndex + 1] : undefined;
    if (reason === undefined || !String(reason).trim()) throw new Error("--reason must be a non-empty string");
    const endpoint = requiredEnv("R2_ENDPOINT");
    const accessKeyId = requiredEnv("R2_ACCESS_KEY_ID");
    const secretAccessKey = requiredEnv("R2_SECRET_ACCESS_KEY");
    const s3 = new S3Client({ region: "auto", endpoint, credentials: { accessKeyId, secretAccessKey } });
    await rollbackSnapshot(s3, bucket, { targetSha, reason, retentionLimit });
    return;
  }

  if (process.argv[2] === "--unrevoke") {
    const sha = process.argv[3];
    if (!sha) throw new Error("--unrevoke requires a SHA-256");
    const endpoint = requiredEnv("R2_ENDPOINT");
    const accessKeyId = requiredEnv("R2_ACCESS_KEY_ID");
    const secretAccessKey = requiredEnv("R2_SECRET_ACCESS_KEY");
    const s3 = new S3Client({ region: "auto", endpoint, credentials: { accessKeyId, secretAccessKey } });
    await unrevokeSha(s3, bucket, sha, retentionLimit);
    return;
  }

  const outDir = resolve(process.env.RULES_OUT_DIR || "dist/rules");

  const localLatest = JSON.parse(await readFile(resolve(outDir, "latest.json"), "utf8"));
  const localStats = JSON.parse(await readFile(resolve(outDir, localLatest.stats), "utf8"));
  const binaryKey = `compiled/rules-${localLatest.sha256}.bin`;
  const statsKey = `compiled/stats-${localLatest.sha256}.json`;

  validateSha(localLatest.sha256);
  validateKey(localLatest.key, localLatest.sha256);
  assertRulesCount(localLatest.rules, "local latest.json");

  const binary = await readFile(resolve(outDir, localLatest.object ?? `rules-${localLatest.sha256}.bin`));
  const validated = validateEdnsV1Buffer(binary);
  if (validated.count !== localLatest.rules) {
    throw new Error(
      `Rule count mismatch: manifest=${localLatest.rules}, binary=${validated.count}`
    );
  }

  const actualSha = createHash("sha256").update(validated.bytes).digest("hex");
  if (actualSha !== localLatest.sha256) {
    throw new Error(`Local binary SHA mismatch: manifest=${localLatest.sha256}, actual=${actualSha}`);
  }

  const shardArtifacts = await readLocalShardArtifacts(
    outDir,
    actualSha,
    validated.count,
    localLatest.shards,
  );

  const version = process.env.RULE_VERSION || process.env.GITHUB_SHA || actualSha;
  const generatedAt = localStats.generatedAt || new Date().toISOString();
  const newEntry = {
    sha256: actualSha,
    version,
    generatedAt,
    key: binaryKey,
    stats: statsKey,
    rules: validated.count,
    ...(localLatest.shards ? { shards: localLatest.shards } : {}),
  };

  if (dryRun) {
    console.log(JSON.stringify({
      dryRun: true,
      bucket,
      endpoint: process.env.R2_ENDPOINT || null,
      binaryKey,
      statsKey,
      binaryBytes: validated.bytes.byteLength,
      sha256: actualSha,
      shardObjects: shardArtifacts.length,
      shardRules: shardArtifacts.reduce((sum, item) => sum + item.descriptor.rules, 0),
      shardBinaryBytes: shardArtifacts.reduce((sum, item) => sum + item.bytes.byteLength, 0),
      retentionLimit,
      plannedRetention: buildRetainedVersions(null, newEntry, retentionLimit),
    }, null, 2));
    return;
  }

  const endpoint = requiredEnv("R2_ENDPOINT");
  const accessKeyId = requiredEnv("R2_ACCESS_KEY_ID");
  const secretAccessKey = requiredEnv("R2_SECRET_ACCESS_KEY");

  const s3 = new S3Client({
    region: "auto",
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
  });

  const current = await readCurrentManifest(s3, bucket);
  if (current) assertManifestInvariants(current, retentionLimit);

  // FIX 2: a regenerated revoked SHA is rejected before any artifact PUT.
  if (current?.revoked?.some((entry) => entry.sha256 === actualSha)) {
    console.log(JSON.stringify({
      event: "skipped_revoked",
      sha256: actualSha,
      actor: process.env.GITHUB_ACTOR || process.env.USER || "unknown",
      runId: process.env.GITHUB_RUN_ID || "local",
      runAttempt: process.env.GITHUB_RUN_ATTEMPT || "1",
      eventName: process.env.GITHUB_EVENT_NAME || "manual",
    }, null, 2));
    return;
  }

  // A pre-sharding snapshot can have the same legacy binary SHA. In that case
  // we must still publish its shard objects and atomically add shard metadata.
  const sameShardLayout = JSON.stringify(current?.shards ?? null)
    === JSON.stringify(localLatest.shards ?? null);
  if (current?.sha256 === actualSha && (!localLatest.shards || sameShardLayout)) {
    validateKey(current.key ?? binaryKey, actualSha);
    await headObject(s3, bucket, binaryKey);
    console.log(JSON.stringify({ status: "unchanged", sha256: actualSha, key: binaryKey }, null, 2));
    return;
  }

  let healedHistory = [];
  if (current?.history) {
    healedHistory = await verifyAndHealHistory(s3, bucket, current.history);
    if (!healedHistory.some((entry) => entry.sha256 === current.sha256)) {
      throw new Error(`Active current history entry is missing or empty: ${current.sha256}`);
    }
  }
  const healedCurrent = current ? { ...current, history: healedHistory } : null;
  const retained = buildRetainedVersions(healedCurrent, newEntry, retentionLimit);

  if (healedCurrent) {
    await verifyAndHealHistory(s3, bucket, retained.slice(1));
  }

  await putObject(s3, bucket, binaryKey, validated.bytes, "application/octet-stream");
  for (const artifact of shardArtifacts) {
    await putObject(s3, bucket, artifact.descriptor.key, artifact.bytes, "application/octet-stream");
  }
  const statsBody = Buffer.from(JSON.stringify({
    ...localStats,
    sha256: actualSha,
    rules: validated.count,
    publishedVersion: version,
    publishedAt: new Date().toISOString(),
  }, null, 2) + "\n");
  await putObject(s3, bucket, statsKey, statsBody, "application/json");

  await verifyNewlyPublishedPair(
    s3,
    bucket,
    binaryKey,
    statsKey,
    validated.bytes.byteLength,
    statsBody.byteLength,
    shardArtifacts,
  );

  // FIX 2: canonical projection preserves the existing revoked ledger.
  const manifest = projectManifestFromHistory(
    retained,
    current?.revoked ?? [],
    new Date().toISOString(),
  );
  assertManifestInvariants(manifest, retentionLimit);
  await putObject(s3, bucket, LATEST_KEY, Buffer.from(JSON.stringify(manifest, null, 2) + "\n"), "application/json");

  const published = JSON.parse(await bodyToString(
    (await s3.send(new GetObjectCommand({ Bucket: bucket, Key: LATEST_KEY }))).Body
  ));
  assertManifestInvariants(published, retentionLimit);
  if (published.sha256 !== newEntry.sha256 || published.history?.[0]?.sha256 !== newEntry.sha256) {
    throw new Error("latest.json verification failed after publish");
  }

  const pinnedSet = new Set(retained.map((entry) => entry.sha256));
  const deleted = await pruneUnpinned(s3, bucket, pinnedSet);

  console.log(JSON.stringify({
    status: "published",
    sha256: actualSha,
    version,
    rules: validated.count,
    retentionLimit,
    retainedVersions: retained.map((entry) => entry.sha256),
    deletedObjects: deleted,
  }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exit(1);
  });
}
