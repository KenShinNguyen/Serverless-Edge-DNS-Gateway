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
  assertRules,
  expectedKey,
  expectedStats,
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
    publishedAt,
    history: [...history],
    revoked: [...revoked],
  };
}

export function assertManifestInvariants(manifest, retentionLimit = 5) {
  const fail = (message) => { throw new Error(`Manifest invariant failed: ${message}`); };
  if (!manifest || typeof manifest !== "object" || manifest.format !== "EDNS-v1") fail("format must be EDNS-v1");
  if (!Number.isSafeInteger(retentionLimit) || retentionLimit < 1) fail("invalid retentionLimit");
  if (!SHA_RE.test(manifest.sha256)) fail("invalid top-level sha256");
  if (manifest.key !== expectedKey(manifest.sha256)) fail("invalid top-level key");
  if (manifest.stats !== expectedStats(manifest.sha256)) fail("invalid top-level stats");
  assertRules(manifest.rules, "manifest");
  if (typeof manifest.version !== "string" || !manifest.version) fail("version must be non-empty");
  if (typeof manifest.generatedAt !== "string" || !manifest.generatedAt) fail("generatedAt must be non-empty");
  if (!Array.isArray(manifest.history) || manifest.history.length < 1 || manifest.history.length > retentionLimit) fail(`history length must be within 1..${retentionLimit}`);
  const historyShas = new Set();
  for (let i = 0; i < manifest.history.length; i++) {
    const e = manifest.history[i];
    if (!e || !SHA_RE.test(e.sha256)) fail(`invalid history[${i}].sha256`);
    if (historyShas.has(e.sha256)) fail(`duplicate history sha256 ${e.sha256}`);
    if (e.key !== expectedKey(e.sha256)) fail(`invalid history[${i}].key`);
    if (e.stats !== expectedStats(e.sha256)) fail(`invalid history[${i}].stats`);
    assertRules(e.rules, `history[${i}]`);
    if (typeof e.version !== "string" || !e.version) fail(`invalid history[${i}].version`);
    if (typeof e.generatedAt !== "string" || !e.generatedAt) fail(`invalid history[${i}].generatedAt`);
    historyShas.add(e.sha256);
  }
  const head = manifest.history[0];
  for (const field of ["sha256", "key", "stats", "rules", "version", "generatedAt"]) {
    if (manifest[field] !== head[field]) fail(`top-level ${field} does not match history[0]`);
  }
  const revoked = manifest.revoked ?? [];
  if (!Array.isArray(revoked) || revoked.length > REVOKED_LIMIT) fail(`revoked must contain at most ${REVOKED_LIMIT} entries`);
  const revokedShas = new Set();
  for (let i = 0; i < revoked.length; i++) {
    const r = revoked[i];
    if (!r || !SHA_RE.test(r.sha256)) fail(`invalid revoked[${i}].sha256`);
    if (revokedShas.has(r.sha256)) fail(`duplicate revoked sha256 ${r.sha256}`);
    if (historyShas.has(r.sha256)) fail(`history and revoked intersect on ${r.sha256}`);
    if (typeof r.revokedAt !== "string" || !r.revokedAt) fail(`invalid revoked[${i}].revokedAt`);
    if (typeof r.reason !== "string" || !r.reason) fail(`invalid revoked[${i}].reason`);
    revokedShas.add(r.sha256);
  }
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
