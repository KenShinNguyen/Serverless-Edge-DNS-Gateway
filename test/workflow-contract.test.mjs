import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "..");
const workflowPath = resolve(root, ".github/workflows/publish-rules-r2.yml");
const blocklistWorkflowPath = resolve(root, ".github/workflows/Update_DNS_Blocklists.yml");
const publishPath = resolve(root, "scripts/publish-r2.mjs");
const verifyPath = resolve(root, "scripts/verify-r2-state.mjs");
const wranglerPath = resolve(root, "wrangler.jsonc");

const workflow = await readFile(workflowPath, "utf8");
const blocklistWorkflow = await readFile(blocklistWorkflowPath, "utf8");
const publish = await readFile(publishPath, "utf8");
const verify = await readFile(verifyPath, "utf8");
const wrangler = JSON.parse(await readFile(wranglerPath, "utf8"));

function runBlocks(source) {
  const lines = source.split(/\r?\n/);
  const blocks = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s+run:\s*(?:\|)?\s*$/.test(lines[i])) {
      const body = [];
      const baseIndent = lines[i].match(/^\s*/)[0].length;
      for (let j = i + 1; j < lines.length; j += 1) {
        if (lines[j].trim() !== "" && lines[j].match(/^\s*/)[0].length <= baseIndent) break;
        body.push(lines[j]);
      }
      blocks.push(body.join("\n"));
    }
  }
  return blocks;
}

function envKeysForStep(source, stepName) {
  const escaped = stepName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`- name: ${escaped}[\\s\\S]*?(?=\\n\\s+- name:|\\n\\s+\\n\\s+- name:|\\n\\s*$)`).exec(source);
  assert.ok(match, `workflow step not found: ${stepName}`);
  const envMatch = /\n\s+env:\n([\s\S]*?)(?=\n\s+run:|\n\s+if:|\n\s+uses:|\n\s+- name:|$)/.exec(match[0]);
  assert.ok(envMatch, `env block missing in step: ${stepName}`);
  return [...envMatch[1].matchAll(/^\s{10}([A-Z][A-Z0-9_]*)\s*:/gm)].map((m) => m[1]);
}

function stepBlock(source, stepName) {
  const escaped = stepName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`- name: ${escaped}[\\s\\S]*?(?=\\n\\s+- name:|$)`).exec(source);
  assert.ok(match, `workflow step not found: ${stepName}`);
  return match[0];
}

test("workflow contract: concurrency and least-privilege permissions are locked", () => {
  assert.match(workflow, /concurrency:\s*[\s\S]*?group:\s*r2-compiled-rules-publisher/);
  assert.match(workflow, /concurrency:\s*[\s\S]*?cancel-in-progress:\s*false/);
  assert.match(workflow, /concurrency:\s*[\s\S]*?queue:\s*max/);
  assert.match(workflow, /permissions:\s*\n\s+contents:\s*read/);
  assert.doesNotMatch(workflow, /contents:\s*write/);
});

