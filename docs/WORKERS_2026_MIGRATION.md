# Workers 2026 migration

> **Status: COMPLETE.** The Worker runtime is now the active architecture; legacy Pages runtime artifacts are removed in Wave 2C. Production deployment remains frozen during this cleanup.

This branch migrates the runtime from Cloudflare Pages Functions to a Cloudflare Workers module with Static Assets.

## What changed

- Added `wrangler.jsonc` with a Workers entrypoint and Static Assets binding.
- Added `src/index.ts`, preserving the existing DNS wire-format implementation and routing behavior.
- Added `public/index.html` as the static asset entrypoint.
- Added `package.json` for Wrangler/TypeScript tooling.
- Added Worker environment controls for upstreams, DoH token, debug mode, query-type blocking and selective ECS.
- Updated CI to Node 24 and current checkout/setup-node actions.

## Security defaults

- No personal Cloudflare Gateway URL is embedded in the Worker.
- `DOH_TOKEN` remains optional, but production deployments should set it.
- `DEBUG_ENABLED` is disabled by default.
- `BLOCK_AAAA` and `BLOCK_HTTPS` remain false so IPv6/HTTPS DNS records are not disabled by default.
- `ECS_MODE=selective` only injects ECS for domains listed in `ECS_ALLOWLIST`; `ECS_MODE=off` disables ECS.

## ECS upstream routing

Selective ECS now uses a dedicated upstream path:

- Non-ECS queries: `UPSTREAM_PRIMARY` → `UPSTREAM_FALLBACK`.
- ECS-eligible queries: `UPSTREAM_ECS` → `UPSTREAM_ECS_FALLBACK`.
- Defaults are Google Public DNS and Quad9's ECS-enabled `dns11` endpoint for the ECS path.
- The default allowlist contains major CDN suffixes; deployments can replace it with `ECS_ALLOWLIST`.

This separation is intentional. Cloudflare 1.1.1.1 does not send ECS, while Quad9 documents `dns11.quad9.net` as its ECS-enabled service.

## Binary rules Phase 2

The branch now contains:

- `src/rules-engine.ts`: zero-copy binary lookup with longest-suffix precedence.
- `scripts/compile-rules.mjs`: deterministic compiler, ALLOW-over-BLOCK conflict resolution, SHA-256 immutable filenames, and critical-domain canaries.
- CI executes the compiler as a quality gate.
- Phase 3 adds an atomic R2 publisher using immutable SHA-256 object names and a pinned five-version history ring.
- `compiled/latest.json` is written last and acts as the single Worker snapshot pointer.

### R2 runtime state

The `RULES_BUCKET` binding changes the AD-block path from the legacy text lists to `RuleSnapshotManager`. A configured but empty bucket is therefore **not** the same as an absent binding: the Worker enters a 60-second negative cooldown and returns `PASS` until a valid `compiled/latest.json` is published. This is an intentional fail-open availability trade-off for first initialization.

The Worker never compiles the large text lists. It loads the immutable binary only after validating the manifest key, SHA-256 digest and binary format, then atomically swaps the active in-memory snapshot. A failed refresh keeps the previous valid snapshot.

### Phase 3 publish safety

The publisher uses the R2 S3-compatible API with bucket-scoped Object Read & Write credentials. The release order is:

1. Upload `rules-{sha}.bin` and `stats-{sha}.json`.
2. HEAD both objects and verify exact byte lengths.
3. Write `compiled/latest.json` last.
4. Read the pointer back and verify the published SHA/key.
5. Retain exactly five unique SHA entries from the explicit history ring.
6. Delete only unpinned `rules-{sha}.bin` and `stats-{sha}.json` objects.

Retention is deliberately **not** based on `LastModified`, because a revert can reuse an old content SHA. The SHA pinned in `latest.json.history` is the source of truth for rollback retention. R2 Lifecycle is not used for these compiled artifacts.

The publisher workflow is serialized with GitHub Actions concurrency and uses `contents: read` only. Dry-run mode compiles and validates the artifact without writing to R2.

## Deliberately not included yet

