# Production Read-Only Exit Gate

**Purpose:** produce a bounded, auditable evidence bundle for the frozen production Worker and R2 snapshot before any release is considered.

This gate is deliberately manual-only. It does not deploy a Worker, change configuration, rotate secrets, publish/rollback R2, or change Cloudflare Pages settings.

## What the workflow reads

Run **Actions → Production Read-only Exit Gate → Run workflow**.

The workflow performs only these operations:

| Surface | Operation | Acceptance |
|---|---|---|
| Worker deployments API | HTTP GET | The first/latest production deployment serves version `456608ef-0dbc-4acb-86a8-39aaeea01400` at 100% |
| Workers Analytics GraphQL | Read-only GraphQL query | At least 100 requests in the measurement window, zero invocation errors, whole-window CPU P50 ≤ 20 ms and P99 ≤ 50 ms, plus maximum per-bucket CPU P99 ≤ 50 ms |
| Production DoH endpoint | One DNS-over-HTTPS POST query for `example.com A` | HTTP 200, `application/dns-message`, matching transaction ID/question, RCODE 0 and at least one answer |
| Production R2 | S3 `GetObject` and `HeadObject` only | Active manifest, binary SHA-256, rule count, byte length, active stats and every retained binary/stat object validate |

The CPU window is the 60 minutes ending 10 minutes before the workflow starts. The metrics query deliberately obtains two views of that same window:

1. **Whole-window aggregate quantiles** (`limit: 1`, without a `dimensions` selection): the primary CPU acceptance uses aggregate `cpuTimeP50` ≤ 20 ms and aggregate `cpuTimeP99` ≤ 50 ms. This avoids treating a one-request time bucket's P50 as the P50 of the full sample.
2. **Per-time-bucket diagnostics** (`limit: 1000`, grouped by `datetime`, `scriptName` and `status`): the gate retains the maximum bucket CPU P99 ≤ 50 ms as an independent tail guard. It reports the maximum bucket P50, the count of buckets whose P50 exceeds 20 ms, and the number of requests contained in those buckets. Bucket P50 outliers are diagnostic; they are not an independent blocker when the whole-window P50 passes.

The request and error totals in the bucket view must exactly match the whole-window totals. The detailed view fails closed when it returns **1,000 rows**, because reaching the configured row cap means completeness cannot be proven. It also fails if any required metric is missing or non-numeric. This prevents a truncated or partial bucket response from silently passing.

**This is an explicit acceptance-criteria change from the original Phase 3D implementation.** The thresholds remain 20 ms / 50 ms, but the P50/P99 population is now the full measurement window; the maximum per-bucket P99 remains as a separate tail guard. This is not a retrospective PASS for earlier evidence. Production evidence must be collected from a fresh measurement window after this change is merged; do not reuse the earlier 260-request probe to certify the revised gate.

Cloudflare's [Workers for Platforms observability example](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/observability/) demonstrates querying a Worker with `workersInvocationsAdaptive(limit: 1)`, selecting sums and CPU quantiles without dimensions. The standard [Querying Workers Metrics with GraphQL tutorial](https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/) demonstrates the time-dimension detail view. Cloudflare also notes that metrics can lag near the newest end of a time window.

## Required GitHub secrets

Create these secrets before running the workflow. The workflow intentionally does not fall back to existing publisher credentials.

| Secret | Required permission / value |
|---|---|
| `CLOUDFLARE_READONLY_API_TOKEN` | One token with **Workers Metadata Read-Only** scoped to `serverless-edge-dns-gateway`, plus **Account Analytics Read** for the account |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID |
| `PRODUCTION_DOH_URL` | Complete HTTPS production DoH URL. Keep this as a secret, especially if it contains a path token |
| `R2_READONLY_ENDPOINT` | Production account's R2 S3 endpoint |
| `R2_READONLY_ACCESS_KEY_ID` | R2 credential scoped to Object Read only for bucket `dns-compiled-rules` |
| `R2_READONLY_SECRET_ACCESS_KEY` | Secret for that Object Read-only R2 credential |

**Do not reuse** `R2_ACCESS_KEY_ID` or `R2_SECRET_ACCESS_KEY` from the publisher. Create a separate R2 credential limited to **Object Read** for the single production bucket. The verifier code imports only `GetObjectCommand` and `HeadObjectCommand`, and the workflow passes only the dedicated `R2_READONLY_*` secrets.

