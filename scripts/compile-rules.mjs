#!/usr/bin/env node
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { domainToASCII } from "node:url";
import { resolve } from "node:path";
import {
  ALLOW_FLAG,
  EDNS_FORMAT_VERSION,
  EDNS_HEADER_BYTES,
  EDNS_MAGIC,
  OFFSET_MASK,
  validateEdnsV1Buffer,
} from "../src/rules-binary-format.ts";
import {
  RULE_SHARD_ALGORITHM,
  RULE_SHARD_COUNT,
  shardIdForRuleDomain,
} from "../src/rules-sharding.ts";

const ROOT = resolve(process.cwd());
const OUT_DIR = resolve(process.env.RULES_OUT_DIR || "dist/rules");
const BLOCK_FILE = resolve(process.env.BLOCKLIST_FILE || "rules/blocklists.txt");
const ALLOW_FILE = resolve(process.env.ALLOWLIST_FILE || "rules/allowlists.txt");
const MIN_RULES = Number(process.env.MIN_RULES || 1000);
const CRITICAL = [
  "cloudflare-dns.com",
  "dns.google",
  "github.com",
  "google.com",
  "example.com",
];

function normalizeDomain(raw) {
  let value = raw.trim().toLowerCase();
  if (!value || value.startsWith("#") || value.startsWith("!")) return null;
  value = value.replace(/\.$/, "");
  const ascii = domainToASCII(value);
  if (!ascii || ascii.length > 253) {
    throw new Error(`Invalid domain: ${raw}`);
  }
  if (!/^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)*$/i.test(ascii)) {
    throw new Error(`Invalid domain: ${raw}`);
  }
  return ascii;
}

async function readRules(path, target) {
  const text = await readFile(path, "utf8");
  let count = 0;
  for (const line of text.split(/\r?\n/)) {
    const domain = normalizeDomain(line);
    if (!domain) continue;
    target.add(domain);
    count++;
  }
  return count;
}

function compareBytes(a, b) {
  return Buffer.from(a).compare(Buffer.from(b));
}

function buildBinary(effective) {
  const rules = [...effective.keys()].sort(compareBytes);
  const encoded = rules.map((domain) => Buffer.from(domain, "ascii"));
  const poolBytes = encoded.reduce((n, b) => n + b.length, 0);

  if (rules.length > OFFSET_MASK || poolBytes > OFFSET_MASK) {
    throw new Error("Rule table exceeds 30-bit offset format");
  }

  const indexBytes = (rules.length + 1) * 4;
  const buffer = Buffer.allocUnsafe(EDNS_HEADER_BYTES + indexBytes + poolBytes);

  buffer.writeUInt32LE(EDNS_MAGIC, 0);
  buffer.writeUInt16LE(EDNS_FORMAT_VERSION, 4);
  buffer.writeUInt16LE(0, 6);
  buffer.writeUInt32LE(rules.length, 8);
  buffer.writeUInt32LE(poolBytes, 12);

  let offset = 0;
  for (let i = 0; i < rules.length; i++) {
    const action = effective.get(rules[i]) === "ALLOW" ? ALLOW_FLAG : 0;
    buffer.writeUInt32LE(action | offset, EDNS_HEADER_BYTES + i * 4);
    encoded[i].copy(buffer, EDNS_HEADER_BYTES + indexBytes + offset);
    offset += encoded[i].length;
  }
  buffer.writeUInt32LE(offset, EDNS_HEADER_BYTES + rules.length * 4);

  return { buffer, rules, poolBytes };
}

function buildShardArtifacts(effective, snapshotSha256) {
  const groups = new Map();
  const global = new Map();

  for (const [domain, action] of effective) {
    const shardId = shardIdForRuleDomain(domain);
    const target = shardId === "global"
      ? global
      : (groups.get(shardId) ?? new Map());
    target.set(domain, action);
    if (shardId !== "global" && !groups.has(shardId)) groups.set(shardId, target);
  }

  const output = [];
  const descriptorFor = (id, entries) => {
    const { buffer } = buildBinary(entries);
    const validated = validateEdnsV1Buffer(buffer);
    const sha256 = createHash("sha256").update(validated.bytes).digest("hex");
    const object = `shards/${id}-${sha256}.bin`;
    return {
      descriptor: {
        key: `compiled/shards/${snapshotSha256}/${id}-${sha256}.bin`,
        sha256,
        rules: validated.count,
        binaryBytes: validated.bytes.byteLength,
        object,
      },
      bytes: validated.bytes,
    };
  };

  const globalArtifact = global.size
    ? descriptorFor("global", global)
    : null;
  if (globalArtifact) output.push(globalArtifact);

  const entries = {};
  for (const shardId of [...groups.keys()].sort()) {
    const artifact = descriptorFor(shardId, groups.get(shardId));
    entries[shardId] = artifact.descriptor;
    output.push(artifact);
  }

  const totalShardRules = (globalArtifact?.descriptor.rules ?? 0)
    + Object.values(entries).reduce((sum, entry) => sum + entry.rules, 0);
  if (totalShardRules !== effective.size) {
    throw new Error(`Shard partition mismatch: expected ${effective.size}, got ${totalShardRules}`);
  }

  return {
    metadata: {
      format: "EDNS-v1-sharded",
      algorithm: RULE_SHARD_ALGORITHM,
      shardCount: RULE_SHARD_COUNT,
      global: globalArtifact?.descriptor ?? null,
      entries,
    },
    artifacts: output,
  };
}

