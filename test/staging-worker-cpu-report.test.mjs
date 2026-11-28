
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_MIN_P50_BUCKET_REQUESTS,
  METRIC_BUCKET_LIMIT,
  runStagingWorkerCpuReport,
  summarizeStagingWorkerMetricRows,
  validateStagingWorkerName,
} from "../scripts/staging-worker-cpu-report.mjs";

const root = resolve(import.meta.dirname, "..");
const workflow = await readFile(
  resolve(root, ".github/workflows/staging-worker-cpu-report.yml"),
  "utf8",
);
const reportScript = await readFile(
  resolve(root, "scripts/staging-worker-cpu-report.mjs"),
  "utf8",
);

function row({
  requests = 25,
  errors = 0,
  p50Us = 1500,
  p99Us = 5000,
  minute = "2026-11-28T04:00:00Z",
  status = "success",
} = {}) {
  return {
    sum: { requests, errors },
    quantiles: { cpuTimeP50: p50Us, cpuTimeP99: p99Us },
    dimensions: { datetimeMinute: minute, status },
  };
}

test("staging report converts CPU microseconds to milliseconds and keeps low-sample tail visible", () => {
  const report = summarizeStagingWorkerMetricRows([
    row({ requests: 2, p50Us: 22956, p99Us: 41110 }),
    row({ requests: 128, p50Us: 1435, p99Us: 4050, minute: "2026-11-28T04:01:00Z" }),
  ]);

  assert.equal(report.status, "MEASURED");
  assert.equal(report.requestCount, 130);
  assert.equal(report.errorCount, 0);
  assert.equal(report.qualifiedP50BucketCount, 1);
  assert.equal(report.lowSampleBucketCount, 1);
  assert.equal(report.maxCpuP50MsAllBuckets, 22.956);
  assert.equal(report.maxCpuP50MsQualifiedBuckets, 1.435);
  assert.equal(report.maxCpuP99MsAllBuckets, 41.11);
  assert.equal(report.maxCpuP99MsLowSampleBuckets, 41.11);
  assert.equal(report.units.conversion, "microseconds / 1000");
  assert.equal(report.reportType, "measurement-only; no release threshold is evaluated");
});

test("staging report never calls low-sample P50 a pass and never drops low-sample P99", () => {
  const report = summarizeStagingWorkerMetricRows([
    row({ requests: 1, p50Us: 35000, p99Us: 44000 }),
    row({ requests: DEFAULT_MIN_P50_BUCKET_REQUESTS, p50Us: 2000, p99Us: 6000 }),
  ]);

  assert.equal(report.lowSampleBucketCount, 1);
  assert.equal(report.maxCpuP50MsAllBuckets, 35);
  assert.equal(report.maxCpuP50MsQualifiedBuckets, 2);
  assert.equal(report.maxCpuP99MsAllBuckets, 44);
});

test("staging report marks an exact GraphQL row-cap result incomplete", () => {
  const capped = Array.from({ length: METRIC_BUCKET_LIMIT }, (_, index) =>
    row({ minute: new Date(Date.UTC(2026, 10, 28, 0, index)).toISOString() }),
  );
  const report = summarizeStagingWorkerMetricRows(capped);

  assert.equal(report.status, "INCOMPLETE");
  assert.equal(report.bucketLimitReached, true);
  assert.equal(report.bucketCount, METRIC_BUCKET_LIMIT);
});

test("staging report marks missing CPU quantiles incomplete instead of converting them to zero", () => {
  const report = summarizeStagingWorkerMetricRows([
    {
      sum: { requests: 15, errors: 0 },
      quantiles: { cpuTimeP50: null, cpuTimeP99: 5000 },
      dimensions: { datetimeMinute: "2026-11-28T04:00:00Z" },
    },
  ]);

  assert.equal(report.status, "INCOMPLETE");
  assert.equal(report.missingCpuMetricBuckets, 1);
  assert.equal(report.maxCpuP50MsAllBuckets, null);
  assert.equal(report.maxCpuP99MsAllBuckets, 5);
});

test("staging report distinguishes no data from a measured zero", () => {
  const report = summarizeStagingWorkerMetricRows([]);
  assert.equal(report.status, "NO_DATA");
  assert.equal(report.bucketCount, 0);
  assert.equal(report.maxCpuP99MsAllBuckets, null);
});

test("staging Worker name validation rejects production and non-staging Worker names", () => {
  assert.equal(
    validateStagingWorkerName("serverless-edge-dns-gateway-staging"),
    "serverless-edge-dns-gateway-staging",
  );
  assert.throws(
    () => validateStagingWorkerName("serverless-edge-dns-gateway"),
    /ending in -staging/,
  );
  assert.throws(
    () => validateStagingWorkerName("some-other-worker"),
    /ending in -staging/,
  );
});

test("staging metrics runner queries only analytics and rejects production names before fetch", async () => {
  let fetchCalls = 0;
  let requestedUrl;
  let requestOptions;
  const fetchStub = async (url, options) => {
    fetchCalls += 1;
    requestedUrl = url;
    requestOptions = options;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          viewer: {
            accounts: [{
              workersInvocationsAdaptive: [row({ requests: 12 })],
            }],
          },
        },
      }),
    };
  };
  const env = {
    CLOUDFLARE_READONLY_API_TOKEN: "test-token",
    CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
    STAGING_WORKER_NAME: "serverless-edge-dns-gateway-staging",
    STAGING_LOOKBACK_MINUTES: "60",
  };
  const result = await runStagingWorkerCpuReport(
    env,
    fetchStub,
    Date.parse("2026-11-28T06:00:00Z"),
  );

  assert.equal(result.status, "MEASURED");
  assert.equal(result.workerName, env.STAGING_WORKER_NAME);
  assert.equal(result.readOnly, true);
  assert.equal(result.productionTouched, false);
  assert.equal(fetchCalls, 1);
  assert.equal(requestedUrl, "https://api.cloudflare.com/client/v4/graphql");
  assert.equal(requestOptions.method, "POST");
  const queryBody = JSON.parse(requestOptions.body);
  assert.equal(queryBody.variables.scriptName, env.STAGING_WORKER_NAME);
  assert.match(queryBody.query, /workersInvocationsAdaptive/);

  await assert.rejects(
    () => runStagingWorkerCpuReport({
      ...env,
      STAGING_WORKER_NAME: "serverless-edge-dns-gateway",
    }, fetchStub),
    /ending in -staging/,
  );
  assert.equal(fetchCalls, 1, "production Worker name must be rejected before any request");
});

test("staging workflow is manual-only and has no deploy, publish or production-gate step", () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^  (?:push|schedule|pull_request):/m);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /STAGING_WORKER_NAME/);
  assert.match(workflow, /CLOUDFLARE_READONLY_API_TOKEN/);
  assert.doesNotMatch(workflow, /wrangler deploy|publish-r2\.mjs|production-readonly-gate\.mjs/);
  assert.doesNotMatch(workflow, /R2_ACCESS_KEY_ID|R2_SECRET_ACCESS_KEY|PRODUCTION_DOH_URL/);
  assert.match(reportScript, /method: "POST"/);
  assert.match(reportScript, /workersInvocationsAdaptive/);
  assert.doesNotMatch(reportScript, /mutation\s+[A-Za-z_]/);
  assert.doesNotMatch(reportScript, /method:\s*"(?:PUT|PATCH|DELETE)"/);
});