test("workflow contract: R2 publisher is manual-only and defaults to dry-run", () => {
  assert.doesNotMatch(workflow, /schedule:/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.ok(workflow.includes('default: "dry-run"'));
  assert.ok(workflow.includes("INPUT_ACTION: ${{ inputs.action }}"));
  assert.ok(workflow.includes('EFFECTIVE="dry-run"'));
  assert.ok(workflow.includes("publish|dry-run|rollback|unrevoke|verify"));
});

test("workflow contract: blocklist refresh opens a draft PR instead of pushing to main", () => {
  assert.match(blocklistWorkflow, /schedule:/);
  assert.ok(blocklistWorkflow.includes("pull-requests: write"));
  assert.ok(blocklistWorkflow.includes("peter-evans/create-pull-request@v7"));
  assert.ok(blocklistWorkflow.includes("branch: automation/dns-blocklists"));
  assert.ok(blocklistWorkflow.includes("draft: true"));
  assert.doesNotMatch(blocklistWorkflow, /git-auto-commit-action/);
  assert.doesNotMatch(blocklistWorkflow, /git push origin main/);
});

test("Workers observability is sampled, query-redacted and excludes raw invocation logs", () => {
  assert.equal(wrangler.observability.enabled, true);
  assert.equal(wrangler.observability.head_sampling_rate, 0.05);
  assert.equal(wrangler.observability.logs.enabled, true);
  assert.equal(wrangler.observability.logs.invocation_logs, false);
  assert.equal(wrangler.observability.logs.head_sampling_rate, 0.05);
  assert.equal(wrangler.observability.redact_query_string, true);
  assert.equal(wrangler.observability.logs.redact_query_string, undefined);
  assert.equal(wrangler.triggers, undefined, "the Worker exports no scheduled handler");
});

test("workflow contract: blocklist refresh opens a draft PR instead of pushing to main", () => {
  assert.match(blocklistWorkflow, /schedule:/);
  assert.match(blocklistWorkflow, /pull-requests:\\s*write/);
  assert.ok(blocklistWorkflow.includes("peter-evans/create-pull-request@v7"));
  assert.match(blocklistWorkflow, /branch: automation\\/dns-blocklists/);
  assert.match(blocklistWorkflow, /draft: true/);
  assert.doesNotMatch(blocklistWorkflow, /git-auto-commit-action/);
  assert.doesNotMatch(blocklistWorkflow, /git push origin main/);
});

test("workflow contract: no user-controlled inputs are interpolated inside run blocks", () => {
  for (const block of runBlocks(workflow)) {
    assert.doesNotMatch(block, /\$\{\{\s*(?:inputs\.|github\.event\.inputs\.)/);
  }
});

test("workflow contract: compile is reachable only for publish and dry-run", () => {
  const compile = stepBlock(workflow, "Compile binary rules and run canaries");
  assert.match(compile, /if:\s*\$\{\{\s*steps\.mode\.outputs\.action\s*==\s*'publish'\s*\|\|\s*steps\.mode\.outputs\.action\s*==\s*'dry-run'\s*\}\}/);
  for (const action of ["rollback", "unrevoke", "verify"]) {
    assert.doesNotMatch(stepBlock(workflow, `Run unit and snapshot tests`), new RegExp(`==\\s*'${action}'`));
  }
});

test("workflow contract: verify runs for every action except dry-run", () => {
  const verifyStep = stepBlock(workflow, "Verify R2 state");
  assert.match(verifyStep, /if:\s*\$\{\{\s*steps\.mode\.outputs\.action\s*!=\s*'dry-run'\s*\}\}/);
  assert.match(verifyStep, /node scripts\/verify-r2-state\.mjs/);
});

test("workflow contract: publisher CLI syntax matches the real parser", () => {
  assert.match(publish, /process\.argv\.includes\("--dry-run"\)/);
  assert.match(publish, /process\.argv\[2\] === "--rollback"/);
  assert.match(publish, /process\.argv\[3\]/);
  assert.match(publish, /process\.argv\.indexOf\("--reason"\)/);
  assert.match(publish, /process\.argv\[2\] === "--unrevoke"/);
  assert.match(publish, /const sha = process\.argv\[3\]/);
  assert.match(stepBlock(workflow, "Dry-run R2 publisher"), /node scripts\/publish-r2\.mjs --dry-run/);
  assert.match(stepBlock(workflow, "Roll back immutable snapshot in R2"), /node scripts\/publish-r2\.mjs --rollback \"\$TARGET_SHA\" --reason \"\$ROLLBACK_REASON\"/);
  assert.match(stepBlock(workflow, "Unrevoke SHA in R2"), /node scripts\/publish-r2\.mjs --unrevoke \"\$TARGET_SHA\"/);
});

test("workflow contract: verifier entrypoint and R2 environment names match source", () => {
  assert.match(verify, /requiredEnv\("R2_ENDPOINT"\)/);
  assert.match(verify, /process\.env\.R2_BUCKET_NAME/);
  assert.match(verify, /requiredEnv\("R2_ACCESS_KEY_ID"\)/);
  assert.match(verify, /requiredEnv\("R2_SECRET_ACCESS_KEY"\)/);
  assert.match(verify, /process\.exitCode\s*=\s*1/);
  assert.match(stepBlock(workflow, "Verify R2 state"), /node scripts\/verify-r2-state\.mjs/);

  const expected = ["R2_ENDPOINT", "R2_BUCKET_NAME", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "RETENTION_LIMIT"];
  assert.deepEqual(envKeysForStep(workflow, "Verify R2 state"), expected);
  assert.deepEqual(envKeysForStep(workflow, "Roll back immutable snapshot in R2"), [...expected, "TARGET_SHA", "ROLLBACK_REASON"]);
  assert.deepEqual(envKeysForStep(workflow, "Unrevoke SHA in R2"), [...expected, "TARGET_SHA"]);
});

test("workflow contract: blank retention_limit is passed through env and the real resolver accepts blank", () => {
  assert.match(workflow, /RETENTION_LIMIT: \$\{\{ inputs\.retention_limit \}\}/);
  assert.match(publish, /envVal === undefined \|\| envVal === \"\"/);
  assert.match(publish, /return DEFAULT_RETENTION_LIMIT/);
});

test("workflow contract: rollback and unrevoke input validation is shell-safe", () => {
  assert.match(workflow, /TARGET_SHA: \$\{\{ inputs\.target_sha \}\}/);
  assert.match(workflow, /ROLLBACK_REASON: \$\{\{ inputs\.reason \}\}/);
  assert.match(workflow, /rollback target_sha must be 'previous' or a 64-character lowercase SHA-256/);
  assert.match(workflow, /unrevoke target_sha must be a 64-character lowercase SHA-256/);
  assert.match(workflow, /node scripts\/publish-r2\.mjs --rollback \"\$TARGET_SHA\" --reason \"\$ROLLBACK_REASON\"/);
});
