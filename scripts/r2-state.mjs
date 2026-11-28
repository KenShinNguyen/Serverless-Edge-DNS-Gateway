import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { validateEdnsV1Buffer } from "../src/rules-binary-format.ts";

import {
  LATEST_KEY,
  REVOKED_LIMIT,
  assertManifestInvariants,
  validateSha,
} from "./r2-manifest.mjs";
export { LATEST_KEY, REVOKED_LIMIT, assertManifestInvariants } from "./r2-manifest.mjs";

export function projectManifestFromHistory(history, revoked = [], publishedAt = new Date().toISOString()) {
  if (!Array.isArray(history) || history.length === 0) throw new Error("Cannot project manifest from empty history");
  const head = history[0];
  return {
    format: "EDNS-v1",
    sha256: head.sha256,
    key: head.key,
    stats: head.stats,
    rules: head.rules,
    version: head.version,
    generatedAt: head.generatedAt,
    ...(head.shards ? { shards: head.shards } : {}),
    publishedAt,
    history: [...history],
    revoked: [...revoked],
  };
}

async function bodyString(body) { return body?.transformToString?.() ?? ""; }
async function bodyBytes(body) {
  if (body?.transformToByteArray) return body.transformToByteArray();
  return new TextEncoder().encode(await bodyString(body));
}
async function getManifest(s3, bucket) {
  const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: LATEST_KEY }));
  return JSON.parse(await bodyString(response.Body));
}
async function putManifest(s3, bucket, manifest) {
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: LATEST_KEY, Body: Buffer.from(JSON.stringify(manifest, null, 2) + "\n"), ContentType: "application/json", CacheControl: "no-cache, no-store, must-revalidate" }));
}
async function head(s3, bucket, key) { return s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key })); }
async function getBytes(s3, bucket, key) { return bodyBytes((await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))).Body); }

function listShardDescriptors(shards) {
  if (!shards) return [];
  return [
    ...(shards.global ? [{ id: "global", ...shards.global }] : []),
    ...Object.entries(shards.entries ?? {}).map(([id, descriptor]) => ({ id, ...descriptor })),
  ];
}

async function verifyShardSet(s3, bucket, snapshot) {
  if (!snapshot.shards) return { shardObjects: 0, shardBinaryBytes: 0 };
  let shardRules = 0;
  let shardBinaryBytes = 0;
  const descriptors = listShardDescriptors(snapshot.shards);

  for (const descriptor of descriptors) {
    const bytes = await getBytes(s3, bucket, descriptor.key);
    const validated = validateEdnsV1Buffer(bytes);
    const actualSha = createHash("sha256").update(validated.bytes).digest("hex");
    if (actualSha !== descriptor.sha256) {
      throw new Error(`Shard SHA mismatch for ${descriptor.id}: expected ${descriptor.sha256}, got ${actualSha}`);
    }
    if (validated.count !== descriptor.rules) {
      throw new Error(`Shard rule count mismatch for ${descriptor.id}: manifest=${descriptor.rules}, binary=${validated.count}`);
    }
    if (validated.bytes.byteLength !== descriptor.binaryBytes) {
      throw new Error(`Shard byte length mismatch for ${descriptor.id}: manifest=${descriptor.binaryBytes}, binary=${validated.bytes.byteLength}`);
    }
    shardRules += validated.count;
    shardBinaryBytes += validated.bytes.byteLength;
  }

  if (shardRules !== snapshot.rules) {
    throw new Error(`Shard set rule count mismatch: manifest=${snapshot.rules}, shards=${shardRules}`);
  }
  return { shardObjects: descriptors.length, shardBinaryBytes };
}
async function pruneUnpinned(s3, bucket, pinned) {
  const response = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: "compiled/", MaxKeys: 1000 }));
  const objects = (response.Contents ?? []).map((x) => x.Key).filter(Boolean).filter((key) => {
    const m = /^compiled\/(?:rules|stats)-([0-9a-f]{64})\.(?:bin|json)$/.exec(key);
    return m && !pinned.has(m[1]);
  }).map((Key) => ({ Key }));
  if (!objects.length) return 0;
  await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } }));
  return objects.length;
}
function audit() {
  return { actor: process.env.GITHUB_ACTOR || process.env.USER || "unknown", runId: process.env.GITHUB_RUN_ID || "local", runAttempt: process.env.GITHUB_RUN_ATTEMPT || "1", eventName: process.env.GITHUB_EVENT_NAME || "manual" };
}

