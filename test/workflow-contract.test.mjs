import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { resolveVerificationBucketName } from "../scripts/verify-r2-state.mjs";
import { runReadOnlyR2Gate } from "../scripts/verify-r2-state-readonly.mjs";

const root = resolve(import.meta.dirname, "..");
const workflowPath = resolve(root, ".github/workflows/publish-rules-r2.yml");
const ciPath = resolve(root, ".github/workflows/ci.yml");
const blocklistWorkflowPath = resolve(root, ".github/workflows/Update_DNS_Blocklists.yml");
const publishPath = resolve(root, "scripts/publish-r2.mjs");
const verifyPath = resolve(root, "scripts/verify-r2-state.mjs");
const readonlyVerifyPath = resolve(root, "scripts/verify-r2-state-readonly.mjs");
const wranglerPath = resolve(root, "wrangler.jsonc");

const workflow = await readFile(workflowPath, "utf8");
const stagingBootstrap = await readFile(resolve(root, "docs/STAGING_BOOTSTRAP.md"), "utf8");
const englishReadme = await readFile(resolve(root, "README.md"), "utf8");
const vietnameseReadme = await readFile(resolve(root, "README_VN.md"), "utf8");
const ciWorkflow = await readFile(ciPath, "utf8");
const blocklistWorkflow = await readFile(blocklistWorkflowPath, "utf8");
const publish = await readFile(publishPath, "utf8");
const verify = await readFile(verifyPath, "utf8");
const readonlyVerify = await readFile(readonlyVerifyPath, "utf8");
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

test("R2 publisher and verifiers refuse an implicit bucket target", async () => {
  assert.equal(resolveBucketName("dns-compiled-rules-staging"), "dns-compiled-rules-staging");
  assert.throws(() => resolveBucketName(""), /R2_BUCKET_NAME is required/);
  assert.throws(() => resolveVerificationBucketName(""), /R2_BUCKET_NAME is required/);
  assert.throws(
    () => runReadOnlyR2Gate({
      R2_READONLY_ENDPOINT: "https://example.r2.cloudflarestorage.com",
      R2_READONLY_ACCESS_KEY_ID: "test-access-key",
      R2_READONLY_SECRET_ACCESS_KEY: "test-secret",
    }),
    /Missing required environment variable: R2_BUCKET_NAME/,
  );
  assert.doesNotMatch(publish, /R2_BUCKET_NAME\s*\|\|\s*DEFAULT_BUCKET/);
  assert.doesNotMatch(verify, /R2_BUCKET_NAME\s*\|\|\s*["']dns-compiled-rules["']/);
  assert.doesNotMatch(readonlyVerify, /R2_BUCKET_NAME\s*\|\|\s*["']dns-compiled-rules["']/);
});

test("staging bootstrap documentation keeps the first snapshot isolated from production", () => {
  assert.match(stagingBootstrap, /R2_BUCKET_NAME="dns-compiled-rules-staging"/);
  assert.match(stagingBootstrap, /publish-r2\.mjs --dry-run/);
  assert.match(stagingBootstrap, /wrangler\.staging\.jsonc/);
  assert.match(stagingBootstrap, /SERVFAIL/);
  assert.match(stagingBootstrap, /10 ms/);
  assert.match(stagingBootstrap, /80%/);
  assert.match(englishReadme, /docs\/STAGING_BOOTSTRAP\.md/);
  assert.match(vietnameseReadme, /docs\/STAGING_BOOTSTRAP\.md/);
  assert.doesNotMatch(englishReadme, /Mullvad DNS/);
  assert.doesNotMatch(vietnameseReadme, /Mullvad DNS/);
  assert.match(englishReadme, /dns10\.quad9\.net/);
  assert.match(vietnameseReadme, /dns10\.quad9\.net/);
});

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

test("workflow contract: manually approved draft PRs trigger CI", () => {
  assert.ok(ciWorkflow.includes("pull_request:\n    types: [opened, synchronize, reopened, ready_for_review]"));
});

test("workflow contract: blocklist refresh creates a guarded draft PR and freezes its HEAD during review", () => {
  assert.match(blocklistWorkflow, /schedule:/);
  assert.ok(blocklistWorkflow.includes("pull-requests: write"));
  assert.ok(blocklistWorkflow.includes("peter-evans/create-pull-request@v7"));
  assert.ok(blocklistWorkflow.includes("branch: automation/dns-blocklists"));
  assert.ok(blocklistWorkflow.includes("draft: true"));
  assert.ok(blocklistWorkflow.includes("gh pr list --state open --head automation/dns-blocklists"));
  assert.ok(blocklistWorkflow.includes("if: steps.review.outputs.exists != 'true'"));
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
  assert.match(verify, /resolveVerificationBucketName\(\)/);
  assert.match(verify, /R2_BUCKET_NAME is required/);
  assert.doesNotMatch(verify, /R2_BUCKET_NAME \|\| "dns-compiled-rules"/);
  assert.match(readonlyVerify, /requiredEnv\(env, "R2_BUCKET_NAME"\)/);
  assert.doesNotMatch(readonlyVerify, /R2_BUCKET_NAME \|\| "dns-compiled-rules"/);
  assert.match(verify, /requiredEnv\("R2_ACCESS_KEY_ID"\)/);
  assert.match(verify, /requiredEnv\("R2_SECRET_ACCESS_KEY"\)/);
  assert.match(verify, /process\.exitCode\s*=\s*1/);
  assert.match(stepBlock(workflow, "Verify R2 state"), /node scripts\/verify-r2-state\.mjs/);
  for (const step of [
    "Dry-run R2 publisher",
    "Publish immutable snapshot to R2",
    "Roll back immutable snapshot in R2",
    "Unrevoke SHA in R2",
    "Verify R2 state",
  ]) {
    assert.match(stepBlock(workflow, step), /R2_BUCKET_NAME: dns-compiled-rules/);
  }
  assert.match(publish, /R2_BUCKET_NAME is required/);
  assert.doesNotMatch(publish, /R2_BUCKET_NAME \|\| DEFAULT_BUCKET/);

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
