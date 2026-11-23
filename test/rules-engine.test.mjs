import test from "node:test";
import assert from "node:assert/strict";
import { ZeroCopyRuleTable } from "../src/rules-engine.ts";

const MAGIC = 0x534e4445;
const ALLOW_FLAG = 0x40000000;

function buildRules(entries) {
  const sorted = [...entries].sort((a, b) => Buffer.from(a[0]).compare(Buffer.from(b[0])));
  const pool = Buffer.concat(sorted.map(([domain]) => Buffer.from(domain)));
  const buffer = new ArrayBuffer(16 + (sorted.length + 1) * 4 + pool.length);
  const view = new DataView(buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint16(4, 1, true);
  view.setUint16(6, 0, true);
  view.setUint32(8, sorted.length, true);
  view.setUint32(12, pool.length, true);

  let offset = 0;
  for (let i = 0; i < sorted.length; i++) {
    const [domain, action] = sorted[i];
    view.setUint32(16 + i * 4, (action === "ALLOW" ? ALLOW_FLAG : 0) | offset, true);
    new Uint8Array(buffer, 16 + (sorted.length + 1) * 4 + offset, domain.length).set(Buffer.from(domain));
    offset += domain.length;
  }
  view.setUint32(16 + sorted.length * 4, offset, true);
  return buffer;
}

test("most-specific suffix wins", () => {
  const table = new ZeroCopyRuleTable(buildRules([
    ["example.com", "BLOCK"],
    ["ads.example.com", "ALLOW"],
    ["tracker.ads.example.com", "BLOCK"],
  ]));

  assert.equal(table.evaluate("example.com"), "BLOCK");
  assert.equal(table.evaluate("www.example.com"), "BLOCK");
  assert.equal(table.evaluate("ads.example.com"), "ALLOW");
  assert.equal(table.evaluate("img.ads.example.com"), "ALLOW");
  assert.equal(table.evaluate("tracker.ads.example.com"), "BLOCK");
  assert.equal(table.evaluate("tracker.ads.example.com."), "BLOCK");
  assert.equal(table.evaluate("unrelated.test"), "PASS");
});

test("hyphen ordering is byte-safe", () => {
  const table = new ZeroCopyRuleTable(buildRules([
    ["com.example", "BLOCK"],
    ["com.example-tracker", "ALLOW"],
    ["com.example.ads", "BLOCK"],
  ]));

  assert.equal(table.evaluate("example.com"), "BLOCK");
  assert.equal(table.evaluate("example-tracker.com"), "ALLOW");
  assert.equal(table.evaluate("example.ads.com"), "BLOCK");
});

test("case is normalized and unicode is fail-safe", () => {
  const table = new ZeroCopyRuleTable(buildRules([
    ["example.com", "BLOCK"],
  ]));

  assert.equal(table.evaluate("WWW.Example.COM"), "BLOCK");
  assert.equal(table.evaluate("example.com."), "BLOCK");
  assert.equal(table.evaluate("éxample.com"), "PASS");
});

test("ALLOW overrides BLOCK at the same domain", () => {
  const table = new ZeroCopyRuleTable(buildRules([
    ["example.com", "ALLOW"],
  ]));

  assert.equal(table.evaluate("example.com"), "ALLOW");
  assert.equal(table.evaluate("www.example.com"), "ALLOW");
});