function evaluateForCanary(domain, effective) {
  let candidate = domain;
  while (true) {
    const action = effective.get(candidate);
    if (action) return action;
    const dot = candidate.indexOf(".");
    if (dot < 0) return "PASS";
    candidate = candidate.slice(dot + 1);
  }
}

async function main() {
  const block = new Set();
  const allow = new Set();
  await readRules(BLOCK_FILE, block);
  await readRules(ALLOW_FILE, allow);

  const effective = new Map();
  for (const domain of block) effective.set(domain, "BLOCK");
  for (const domain of allow) effective.set(domain, "ALLOW");

  if (effective.size < MIN_RULES) {
    throw new Error(`Canary failed: only ${effective.size} effective rules; minimum is ${MIN_RULES}`);
  }

  const blockedCritical = CRITICAL.filter((domain) => evaluateForCanary(domain, effective) === "BLOCK");
  if (blockedCritical.length) {
    throw new Error(`Canary failed: critical domains would be BLOCKED: ${blockedCritical.join(", ")}`);
  }

  const { buffer, rules, poolBytes } = buildBinary(effective);
  const validated = validateEdnsV1Buffer(buffer);
  if (validated.count !== rules.length) {
    throw new Error(`Compiled rule count mismatch: binary=${validated.count}, source=${rules.length}`);
  }

  const sha256 = createHash("sha256").update(validated.bytes).digest("hex");
  const fileName = `rules-${sha256}.bin`;
  const sharded = buildShardArtifacts(effective, sha256);

  await mkdir(OUT_DIR, { recursive: true });
  await mkdir(resolve(OUT_DIR, "shards"), { recursive: true });
  await writeFile(resolve(OUT_DIR, fileName), validated.bytes);
  for (const artifact of sharded.artifacts) {
    await writeFile(resolve(OUT_DIR, artifact.descriptor.object), artifact.bytes);
  }

  const shardDescriptors = [
    ...(sharded.metadata.global ? [sharded.metadata.global] : []),
    ...Object.values(sharded.metadata.entries),
  ];
  const shardSizes = shardDescriptors.map((entry) => entry.binaryBytes);

  const stats = {
    format: "EDNS-v1",
    sha256,
    rules: rules.length,
    allowRules: [...effective.values()].filter((v) => v === "ALLOW").length,
    blockRules: [...effective.values()].filter((v) => v === "BLOCK").length,
    poolBytes,
    binaryBytes: validated.bytes.byteLength,
    sharding: {
      algorithm: RULE_SHARD_ALGORITHM,
      shardCount: RULE_SHARD_COUNT,
      nonEmptyShardCount: Object.keys(sharded.metadata.entries).length,
      globalRules: sharded.metadata.global?.rules ?? 0,
      shardObjectCount: shardDescriptors.length,
      totalShardBinaryBytes: shardSizes.reduce((sum, bytes) => sum + bytes, 0),
      maxShardBinaryBytes: shardSizes.length ? Math.max(...shardSizes) : 0,
    },
    sources: {
      blocklist: BLOCK_FILE.replace(ROOT + "/", ""),
      allowlist: ALLOW_FILE.replace(ROOT + "/", ""),
    },
    canary: { status: "pass", critical: CRITICAL },
    generatedAt: new Date().toISOString(),
  };

  await writeFile(resolve(OUT_DIR, `stats-${sha256}.json`), JSON.stringify(stats, null, 2) + "\n");
  await writeFile(resolve(OUT_DIR, "latest.json"), JSON.stringify({
    format: "EDNS-v1",
    version: sha256,
    sha256,
    key: `compiled/${fileName}`,
    object: fileName,
    stats: `stats-${sha256}.json`,
    rules: rules.length,
    generatedAt: stats.generatedAt,
    shards: sharded.metadata,
  }, null, 2) + "\n");

  console.log(JSON.stringify(stats, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
