const DEPLOYMENTS_API = "https://api.cloudflare.com/client/v4";
const GRAPHQL_API = "https://api.cloudflare.com/client/v4/graphql";
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
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("Cloudflare returned no Workers invocation metric rows for the selected window");
  }

  let requests = 0;
  let errors = 0;
  const p50Values = [];
  const p99Values = [];

  for (const row of rows) {
    requests += Number(row.sum?.requests ?? 0);
    errors += Number(row.sum?.errors ?? 0);
    const p50 = Number(row.quantiles?.cpuTimeP50);
    const p99 = Number(row.quantiles?.cpuTimeP99);
    if (Number.isFinite(p50)) p50Values.push(p50);
    if (Number.isFinite(p99)) p99Values.push(p99);
  }

  if (requests < minimumRequests) {
    throw new Error(`Cloudflare metrics sample is insufficient: ${requests} requests; at least ${minimumRequests} required`);
  }
  if (!p50Values.length || !p99Values.length) {
    throw new Error("Cloudflare did not return CPU P50/P99 quantiles for the selected window");
  }

  // Cloudflare GraphQL CPU quantiles are expressed in microseconds; publish ms.
  const maxP50Ms = Math.max(...p50Values) / 1000;
  const maxP99Ms = Math.max(...p99Values) / 1000;
  const thresholds = {
    maxP50Ms: options.maxP50Ms ?? 20,
    maxP99Ms: options.maxP99Ms ?? 50,
    maxErrors: options.maxErrors ?? 0,
  };

  if (errors > thresholds.maxErrors) {
    throw new Error(`Production Worker invocation errors exceeded threshold: ${errors}`);
  }
  if (maxP50Ms > thresholds.maxP50Ms) {
    throw new Error(`Production Worker max bucket CPU P50 exceeded threshold: ${maxP50Ms.toFixed(3)} ms`);
  }
  if (maxP99Ms > thresholds.maxP99Ms) {
    throw new Error(`Production Worker max bucket CPU P99 exceeded threshold: ${maxP99Ms.toFixed(3)} ms`);
  }

  return {
    requests,
    errors,
    maxBucketCpuP50Ms: Number(maxP50Ms.toFixed(3)),
    maxBucketCpuP99Ms: Number(maxP99Ms.toFixed(3)),
    thresholds,
    aggregation: "maximum quantile across returned time buckets (conservative)",
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
