import test from "node:test";
import assert from "node:assert/strict";
import {
  GLOBAL_RULE_SHARD,
  RULE_SHARD_ALGORITHM,
  RULE_SHARD_COUNT,
  shardIdForQuery,
  shardIdForRuleDomain,
} from "../src/rules-sharding.ts";
import { ZeroCopyRuleTable } from "../src/rules-engine.ts";

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

test("query routing depends only on the last two labels, whatever bytes precede them", () => {
  const expected = shardIdForRuleDomain("example.com");
  for (const prefix of ["*", "a b", "x!", "a=b", "a."]) {
    assert.equal(shardIdForQuery(`${prefix}.example.com`), expected);
  }
});


function buildBinary(entries) {
  const sorted = [...entries].sort((a, b) => Buffer.from(a[0]).compare(Buffer.from(b[0])));
  const pool = Buffer.concat(sorted.map(([domain]) => Buffer.from(domain, "ascii")));
  const buffer = new ArrayBuffer(16 + (sorted.length + 1) * 4 + pool.length);
  const view = new DataView(buffer);
  view.setUint32(0, 0x534e4445, true);
  view.setUint16(4, 1, true);
  view.setUint32(8, sorted.length, true);
  view.setUint32(12, pool.length, true);
  let offset = 0;
  for (let index = 0; index < sorted.length; index++) {
    const [domain, action] = sorted[index];
    view.setUint32(16 + index * 4, offset | (action === "ALLOW" ? 0x40000000 : 0), true);
    new Uint8Array(buffer, 16 + (sorted.length + 1) * 4 + offset, domain.length)
      .set(Buffer.from(domain, "ascii"));
    offset += domain.length;
  }
  view.setUint32(16 + sorted.length * 4, offset, true);
  return buffer;
}

function evaluateTables(tables, qname) {
  let best = null;
  for (const table of tables) {
    if (!table) continue;
    const match = table.findMatch(qname);
    if (match && (!best || match.matchedLength > best.matchedLength)) best = match;
  }
  return best?.decision ?? "PASS";
}

test("sharded tables return identical decisions to the monolithic table for generated suffix workloads", () => {
  const effective = new Map([["com", "BLOCK"], ["internal", "ALLOW"]]);
  for (let index = 0; index < 2048; index++) {
    const zone = `zone-${index}.example`;
    effective.set(`ads-${index}.${zone}`, index % 5 === 0 ? "ALLOW" : "BLOCK");
    if (index % 3 === 0) effective.set(`tracker.ads-${index}.${zone}`, "BLOCK");
    if (index % 7 === 0) effective.set(`safe.ads-${index}.${zone}`, "ALLOW");
  }

  const monolithic = new ZeroCopyRuleTable(buildBinary([...effective]));
  const globalEntries = [];
  const groupedEntries = new Map();
  for (const entry of effective) {
    const shardId = shardIdForRuleDomain(entry[0]);
    if (shardId === GLOBAL_RULE_SHARD) globalEntries.push(entry);
    else {
      const group = groupedEntries.get(shardId) ?? [];
      group.push(entry);
      groupedEntries.set(shardId, group);
    }
  }
  const globalTable = globalEntries.length
    ? new ZeroCopyRuleTable(buildBinary(globalEntries))
    : null;
  const shardTables = new Map(
    [...groupedEntries].map(([id, entries]) => [id, new ZeroCopyRuleTable(buildBinary(entries))]),
  );

  const queries = new Set(["a.example.com", "x.internal", "unmatched.test"]);
  for (let index = 0; index < 2048; index++) {
    const apex = `ads-${index}.zone-${index}.example`;
    queries.add(apex);
    queries.add(`www.${apex}`);
    queries.add(`tracker.${apex}`);
    queries.add(`tracker.ads-${index}.zone-${index}.example`);
    queries.add(`safe.ads-${index}.zone-${index}.example`);
    queries.add(`unmatched-${index}.other-${index}.test`);
  }

  for (const qname of queries) {
    const shardTable = shardTables.get(shardIdForQuery(qname));
    const shardedDecision = evaluateTables([globalTable, shardTable], qname);
    assert.equal(
      shardedDecision,
      monolithic.evaluate(qname),
      `sharded/monolithic mismatch for ${qname}`,
    );
  }
});
