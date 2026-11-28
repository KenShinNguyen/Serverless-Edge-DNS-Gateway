import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  assertManifestInvariants,
  projectManifestFromHistory,
  rollbackSnapshot,
  unrevokeSha,
} from "../scripts/r2-state.mjs";

function entry(sha, rules = 1) {
  return {
    sha256: sha,
    key: `compiled/rules-${sha}.bin`,
    stats: `compiled/stats-${sha}.json`,
    rules,
    version: `v-${sha.slice(0, 4)}`,
    generatedAt: "2026-11-23T00:00:00.000Z",
  };
}
function revoked(sha) {
  return {
    sha256: sha,
    revokedAt: "2026-11-23T01:00:00.000Z",
    reason: "test",
    rolledBackTo: "d".repeat(64),
    actor: "test",
    runId: "1",
    runAttempt: "1",
    eventName: "workflow_dispatch",
  };
}
function manifest(history, revokedList = []) {
  return projectManifestFromHistory(history, revokedList, "2026-11-23T02:00:00.000Z");
}
function shardMetadata(snapshotSha, shardSha, bytes = 35) {
  return {
    format: "EDNS-v1-sharded",
    algorithm: "fnv1a32-last-two-labels-v1",
    shardCount: 256,
    global: null,
    entries: {
      "2a": {
        key: `compiled/shards/${snapshotSha}/2a-${shardSha}.bin`,
        sha256: shardSha,
        rules: 1,
        binaryBytes: bytes,
        object: `shards/2a-${shardSha}.bin`,
      },
    },
  };
}
function binary() {
  const domain = Buffer.from("example.com");
  const out = Buffer.alloc(16 + 8 + domain.length);
  out.writeUInt32LE(0x534e4445, 0);
  out.writeUInt16LE(1, 4);
  out.writeUInt32LE(1, 8);
  out.writeUInt32LE(domain.length, 12);
  out.writeUInt32LE(0, 16);
  out.writeUInt32LE(domain.length, 20);
  domain.copy(out, 24);
  return out;
}
function mockR2(objects = new Map()) {
  const calls = [];
  return {
    calls,
    objects,
    async send(command) {
      calls.push(command);
      const name = command.constructor.name;
      const key = command.input.Key;
      if (name === "GetObjectCommand") {
        if (!objects.has(key)) {
          const e = new Error("NotFound");
          e.name = "NotFound";
          e.$metadata = { httpStatusCode: 404 };
          throw e;
        }
        const bytes = Buffer.from(objects.get(key));
        return {
          Body: {
            transformToString: async () => bytes.toString("utf8"),
            transformToByteArray: async () => new Uint8Array(bytes),
          },
        };
      }
      if (name === "HeadObjectCommand") {
        if (!objects.has(key)) throw new Error("missing");
        return { ContentLength: Buffer.byteLength(objects.get(key)) };
      }
      if (name === "PutObjectCommand") {
        objects.set(key, Buffer.from(command.input.Body));
        return {};
      }
      if (name === "ListObjectsV2Command") {
        return { Contents: [...objects.keys()].map((Key) => ({ Key })) };
      }
      if (name === "DeleteObjectsCommand") {
        for (const item of command.input.Delete.Objects ?? []) objects.delete(item.Key);
        return {};
      }
      throw new Error(`Unsupported command: ${name}`);
    },
  };
}

const a = "a".repeat(64);
const b = "b".repeat(64);
const c = "c".repeat(64);
const e = "e".repeat(64);
const f = "f".repeat(64);

test("projectManifestFromHistory uses history[0] as the sole canonical source", () => {
  const head = entry(a, 123);
  const m = projectManifestFromHistory([head, entry(b)], [revoked(c)]);
  for (const field of ["sha256", "key", "stats", "rules", "version", "generatedAt"]) assert.equal(m[field], head[field]);
  assert.deepEqual(m.revoked.map((x) => x.sha256), [c]);
});

test("canonical mutation of top-level sha256 is rejected", () => {
  const m = manifest([entry(a)]);
  m.sha256 = b;
  assert.throws(() => assertManifestInvariants(m), /Manifest invariant failed/);
});
test("canonical mutation of top-level key is rejected", () => {
  const m = manifest([entry(a)]);
  m.key = `compiled/rules-${b}.bin`;
  assert.throws(() => assertManifestInvariants(m), /Manifest invariant failed/);
});
test("canonical mutation of top-level stats is rejected", () => {
  const m = manifest([entry(a)]);
  m.stats = `compiled/stats-${b}.json`;
  assert.throws(() => assertManifestInvariants(m), /Manifest invariant failed/);
});
test("canonical mutation of top-level rules is rejected", () => {
  const m = manifest([entry(a, 123)]);
  m.rules = 124;
  assert.throws(() => assertManifestInvariants(m), /Manifest invariant failed/);
});
test("canonical mutation of top-level version is rejected", () => {
  const m = manifest([entry(a)]);
  m.version = "mutated";
  assert.throws(() => assertManifestInvariants(m), /Manifest invariant failed/);
});
test("canonical mutation of top-level generatedAt is rejected", () => {
  const m = manifest([entry(a)]);
  m.generatedAt = "mutated";
  assert.throws(() => assertManifestInvariants(m), /Manifest invariant failed/);
});

