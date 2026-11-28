const DEPLOYMENTS_API = "https://api.cloudflare.com/client/v4";
const GRAPHQL_API = "https://api.cloudflare.com/client/v4/graphql";
export const METRIC_BUCKET_LIMIT = 1000;

const METRICS_QUERY = `
query GetWorkersAnalytics($accountTag: string, $datetimeStart: string, $datetimeEnd: string, $scriptName: string) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      aggregateMetrics: workersInvocationsAdaptive(limit: 1, filter: {
        scriptName: $scriptName,
        datetime_geq: $datetimeStart,
        datetime_leq: $datetimeEnd
      }) {
        sum {
          requests
          errors
        }
        quantiles {
          cpuTimeP50
          cpuTimeP99
        }
      }
      bucketMetrics: workersInvocationsAdaptive(limit: 1000, filter: {
        scriptName: $scriptName,
        datetime_geq: $datetimeStart,
        datetime_leq: $datetimeEnd
      }) {
        sum {
          requests
          errors
        }
        quantiles {
          cpuTimeP50
          cpuTimeP99
        }
        dimensions {
          datetime
          scriptName
          status
        }
      }
    }
  }
}`;

function requiredEnv(name, env = process.env) {
  const value = env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function requiredMetricNumber(value, label) {
  if (value === null || value === undefined || value === "") {
    throw new Error(`Cloudflare did not return ${label}`);
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`Cloudflare returned an invalid ${label}`);
  }
  return number;
}

function roundMs(value) {
  return Number(value.toFixed(3));
}

export function assertPinnedDeployment(deployment, expectedVersionId) {
  if (!deployment || !Array.isArray(deployment.versions) || deployment.versions.length !== 1) {
    throw new Error("Production Worker deployment is not pinned to exactly one version");
  }
  const [version] = deployment.versions;
  if (version.version_id !== expectedVersionId || version.percentage !== 100) {
    throw new Error("Production Worker version or traffic allocation differs from the frozen baseline");
  }
  return {
    deploymentId: deployment.id,
    versionId: version.version_id,
    percentage: version.percentage,
    createdOn: deployment.created_on,
  };
}

export function summarizeWorkerMetricRows(aggregateRows, bucketRows, options = {}) {
  const minimumRequests = options.minimumRequests ?? 100;
  const bucketLimit = options.bucketLimit ?? METRIC_BUCKET_LIMIT;
  const thresholds = {
    aggregateP50Ms: options.aggregateP50Ms ?? 20,
    aggregateP99Ms: options.aggregateP99Ms ?? 50,
    maxBucketP99Ms: options.maxBucketP99Ms ?? 50,
    maxErrors: options.maxErrors ?? 0,
  };

  if (!Array.isArray(aggregateRows) || aggregateRows.length !== 1) {
    throw new Error("Cloudflare did not return exactly one whole-window aggregate metrics row");
  }
  if (!Array.isArray(bucketRows) || bucketRows.length === 0) {
    throw new Error("Cloudflare returned no per-bucket Workers invocation metric rows for the selected window");
  }
  if (!Number.isInteger(bucketLimit) || bucketLimit < 1) {
    throw new Error("Metric bucket row limit must be a positive integer");
  }
  if (bucketRows.length >= bucketLimit) {
    throw new Error(
      `Cloudflare returned ${bucketRows.length} bucket rows at the ${bucketLimit}-row limit; completeness cannot be proven`,
    );
  }

  const aggregate = aggregateRows[0];
  const requests = requiredMetricNumber(aggregate.sum?.requests, "whole-window request count");
  const errors = requiredMetricNumber(aggregate.sum?.errors, "whole-window error count");
  const aggregateP50Ms = requiredMetricNumber(
    aggregate.quantiles?.cpuTimeP50,
    "whole-window CPU P50",
  ) / 1000;
  const aggregateP99Ms = requiredMetricNumber(
    aggregate.quantiles?.cpuTimeP99,
    "whole-window CPU P99",
  ) / 1000;

  if (requests < minimumRequests) {
    throw new Error(
      `Cloudflare metrics sample is insufficient: ${requests} requests; at least ${minimumRequests} required`,
    );
  }
  if (errors > thresholds.maxErrors) {
    throw new Error(`Production Worker invocation errors exceeded threshold: ${errors}`);
  }
  if (aggregateP50Ms > thresholds.aggregateP50Ms) {
    throw new Error(
      `Production Worker whole-window CPU P50 exceeded threshold: ${aggregateP50Ms.toFixed(3)} ms`,
    );
  }
  if (aggregateP99Ms > thresholds.aggregateP99Ms) {
    throw new Error(
      `Production Worker whole-window CPU P99 exceeded threshold: ${aggregateP99Ms.toFixed(3)} ms`,
    );
  }

  let bucketRequests = 0;
  let bucketErrors = 0;
  let maxBucketCpuP50Ms = 0;
  let maxBucketCpuP99Ms = 0;
  let bucketsAboveP50Threshold = 0;
  let requestsInBucketsAboveP50Threshold = 0;

  for (const [index, row] of bucketRows.entries()) {
    const rowRequests = requiredMetricNumber(
      row.sum?.requests,
      `bucket[${index}] request count`,
    );
    const rowErrors = requiredMetricNumber(
      row.sum?.errors,
      `bucket[${index}] error count`,
    );
    const bucketP50Ms = requiredMetricNumber(
      row.quantiles?.cpuTimeP50,
      `bucket[${index}] CPU P50`,
    ) / 1000;
    const bucketP99Ms = requiredMetricNumber(
      row.quantiles?.cpuTimeP99,
      `bucket[${index}] CPU P99`,
    ) / 1000;

    bucketRequests += rowRequests;
    bucketErrors += rowErrors;
    maxBucketCpuP50Ms = Math.max(maxBucketCpuP50Ms, bucketP50Ms);
    maxBucketCpuP99Ms = Math.max(maxBucketCpuP99Ms, bucketP99Ms);

    if (bucketP50Ms > thresholds.aggregateP50Ms) {
      bucketsAboveP50Threshold += 1;
      requestsInBucketsAboveP50Threshold += rowRequests;
    }
  }

  if (bucketRequests !== requests || bucketErrors !== errors) {
    throw new Error(
      `Cloudflare bucket totals do not match whole-window totals (requests ${bucketRequests}/${requests}, errors ${bucketErrors}/${errors}); bucket completeness cannot be proven`,
    );
  }
  if (maxBucketCpuP99Ms > thresholds.maxBucketP99Ms) {
    throw new Error(
      `Production Worker max bucket CPU P99 exceeded threshold: ${maxBucketCpuP99Ms.toFixed(3)} ms`,
    );
  }

  return {
    requests,
    errors,
    bucketCount: bucketRows.length,
    aggregateCpuP50Ms: roundMs(aggregateP50Ms),
    aggregateCpuP99Ms: roundMs(aggregateP99Ms),
    maxBucketCpuP50Ms: roundMs(maxBucketCpuP50Ms),
    maxBucketCpuP99Ms: roundMs(maxBucketCpuP99Ms),
    bucketsAboveP50Threshold,
    requestsInBucketsAboveP50Threshold,
    thresholds: {
      minimumRequests,
      ...thresholds,
      bucketRowLimit: bucketLimit,
    },
    aggregation: "whole-window aggregate CPU P50/P99; maximum per-bucket CPU P99 retained as a tail guard",
    bucketCompleteness: "bucket request/error totals must match whole-window totals; reaching the row limit fails closed",
  };
}

