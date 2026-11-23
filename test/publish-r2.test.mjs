import test from "node:test";
import assert from "node:assert/strict";
import { buildRetainedVersions } from "../scripts/publish-r2.mjs";

function entry(sha, version = sha.slice(0, 8)) {
  return {
    sha256: sha,
    version,
    generatedAt: "2026-11-23T00:00:00.000Z",
    key: `compiled/rules-${sha}.bin`,
    stats: `compiled/stats-${sha}.json`,
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
    generatedAt: "2026-11-20T00:00:00.000Z",
    history: [entry(a, "old-a"), entry(b), entry(c), entry(d), entry(e)],
  };

  const retained = buildRetainedVersions(current, entry(a, "revert-a"));

  assert.deepEqual(retained.map((x) => x.sha256), [a, b, c, d, e]);
});

test("a new SHA enters the ring and the oldest unpinned SHA falls out", () => {
  const current = {
    sha256: a,
    version: "a",
    history: [entry(a), entry(b), entry(c), entry(d), entry(e)],
  };

  const retained = buildRetainedVersions(current, entry(f));

  assert.deepEqual(retained.map((x) => x.sha256), [f, a, b, c, d]);
  assert.equal(retained.length, 5);
});

test("legacy latest.json without history is upgraded safely", () => {
  const current = {
    sha256: a,
    version: "legacy",
    key: `compiled/rules-${a}.bin`,
    stats: `compiled/stats-${a}.json`,
  };

  const retained = buildRetainedVersions(current, entry(b));

  assert.deepEqual(retained.map((x) => x.sha256), [b, a]);
});