test("canonical mutation inside history[0] is rejected", () => {
  for (const field of ["sha256", "key", "stats", "rules", "version", "generatedAt"]) {
    const m = manifest([entry(a)]);
    if (field === "sha256") m.history[0][field] = b;
    else if (field === "key") m.history[0][field] = `compiled/rules-${b}.bin`;
    else if (field === "stats") m.history[0][field] = `compiled/stats-${b}.json`;
    else if (field === "rules") m.history[0][field] = 2;
    else m.history[0][field] = "mutated";
    assert.throws(() => assertManifestInvariants(m), /Manifest invariant failed/);
  }
});

test("history and revoked intersection is a hard invariant", () => {
  assert.throws(() => assertManifestInvariants(manifest([entry(a)], [revoked(a)])), /intersect/);
});
test("duplicate revoked SHA is a hard invariant", () => {
  assert.throws(() => assertManifestInvariants(manifest([entry(a)], [revoked(b), revoked(b)])), /duplicate revoked/);
});
test("revoked is independently capped at five", () => {
  assert.throws(() => assertManifestInvariants(manifest([entry(a)], [revoked(b), revoked(c), revoked(e), revoked(f), revoked("1".repeat(64)), revoked("2".repeat(64))])), /at most 5/);
});

test("rollback previous reads target binary from R2 and never needs local build artifacts", async () => {
  const bytes = binary();
  const targetSha = createHash("sha256").update(bytes).digest("hex");
  const current = entry(e);
  const target = entry(targetSha);
  const objects = new Map([
    ["compiled/latest.json", Buffer.from(JSON.stringify(manifest([current, target])))],
    [target.key, bytes],
    [target.stats, Buffer.from("{}")],
  ]);
  const s3 = mockR2(objects);
  const result = await rollbackSnapshot(s3, "dns-compiled-rules", { targetSha: "previous", reason: "bad release" });
  assert.equal(result.status, "rolled_back");
  assert.equal(result.manifest.sha256, targetSha);
  assert.equal(result.manifest.revoked[0].sha256, e);
  assert.equal(s3.calls.filter((x) => x.constructor.name === "PutObjectCommand").length, 1);
});

test("rollback explicit target skips intermediate versions", async () => {
  const bytes = binary();
  const targetSha = createHash("sha256").update(bytes).digest("hex");
  const current = entry(e);
  const middle = entry(f);
  const target = entry(targetSha);
  const objects = new Map([
    ["compiled/latest.json", Buffer.from(JSON.stringify(manifest([current, middle, target, entry(c)])))],
    [target.key, bytes],
    [target.stats, Buffer.from("{}")],
  ]);
  const result = await rollbackSnapshot(mockR2(objects), "dns-compiled-rules", { targetSha, reason: "jump back" });
  assert.deepEqual(result.manifest.history.map((x) => x.sha256), [targetSha, f, c]);
});

test("rollback rejects binary with SHA mismatch", async () => {
  const target = entry(a);
  const current = entry(e);
  const objects = new Map([
    ["compiled/latest.json", Buffer.from(JSON.stringify(manifest([current, target])))],
    [target.key, binary()],
    [target.stats, Buffer.from("{}")],
  ]);
  await assert.rejects(() => rollbackSnapshot(mockR2(objects), "dns-compiled-rules", { targetSha: a, reason: "test" }), /SHA mismatch/);
});

test("rollback rejects binary rule-count mismatch", async () => {
  const bytes = binary();
  const sha = createHash("sha256").update(bytes).digest("hex");
  const target = entry(sha, 2);
  const current = entry(e);
  const objects = new Map([
    ["compiled/latest.json", Buffer.from(JSON.stringify(manifest([current, target])))],
    [target.key, bytes],
    [target.stats, Buffer.from("{}")],
  ]);
  await assert.rejects(() => rollbackSnapshot(mockR2(objects), "dns-compiled-rules", { targetSha: sha, reason: "test" }), /rule count mismatch/);
});

test("rollback rejects empty target stats", async () => {
  const bytes = binary();
  const sha = createHash("sha256").update(bytes).digest("hex");
  const target = entry(sha);
  const current = entry(e);
  const objects = new Map([
    ["compiled/latest.json", Buffer.from(JSON.stringify(manifest([current, target])))],
    [target.key, bytes],
    [target.stats, Buffer.alloc(0)],
  ]);
  await assert.rejects(() => rollbackSnapshot(mockR2(objects), "dns-compiled-rules", { targetSha: sha, reason: "test" }), /stats missing\/empty/);
});

