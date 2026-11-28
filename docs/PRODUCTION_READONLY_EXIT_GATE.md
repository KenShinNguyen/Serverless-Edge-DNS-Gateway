# Production Read-Only Exit Gate

**Purpose:** produce a bounded, auditable evidence bundle for the frozen production Worker and R2 snapshot before any release is considered.

This gate is deliberately manual-only. It does not deploy a Worker, change configuration, rotate secrets, publish/rollback R2, or change Cloudflare Pages settings.

## What the workflow reads

Run **Actions → Production Read-only Exit Gate → Run workflow**.

The workflow performs only these operations:

| Surface | Operation | Acceptance |
|---|---|---|
| Worker deployments API | HTTP GET | The first/latest production deployment serves version `456608ef-0dbc-4acb-86a8-39aaeea01400` at 100% |
| Workers Analytics GraphQL | Read-only GraphQL query | At least 100 requests in the measurement window, zero invocation errors, maximum adequately sampled minute-bucket CPU P50 ≤ 20 ms and maximum minute-bucket CPU P99 ≤ 50 ms |
| Production DoH endpoint | One DNS-over-HTTPS POST query for `example.com A` | HTTP 200, `application/dns-message`, matching transaction ID/question, RCODE 0 and at least one answer |
| Production R2 | S3 `GetObject` and `HeadObject` only | Active manifest, binary SHA-256, rule count, byte length, active stats and every retained binary/stat object validate |

The CPU window is the 60 minutes ending 10 minutes before the workflow starts. The Workers Analytics query groups records by **`datetimeMinute`**, not exact `datetime` (second-level timestamps). This produces one-minute buckets rather than allowing a one-request second bucket to define a P50.

### CPU metrics and units

The gate queries `cpuTimeP50` and `cpuTimeP99`. Cloudflare returns these CPU quantiles in **microseconds**. The script explicitly converts each value to milliseconds before comparing with the thresholds:

```text
cpuTime* (microseconds) / 1000 = CPU time (milliseconds)
```

The gate does **not** query `durationP50`. Duration is wall-clock time and includes waiting; it is not CPU time and must not be compared with CPU thresholds. Keep these units distinct in any manual analysis.

### Acceptance rules

- At least **100 requests** and exactly **0 invocation errors** across the selected measurement window.
- For P50, a minute bucket is considered adequately sampled only when it contains at least **20 requests**. The maximum CPU P50 across those qualified minute buckets must be **≤ 20 ms**. At least one qualified minute bucket must exist; otherwise the gate fails because P50 has not been meaningfully evaluated.
- Minute buckets with fewer than 20 requests remain visible in diagnostics. Their P50 values, including values above 20 ms, are informational and do not independently fail the P50 criterion. This avoids treating the P50 of a single cold-start request as a stable minute-level median.
- The maximum CPU P99 across **all** minute buckets, including low-volume buckets, must be **≤ 50 ms**. This preserves a separate tail guard so a low-sample cold-start outlier is not simply discarded.
- The report includes bucket count, qualified/low-sample bucket counts, maximum P50 across qualified buckets, maximum P50 across all buckets, maximum P99 across all buckets, and the number of P50-hot buckets / requests they contain.
- The GraphQL query uses a **1,000-row cap** and does not expose pagination for this result. If exactly 1,000 rows are returned, the gate fails closed because completeness cannot be proven.
- Missing, null, negative, or non-numeric request/error/CPU metrics fail closed.

**This is an explicit acceptance-criteria change from the original Phase 3D implementation.** The numeric thresholds remain 20 ms P50 and 50 ms P99, but the grouping resolution and P50 sample qualification are now explicit: one-minute buckets, at least 20 requests for a bucket's P50 to be judged, and a P99 tail guard over every bucket. The earlier 260-request second-bucket evidence is not a certification of this revised gate. Collect a fresh measurement window after this PR is merged.

Cloudflare's [Workers Metrics GraphQL tutorial](https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/) documents the `workersInvocationsAdaptive` dataset and its `cpuTimeP50` / `cpuTimeP99` fields. Cloudflare's GraphQL time dimensions include minute-level time bucketing; this gate explicitly selects `datetimeMinute`. The query's row limit is treated as a hard completeness boundary, not as a pageable result.

## Workers plan and CPU entitlement

The Gate's 20 ms / 50 ms values are observability acceptance thresholds; they are **not** the account's CPU execution limit.

Cloudflare currently documents a **10 ms CPU limit per request on Workers Free** and a default **30-second CPU limit per request on Workers Paid (Standard)**, configurable up to five minutes. Cloudflare also documents built-in flexibility for infrequent requests that exceed the configured CPU limit; repeated overruns are terminated, and Free-plan CPU exhaustion is surfaced as Error 1102 / `exceededCpu`. Therefore, a rare successful invocation above 10 ms is not sufficient proof that the account is on Paid. Confirm the actual Workers plan and Worker's configured CPU limit in Cloudflare Dashboard → **Workers & Pages → Plans / Worker Settings** before release.

See [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).

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
- At least 100 requests and zero invocation errors are recorded in the selected window.
- At least one adequately sampled minute bucket exists (20 or more requests), and maximum qualified-minute CPU P50 ≤ 20 ms.
- Maximum minute-bucket CPU P99 across every bucket ≤ 50 ms.
- Detailed minute buckets are fewer than 1,000 rows; no metric is missing or malformed.
- The report includes the required minute-bucket and P50 outlier diagnostics.
- The Workers plan and configured CPU limit are confirmed.
- R2's active snapshot matches the frozen baseline: SHA prefix `2b1bea6d`, `366,391` rules, `8,785,954` binary bytes; every retained history binary also verifies.
- The manual Wrangler tail sample has been reviewed without disclosing raw request metadata.
- The Pages production rollback and auto-deploy containment checks are confirmed.

A missing secret, insufficient read-only permission, too-small metric sample, no qualified P50 bucket, version drift, artifact drift, row-cap hit, missing metric, CPU/error threshold failure, or unverified plan/Pages containment is **FAIL / HOLD**. Do not loosen numeric thresholds or substitute write-capable credentials to force a pass.

## Explicitly forbidden during this gate

- `wrangler deploy`, `wrangler versions deploy`, `wrangler rollback`
- R2 `PutObject`, `DeleteObjects`, rollback, unrevoke, or publisher workflow actions
- Worker variable/secret edits
- Pages rollback/redeploy or production branch-control changes

The workflow is manual-only, has `contents: read` permission, and does not run on `push`, `pull_request`, or a schedule.
