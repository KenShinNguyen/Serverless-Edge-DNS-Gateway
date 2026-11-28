import test from "node:test";
import assert from "node:assert/strict";
import {
  GLOBAL_RULE_SHARD,
  RULE_SHARD_ALGORITHM,
  RULE_SHARD_COUNT,
  shardIdForQuery,
  shardIdForRuleDomain,
} from "../src/rules-sharding.ts";

test("one-label rules are assigned to the global table", () => {
  assert.equal(shardIdForRuleDomain("com"), GLOBAL_RULE_SHARD);
  assert.equal(shardIdForRuleDomain("lan"), GLOBAL_RULE_SHARD);
  assert.equal(shardIdForQuery("localhost"), GLOBAL_RULE_SHARD);
});

test("all multi-label suffix rules for one QNAME resolve to the same shard", () => {
  const rules = [
    "example.com",
    "b.example.com",
    "a.b.example.com",
    "example.co.uk",
    "private.example.co.uk",
    "a.b.example.co.uk",
    "service.internal",
  ];

  for (const rule of rules) {
    const queryNames = [rule, `www.${rule}`, `a.b.${rule}`];
    for (const qname of queryNames) {
      assert.equal(
        shardIdForQuery(qname),
        shardIdForRuleDomain(rule),
        `${rule} must be colocated with suffix-matching QNAME ${qname}`,
      );
    }
  }
});

test("shard routing is case and trailing-dot insensitive", () => {
  assert.equal(shardIdForQuery("WWW.Example.COM."), shardIdForQuery("www.example.com"));
  assert.equal(shardIdForRuleDomain("EXAMPLE.COM."), shardIdForRuleDomain("example.com"));
});

test("algorithm is stable and spans a bounded set of 256 identifiers", () => {
  assert.equal(RULE_SHARD_ALGORITHM, "fnv1a32-last-two-labels-v1");
  assert.equal(RULE_SHARD_COUNT, 256);

  const ids = new Set(
    Array.from({ length: 4096 }, (_, index) =>
      shardIdForRuleDomain(`host-${index}.zone-${index}.example`),
    ),
  );
  assert.ok(ids.size > 200, `expected broad distribution, got ${ids.size} shard IDs`);
  for (const id of ids) assert.match(id, /^[0-9a-f]{2}$/);
});

test("invalid or non-ASCII names fail closed instead of selecting a data shard", () => {
  assert.throws(() => shardIdForQuery("éxample.com"), /ASCII/);
  assert.throws(() => shardIdForQuery("example..com"), /invalid label/);
});
