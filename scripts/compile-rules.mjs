#!/usr/bin/env node
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { domainToASCII } from "node:url";
import { resolve } from "node:path";

const MAGIC = Buffer.from("EDNS");
const VERSION = 1;
const OFFSET_MASK = 0x3fffffff;
const ALLOW_FLAG = 0x40000000;

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
  const buffer = Buffer.allocUnsafe(16 + indexBytes + poolBytes);

  MAGIC.copy(buffer, 0);
  buffer.writeUInt16LE(VERSION, 4);
  buffer.writeUInt16LE(0, 6);
  buffer.writeUInt32LE(rules.length, 8);
  buffer.writeUInt32LE(poolBytes, 12);

  let offset = 0;
  for (let i = 0; i < rules.length; i++) {
    const action = effective.get(rules[i]) === "ALLOW" ? ALLOW_FLAG : 0;
    buffer.writeUInt32LE(action | offset, 16 + i * 4);
    encoded[i].copy(buffer, 16 + indexBytes + offset);
    offset += encoded[i].length;
  }
  buffer.writeUInt32LE(offset, 16 + rules.length * 4);

  return { buffer, rules, poolBytes };
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

  // Deterministic policy: ALLOW wins at the same domain.
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
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  const fileName = `rules-${sha256}.bin`;

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(resolve(OUT_DIR, fileName), buffer);

  const stats = {
    format: "EDNS-v1",
    sha256,
    rules: rules.length,
    allowRules: [...effective.values()].filter((v) => v === "ALLOW").length,
    blockRules: [...effective.values()].filter((v) => v === "BLOCK").length,
    poolBytes,
    binaryBytes: buffer.length,
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
    ruleCount: rules.length,
    rules: rules.length,
    generatedAt: stats.generatedAt,
  }, null, 2) + "\n");

  console.log(JSON.stringify(stats, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
