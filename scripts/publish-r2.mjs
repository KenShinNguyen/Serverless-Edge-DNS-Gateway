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
    const results = await Promise.allSettled([
      headObject(s3, bucket, entry.key),
      headObject(s3, bucket, entry.stats),
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

      if (!Number.isInteger(result.value.ContentLength) || result.value.ContentLength <= 0) {
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
) {
  const results = await Promise.allSettled([
    headObject(s3, bucket, binaryKey),
    headObject(s3, bucket, statsKey),
  ]);

  for (const result of results) {
    if (result.status === "rejected") {
      throw result.reason;
    }
  }

  const binaryHead = results[0].value;
  const statsHead = results[1].value;

  if (binaryHead.ContentLength !== expectedBinaryBytes || binaryHead.ContentLength <= 0) {
    throw new Error(
      `Binary ContentLength mismatch: expected ${expectedBinaryBytes}, got ${binaryHead.ContentLength}`
    );
  }
  if (statsHead.ContentLength !== expectedStatsBytes || statsHead.ContentLength <= 0) {
    throw new Error(
      `Stats ContentLength mismatch: expected ${expectedStatsBytes}, got ${statsHead.ContentLength}`
    );
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

async function pruneUnpinned(s3, bucket, pinnedSet) {
  const keys = await listCompiledObjects(s3, bucket);
  const deletions = [];

  for (const key of keys) {
    const sha = shaFromRuleKey(key) ?? shaFromStatsKey(key);
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

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const bucket = process.env.R2_BUCKET_NAME || DEFAULT_BUCKET;
  const retentionLimit = resolveRetentionLimit();
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

  const version = process.env.RULE_VERSION || process.env.GITHUB_SHA || actualSha;
  const generatedAt = localStats.generatedAt || new Date().toISOString();
  const newEntry = {
    sha256: actualSha,
    version,
    generatedAt,
    key: binaryKey,
    stats: statsKey,
    rules: validated.count,
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

  if (current?.sha256 === actualSha) {
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
  );

  const manifest = {
    format: "EDNS-v1",
    sha256: newEntry.sha256,
    key: newEntry.key,
    stats: newEntry.stats,
    rules: newEntry.rules,
    version: newEntry.version,
    generatedAt: newEntry.generatedAt,
    publishedAt: new Date().toISOString(),
    history: retained,
  };
  await putObject(s3, bucket, LATEST_KEY, Buffer.from(JSON.stringify(manifest, null, 2) + "\n"), "application/json");

  const published = JSON.parse(await bodyToString(
    (await s3.send(new GetObjectCommand({ Bucket: bucket, Key: LATEST_KEY }))).Body
  ));
  if (
    published.sha256 !== newEntry.sha256 ||
    published.key !== newEntry.key ||
    published.stats !== newEntry.stats ||
    published.rules !== newEntry.rules ||
    published.version !== newEntry.version ||
    published.generatedAt !== newEntry.generatedAt ||
    published.history?.[0]?.sha256 !== newEntry.sha256 ||
    published.history?.[0]?.rules !== newEntry.rules
  ) {
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
