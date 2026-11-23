import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRetainedVersions,
  isMissingObjectError,
  resolveRetentionLimit,
  verifyAndHealHistory,
  verifyNewlyPublishedPair,
} from "../scripts/publish-r2.mjs";

function entry(sha, version = sha.slice(0, 8), rules = 10) {
  return {
    sha256: sha,
    version,
    generatedAt: "2026-11-23T00:00:00.000Z",
    key: `compiled/rules-${sha}.bin`,
    stats: `compiled/stats-${sha}.json`,
    rules,
  };
}

const a = "a".repeat(64);
const b = "b".repeat(64);
const c = "c".repeat(64);
const d = "d".repeat(64);
const e = "e".repeat(64);
const f = "f".repeat(64);

test("retention is pinned by SHA, not LastModified", () => {
  const current = {
    sha256: a,
    version: "old-a",
    rules: 10,
    generatedAt: "2026-11-20T00:00:00.000Z",
    history: [entry(a, "old-a"), entry(b), entry(c), entry(d), entry(e)],
  };

  const retained = buildRetainedVersions(current, entry(a, "revert-a"), 5);
  assert.deepEqual(retained.map((x) => x.sha256), [a, b, c, d, e]);
});

test("retentionLimit=2 prunes to exactly two SHAs", () => {
  const current = {
    sha256: a,
    version: "a",
    rules: 10,
    history: [entry(a), entry(b), entry(c), entry(d)],
  };

  const retained = buildRetainedVersions(current, entry(f), 2);
  assert.deepEqual(retained.map((x) => x.sha256), [f, a]);
  assert.equal(retained.length, 2);
});

test("RETENTION_LIMIT resolver is deterministic and rejects invalid values", () => {
  assert.equal(resolveRetentionLimit(undefined), 5);
  assert.equal(resolveRetentionLimit("2"), 2);
  assert.equal(resolveRetentionLimit(" 7 "), 7);
  assert.throws(() => resolveRetentionLimit("abc"), /Invalid RETENTION_LIMIT/);
  assert.throws(() => resolveRetentionLimit("0"), /Invalid RETENTION_LIMIT/);
  assert.throws(() => resolveRetentionLimit("51"), /out of range/);
});

test("missing history object is healed, but 403 is fatal even when 404 rejects first", async () => {
  const mockS3 = {
    async send(command) {
      const key = command.input.Key;
      if (key.endsWith(".bin")) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        const error = new Error("NotFound");
        error.name = "NotFound";
        error.$metadata = { httpStatusCode: 404 };
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, 15));
      const error = new Error("AccessDenied");
      error.name = "AccessDenied";
      error.$metadata = { httpStatusCode: 403 };
      throw error;
    },
  };

  await assert.rejects(
    () => verifyAndHealHistory(mockS3, "dns-compiled-rules", [entry(a)]),
    (error) => error?.$metadata?.httpStatusCode === 403,
  );
});

test("404 + 404 drops an old history entry", async () => {
  const mockS3 = {
    async send() {
      const error = new Error("NotFound");
      error.name = "NotFound";
      error.$metadata = { httpStatusCode: 404 };
      throw error;
    },
  };

  const healed = await verifyAndHealHistory(mockS3, "dns-compiled-rules", [entry(a)]);
  assert.deepEqual(healed, []);
});

test("old 0-byte object is healed", async () => {
  const mockS3 = {
    async send(command) {
      return { ContentLength: command.input.Key.endsWith(".bin") ? 0 : 10 };
    },
  };

  const healed = await verifyAndHealHistory(mockS3, "dns-compiled-rules", [entry(a)]);
  assert.deepEqual(healed, []);
});

test("newly published 0-byte object is fatal", async () => {
  const mockS3 = {
    async send(command) {
      return { ContentLength: command.input.Key.endsWith(".bin") ? 0 : 10 };
    },
  };

  await assert.rejects(
    () => verifyNewlyPublishedPair(mockS3, "dns-compiled-rules", entry(a).key, entry(a).stats, 100, 10),
    /Binary ContentLength mismatch/,
  );
});

test("missing-object classifier does not hide 403", () => {
  const notFound = new Error("NotFound");
  notFound.name = "NotFound";
  notFound.$metadata = { httpStatusCode: 404 };
  const denied = new Error("AccessDenied");
  denied.name = "AccessDenied";
  denied.$metadata = { httpStatusCode: 403 };

  assert.equal(isMissingObjectError(notFound), true);
  assert.equal(isMissingObjectError(denied), false);
});

test("history entries retain rules metadata", () => {
  const retained = buildRetainedVersions(null, entry(a, "v1", 123), 1);
  assert.deepEqual(retained[0], entry(a, "v1", 123));
});
