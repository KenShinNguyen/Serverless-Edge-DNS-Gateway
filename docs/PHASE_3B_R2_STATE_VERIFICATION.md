# Phase 3B — R2 state verification

> **Status: implementation ready.** This gate verifies the production R2 snapshot state using the existing strict verifier. It is deliberately read-only.

## Scope

The manual workflow `R2 State Verification` runs `scripts/verify-r2-state.mjs` against the configured R2 bucket.

The verifier checks:

- `compiled/latest.json` exists and satisfies manifest invariants.
- Every retained history entry has a non-empty binary and stats object.
- Every retained binary passes EDNS-v1 validation.
- Every binary SHA-256 matches its manifest entry.
- Every binary rule count matches its manifest entry.
- Active stats JSON matches the active SHA and rule count.
- Missing/corrupt state fails closed.

## Read-only guarantee

The verifier only uses R2 `GetObject` and `HeadObject` operations. It does not issue `PutObject`, `DeleteObject`, or publish/rollback operations.

## Required GitHub Actions secrets

- `R2_ENDPOINT`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET_NAME`

The credentials should be scoped to the minimum R2 permissions required for read-only verification.

## Exit gate

A Phase 3B production-state verification is **PASS** only when the manual workflow returns:

```
{
  "status": "PASS",
  ...
}
```

No production deployment, R2 write, secret rotation, or Worker configuration change is part of this gate.

## Execution order

1. Run the workflow manually.
2. Capture the complete JSON result as evidence.
3. Confirm `status=PASS`.
4. Record the verified SHA, history count, revoked count, and per-entry byte/rule counts.
5. Keep the Wave 1 production Worker baseline unchanged.
