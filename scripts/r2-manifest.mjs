export const LATEST_KEY = "compiled/latest.json";
export const REVOKED_LIMIT = 5;

const SHA_RE = /^[0-9a-f]{64}$/;

export function validateSha(sha) {
  if (!SHA_RE.test(sha)) throw new Error(`Invalid SHA-256: ${sha}`);
}

export function assertRules(rules, label) {
  if (!Number.isInteger(rules) || rules < 0) {
    throw new Error(`Invalid rule count in ${label}: ${rules}`);
  }
}

export function expectedKey(sha) {
  return `compiled/rules-${sha}.bin`;
}

export function expectedStats(sha) {
  return `compiled/stats-${sha}.json`;
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
  if (!Array.isArray(manifest.history) || manifest.history.length < 1 || manifest.history.length > retentionLimit) {
    fail(`history length must be within 1..${retentionLimit}`);
  }

  const historyShas = new Set();
  for (let i = 0; i < manifest.history.length; i++) {
    const entry = manifest.history[i];
    if (!entry || !SHA_RE.test(entry.sha256)) fail(`invalid history[${i}].sha256`);
    if (historyShas.has(entry.sha256)) fail(`duplicate history sha256 ${entry.sha256}`);
    if (entry.key !== expectedKey(entry.sha256)) fail(`invalid history[${i}].key`);
    if (entry.stats !== expectedStats(entry.sha256)) fail(`invalid history[${i}].stats`);
    assertRules(entry.rules, `history[${i}]`);
    if (typeof entry.version !== "string" || !entry.version) fail(`invalid history[${i}].version`);
    if (typeof entry.generatedAt !== "string" || !entry.generatedAt) fail(`invalid history[${i}].generatedAt`);
    historyShas.add(entry.sha256);
  }

  const head = manifest.history[0];
  for (const field of ["sha256", "key", "stats", "rules", "version", "generatedAt"]) {
    if (manifest[field] !== head[field]) fail(`top-level ${field} does not match history[0]`);
  }

  const revoked = manifest.revoked ?? [];
  if (!Array.isArray(revoked) || revoked.length > REVOKED_LIMIT) {
    fail(`revoked must contain at most ${REVOKED_LIMIT} entries`);
  }
  const revokedShas = new Set();
  for (let i = 0; i < revoked.length; i++) {
    const entry = revoked[i];
    if (!entry || !SHA_RE.test(entry.sha256)) fail(`invalid revoked[${i}].sha256`);
    if (revokedShas.has(entry.sha256)) fail(`duplicate revoked sha256 ${entry.sha256}`);
    if (historyShas.has(entry.sha256)) fail(`history and revoked intersect on ${entry.sha256}`);
    if (typeof entry.revokedAt !== "string" || !entry.revokedAt) fail(`invalid revoked[${i}].revokedAt`);
    if (typeof entry.reason !== "string" || !entry.reason) fail(`invalid revoked[${i}].reason`);
    revokedShas.add(entry.sha256);
  }
}
