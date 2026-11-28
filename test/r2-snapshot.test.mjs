import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ZeroCopyRuleTable, RuleSnapshotManager } from "../src/rules-engine.ts";

function buildRules(entries) {
  const sorted = [...entries].sort((a, b) => Buffer.from(a[0]).compare(Buffer.from(b[0])));
  const pool = Buffer.concat(sorted.map(([domain]) => Buffer.from(domain)));
  const buffer = new ArrayBuffer(16 + (sorted.length + 1) * 4 + pool.length);
  const view = new DataView(buffer);
  view.setUint32(0, 0x534e4445, true);
  view.setUint16(4, 1, true);
  view.setUint32(8, sorted.length, true);
  view.setUint32(12, pool.length, true);

  let offset = 0;
  for (let i = 0; i < sorted.length; i++) {
    const [domain, action] = sorted[i];
    view.setUint32(16 + i * 4, (action === "ALLOW" ? 0x40000000 : 0) | offset, true);
    new Uint8Array(buffer, 16 + (sorted.length + 1) * 4 + offset, domain.length)
      .set(Buffer.from(domain));
    offset += domain.length;
  }
  view.setUint32(16 + sorted.length * 4, offset, true);
  return buffer;
}

function manifestFor(buffer, version) {
  const sha256 = createHash("sha256").update(Buffer.from(buffer)).digest("hex");
  return {
    version,
    sha256,
    key: `compiled/rules-${sha256}.bin`,
    rules: 1,
    generatedAt: new Date().toISOString(),
  };
}

class MockR2 {
  objects = new Map();
  gets = [];
  async get(key) {
    this.gets.push(key);
    const value = this.objects.get(key);
    if (value === undefined) return null;
    if (key.endsWith(".json")) {
      return { json: async () => JSON.parse(value) };
    }
    return { arrayBuffer: async () => value.slice(0) };
  }
}

function ctx() {
  return { waitUntil(promise) { return promise; } };
}

test("cold-start concurrent evaluations use one R2 reload", async () => {
  const bucket = new MockR2();
  const buffer = buildRules([["ads.example.com", "BLOCK"]]);
  const manifest = manifestFor(buffer, "v1");
  bucket.objects.set("compiled/latest.json", JSON.stringify(manifest));
  bucket.objects.set(manifest.key, buffer);

  const manager = new RuleSnapshotManager();
  const results = await Promise.all(
    Array.from({ length: 30 }, () => manager.evaluate("ads.example.com", bucket, ctx()))
  );

  assert.deepEqual(new Set(results), new Set(["BLOCK"]));
  assert.equal(manager.getLoadedRuleCount(), 1);
  assert.equal(bucket.gets.filter((key) => key === "compiled/latest.json").length, 1);
  assert.equal(bucket.gets.filter((key) => key === manifest.key).length, 1);
});

test("empty bucket enters negative cooldown", async () => {
  const bucket = new MockR2();
  const manager = new RuleSnapshotManager();

  const first = await manager.evaluate("ads.example.com", bucket, ctx());
  assert.equal(first, "UNAVAILABLE");

  await Promise.all(
    Array.from({ length: 10 }, () => manager.evaluate("ads.example.com", bucket, ctx()))
  );

  assert.equal(bucket.gets.filter((key) => key === "compiled/latest.json").length, 1);
});

test("corrupt v2 rolls back to the active v1 snapshot", async () => {
  const bucket = new MockR2();
  const v1 = buildRules([["ads.example.com", "BLOCK"]]);
  const m1 = manifestFor(v1, "v1");
  bucket.objects.set("compiled/latest.json", JSON.stringify(m1));
  bucket.objects.set(m1.key, v1);

  const manager = new RuleSnapshotManager();
  assert.equal(await manager.evaluate("ads.example.com", bucket, ctx()), "BLOCK");
  assert.equal(manager.getLoadedVersion(), "v1");

  const v2 = buildRules([["ads.example.com", "ALLOW"]]);
  const m2 = manifestFor(v2, "v2");
  const corrupt = v2.slice(0);
  new Uint8Array(corrupt)[corrupt.byteLength - 1] ^= 0xff;

  bucket.objects.set("compiled/latest.json", JSON.stringify(m2));
  bucket.objects.set(m2.key, corrupt);

  manager.nextCheckAt = 0;
  const result = await manager.evaluate("ads.example.com", bucket, ctx());
  assert.equal(result, "BLOCK");
  assert.equal(manager.getLoadedVersion(), "v1");
});

test("unchanged manifest does not reload the binary", async () => {
  const bucket = new MockR2();
  const buffer = buildRules([["ads.example.com", "BLOCK"]]);
  const manifest = manifestFor(buffer, "v1");
  bucket.objects.set("compiled/latest.json", JSON.stringify(manifest));
  bucket.objects.set(manifest.key, buffer);

  const manager = new RuleSnapshotManager();
  assert.equal(await manager.evaluate("ads.example.com", bucket, ctx()), "BLOCK");
  const binaryGets = bucket.gets.filter((key) => key === manifest.key).length;

  assert.equal(await manager.evaluate("ads.example.com", bucket, ctx()), "BLOCK");
  assert.equal(bucket.gets.filter((key) => key === manifest.key).length, binaryGets);
});


test("manifest key must be canonical for its SHA before binary fetch", async () => {
  const bucket = new MockR2();
  const buffer = buildRules([["ads.example.com", "BLOCK"]]);
  const manifest = manifestFor(buffer, "v1");
  const wrongSha = "a".repeat(64);
  bucket.objects.set("compiled/latest.json", JSON.stringify({
    ...manifest,
    key: `compiled/rules-${wrongSha}.bin`,
  }));
  bucket.objects.set(manifest.key, buffer);
  bucket.objects.set(`compiled/rules-${wrongSha}.bin`, buffer);

  const manager = new RuleSnapshotManager();
  assert.equal(await manager.evaluate("ads.example.com", bucket, ctx()), "UNAVAILABLE");
  assert.deepEqual(bucket.gets, ["compiled/latest.json"]);
  assert.equal(manager.getHealth().status, "degraded");
});

test("manifest rejects an unsafe rule count before binary fetch", async () => {
  const bucket = new MockR2();
  const buffer = buildRules([["ads.example.com", "BLOCK"]]);
  const manifest = manifestFor(buffer, "v1");
  bucket.objects.set("compiled/latest.json", JSON.stringify({
    ...manifest,
    rules: Number.MAX_SAFE_INTEGER + 1,
  }));
  bucket.objects.set(manifest.key, buffer);

  const manager = new RuleSnapshotManager();
  assert.equal(await manager.evaluate("ads.example.com", bucket, ctx()), "PASS");
  assert.deepEqual(bucket.gets, ["compiled/latest.json"]);
  assert.equal(manager.getHealth().status, "degraded");
});

test("manifest rejects an empty version before binary fetch", async () => {
  const bucket = new MockR2();
  const buffer = buildRules([["ads.example.com", "BLOCK"]]);
  const manifest = manifestFor(buffer, "v1");
  bucket.objects.set("compiled/latest.json", JSON.stringify({
    ...manifest,
    version: "",
  }));
  bucket.objects.set(manifest.key, buffer);

  const manager = new RuleSnapshotManager();
  assert.equal(await manager.evaluate("ads.example.com", bucket, ctx()), "PASS");
  assert.deepEqual(bucket.gets, ["compiled/latest.json"]);
  assert.equal(manager.getHealth().status, "degraded");
});
