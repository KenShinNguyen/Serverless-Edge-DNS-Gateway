const DEPLOYMENTS_API = "https://api.cloudflare.com/client/v4";
const GRAPHQL_API = "https://api.cloudflare.com/client/v4/graphql";
export const METRIC_BUCKET_LIMIT = 1000;
export const MIN_P50_BUCKET_REQUESTS = 20;
const MICROSECONDS_PER_MILLISECOND = 1000;

const METRICS_QUERY = `
query GetWorkersAnalytics($accountTag: string, $datetimeStart: string, $datetimeEnd: string, $scriptName: string) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      workersInvocationsAdaptive(limit: 1000, filter: {
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
          datetimeMinute
          scriptName
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

export function summarizeWorkerMetricRows(rows, options = {}) {
  const minimumRequests = options.minimumRequests ?? 100;
  const bucketLimit = options.bucketLimit ?? METRIC_BUCKET_LIMIT;
  const minP50BucketRequests = options.minP50BucketRequests ?? MIN_P50_BUCKET_REQUESTS;
  const thresholds = {
    maxMinuteP50Ms: options.maxMinuteP50Ms ?? 20,
    maxMinuteP99Ms: options.maxMinuteP99Ms ?? 50,
    maxErrors: options.maxErrors ?? 0,
  };

  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("Cloudflare returned no Workers invocation metric rows for the selected window");
  }
  if (!Number.isInteger(bucketLimit) || bucketLimit < 1) {
    throw new Error("Metric bucket row limit must be a positive integer");
  }
  if (rows.length >= bucketLimit) {
    throw new Error(
      `Cloudflare returned ${rows.length} minute buckets at the ${bucketLimit}-row limit; completeness cannot be proven`,
    );
  }
  if (!Number.isInteger(minP50BucketRequests) || minP50BucketRequests < 1) {
    throw new Error("Minimum P50 bucket request count must be a positive integer");
  }

  let requests = 0;
  let errors = 0;
  let maxMinuteCpuP50Ms = 0;
  let maxQualifiedMinuteCpuP50Ms = 0;
  let maxMinuteCpuP99Ms = 0;
  let qualifiedP50BucketCount = 0;
  let lowSampleP50BucketCount = 0;
  let bucketsAboveP50Threshold = 0;
  let requestsInBucketsAboveP50Threshold = 0;
  let lowSampleBucketsAboveP50Threshold = 0;
  let requestsInLowSampleBucketsAboveP50Threshold = 0;

  for (const [index, row] of rows.entries()) {
    const bucketRequests = requiredMetricNumber(
      row.sum?.requests,
      `minute bucket[${index}] request count`,
    );
    const bucketErrors = requiredMetricNumber(
      row.sum?.errors,
      `minute bucket[${index}] error count`,
    );

    // Cloudflare cpuTimeP50/cpuTimeP99 are microseconds. Convert to ms
    // before comparing with the gate's millisecond thresholds. This gate
    // does not query durationP50 (wall-clock duration).
    const minuteCpuP50Ms = requiredMetricNumber(
      row.quantiles?.cpuTimeP50,
      `minute bucket[${index}] CPU P50 (microseconds)`,
    ) / MICROSECONDS_PER_MILLISECOND;
    const minuteCpuP99Ms = requiredMetricNumber(
      row.quantiles?.cpuTimeP99,
      `minute bucket[${index}] CPU P99 (microseconds)`,
    ) / MICROSECONDS_PER_MILLISECOND;

    requests += bucketRequests;
    errors += bucketErrors;
    maxMinuteCpuP50Ms = Math.max(maxMinuteCpuP50Ms, minuteCpuP50Ms);
    maxMinuteCpuP99Ms = Math.max(maxMinuteCpuP99Ms, minuteCpuP99Ms);

    if (minuteCpuP50Ms > thresholds.maxMinuteP50Ms) {
      bucketsAboveP50Threshold += 1;
      requestsInBucketsAboveP50Threshold += bucketRequests;
    }

    // Low-volume minute buckets (for example, a single cold-start request)
    // are diagnostic for P50. Their P99 remains subject to the tail guard.
    if (bucketRequests >= minP50BucketRequests) {
      qualifiedP50BucketCount += 1;
      maxQualifiedMinuteCpuP50Ms = Math.max(
        maxQualifiedMinuteCpuP50Ms,
        minuteCpuP50Ms,
      );
    } else {
      lowSampleP50BucketCount += 1;
      if (minuteCpuP50Ms > thresholds.maxMinuteP50Ms) {
        lowSampleBucketsAboveP50Threshold += 1;
        requestsInLowSampleBucketsAboveP50Threshold += bucketRequests;
      }
    }
  }

  if (requests < minimumRequests) {
    throw new Error(
      `Cloudflare metrics sample is insufficient: ${requests} requests; at least ${minimumRequests} required`,
    );
  }
  if (errors > thresholds.maxErrors) {
    throw new Error(`Production Worker invocation errors exceeded threshold: ${errors}`);
  }
  if (qualifiedP50BucketCount === 0) {
    throw new Error(
      `No minute bucket contains at least ${minP50BucketRequests} requests; CPU P50 cannot be evaluated reliably`,
    );
  }
  if (maxQualifiedMinuteCpuP50Ms > thresholds.maxMinuteP50Ms) {
    throw new Error(
      `Production Worker max qualified minute CPU P50 exceeded threshold: ${roundMs(maxQualifiedMinuteCpuP50Ms)} ms (${bucketsAboveP50Threshold} minute buckets / ${requestsInBucketsAboveP50Threshold} requests above threshold)`,
    );
  }
  if (maxMinuteCpuP99Ms > thresholds.maxMinuteP99Ms) {
    throw new Error(
      `Production Worker max minute CPU P99 exceeded threshold: ${roundMs(maxMinuteCpuP99Ms)} ms`,
    );
  }

  return {
    requests,
    errors,
    bucketCount: rows.length,
    bucketGranularity: "1 minute",
    minimumRequestsPerP50Bucket: minP50BucketRequests,
    qualifiedP50BucketCount,
    lowSampleP50BucketCount,
    maxQualifiedMinuteCpuP50Ms: roundMs(maxQualifiedMinuteCpuP50Ms),
    maxMinuteCpuP50Ms: roundMs(maxMinuteCpuP50Ms),
    maxMinuteCpuP99Ms: roundMs(maxMinuteCpuP99Ms),
    bucketsAboveP50Threshold,
    requestsInBucketsAboveP50Threshold,
    lowSampleBucketsAboveP50Threshold,
    requestsInLowSampleBucketsAboveP50Threshold,
    thresholds: {
      minimumRequests,
      ...thresholds,
      bucketRowLimit: bucketLimit,
    },
    units: {
      source: "Cloudflare cpuTime quantiles: microseconds",
      reported: "milliseconds",
      conversion: "microseconds / 1000",
      durationP50: "not queried; wall-clock duration is not CPU time",
    },
    aggregation: "maximum per-minute CPU P50 for minute buckets with >= minimumRequestsPerP50Bucket; maximum per-minute CPU P99 across all buckets",
    lowSamplePolicy: "low-volume minute-bucket P50 outliers are diagnostic only; their P99 remains in the tail guard",
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
  const rows = payload.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive;
  return {
    start: start.toISOString(),
    end: end.toISOString(),
    summary: summarizeWorkerMetricRows(rows),
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