async function cloudflareGet(path, token) {
  const response = await fetch(`${DEPLOYMENTS_API}${path}`, {
    method: "GET",
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    signal: AbortSignal.timeout(15000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.success !== true) {
    throw new Error(`Cloudflare read-only deployment query failed with HTTP ${response.status}`);
  }
  return payload.result;
}

async function cloudflareMetrics(token, accountId, workerName) {
  const end = new Date(Date.now() - 10 * 60 * 1000);
  const start = new Date(end.getTime() - 60 * 60 * 1000);
  const response = await fetch(GRAPHQL_API, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      query: METRICS_QUERY,
      variables: {
        accountTag: accountId,
        datetimeStart: start.toISOString(),
        datetimeEnd: end.toISOString(),
        scriptName: workerName,
      },
    }),
    signal: AbortSignal.timeout(20000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload || payload.errors?.length) {
    throw new Error(`Cloudflare read-only metrics query failed with HTTP ${response.status}`);
  }
  const account = payload.data?.viewer?.accounts?.[0];
  if (!account) {
    throw new Error("Cloudflare returned no account metrics for the configured account ID");
  }
  const summary = summarizeWorkerMetricRows(
    account.aggregateMetrics,
    account.bucketMetrics,
  );

  return {
    start: start.toISOString(),
    end: end.toISOString(),
    summary,
  };
}

export async function runProductionDeploymentGate(env = process.env) {
  const token = requiredEnv("CLOUDFLARE_READONLY_API_TOKEN", env);
  const accountId = requiredEnv("CLOUDFLARE_ACCOUNT_ID", env);
  const workerName = env.PRODUCTION_WORKER_NAME || "serverless-edge-dns-gateway";
  const expectedVersionId = requiredEnv("EXPECTED_WORKER_VERSION_ID", env);
  if (!/^[0-9a-f-]{36}$/.test(expectedVersionId)) {
    throw new Error("EXPECTED_WORKER_VERSION_ID must be a UUID");
  }

  const path = `/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(workerName)}/deployments?per_page=1`;
  const deploymentResult = await cloudflareGet(path, token);
  const latest = deploymentResult.deployments?.[0];
  if (!latest) throw new Error("Cloudflare returned no production Worker deployment");
  const deployment = assertPinnedDeployment(latest, expectedVersionId);
  const metrics = await cloudflareMetrics(token, accountId, workerName);

  return {
    status: "PASS",
    readOnly: true,
    workerName,
    deployment,
    metrics,
  };
}

async function main() {
  const result = await runProductionDeploymentGate();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      status: "FAIL",
      readOnly: true,
      error: error instanceof Error ? error.message : "Unknown Cloudflare read-only gate error",
    }, null, 2)}\n`);
    process.exitCode = 1;
  });
}
