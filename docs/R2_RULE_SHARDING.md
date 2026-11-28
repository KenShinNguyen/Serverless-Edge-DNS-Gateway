# EDNS-v1 Rule Sharding (256-way)

## Purpose

The sharded snapshot reduces cold-start CPU spent hashing and validating one large rule binary. It preserves the existing EDNS-v1 binary format and exact suffix-rule semantics. It is a storage/runtime format change, not a relaxation of integrity checks.

This branch is development-only. It does not publish to production R2, deploy a Worker, change Worker settings, or edit production secrets.

## Partition invariant

The compiler creates up to 256 data shards and an optional global table:

- A rule with one DNS label (for example, **com** or **lan**) goes into the global table.
- Every rule with two or more labels is assigned by FNV-1a 32-bit over its final two labels; the low 8 bits select a shard ID from **00** to **ff**.
- A QNAME selects its shard by the same function over its final two labels. A one-label QNAME selects the global table.

The important property is independent of public-suffix data: every multi-label suffix of a QNAME has the same final two labels as that QNAME. Therefore every multi-label rule that could match the QNAME is in the selected shard. One-label suffix rules are in the global table.

The runtime loads at most the global table (when present) and the one selected data shard. It evaluates both and chooses the match with the greatest matched suffix length, preserving the original most-specific-rule-wins behavior. ALLOW/BLOCK decisions are not combined by arbitrary table order.

Algorithm identifier: **fnv1a32-last-two-labels-v1**. Changing the routing function requires a new algorithm identifier and a compiler/runtime compatibility migration.

## Snapshot and compatibility contract

The top-level manifest remains **format: EDNS-v1** and retains the original fields:

- **version**, **sha256**, **key**, **stats**, **rules**, and **generatedAt**;
- **key** continues to point to the complete legacy **compiled/rules-{sha256}.bin** object.

A new optional **shards** property contains:

- **format: EDNS-v1-sharded**;
- the algorithm identifier and fixed shard count;
- an optional global descriptor;
- a sparse map of non-empty shard descriptors, each with its immutable R2 key, SHA-256, rule count, and byte length.

The complete legacy binary is intentionally retained with every sharded snapshot. A pre-sharding Worker ignores the extra **shards** property and continues reading the legacy **key**. A dual-reader Worker reads old manifests as monolithic snapshots and new manifests as shards. This supports a staged rollout and protects rollback to a pre-sharding Worker.

## Runtime load and integrity

For every loaded table, the runtime:

1. fetches only the relevant immutable object from R2, unless an integrity-checked Cache API copy is available;
2. calculates SHA-256 and compares it with the descriptor;
3. validates EDNS-v1 header, offsets, sentinel and byte layout;
4. checks the declared rule count and byte length;
5. only then creates the zero-copy lookup table and caches it.

Shard loads are single-flight per isolate. A shard-load failure does not replace the last working snapshot. When a replacement manifest is being evaluated, the runtime keeps the existing snapshot active until the requested tables from the replacement have passed integrity checks.

## Publisher, retention and rollback

The publisher validates the local monolithic artifact and every local shard before using R2 credentials. It uploads immutable objects first, verifies each object's ContentLength, and writes **compiled/latest.json** only after the compatibility binary, stats and all shard objects have passed verification.

The history entry retains its shard descriptors. Retention pruning recognizes both legacy rule/stats objects and all objects under **compiled/shards/{snapshot-sha}/**. Rollback verifies the target compatibility binary and every shard's SHA-256, EDNS-v1 structure, rule count and byte length before switching **latest.json**. The strict R2 verifier performs the same checks over every retained snapshot and remains read-only.

A legacy snapshot without **shards** remains a valid history entry. A same-SHA transition from a legacy manifest to a sharded manifest is handled explicitly: the publisher does not incorrectly treat it as unchanged; it publishes and validates the shard objects, then adds the metadata to the existing snapshot SHA.

## Validation required before production consideration

- Compiler: monolithic rule count equals the sum of global and data-shard rule counts.
- Differential lookup: for generated workloads, sharded decisions equal monolithic decisions, including one-label rules, overlapping suffixes, ALLOW overrides and most-specific matches.
- Runtime: only the selected shard plus global table are fetched; old monolithic manifests still load; corrupt or missing replacement shards do not displace the previous working snapshot.
- R2: each shard's SHA, EDNS-v1 structure, rule count and bytes validate; history/retention/rollback include the complete shard set.
- Performance: benchmark cold and warm Worker CPU on Workers Free. Node benchmark results are directional only and cannot establish production CPU compliance.
- Release: deploy a dual-reader Worker before publishing a sharded manifest. Keep the old monolithic snapshot and a documented rollback route. Production publish/deploy requires a separately approved change window.

Do not use a successful local compile or Node benchmark as a production PASS. Keep the release HOLD until fresh Worker measurements show the agreed Free-plan CPU criteria and no relevant DNS regressions.


## Cold-start failure semantics and memory

A configured R2 snapshot is not equivalent to an empty ruleset. If an isolate cannot load and verify the selected shard and has no previously verified snapshot to consult, the runtime returns `UNAVAILABLE`; the DNS handler responds with **SERVFAIL** and `Cache-Control: no-store`. It must not silently turn an integrity/load failure into `PASS`. If a verified previous snapshot exists, it remains the fallback. An absent shard descriptor in a valid manifest remains an authoritative empty result.

Use `npm run measure:memory` after `npm run compile-rules` to estimate the Node memory footprint of (a) one previous monolithic table plus (b) all active sharded tables loaded. The script reports `heapUsed`, `external`, `arrayBuffers`, and RSS deltas after forced GC where available. This is a directional Node process estimate, **not Cloudflare isolate memory evidence**; staging measurements remain mandatory.
