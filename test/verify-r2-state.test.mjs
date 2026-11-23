import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { verifyAllHistoryStrict, verifyR2State } from "../scripts/verify-r2-state.mjs";
import { projectManifestFromHistory } from "../scripts/r2-state.mjs";

function entry(sha, rules = 1) {
  return {
    sha256: sha,
    key: `compiled/rules-${sha}.bin`,
    stats: `compiled/stats-${sha}.json`,
    rules,
    version: "v1",
    generatedAt: "2026-11-23T00:00:00.000Z",
  };
}
function binary(domainName = "example.com") {
  const domain = Buffer.from(domainName);
  const out = Buffer.alloc(24 + domain.length);
  out.writeUInt32LE(0x534e4445, 0);
  out.writeUInt16LE(1, 4);
  out.writeUInt32LE(1, 8);
  out.writeUInt32LE(domain.length, 12);
  out.writeUInt32LE(0, 16);
  out.writeUInt32LE(domain.length, 20);
  domain.copy(out, 24);
  return out;
}
function mockR2(objects) {
  const calls = [];
  return {
    calls,
    async send(command) {
      calls.push(command);
      const name = command.constructor.name;
      const key = command.input.Key;
      if (!objects.has(key)) {
        const e = new Error("NotFound");
        e.name = "NotFound";
        e.$metadata = { httpStatusCode: 404 };
        throw e;
      }
      if (name === "GetObjectCommand") {
        const value = Buffer.from(objects.get(key));
        return {
          Body: {
            transformToByteArray: async () => new Uint8Array(value),
            transformToString: async () => value.toString("utf8"),
          },
        };
      }
      if (name === "HeadObjectCommand") {
        return { ContentLength: Buffer.byteLength(objects.get(key)) };
      }
      throw new Error(`Unsupported command: ${name}`);
    },
  };
}

const bytes = binary();
const sha = createHash("sha256").update(bytes).digest("hex");
const history = [entry(sha)];
const manifest = projectManifestFromHistory(history, []);

function objectsFor(m = manifest) {
  return new Map([
    ["compiled/latest.json", Buffer.from(JSON.stringify(m))],
    [m.history[0].key, bytes],
    [m.history[0].stats, Buffer.from(JSON.stringify({ sha256: m.sha256, rules: m.rules }))],
  ]);
}

test("strict verifier passes a complete valid state", async () => {
  const s3 = mockR2(objectsFor());
  const result = await verifyAllHistoryStrict(s3, "bucket", manifest);
  assert.equal(result.status, "PASS");
  assert.equal(result.historyCount, 1);
});

test("strict verifier fails when history binary is 404", async () => {
  const objects = objectsFor();
  objects.delete(history[0].key);
  await assert.rejects(() => verifyAllHistoryStrict(mockR2(objects), "bucket", manifest), /404|NotFound|missing/);
});

test("strict verifier fails when history stats is 404", async () => {
  const objects = objectsFor();
  objects.delete(history[0].stats);
  await assert.rejects(() => verifyAllHistoryStrict(mockR2(objects), "bucket", manifest), /404|NotFound|missing/);
});

test("strict verifier fails when history binary is zero-byte", async () => {
  const objects = objectsFor();
  objects.set(history[0].key, Buffer.alloc(0));
  await assert.rejects(() => verifyAllHistoryStrict(mockR2(objects), "bucket", manifest), /empty/);
});

test("strict verifier fails on binary SHA mismatch", async () => {
  const objects = objectsFor();
  objects.set(history[0].key, binary("example.org"));
  await assert.rejects(() => verifyAllHistoryStrict(mockR2(objects), "bucket", manifest), /SHA mismatch/);
});

test("strict verifier fails on binary rule-count mismatch", async () => {
  const badManifest = projectManifestFromHistory([entry(sha, 2)], []);
  await assert.rejects(() => verifyAllHistoryStrict(mockR2(objectsFor(badManifest)), "bucket", badManifest), /rule count mismatch/);
});

test("strict verifier fails on corrupt EDNS binary", async () => {
  const objects = objectsFor();
  objects.set(history[0].key, Buffer.from("not-edns"));
  await assert.rejects(() => verifyAllHistoryStrict(mockR2(objects), "bucket", manifest), /EDNS|invalid|header|binary/i);
});

test("strict verifier fails when active stats JSON is malformed", async () => {
  const objects = objectsFor();
  objects.set(history[0].stats, Buffer.from("{"));
  await assert.rejects(() => verifyAllHistoryStrict(mockR2(objects), "bucket", manifest), /JSON|Unexpected/);
});

test("strict verifier fails when active stats sha256 disagrees", async () => {
  const objects = objectsFor();
  objects.set(history[0].stats, Buffer.from(JSON.stringify({ sha256: "0".repeat(64), rules: 1 })));
  await assert.rejects(() => verifyAllHistoryStrict(mockR2(objects), "bucket", manifest), /stats sha256 mismatch/);
});

test("strict verifier fails when active stats rules disagrees", async () => {
  const objects = objectsFor();
  objects.set(history[0].stats, Buffer.from(JSON.stringify({ sha256: sha, rules: 2 })));
  await assert.rejects(() => verifyAllHistoryStrict(mockR2(objects), "bucket", manifest), /stats rules mismatch/);
});

test("verifyR2State fails closed when latest.json is absent", async () => {
  await assert.rejects(() => verifyR2State(mockR2(new Map()), "bucket"), /latest\.json does not exist/);
});

test("strict verifier is read-only and never sends PUT or DELETE commands", async () => {
  const s3 = mockR2(objectsFor());
  await verifyAllHistoryStrict(s3, "bucket", manifest);
  const names = s3.calls.map((command) => command.constructor.name);
  assert.ok(names.every((name) => name === "GetObjectCommand" || name === "HeadObjectCommand"));
});
