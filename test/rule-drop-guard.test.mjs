import test from "node:test";
import assert from "node:assert/strict";
import { assertRuleUpdateSafe } from "../scripts/check-rule-drop.mjs";

test("first-run baseline still enforces the absolute minimum", () => {
  const result = assertRuleUpdateSafe({
    previousCount: 0,
    candidateCount: 500,
    maxDropPercent: 20,
    minCount: 100,
    label: "allowlist",
  });
  assert.equal(result.baseline, "first-run");
});

test("a candidate exactly at the configured drop boundary passes", () => {
  const result = assertRuleUpdateSafe({
    previousCount: 1000,
    candidateCount: 800,
    maxDropPercent: 20,
    minCount: 100,
    label: "blocklist",
  });
  assert.equal(result.minimumAllowed, 800);
});

test("a candidate below the configured drop boundary fails closed", () => {
  assert.throws(
    () => assertRuleUpdateSafe({
      previousCount: 1000,
      candidateCount: 799,
      maxDropPercent: 20,
      minCount: 100,
      label: "blocklist",
    }),
    /drop guard failed/
  );
});

test("a candidate below its absolute floor fails even without a previous baseline", () => {
  assert.throws(
    () => assertRuleUpdateSafe({
      previousCount: 0,
      candidateCount: 99,
      maxDropPercent: 20,
      minCount: 100,
      label: "allowlist",
    }),
    /minimum is 100/
  );
});

test("drop guard settings outside 0..100 are rejected", () => {
  assert.throws(
    () => assertRuleUpdateSafe({
      previousCount: 1000,
      candidateCount: 1000,
      maxDropPercent: 101,
      minCount: 1,
    }),
    /maxDropPercent/
  );
});