Cloudflare documents [Workers Metadata Read-Only](https://developers.cloudflare.com/workers/authorization/workers/) as sufficient for both [listing Worker deployments](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/list/) and using `wrangler tail`. The [Workers Analytics GraphQL query](https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/) additionally requires `Account Analytics Read`. No Workers Editor, Workers Scripts Write, R2 Object Write, or account administration permission is needed.

## CPU budget and account plan

The Gate's 20 ms / 50 ms values are observability acceptance thresholds; they are not a statement of the account's Workers CPU entitlement. Confirm the account's Workers plan and this Worker's configured CPU limit in Cloudflare Dashboard before release. Cloudflare currently documents a 10 ms per-request CPU limit on Workers Free and a 30-second default (configurable) on Workers Paid. Cloudflare also documents that infrequent requests can exceed a configured CPU limit through runtime rollover without necessarily generating an invocation error. Therefore, a high CPU quantile with zero errors still warrants investigation; it must not be described as proof that the Worker is safely within the account's plan limit.

See [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and [Workers CPU metrics](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/).

## Manual runtime evidence: Wrangler tail

The currently frozen production version `456608ef-0dbc-4acb-86a8-39aaeea01400` predates the Phase 3C `request_summary` event. For this frozen baseline, do **not** filter for `request_summary`; use an unfiltered short tail:

```bash
npx wrangler tail serverless-edge-dns-gateway --format json
```

Observe a short sample, then stop it with **Ctrl-C**. Inspect the legacy event's `outcome` and `exceptions` fields only. Do not enable native invocation logs, and do not copy raw request URLs or raw tail output into tickets/PRs because request metadata may contain secrets.

After a future approved deployment that includes Phase 3C request-summary logging, the separate post-deploy check can filter for `request_summary` and verify that the application event contains only:

- `event`: `request_summary`
- `method`
- normalized `route`
- HTTP `status`
- `durationMs`

Cloudflare's [current CLI reference](https://developers.cloudflare.com/workers/wrangler/commands/workers/) documents `wrangler tail --format json --search`, and the permission reference lists **Metadata Read-Only** as the minimum role for tailing a Worker.

## Manual Pages containment check

The repository cannot prove the settings of the separate Pages project through this workflow. In Cloudflare Dashboard → **Workers & Pages → serverless-tuannq → Deployments**, verify:

1. Production deployment remains on the operator-approved rollback baseline `9cb16f55` (or the exact deployment you have explicitly approved).
2. Automatic production branch deployments remain **OFF**.
3. Any deployment generated by this PR is identified as a **Preview**, not Production.

Record the check time, visible production deployment/commit and the auto-deploy state in your release evidence. Do not click rollback, retry deployment, or change branch controls as part of this gate.

## Release decision

The revised gate is **PASS** only when:

- The manual workflow completes with all three checks green.
- The frozen Worker version is still serving 100% of traffic.
- DNS smoke returns a valid A answer.
- Whole-window CPU P50 ≤ 20 ms and P99 ≤ 50 ms with at least 100 requests sampled and zero invocation errors.
- Maximum per-bucket CPU P99 ≤ 50 ms.
- Detailed bucket rows are complete (fewer than 1,000 rows) and their request/error totals match the whole-window aggregate totals.
- The report includes bucket count, maximum bucket P50, number of buckets with P50 > 20 ms and requests in those buckets.
- R2's active snapshot matches the frozen baseline: SHA prefix `2b1bea6d`, `366,391` rules, `8,785,954` binary bytes; every retained history binary also verifies.
- The manual Wrangler tail sample has been reviewed without disclosing raw request metadata.
- The Workers account plan / CPU limit and the Pages production rollback / auto-deploy containment checks are confirmed.

A missing secret, insufficient read-only permission, too-small metric sample, version drift, artifact drift, incomplete bucket detail, any failed CPU/error threshold, or unverified plan/Pages containment is **FAIL / HOLD**. Do not loosen numeric thresholds or substitute write-capable credentials to force a pass.

## Explicitly forbidden during this gate

- `wrangler deploy`, `wrangler versions deploy`, `wrangler rollback`
- R2 `PutObject`, `DeleteObjects`, rollback, unrevoke, or publisher workflow actions
- Worker variable/secret edits
- Pages rollback/redeploy or production branch-control changes

The workflow is manual-only, has `contents: read` permission, and does not run on `push`, `pull_request`, or a schedule.
