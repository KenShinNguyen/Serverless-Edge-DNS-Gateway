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

const DEFAULT_BUCKET = "dns-compiled-rules";
const LATEST_KEY = "compiled/latest.json";
const RETENTION = 5;
const SHA_RE = /^[0-9a-f]{64}$/;

export function buildRetainedVersions(currentManifest, newEntry) {
  const candidates = [
    newEntry,
    ...(Array.isArray(currentManifest?.history) ? currentManifest.history : []),
    currentManifest?.sha256
      ? [{
          sha256: currentManifest.sha256,
          version: currentManifest.version ?? "legacy",
          generatedAt: currentManifest.generatedAt ?? null,
          key: currentManifest.key ?? `compiled/rules-${currentManifest.sha256}.bin`,
          stats: currentManifest.stats ?? `compiled/stats-${currentManifest.sha256}.json`,
        }]
      : [],
  ];

  const seen = new Set();
  const retained = [];

  for (const entry of candidates) {
    if (!entry || !SHA_RE.test(entry.sha256) || seen.has(entry.sha256)) continue;
    seen.add(entry.sha256);
    retained.push({
      sha256: entry.sha256,
      version: String(entry.version ?? "unknown"),
      generatedAt: entry.generatedAt ?? null,
      key: `compiled/rules-${entry.sha256}.bin`,
      stats: `compiled/stats-${entry.sha256}.json`,
    });
    if (retained.length === RETENTION) break;
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
    if (error?.name === "NoSuchKey" || error?.$metadata?.httpStatusCode === 404) return null;
    throw error;
  }
}

async function headRequiredObjects(s3, bucket, entries) {
  for (const entry of entries) {
    const binary = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: entry.key }));
    const stats = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: entry.stats }));
    if (!Number.isInteger(binary.ContentLength) || binary.ContentLength <= 0) {
      throw new Error(`Pinned binary missing/empty: ${entry.key}`);
    }
    if (!Number.isInteger(stats.ContentLength) || stats.ContentLength <= 0) {
      throw new Error(`Pinned stats missing/empty: ${entry.stats}`);
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

async function pruneUnpinned(s3, bucket, pinnedSet) {
  const keys = await listCompiledObjects(s3, bucket);
  const deletions = [];

  for (const key of keys) {
    const sha = shaFromRuleKey(key) ?? shaFromStatsKey(key);
    if (sha && !pinnedSet.has(sha)) deletions.push({ Key: key });
  }

  if (!deletions.length) return 0;

  // R2 implements DeleteObjects. Keep the batch comfortably below the S3
  // 1000-object request limit even if the retention policy changes later.
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
  const outDir = resolve(process.env.RULES_OUT_DIR || "dist/rules");

  const localLatest = JSON.parse(await readFile(resolve(outDir, "latest.json"), "utf8"));
  const localStats = JSON.parse(await readFile(resolve(outDir, localLatest.stats), "utf8"));
  const binaryKey = `compiled/rules-${localLatest.sha256}.bin`;
  const statsKey = `compiled/stats-${localLatest.sha256}.json`;

  validateSha(localLatest.sha256);
  validateKey(localLatest.object, localLatest.sha256);

  const binary = await readFile(resolve(outDir, localLatest.object));
  const actualSha = createHash("sha256").update(binary).digest("hex");
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
  };

  if (dryRun) {
    console.log(JSON.stringify({
      dryRun: true,
      bucket,
      endpoint: process.env.R2_ENDPOINT || null,
      binaryKey,
      statsKey,
      binaryBytes: binary.byteLength,
      sha256: actualSha,
      plannedRetention: buildRetainedVersions(null, newEntry),
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
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: binaryKey }));
    console.log(JSON.stringify({ status: "unchanged", sha256: actualSha, key: binaryKey }, null, 2));
    return;
  }

  const retained = buildRetainedVersions(current, newEntry);

  // If the previous manifest has a history, prove every pinned predecessor
  // still exists before publishing a new pointer. Otherwise we could publish
  // a "rollback history" containing dead objects.
  if (current) {
    await headRequiredObjects(s3, bucket, retained.slice(1));
  }

  // 1-2. Immutable artifacts first.
  await putObject(s3, bucket, binaryKey, binary, "application/octet-stream");
  const statsBody = Buffer.from(JSON.stringify({
    ...localStats,
    sha256: actualSha,
    publishedVersion: version,
    publishedAt: new Date().toISOString(),
  }, null, 2) + "\n");
  await putObject(s3, bucket, statsKey, statsBody, "application/json");

  // 3. Verify the exact byte lengths before changing the pointer.
  const binaryHead = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: binaryKey }));
  const statsHead = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: statsKey }));
  if (binaryHead.ContentLength !== binary.byteLength) {
    throw new Error(`Binary ContentLength mismatch: expected ${binary.byteLength}, got ${binaryHead.ContentLength}`);
  }
  if (statsHead.ContentLength !== statsBody.byteLength) {
    throw new Error(`Stats ContentLength mismatch: expected ${statsBody.byteLength}, got ${statsHead.ContentLength}`);
  }

  // 4. latest.json is the commit point. It is written last.
  const manifest = {
    format: "EDNS-v1",
    sha256: actualSha,
    key: binaryKey,
    stats: statsKey,
    rules: localLatest.rules,
    version,
    generatedAt,
    publishedAt: new Date().toISOString(),
    history: retained,
  };
  await putObject(s3, bucket, LATEST_KEY, Buffer.from(JSON.stringify(manifest, null, 2) + "\n"), "application/json");

  // 5. Read the pointer back before pruning anything.
  const published = JSON.parse(await bodyToString(
    (await s3.send(new GetObjectCommand({ Bucket: bucket, Key: LATEST_KEY }))).Body
  ));
  if (published.sha256 !== actualSha || published.key !== binaryKey) {
    throw new Error("latest.json verification failed after publish");
  }

  // 6-7. Prune only content-addressed artifacts not explicitly pinned by the
  // five-entry history ring. Never infer retention from LastModified.
  const pinnedSet = new Set(retained.map((entry) => entry.sha256));
  const deleted = await pruneUnpinned(s3, bucket, pinnedSet);

  console.log(JSON.stringify({
    status: "published",
    sha256: actualSha,
    version,
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
