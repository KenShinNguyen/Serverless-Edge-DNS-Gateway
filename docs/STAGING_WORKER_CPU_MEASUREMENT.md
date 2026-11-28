
# Staging Worker CPU Measurement

## Purpose

This is a measurement-only workflow for collecting Cloudflare Workers Analytics CPU quantiles from a separately deployed staging Worker. It does not certify production, change acceptance thresholds, or return a release-gate PASS.

The report queries one-minute buckets and preserves low-sample buckets. It converts Cloudflare CPU quantiles from microseconds to milliseconds. Wall-clock duration is not queried or substituted for CPU time. The query groups by minute and Worker name only; it does not split one minute by invocation status.

## Safety boundary

- The workflow is manual-only and uses CLOUDFLARE_READONLY_API_TOKEN plus CLOUDFLARE_ACCOUNT_ID.
- It sends one GraphQL query to Workers Analytics. It does not call deployment mutation APIs.
- The Worker name must end in -staging; the production Worker name is rejected before a request is sent.
- It does not call the DNS endpoint, deploy a Worker, publish or mutate R2, change Worker variables/secrets, or invoke the production exit Gate.
- The current wrangler.jsonc binds the production bucket dns-compiled-rules. Do not use that configuration to deploy a staging Worker. A staging Worker must be separately deployed and bound only to a distinct staging bucket.

## Prepare staging

1. Create a separate R2 bucket, for example dns-compiled-rules-staging.
2. Use the committed wrangler.staging.jsonc. It names the Worker serverless-edge-dns-gateway-staging, enables workers.dev, and binds RULES_BUCKET only to dns-compiled-rules-staging. Do not reuse the production wrangler.jsonc for a staging deployment. After creating the bucket, deploy the isolated config with: npx wrangler deploy --config wrangler.staging.jsonc.
3. First run a dry-run with R2_BUCKET_NAME=dns-compiled-rules-staging and staging-only R2 endpoint/credentials. Only after validating the planned objects, publish to that staging bucket using the same staging-only values. Never point the publisher at the production bucket or use production publisher credentials.
4. Configure a staging-only DoH token with npx wrangler secret put DOH_TOKEN --config wrangler.staging.jsonc and keep the staging endpoint separate from the production endpoint.
5. Generate a controlled staging workload. Include enough requests to create adequately sampled minute buckets and retain the exact test window and workload shape in the evidence notes.

Staging bucket creation, Worker deployment, artifact publication and traffic generation are deliberately operator-controlled prerequisites; this workflow does none of them.

## Run the report

In GitHub Actions, choose Staging Worker CPU Evidence -> Run workflow.

- worker_name: the staging Worker script name; it must end in -staging.
- lookback_minutes: 15 through 720. The window ends 10 minutes before the workflow starts to allow analytics ingestion.

Required GitHub secrets:

- CLOUDFLARE_READONLY_API_TOKEN: Account Analytics Read permission for the account.
- CLOUDFLARE_ACCOUNT_ID: the 32-character account ID.

The workflow uploads staging-worker-cpu-report.json as an artifact. Report statuses mean:

- MEASURED: rows returned, below the 1,000-row cap, CPU quantiles present.
- INCOMPLETE: the 1,000-row limit was reached or one or more CPU quantiles were missing.
- NO_DATA: no rows were returned.

The query requests exactly the `datetimeMinute` and `scriptName` dimensions. It deliberately omits `status`: status is also a Workers Analytics dimension, and selecting it would split invocations from the same minute into separate rows. The minimum-10-request qualification must apply to a complete minute across invocation statuses, not to a status fragment.

The report includes request/error totals, all minute buckets, P50/P99 quantiles, the request count in qualified (at least 10 request) minute buckets, and the percentage of returned request volume represented by those qualified buckets. It also reports `freeCpuEvidence` separately from the top-level report status:

- P99 target: maximum `cpuTimeP99` across **all** minute buckets, including low-sample buckets, must be **≤ 10 ms**.
- P50 sample coverage: at least **80%** of the returned request count must belong to minute buckets with at least **10 requests**. The report calculates the maximum P50 over those qualified minute buckets.
- A result of `WITHIN_OBSERVED_TARGETS` means only that the returned Analytics evidence met these two observation criteria. It is not a production release PASS, an entitlement/plan certification, or proof that every individual invocation stayed below the Free CPU limit.

Possible `freeCpuEvidence.status` values are `NO_DATA`, `INCOMPLETE`, `NO_TRAFFIC`, `P99_ABOVE_TARGET`, `INSUFFICIENT_QUALIFIED_COVERAGE`, and `WITHIN_OBSERVED_TARGETS`. A report can be `MEASURED` while its Free evidence is above target or has insufficient qualified traffic.

## Interpretation

A 10-request bucket qualification is used only to decide whether a minute's P50 sample is sufficiently populated. The 80% coverage ratio is calculated from the `sum.requests` values returned by Cloudflare's `workersInvocationsAdaptive` dataset; it is therefore subject to Cloudflare Analytics adaptive sampling and extrapolation, not an independently counted raw-request census. Cloudflare documents that Analytics can select 100%, 10%, or 1% resolutions and extrapolate aggregate metrics. Keep that sampling caveat with the evidence, and do not assume `MEASURED` means the query used 100% resolution. See [Understanding sampling in Cloudflare Analytics](https://developers.cloudflare.com/analytics/sampling/).

Do not discard low-sample P99 values. A rare successful request above the Free CPU allowance is not evidence of sustained compliance; conversely, a minute-bucket quantile is not an individual-request trace. Correlate the report with controlled staging runs and Cloudflare's actual invocation outcomes before deciding whether to alter integrity verification or the CPU Gate.

The Worker still performs per-shard SHA-256 verification when a table is first loaded into a given isolate, including a Cache API hit. This report measures end-to-end Worker CPU at the one-minute bucket level; it does not attribute CPU to the SHA-256 operation alone.


## Cold-start fault injection and memory prerequisite

Before any staging publish is considered, test a fresh isolate against two staging-only fault fixtures: a missing selected shard and a selected shard with corrupted bytes. With no previous snapshot, the expected DNS result is **SERVFAIL (RCODE 2)**, `Cache-Control: no-store`, and no upstream request. With an already verified previous snapshot, the expected result is the previous snapshot's decision. These tests must not be performed against production R2.

Run `npm run compile-rules` followed by `npm run measure:memory`. Record the Node-only memory estimate for one previous monolithic table plus all active shards as a conservative loaded-shard upper bound. This is not a substitute for measuring Worker isolate memory on staging.
