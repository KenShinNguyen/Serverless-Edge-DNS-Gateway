
const GRAPHQL_API = "https://api.cloudflare.com/client/v4/graphql";

export const METRIC_BUCKET_LIMIT = 1000;
export const DEFAULT_MIN_P50_BUCKET_REQUESTS = 10;
export const DEFAULT_MIN_FREE_P50_REQUEST_COVERAGE_PERCENT = 80;
export const DEFAULT_FREE_CPU_P99_LIMIT_MS = 10;
const MICROSECONDS_PER_MILLISECOND = 1000;

export const STAGING_METRICS_QUERY = [
  "query GetStagingWorkersAnalytics($accountTag: string, $datetimeStart: string, $datetimeEnd: string, $scriptName: string) {",
  "  viewer {",
  "    accounts(filter: { accountTag: $accountTag }) {",
  "      workersInvocationsAdaptive(limit: 1000, filter: {",
  "        scriptName: $scriptName,",
  "        datetime_geq: $datetimeStart,",
  "        datetime_leq: $datetimeEnd",
  "      }) {",
  "        sum { requests errors }",
  "        quantiles { cpuTimeP50 cpuTimeP99 }",
  "        dimensions { datetimeMinute scriptName }",
  "      }",
  "    }",
  "  }",
  "}",
].join("\n");

function requiredEnv(name, env) {
  const value = env[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("Missing required environment variable: " + name);
  }
  return value.trim();
}

function finiteNonNegative(value, label) {
  if (value === null || value === undefined || value === "") {
    throw new Error("Cloudflare did not return " + label);
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error("Cloudflare returned an invalid " + label);
  }
  return number;
}

function optionalCpuMs(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return Number((number / MICROSECONDS_PER_MILLISECOND).toFixed(3));
}

function maxOrNull(values) {
  const present = values.filter((value) => value !== null);
  return present.length ? Math.max(...present) : null;
}

export function validateStagingWorkerName(value) {
  if (
    typeof value !== "string"
    || value.length > 63
    || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?-staging$/.test(value)
    || value === "serverless-edge-dns-gateway"
  ) {
    throw new Error(
      "STAGING_WORKER_NAME must be a valid Worker name ending in -staging; production Worker names are not accepted",
    );
  }
  return value;
}

/**
 * Summarize raw minute-bucket metrics without applying release thresholds.
 * This is an evidence report, not a pass/fail production gate.
 */
