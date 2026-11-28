import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  buildDnsProbeQuery,
  verifyDnsProbeResponse,
} from "../scripts/production-worker-smoke.mjs";
import {
  assertPinnedDeployment,
  summarizeWorkerMetricRows,
} from "../scripts/production-worker-deployment-gate.mjs";

const root = resolve(import.meta.dirname, "..");
const workflow = await readFile(resolve(root, ".github/workflows/production-readonly-gate.yml"), "utf8");
const r2Verifier = await readFile(resolve(root, "scripts/verify-r2-state-readonly.mjs"), "utf8");
const r2Core = await readFile(resolve(root, "scripts/verify-r2-state.mjs"), "utf8");
const deploymentGate = await readFile(resolve(root, "scripts/production-worker-deployment-gate.mjs"), "utf8");

test("production DNS probe emits a single bounded example.com A query", () => {
  const query = buildDnsProbeQuery(0x1234, "example.com");
  assert.equal(query.readUInt16BE(0), 0x1234);
  assert.equal(query.readUInt16BE(2), 0x0100);
  assert.equal(query.readUInt16BE(4), 1);
  assert.equal(query.readUInt16BE(6), 0);
  assert.equal(query.readUInt16BE(query.length - 4), 1);
  assert.equal(query.readUInt16BE(query.length - 2), 1);
  assert.ok(query.byteLength < 512);
});

test("production DNS probe rejects malformed, truncated, wrong-ID and empty-answer responses", () => {
  const query = buildDnsProbeQuery(0x1234, "example.com");
  const response = Buffer.concat([
    Buffer.from(query),
    Buffer.from([0xc0, 0x0c, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x3c, 0x00, 0x04, 0x5d, 0xb8, 0xd8, 0x22]),
  ]);
  response.writeUInt16BE(0x8180, 2);
  response.writeUInt16BE(1, 6);

  assert.deepEqual(verifyDnsProbeResponse(response, query), {
    rcode: 0,
    questionCount: 1,
    answerCount: 1,
  });

  const wrongId = Buffer.from(response);
  wrongId.writeUInt16BE(0xbeef, 0);
  assert.throws(() => verifyDnsProbeResponse(wrongId, query), /transaction ID/);

  const truncated = Buffer.from(response);
  truncated.writeUInt16BE(0x8380, 2);
  assert.throws(() => verifyDnsProbeResponse(truncated, query), /truncated/);

  const noAnswers = Buffer.from(response);
  noAnswers.writeUInt16BE(0, 6);
  assert.throws(() => verifyDnsProbeResponse(noAnswers, query), /no A answers/);
});

test("production deployment gate requires the frozen version to receive 100 percent traffic", () => {
  const deployment = {
    id: "deployment-id",
    created_on: "2026-11-28T00:00:00.000Z",
    versions: [{ version_id: "456608ef-0dbc-4acb-86a8-39aaeea01400", percentage: 100 }],
  };
  assert.equal(
    assertPinnedDeployment(deployment, "456608ef-0dbc-4acb-86a8-39aaeea01400").percentage,
    100,
  );
  assert.throws(
    () => assertPinnedDeployment({
      ...deployment,
      versions: [{ version_id: deployment.versions[0].version_id, percentage: 90 }],
    }, deployment.versions[0].version_id),
    /version or traffic allocation/
  );
  assert.throws(
    () => assertPinnedDeployment({
      ...deployment,
      versions: [
        { version_id: deployment.versions[0].version_id, percentage: 50 },
        { version_id: "other", percentage: 50 },
      ],
    }, deployment.versions[0].version_id),
    /exactly one version/
  );
});

test("CPU metrics gate uses conservative max-bucket quantiles and strict request/error floors", () => {
  const result = summarizeWorkerMetricRows([
    { sum: { requests: 80, errors: 0 }, quantiles: { cpuTimeP50: 12000, cpuTimeP99: 38000 } },
    { sum: { requests: 40, errors: 0 }, quantiles: { cpuTimeP50: 16000, cpuTimeP99: 42000 } },
  ]);
  assert.equal(result.requests, 120);
  assert.equal(result.errors, 0);
  assert.equal(result.maxBucketCpuP50Ms, 16);
  assert.equal(result.maxBucketCpuP99Ms, 42);
  assert.throws(
    () => summarizeWorkerMetricRows([
      { sum: { requests: 99, errors: 0 }, quantiles: { cpuTimeP50: 10000, cpuTimeP99: 20000 } },
    ]),
    /at least 100 required/
  );
  assert.throws(
    () => summarizeWorkerMetricRows([
      { sum: { requests: 120, errors: 1 }, quantiles: { cpuTimeP50: 10000, cpuTimeP99: 20000 } },
    ]),
    /errors exceeded threshold/
  );
  assert.throws(
    () => summarizeWorkerMetricRows([
      { sum: { requests: 120, errors: 0 }, quantiles: { cpuTimeP50: 10000, cpuTimeP99: 51000 } },
    ]),
    /P99 exceeded threshold/
  );
});

test("Production Read-only Exit Gate is manual-only, least-privilege and has no mutation path", () => {
  assert.ok(workflow.includes("workflow_dispatch:"));
  assert.doesNotMatch(workflow, /^  (?:push|schedule|pull_request):/m);
  assert.ok(workflow.includes("permissions:\n  contents: read"));
  assert.doesNotMatch(workflow, /contents: write|actions: write|wrangler deploy|wrangler versions deploy|publish-r2\.mjs/);
  assert.ok(workflow.includes("CLOUDFLARE_READONLY_API_TOKEN"));
  assert.ok(workflow.includes("R2_READONLY_ACCESS_KEY_ID"));
  assert.ok(workflow.includes("R2_READONLY_SECRET_ACCESS_KEY"));
  assert.ok(workflow.includes("EXPECTED_R2_SHA256_PREFIX: 2b1bea6d"));
});

test("R2 read-only verifier uses a dedicated credential namespace and only GetObject/HeadObject", () => {
  assert.ok(r2Verifier.includes("R2_READONLY_ENDPOINT"));
  assert.ok(r2Verifier.includes("R2_READONLY_ACCESS_KEY_ID"));
  assert.ok(r2Verifier.includes("R2_READONLY_SECRET_ACCESS_KEY"));
  assert.ok(r2Verifier.includes('operations: ["GetObject", "HeadObject"]'));
  assert.doesNotMatch(r2Verifier, /PutObjectCommand|DeleteObjectsCommand|CopyObjectCommand|UploadPartCommand/);
  assert.doesNotMatch(r2Core, /publish-r2\.mjs|PutObjectCommand|DeleteObjectsCommand|ListObjectsV2Command/);
});

test("Cloudflare deployment and metrics gate uses GET plus a GraphQL query, never a GraphQL mutation", () => {
  assert.ok(deploymentGate.includes('method: "GET"'));
  assert.ok(deploymentGate.includes("workersInvocationsAdaptive"));
  assert.match(deploymentGate, /const METRICS_QUERY = `\s*\nquery /);
  assert.doesNotMatch(deploymentGate, /\bmutation\s+[A-Za-z_]/);
  assert.doesNotMatch(deploymentGate, /method:\s*"(?:PUT|PATCH|DELETE)"/);
});
