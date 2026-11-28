import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  buildDnsProbeQuery,
  verifyDnsProbeResponse,
  validateProductionDohUrl,
} from "../scripts/production-worker-smoke.mjs";
import {
  assertPinnedDeployment,
  METRIC_BUCKET_LIMIT,
  summarizeWorkerMetricRows,
} from "../scripts/production-worker-deployment-gate.mjs";

const root = resolve(import.meta.dirname, "..");
const workflow = await readFile(resolve(root, ".github/workflows/production-readonly-gate.yml"), "utf8");
const r2Verifier = await readFile(resolve(root, "scripts/verify-r2-state-readonly.mjs"), "utf8");
const r2Core = await readFile(resolve(root, "scripts/verify-r2-state.mjs"), "utf8");
const r2Manifest = await readFile(resolve(root, "scripts/r2-manifest.mjs"), "utf8");
const deploymentGate = await readFile(resolve(root, "scripts/production-worker-deployment-gate.mjs"), "utf8");

function aggregateRow({
  requests = 120,
  errors = 0,
  cpuP50Us = 12000,
  cpuP99Us = 42000,
} = {}) {
  return {
    sum: { requests, errors },
    quantiles: { cpuTimeP50: cpuP50Us, cpuTimeP99: cpuP99Us },
  };
}

function bucketRow({
  requests = 60,
  errors = 0,
  cpuP50Us = 1200,
  cpuP99Us = 4000,
  datetime = "2026-11-28T04:00:00Z",
} = {}) {
  return {
    sum: { requests, errors },
    quantiles: { cpuTimeP50: cpuP50Us, cpuTimeP99: cpuP99Us },
    dimensions: {
      datetime,
      scriptName: "serverless-edge-dns-gateway",
      status: "success",
    },
  };
}

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