export async function rollbackSnapshot(s3, bucket, { targetSha = "previous", reason, retentionLimit = 5 } = {}) {
  if (typeof reason !== "string" || !reason.trim()) throw new Error("--reason must be a non-empty string");
  const current = await getManifest(s3, bucket);
  assertManifestInvariants(current, retentionLimit);
  if (current.sha256 !== current.history[0].sha256) throw new Error("Rollback requires latest.sha256 to match history[0].sha256");
  const target = targetSha === "previous" ? current.history[1] : current.history.find((x) => x.sha256 === targetSha);
  if (!target) throw new Error(`Rollback target is not a retained predecessor: ${targetSha}`);
  const bytes = await getBytes(s3, bucket, target.key);
  const validated = validateEdnsV1Buffer(bytes);
  const actualSha = createHash("sha256").update(validated.bytes).digest("hex");
  if (actualSha !== target.sha256) throw new Error(`Rollback target SHA mismatch: expected ${target.sha256}, got ${actualSha}`);
  if (validated.count !== target.rules) throw new Error(`Rollback target rule count mismatch: manifest=${target.rules}, binary=${validated.count}`);
  await verifyShardSet(s3, bucket, target);
  const statsHead = await head(s3, bucket, target.stats);
  if (!Number.isInteger(statsHead.ContentLength) || statsHead.ContentLength <= 0) throw new Error(`Rollback target stats missing/empty: ${target.stats}`);
  const history = [target, ...current.history.filter((x) => x.sha256 !== current.sha256 && x.sha256 !== target.sha256)].slice(0, retentionLimit);
  const revoked = [...(current.revoked ?? []), { sha256: current.sha256, revokedAt: new Date().toISOString(), reason: reason.trim(), rolledBackTo: target.sha256, ...audit() }];
  const revokedEvicted = revoked.length > REVOKED_LIMIT ? revoked.shift() : null;
  const manifest = projectManifestFromHistory(history, revoked, new Date().toISOString());
  assertManifestInvariants(manifest, retentionLimit);
  await putManifest(s3, bucket, manifest);
  const verified = await getManifest(s3, bucket);
  assertManifestInvariants(verified, retentionLimit);
  const deletedObjects = await pruneUnpinned(s3, bucket, new Set(verified.history.map((x) => x.sha256)));
  console.log(JSON.stringify({ event: "rollback", sha256: current.sha256, rolledBackTo: target.sha256, reason: reason.trim(), revokedEvicted, deletedObjects, ...audit() }, null, 2));
  return { status: "rolled_back", manifest: verified, revokedEvicted, deletedObjects };
}

export async function unrevokeSha(s3, bucket, sha, retentionLimit = 5) {
  validateSha(sha);
  const current = await getManifest(s3, bucket);
  assertManifestInvariants(current, retentionLimit);
  if (current.history.some((x) => x.sha256 === sha)) throw new Error(`Cannot unrevoke active/history SHA: ${sha}`);
  const revoked = current.revoked ?? [];
  if (!revoked.some((x) => x.sha256 === sha)) {
    console.warn(JSON.stringify({ event: "unrevoke_noop", sha256: sha, ...audit() }));
    return { status: "not_revoked", put: false, manifest: current };
  }
  const manifest = projectManifestFromHistory(current.history, revoked.filter((x) => x.sha256 !== sha), new Date().toISOString());
  assertManifestInvariants(manifest, retentionLimit);
  await putManifest(s3, bucket, manifest);
  const verified = await getManifest(s3, bucket);
  assertManifestInvariants(verified, retentionLimit);
  console.log(JSON.stringify({ event: "unrevoke", sha256: sha, ...audit() }));
  return { status: "unrevoked", put: true, manifest: verified };
}
