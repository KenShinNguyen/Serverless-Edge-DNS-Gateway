export const RULE_SHARD_COUNT = 256;
export const RULE_SHARD_ALGORITHM = "fnv1a32-last-two-labels-v1";
export const GLOBAL_RULE_SHARD = "global";

const SHARD_ID_RE = /^[0-9a-f]{2}$/;

/**
 * Assign rules by a hash of the final two labels. Every multi-label suffix
 * of a QNAME shares those same final two labels, so all suffix rules that
 * can match one QNAME are guaranteed to live in the same shard.
 *
 * Single-label rules are kept in the separate global table.
 */
export function shardIdForRuleDomain(domain: string): string {
  const normalized = normalizeDomain(domain);
  const labels = normalized.split(".");
  if (labels.length < 2) return GLOBAL_RULE_SHARD;
  return shardIdForSuffix(labels.slice(-2).join("."));
}

/** Return the shard needed to evaluate a QNAME. */
export function shardIdForQuery(qname: string): string {
  const normalized = normalizeDomain(qname);
  const labels = normalized.split(".");
  if (labels.length < 2) return GLOBAL_RULE_SHARD;
  return shardIdForSuffix(labels.slice(-2).join("."));
}

export function isRuleShardId(value: unknown): value is string {
  return typeof value === "string" && SHARD_ID_RE.test(value);
}

function normalizeDomain(value: string): string {
  if (typeof value !== "string") throw new Error("Domain must be a string");
  const normalized = value.trim().toLowerCase().replace(/\.$/, "");
  if (!normalized || normalized.length > 253 || /[^a-z0-9._-]/.test(normalized)) {
    throw new Error("Domain is not a normalized ASCII name");
  }
  const labels = normalized.split(".");
  if (labels.some((label) => !label || label.length > 63)) {
    throw new Error("Domain contains an invalid label");
  }
  return normalized;
}

function shardIdForSuffix(suffix: string): string {
  // FNV-1a 32-bit over ASCII bytes, then retain the low 8 bits.
  let hash = 0x811c9dc5;
  for (let i = 0; i < suffix.length; i++) {
    hash ^= suffix.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash & (RULE_SHARD_COUNT - 1)).toString(16).padStart(2, "0");
}