test("production DoH URL validation accepts only HTTPS dns-query paths and keeps token paths opaque", () => {
  assert.equal(
    validateProductionDohUrl("https://example.workers.dev/dns-query").pathname,
    "/dns-query",
  );
  assert.equal(
    validateProductionDohUrl("https://example.workers.dev/dns-query/token-segment").pathname,
    "/dns-query/token-segment",
  );
  assert.throws(() => validateProductionDohUrl("http://example.workers.dev/dns-query"), /HTTPS/);
  assert.throws(() => validateProductionDohUrl("https://example.workers.dev/other"), /dns-query/);
  assert.throws(() => validateProductionDohUrl("https://example.workers.dev/dns-query?token=x"), /query string/);
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

test("CPU gate uses whole-window P50/P99 and preserves maximum per-bucket P99", () => {
  const result = summarizeWorkerMetricRows(
    [aggregateRow({ requests: 120, cpuP50Us: 12000, cpuP99Us: 42000 })],
    [
      bucketRow({ requests: 20, cpuP50Us: 30000, cpuP99Us: 47000 }),
      bucketRow({ requests: 100, cpuP50Us: 1200, cpuP99Us: 4050 }),
    ],
  );

  assert.equal(result.requests, 120);
  assert.equal(result.errors, 0);
  assert.equal(result.bucketCount, 2);
  assert.equal(result.aggregateCpuP50Ms, 12);
  assert.equal(result.aggregateCpuP99Ms, 42);
  assert.equal(result.maxBucketCpuP50Ms, 30);
  assert.equal(result.maxBucketCpuP99Ms, 47);
  assert.equal(result.bucketsAboveP50Threshold, 1);
  assert.equal(result.requestsInBucketsAboveP50Threshold, 20);
  assert.equal(result.thresholds.aggregateP50Ms, 20);
  assert.equal(result.thresholds.aggregateP99Ms, 50);
  assert.equal(result.thresholds.maxBucketP99Ms, 50);
});

test("CPU gate rejects insufficient whole-window request samples and invocation errors", () => {
  assert.throws(
    () => summarizeWorkerMetricRows(
      [aggregateRow({ requests: 99 })],
      [bucketRow({ requests: 99 })],
    ),
    /at least 100 required/,
  );

  assert.throws(
    () => summarizeWorkerMetricRows(
      [aggregateRow({ requests: 120, errors: 1 })],
      [bucketRow({ requests: 120, errors: 1 })],
    ),
    /errors exceeded threshold/,
  );
});

test("CPU gate rejects whole-window P50 and P99 threshold violations", () => {
  assert.throws(
    () => summarizeWorkerMetricRows(
      [aggregateRow({ cpuP50Us: 20001 })],
      [bucketRow()],
    ),
    /whole-window CPU P50 exceeded threshold/,
  );

  assert.throws(
    () => summarizeWorkerMetricRows(
      [aggregateRow({ cpuP99Us: 50001 })],
      [bucketRow({ cpuP99Us: 49000 })],
    ),
    /whole-window CPU P99 exceeded threshold/,
  );
});

test("CPU gate retains a strict maximum per-bucket P99 tail guard", () => {
  assert.throws(
    () => summarizeWorkerMetricRows(
      [aggregateRow()],
      [bucketRow({ cpuP99Us: 50001 })],
    ),
    /max bucket CPU P99 exceeded threshold/,
  );
});

test("CPU gate reports hot P50 buckets without making per-bucket P50 an independent blocker", () => {
  const result = summarizeWorkerMetricRows(
    [aggregateRow({ requests: 121, cpuP50Us: 14000, cpuP99Us: 45000 })],
    [
      bucketRow({ requests: 1, cpuP50Us: 39484, cpuP99Us: 39484 }),
      bucketRow({ requests: 120, cpuP50Us: 1800, cpuP99Us: 45000 }),
    ],
  );

  assert.equal(result.aggregateCpuP50Ms, 14);
  assert.equal(result.maxBucketCpuP50Ms, 39.484);
  assert.equal(result.bucketsAboveP50Threshold, 1);
  assert.equal(result.requestsInBucketsAboveP50Threshold, 1);
  assert.equal(result.maxBucketCpuP99Ms, 45);
});

test("CPU gate fails closed when bucket detail reaches its configured row cap", () => {
  const cappedRows = Array.from({ length: METRIC_BUCKET_LIMIT }, (_, index) =>
    bucketRow({
      requests: 1,
      datetime: new Date(Date.UTC(2026, 10, 28, 0, 0, index)).toISOString(),
    }),
  );

  assert.throws(
    () => summarizeWorkerMetricRows(
      [aggregateRow({ requests: METRIC_BUCKET_LIMIT })],
      cappedRows,
    ),
    /at the 1000-row limit; completeness cannot be proven/,
  );
});

test("CPU gate rejects incomplete bucket details even below the row cap", () => {
  assert.throws(
    () => summarizeWorkerMetricRows(
      [aggregateRow({ requests: 120 })],
      [bucketRow({ requests: 119 })],
    ),
    /bucket totals do not match whole-window totals/,
  );
});

test("CPU gate rejects missing aggregate or bucket quantiles rather than treating them as zero", () => {
  assert.throws(
    () => summarizeWorkerMetricRows(
      [{ sum: { requests: 120, errors: 0 }, quantiles: { cpuTimeP50: null, cpuTimeP99: 40000 } }],
      [bucketRow({ requests: 120 })],
    ),
    /whole-window CPU P50/,
  );

  assert.throws(
    () => summarizeWorkerMetricRows(
      [aggregateRow()],
      [{ sum: { requests: 120, errors: 0 }, quantiles: { cpuTimeP50: 1000, cpuTimeP99: null } }],
    ),
    /bucket\[0\] CPU P99/,
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
  assert.doesNotMatch(r2Verifier, /R2_ACCESS_KEY_ID|R2_SECRET_ACCESS_KEY/);
  assert.ok(r2Verifier.includes('operations: ["GetObject", "HeadObject"]'));
  assert.doesNotMatch(r2Verifier, /PutObjectCommand|DeleteObjectsCommand|CopyObjectCommand|UploadPartCommand/);
  assert.doesNotMatch(r2Core, /publish-r2\.mjs|PutObjectCommand|DeleteObjectsCommand|ListObjectsV2Command/);
});

test("Cloudflare GraphQL query separates whole-window quantiles from bounded per-bucket diagnostics", () => {
  assert.match(deploymentGate, /aggregateMetrics: workersInvocationsAdaptive\(limit: 1/);
  assert.match(deploymentGate, /bucketMetrics: workersInvocationsAdaptive\(limit: 1000/);
  assert.ok(deploymentGate.includes("bucketsAboveP50Threshold"));
  assert.ok(deploymentGate.includes("requestsInBucketsAboveP50Threshold"));
  assert.ok(deploymentGate.includes("bucketRows.length >= bucketLimit"));
  assert.match(deploymentGate, /const METRICS_QUERY = `\s*\nquery /);
  assert.doesNotMatch(deploymentGate, /\bmutation\s+[A-Za-z_]/);
  assert.doesNotMatch(deploymentGate, /method:\s*"(?:PUT|PATCH|DELETE)"/);
});

test("Cloudflare deployment and metrics gate uses GET plus a GraphQL query, never a GraphQL mutation", () => {
  assert.ok(deploymentGate.includes('method: "GET"'));
  assert.ok(deploymentGate.includes("workersInvocationsAdaptive"));
  assert.doesNotMatch(deploymentGate, /method:\s*"(?:PUT|PATCH|DELETE)"/);
});