The blocklist storage migration from Git-tracked text files to R2/KV is a separate step. The current rule update workflow remains the source of truth until the R2/KV compiler and rollback mechanism are tested. This avoids replacing a working data pipeline with an untested cron job.

## Deployment

Before production cutover:

1. Create the Worker from this branch with Wrangler/Workers Builds.
2. Set `UPSTREAM_PRIMARY`, `UPSTREAM_FALLBACK`, `UPSTREAM_GEO_BYPASS` and `DOH_TOKEN` as secrets/variables.
3. Set `ECS_MODE=selective` and populate `ECS_ALLOWLIST` only with domains that genuinely need client-subnet based CDN steering.
4. Verify `/dns-query/<token>`, Apple profile generation and normal web browsing.
5. Keep the production Worker baseline frozen while completing post-migration cleanup and parity verification.


## Phase 3A — Runtime observability contract

The Worker keeps production deployment frozen while the R2 snapshot health surface is verified as an operational contract.

The authenticated-by-configuration `/debug` route exposes non-secret snapshot state:

- `ready`: an R2 snapshot is active and healthy.
- `stale`: a previously loaded snapshot remains active after a refresh error.
- `degraded`: no R2 snapshot is active and the Worker has recorded a load error; the embedded fallback remains available.
- `sha256` and `ruleCount`: identify the active immutable snapshot without exposing the R2 credentials or account configuration.

Phase 3A tests lock both the healthy and malformed-manifest paths. This is an observability/test gate only; it does not require a production deployment or a production R2 write.


## Phase 3C — Operational hardening

Phase 3C hardens the operational path without deploying the Worker or writing to Production R2.

### Rule update pipeline

- `Update DNS Blocklists` checks its sources every three hours and opens or updates a draft PR on `automation/dns-blocklists`; it does not push directly to `main`.
- The updater uses `GITHUB_TOKEN`; after inspecting a draft candidate, an operator marks it ready for review. The CI workflow explicitly listens for `ready_for_review`, so the final tests run before a human merges the candidate.
- While the automation branch has an open PR, subsequent scheduled refreshes skip rather than mutate that PR's HEAD. The next refresh resumes after the review PR is merged or closed.
- The script builds both list candidates before replacing either tracked file. Source failures, absolute floors, and previous-file drop guards fail closed.
- Defaults: blocklist floor 50,000 entries, allowlist floor 100 entries, maximum 20% shrink for each list, and no more than half of sources failing in either source group.
- Rule PRs require human review and merge before they become inputs to a release.

### R2 publication boundary

- `publish-rules-r2.yml` is manual-only; the six-hour production publish schedule has been removed.
- The default dispatch action is `dry-run`. A human operator must explicitly choose `publish` to write the R2 snapshot.
- This gate does not execute a publish or a production R2 write.

### DoH body limits

- POST bodies are read incrementally and cancelled as soon as the cumulative size exceeds 65,535 bytes.
- GET base64url input is length-checked and the decoded DNS message is checked against the same 65,535-byte cap.
- Oversized requests receive HTTP 413; malformed DNS messages continue to receive HTTP 400.

### Privacy-safe observability

- Workers Logs are enabled at 5% sampling; query-string redaction is enabled.
- Native invocation logs remain disabled because the optional `DOH_TOKEN` is part of the request path and URL redaction does not remove path segments.
- Application summaries contain only method, normalized route, HTTP status, and duration. Raw URL/path, DNS question names, client IPs, and request headers are deliberately excluded.

### Exit guardrails

- No production Worker deployment.
- No Production R2 write.
- No Worker secret or variable changes.
- Pages rollback and automatic production branch deployment containment remain untouched.


## Phase 3D — Production Read-Only Exit Gate

See [Production Read-Only Exit Gate](PRODUCTION_READONLY_EXIT_GATE.md) for the manual-only Worker version pin, DNS smoke, CPU/error metrics, R2 artifact-integrity checks, Wrangler tail procedure, Pages containment checklist, required read-only credentials, and explicit no-mutation guardrails.