test("unrevoke rejects a SHA that is still in history", async () => {
  const s3 = mockR2(new Map([["compiled/latest.json", Buffer.from(JSON.stringify(manifest([entry(a)])))] ]));
  await assert.rejects(() => unrevokeSha(s3, "dns-compiled-rules", a), /active\/history SHA/);
  assert.equal(s3.calls.filter((x) => x.constructor.name === "PutObjectCommand").length, 0);
});

test("unrevoke absent SHA exits cleanly without PUT", async () => {
  const s3 = mockR2(new Map([["compiled/latest.json", Buffer.from(JSON.stringify(manifest([entry(a)], [revoked(b)])))] ]));
  const result = await unrevokeSha(s3, "dns-compiled-rules", c);
  assert.equal(result.status, "not_revoked");
  assert.equal(result.put, false);
  assert.equal(s3.calls.filter((x) => x.constructor.name === "PutObjectCommand").length, 0);
});

test("unrevoke removes a revoked SHA and verifies the new manifest", async () => {
  const s3 = mockR2(new Map([["compiled/latest.json", Buffer.from(JSON.stringify(manifest([entry(a)], [revoked(b)])))] ]));
  const result = await unrevokeSha(s3, "dns-compiled-rules", b);
  assert.equal(result.status, "unrevoked");
  assert.deepEqual(result.manifest.revoked, []);
  assert.equal(s3.calls.filter((x) => x.constructor.name === "PutObjectCommand").length, 1);
});

test("rollback sixth time evicts revoked FIFO oldest record", async () => {
  const bytes = binary();
  const targetSha = createHash("sha256").update(bytes).digest("hex");
  const current = entry(e);
  const target = entry(targetSha);
  const revokedList = [a, b, c, f, "1".repeat(64)].map(revoked);
  const objects = new Map([
    ["compiled/latest.json", Buffer.from(JSON.stringify(manifest([current, target], revokedList)))],
    [target.key, bytes],
    [target.stats, Buffer.from("{}")],
  ]);
  const result = await rollbackSnapshot(mockR2(objects), "dns-compiled-rules", { targetSha, reason: "sixth rollback" });
  assert.equal(result.revokedEvicted.sha256, a);
  assert.deepEqual(result.manifest.revoked.map((x) => x.sha256), [b, c, f, "1".repeat(64), e]);
});


test("sharded manifests preserve shard metadata and enforce canonical shard keys", () => {
  const head = { ...entry(a), shards: shardMetadata(a, b, 35) };
  const m = manifest([head, entry(c)]);
  assert.deepEqual(m.shards, head.shards);
  assertManifestInvariants(m);

  const corrupted = structuredClone(m);
  corrupted.shards.entries["2a"].key = `compiled/shards/${a}/wrong.bin`;
  assert.throws(() => assertManifestInvariants(corrupted), /invalid .* descriptor fields/);
});

test("projectManifestFromHistory carries the shard index from the rollback target", async () => {
  const bytes = binary();
  const targetSha = createHash("sha256").update(bytes).digest("hex");
  const target = {
    ...entry(targetSha),
    shards: shardMetadata(targetSha, targetSha, bytes.byteLength),
  };
  const current = entry(e);
  const shardKey = target.shards.entries["2a"].key;
  const objects = new Map([
    ["compiled/latest.json", Buffer.from(JSON.stringify(manifest([current, target])))],
    [target.key, bytes],
    [target.stats, Buffer.from("{}")],
    [shardKey, bytes],
  ]);

  const s3 = mockR2(objects);
  const result = await rollbackSnapshot(s3, "dns-compiled-rules", {
    targetSha: "previous",
    reason: "verify shard-aware rollback",
  });
  assert.equal(result.status, "rolled_back");
  assert.deepEqual(result.manifest.shards, target.shards);
  assert.ok(
    s3.calls.some((command) =>
      command.constructor.name === "GetObjectCommand" && command.input.Key === shardKey
    ),
    "rollback must verify every target shard before switching latest.json",
  );
});

test("rollback refuses a target snapshot when one of its shard objects is corrupt", async () => {
  const bytes = binary();
  const targetSha = createHash("sha256").update(bytes).digest("hex");
  const target = {
    ...entry(targetSha),
    shards: shardMetadata(targetSha, targetSha, bytes.byteLength),
  };
  const current = entry(e);
  const shardKey = target.shards.entries["2a"].key;
  const corrupt = Buffer.from(bytes);
  corrupt[corrupt.length - 1] ^= 0xff;
  const objects = new Map([
    ["compiled/latest.json", Buffer.from(JSON.stringify(manifest([current, target])))],
    [target.key, bytes],
    [target.stats, Buffer.from("{}")],
    [shardKey, corrupt],
  ]);

  await assert.rejects(
    () => rollbackSnapshot(mockR2(objects), "dns-compiled-rules", {
      targetSha: "previous",
      reason: "reject damaged shard",
    }),
    /Shard SHA mismatch/,
  );
});