export function summarizeStagingWorkerMetricRows(
  rows,
  {
    bucketLimit = METRIC_BUCKET_LIMIT,
    minP50BucketRequests = DEFAULT_MIN_P50_BUCKET_REQUESTS,
  } = {},
) {
  if (!Array.isArray(rows)) {
    throw new Error("Cloudflare returned an invalid Workers metrics row set");
  }
  if (!Number.isInteger(bucketLimit) || bucketLimit < 1) {
    throw new Error("Metric bucket row limit must be a positive integer");
  }
  if (!Number.isInteger(minP50BucketRequests) || minP50BucketRequests < 1) {
    throw new Error("Minimum P50 bucket request count must be a positive integer");
  }

  let requestCount = 0;
  let errorCount = 0;
  let missingCpuMetricBuckets = 0;

  const buckets = rows.map((row, index) => {
    const requests = finiteNonNegative(
      row.sum?.requests,
      "minute bucket[" + index + "] request count",
    );
    const errors = finiteNonNegative(
      row.sum?.errors,
      "minute bucket[" + index + "] error count",
    );
    const cpuP50Ms = optionalCpuMs(row.quantiles?.cpuTimeP50);
    const cpuP99Ms = optionalCpuMs(row.quantiles?.cpuTimeP99);

    if (cpuP50Ms === null || cpuP99Ms === null) {
      missingCpuMetricBuckets += 1;
    }
    requestCount += requests;
    errorCount += errors;

    return {
      minute: typeof row.dimensions?.datetimeMinute === "string"
        ? row.dimensions.datetimeMinute
        : null,
      requests,
      errors,
      cpuP50Ms,
      cpuP99Ms,
      p50SampleQualified: requests >= minP50BucketRequests,
      sampleClass: requests >= minP50BucketRequests ? "qualified" : "low-sample",
    };
  });

  const complete = rows.length < bucketLimit && missingCpuMetricBuckets === 0;
  const status = rows.length === 0
    ? "NO_DATA"
    : complete
      ? "MEASURED"
      : "INCOMPLETE";

  const qualified = buckets.filter((bucket) => bucket.p50SampleQualified);
  const lowSample = buckets.filter((bucket) => !bucket.p50SampleQualified);
  const qualifiedP50RequestCount = qualified.reduce(
    (total, bucket) => total + bucket.requests,
    0,
  );
  const lowSampleRequestCount = lowSample.reduce(
    (total, bucket) => total + bucket.requests,
    0,
  );
  const qualifiedP50RequestCoveragePercent = requestCount > 0
    ? Number(((qualifiedP50RequestCount / requestCount) * 100).toFixed(3))
    : null;
  const maxCpuP50MsAllBuckets = maxOrNull(buckets.map((bucket) => bucket.cpuP50Ms));
  const maxCpuP50MsQualifiedBuckets = maxOrNull(qualified.map((bucket) => bucket.cpuP50Ms));
  const maxCpuP99MsAllBuckets = maxOrNull(buckets.map((bucket) => bucket.cpuP99Ms));
  const maxCpuP99MsLowSampleBuckets = maxOrNull(lowSample.map((bucket) => bucket.cpuP99Ms));
  const p99WithinFreeCpuLimit = maxCpuP99MsAllBuckets === null
    ? null
    : maxCpuP99MsAllBuckets <= DEFAULT_FREE_CPU_P99_LIMIT_MS;
  const qualifiedRequestCoverageMeetsFreeMinimum = qualifiedP50RequestCoveragePercent === null
    ? null
    : qualifiedP50RequestCoveragePercent >= DEFAULT_MIN_FREE_P50_REQUEST_COVERAGE_PERCENT;

  let freeCpuEvidenceStatus;
  if (status === "NO_DATA") {
    freeCpuEvidenceStatus = "NO_DATA";
  } else if (status !== "MEASURED") {
    freeCpuEvidenceStatus = "INCOMPLETE";
  } else if (requestCount === 0) {
    freeCpuEvidenceStatus = "NO_TRAFFIC";
  } else if (p99WithinFreeCpuLimit === false) {
    freeCpuEvidenceStatus = "P99_ABOVE_TARGET";
  } else if (qualifiedRequestCoverageMeetsFreeMinimum === false) {
    freeCpuEvidenceStatus = "INSUFFICIENT_QUALIFIED_COVERAGE";
  } else {
    freeCpuEvidenceStatus = "WITHIN_OBSERVED_TARGETS";
  }

  return {
    status,
    reportType: "measurement-only; no release threshold is evaluated",
    requestCount,
    errorCount,
    bucketCount: rows.length,
    bucketLimit,
    bucketLimitReached: rows.length >= bucketLimit,
    minP50BucketRequests,
    qualifiedP50BucketCount: qualified.length,
    lowSampleBucketCount: lowSample.length,
    qualifiedP50RequestCount,
    lowSampleRequestCount,
    qualifiedP50RequestCoveragePercent,
    freeCpuEvidence: {
      status: freeCpuEvidenceStatus,
      cpuP99LimitMs: DEFAULT_FREE_CPU_P99_LIMIT_MS,
      observedMaxCpuP99Ms: maxCpuP99MsAllBuckets,
      p99WithinLimit: p99WithinFreeCpuLimit,
      minP50BucketRequests: DEFAULT_MIN_P50_BUCKET_REQUESTS,
      minQualifiedRequestCoveragePercent: DEFAULT_MIN_FREE_P50_REQUEST_COVERAGE_PERCENT,
      qualifiedRequestCoveragePercent: qualifiedP50RequestCoveragePercent,
      qualifiedRequestCoverageMeetsMinimum: qualifiedRequestCoverageMeetsFreeMinimum,
      requestCoverageBasis: "sum.requests returned by workersInvocationsAdaptive; Analytics may apply adaptive sampling",
      assessmentType: "measurement-only; not a production release gate or plan entitlement certification",
    },
    missingCpuMetricBuckets,
    maxCpuP50MsAllBuckets,
    maxCpuP50MsQualifiedBuckets,
    maxCpuP99MsAllBuckets,
    maxCpuP99MsLowSampleBuckets,
    units: {
      source: "Cloudflare cpuTimeP50/cpuTimeP99 in microseconds",
      report: "milliseconds",
      conversion: "microseconds / 1000",
      duration: "not queried; wall-clock duration is not CPU time",
    },
    buckets,
  };
}

export async function runStagingWorkerCpuReport(
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = Date.now(),
) {
  const token = requiredEnv("CLOUDFLARE_READONLY_API_TOKEN", env);
  const accountId = requiredEnv("CLOUDFLARE_ACCOUNT_ID", env);
  const workerName = validateStagingWorkerName(
    requiredEnv("STAGING_WORKER_NAME", env),
  );
  const lookbackMinutes = Number(env.STAGING_LOOKBACK_MINUTES ?? 60);

  if (!/^[a-f0-9]{32}$/i.test(accountId)) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID must be a 32-character hexadecimal account ID");
  }
  if (
    !Number.isInteger(lookbackMinutes)
    || lookbackMinutes < 15
    || lookbackMinutes > 720
  ) {
    throw new Error("STAGING_LOOKBACK_MINUTES must be an integer from 15 through 720");
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("A Fetch-compatible function is required");
  }

  // Leave a 10-minute ingestion buffer so recent rows can settle.
  const end = new Date(now - 10 * 60 * 1000);
  const start = new Date(end.getTime() - lookbackMinutes * 60 * 1000);
  const window = {
    start: start.toISOString(),
    end: end.toISOString(),
    lookbackMinutes,
    ingestionDelayMinutes: 10,
  };

  const response = await fetchImpl(GRAPHQL_API, {
    method: "POST",
    headers: {
      authorization: "Bearer " + token,
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      query: STAGING_METRICS_QUERY,
      variables: {
        accountTag: accountId,
        datetimeStart: window.start,
        datetimeEnd: window.end,
        scriptName: workerName,
      },
    }),
    signal: AbortSignal.timeout(20000),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload || payload.errors?.length) {
    throw new Error(
      "Cloudflare staging analytics query failed with HTTP " + response.status,
    );
  }

  const rows = payload.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive;
  const summary = summarizeStagingWorkerMetricRows(rows);

  return {
    ...summary,
    workerName,
    window,
    readOnly: true,
    productionTouched: false,
  };
}

async function main() {
  const report = await runStagingWorkerCpuReport();
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

if (process.argv[1] && import.meta.url === new URL("file://" + process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(JSON.stringify({
      status: "REPORT_ERROR",
      readOnly: true,
      error: error instanceof Error ? error.message : "Unknown staging metrics error",
    }, null, 2) + "\n");
    process.exitCode = 1;
  });
}
