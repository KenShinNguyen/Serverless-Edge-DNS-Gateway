# Workers 2026 migration

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
- CI executes the compiler as a quality gate but does not publish the artifact to R2 yet.

R2 publication and Worker-side snapshot reload remain deliberately separate from the compiler until the binary format passes the full regression matrix.

## Deliberately not included yet

The blocklist storage migration from Git-tracked text files to R2/KV is a separate step. The current rule update workflow remains the source of truth until the R2/KV compiler and rollback mechanism are tested. This avoids replacing a working data pipeline with an untested cron job.

## Deployment

Before production cutover:

1. Create the Worker from this branch with Wrangler/Workers Builds.
2. Set `UPSTREAM_PRIMARY`, `UPSTREAM_FALLBACK`, `UPSTREAM_GEO_BYPASS` and `DOH_TOKEN` as secrets/variables.
3. Set `ECS_MODE=selective` and populate `ECS_ALLOWLIST` only with domains that genuinely need client-subnet based CDN steering.
4. Verify `/dns-query/<token>`, Apple profile generation and normal web browsing.
5. Keep the Pages deployment available until the Worker passes the production test matrix.
