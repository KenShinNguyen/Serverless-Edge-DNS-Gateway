
# Staging Worker CPU Measurement

## Purpose

This is a measurement-only workflow for collecting Cloudflare Workers Analytics CPU quantiles from a separately deployed staging Worker. It does not certify production, change acceptance thresholds, or return a release-gate PASS.

The report queries one-minute buckets and preserves low-sample buckets. It converts Cloudflare CPU quantiles from microseconds to milliseconds. Wall-clock duration is not queried or substituted for CPU time.

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

None of these statuses is a production PASS. The report is intentionally descriptive: it records request/error totals, each minute bucket, max P50 across all buckets, max P50 for buckets with at least 10 requests, max P99 across all buckets, and max P99 among low-sample buckets.

## Interpretation

A 10-request bucket qualification is a reporting aid, not an execution policy. Do not discard low-sample P99 values. A rare successful request above the Free CPU allowance is not evidence of sustained compliance; conversely, a minute-bucket quantile is not an individual-request trace. Correlate the report with controlled staging runs and Cloudflare's actual invocation outcomes before deciding whether to alter integrity verification or the CPU Gate.

The Worker still performs per-shard SHA-256 verification when a table is first loaded into a given isolate, including a Cache API hit. This report measures end-to-end Worker CPU at the one-minute bucket level; it does not attribute CPU to the SHA-256 operation alone.
