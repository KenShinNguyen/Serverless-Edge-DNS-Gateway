# Staging Bootstrap and First DNS Validation

This runbook creates an isolated staging data plane. It does not deploy or write to production.

## Why the order matters

A Worker with the `RULES_BUCKET` binding must load a valid, integrity-verified R2 snapshot before it can make ordinary DNS decisions. On a fresh install, if `compiled/latest.json` is absent, the selected shard is missing/corrupt, and there is no previously verified snapshot, the Worker intentionally returns DNS **SERVFAIL**. It does not silently treat the rule set as empty and forward the query upstream.

Therefore, publish and verify the first staging snapshot **before** exposing the new staging Worker.

## 1. Prepare local artifacts

Use Node.js 24 and the repository lockfile:

```bash
npm ci --ignore-scripts
npm run typecheck
npm test
npm run compile-rules
```

Compilation writes the monolithic compatibility binary, shard binaries, and manifest under `dist/rules/`. Do not edit those generated artifacts manually.

## 2. Create the isolated staging bucket

Authenticate Wrangler and create the bucket once:

```bash
npx wrangler login
npx wrangler r2 bucket create dns-compiled-rules-staging
```

If the bucket already exists in the intended account, do not create a second bucket with a similar name; confirm the exact bucket/account instead.

Create a dedicated R2 S3 API credential limited to **Object Read and Object Write** for `dns-compiled-rules-staging` only. Do not reuse a production publisher credential. The bucket name must match the binding in `wrangler.staging.jsonc`.

## 3. Dry-run, then publish only to staging

Set the target explicitly in the same shell that runs the publisher. **Never omit `R2_BUCKET_NAME`**. The publisher requires it and does not select a default bucket implicitly.

```bash
export CLOUDFLARE_ACCOUNT_ID="<32-character-account-id>"
export R2_BUCKET_NAME="dns-compiled-rules-staging"
export R2_ENDPOINT="https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com"
export R2_ACCESS_KEY_ID="<staging-object-read-write-access-key>"
export R2_SECRET_ACCESS_KEY="<staging-secret-access-key>"

# Inspect the exact target and planned objects first; this command does not write R2.
node scripts/publish-r2.mjs --dry-run

# Only after confirming the report names dns-compiled-rules-staging:
node scripts/publish-r2.mjs
```

Review the publisher output and independently verify the staging bucket's `compiled/latest.json`, binary, stats and all shard objects. The publisher writes immutable objects first and switches `compiled/latest.json` only after validation.

Remove credentials from the shell environment when finished:

```bash
unset R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_ENDPOINT R2_BUCKET_NAME CLOUDFLARE_ACCOUNT_ID
```

Do not put credentials in shell scripts, repository files, workflow logs, screenshots or issue/PR comments.

## 4. Deploy the staging Worker against the staging bucket

The checked-in `wrangler.staging.jsonc` has:

- Worker name: `serverless-edge-dns-gateway-staging`
- R2 binding: `RULES_BUCKET`
- R2 bucket: `dns-compiled-rules-staging`
- `workers_dev: true`

Deploy only this isolated configuration:

```bash
npx wrangler deploy --config wrangler.staging.jsonc
npx wrangler secret put DOH_TOKEN --config wrangler.staging.jsonc
```

Set a new staging-only token when Wrangler prompts. Do not reuse the production DoH token. Do not run `wrangler deploy` without `--config wrangler.staging.jsonc` as part of this staging runbook.

The endpoint has this shape:

```text
https://serverless-edge-dns-gateway-staging.<your-workers-subdomain>.workers.dev/dns-query/<staging-token>
```

Do not send test traffic until the staging token has been configured.

## 5. Validate ordinary DNS and blocking behavior

Use a DNS client or browser configured with the staging DoH URL. Check at minimum:

- Ordinary names such as `google.com`, `zalo.me`, and `github.com` resolve successfully.
- A known blocked test name from the compiled blocklist returns the expected blocked response.
- An allowed exception from the allowlist resolves normally.
- A known wildcard block test (for example `popads.net` and a subdomain) is blocked according to the suffix rules.
- When a staging-only selected shard is missing or corrupted in a **fresh test isolate**, the expected answer is SERVFAIL (RCODE 2), `Cache-Control: no-store`, and no upstream forwarding. Restore the staging fixture after fault injection.

A DNS failure during this phase is a HOLD. Check that the staging `compiled/latest.json` points to a snapshot whose monolith, stats and selected shard objects all exist and pass the SHA-256, EDNS-v1 layout, rule-count and byte-length checks. Do not work around a missing snapshot by weakening fail-closed behavior.

## 6. Collect staging CPU evidence

Add GitHub Actions secrets:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_READONLY_API_TOKEN` with Account Analytics Read permission

After controlled staging traffic has been generated, run **Actions → Staging Worker CPU Evidence → Run workflow** with `serverless-edge-dns-gateway-staging`.

The report is measurement-only. Its Free-plan observation criteria are:

- Maximum per-minute CPU P99 no greater than **10 ms**, including low-sample minute buckets.
- At least **80%** of the request volume returned by Analytics must be represented in minute buckets containing at least **10 requests** before qualified-bucket P50 is treated as adequately sampled.

Analytics may adaptively sample and extrapolate its `sum.requests` values; the reported coverage is not an independent raw-request census. A `WITHIN_OBSERVED_TARGETS` result is not an entitlement certification, a production release PASS, or proof that every individual invocation complied with the Free CPU limit. Keep the complete JSON report with the exact workload/window notes.

## 7. Production remains a separate decision

This runbook does not authorize a production deploy or publish. Keep production on its frozen baseline and keep the release HOLD until separately approved production read-only evidence, staging CPU evidence, DNS regression checks, plan/CPU-limit confirmation and rollback readiness have all been reviewed.

Never use `wrangler.jsonc`, `dns-compiled-rules`, production R2 credentials, the production DoH URL or the production token for staging experiments.
