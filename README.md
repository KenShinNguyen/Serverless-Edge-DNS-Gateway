# 🛡️ Serverless Edge DNS Gateway
[English](README.md) | [Tiếng Việt](README_VN.md)

A secure, high-performance DNS-over-HTTPS (DoH) proxy running on Cloudflare's global Edge via Cloudflare Workers. Optimized for speed, geographic accuracy (ECS), and professional adblocking.

<p align="center">
  <img src="https://img.bibica.net/0Biaw3bp.webp" alt="ECS">
</p>

---

## ⚡ Key Features

*   **100% Free Usage**: Fully hosted on Cloudflare Workers with a limit of 100,000 requests per day. Given an average consumption of 200 – 4,000 requests per device daily, a single account can comfortably support 10 – 20 devices (or even 100 – 200 devices with casual usage).
*   **Custom Domain Scaling**: Attach your own domain for a professional, short DNS endpoint. You can spread usage across multiple Cloudflare accounts to multiply your quota (100k per account) while keeping your custom domains.
*   **Smart Adblocking**: Local filtering using professional lists (AdGuard, HaGeZi, etc.). Source lists are checked every 3 hours and changes are proposed as a guarded draft PR for review.
*   **ECS Geo-Optimization (RFC 7871)**: Injects EDNS Client Subnet (IPv4 `/24`, IPv6 `/48`) to ensure CDNs (Akamai, CloudFront, Fastly, BunnyCDN, Gcore) resolve you to the nearest servers.
*   **Sequential Failover Reliability**: 
    *   **Primary/Fallback**: Tries the primary upstream first, with automatic failover to a *different* backup resolver if it fails.
    *   **Geo-Bypass**: Automatically detects geo-blocked results (127.0.0.1) and re-resolves via **Mullvad DNS**.
*   **Optional Access Token**: Set a `DOH_TOKEN` environment variable to require `/dns-query/<token>`, keeping strangers from burning your free-tier quota.
*   **Early Response Filtering**: Drops unnecessary query types (`ANY`, `AAAA`, `PTR`, `HTTPS`) at the edge to save resources and improve speed.
*   **Private TLD Shield**: Prevents local/internal domain leaks (e.g., `.local`, `.lan`, router logins) by returning `NXDOMAIN` instantly.
*   **DNS Redirection (CNAME Injection)**: Redirects domain A to domain B using a CNAME record. This allows forcing a specific CDN chain or overriding resolution (e.g., Bilibili, TikTok, Medium).
*   **Zero-App Setup**: Native Apple `.mobileconfig` generation and a clean, responsive landing page included.
*   **Response Caching**: Every answer carries a `Cache-Control` header derived from the record TTLs (RFC 8484 §5.1, capped at 1 hour), so clients and Cloudflare's edge reuse answers instead of burning free-tier requests.

---

## 🚀 Deployment

### 1. Fork & Setup Actions
1. [Fork this project](../../fork) to your GitHub account.
2. Go to the **Actions** tab in your forked repository and click **I understand my workflows, go ahead and enable them**.
3. Enable `Update DNS Blocklists` and `Delete Old Workflow Runs`. (`Update Filter Lists` is the optional Layer 2 / CGPS workflow — leave it disabled unless you set up the secrets described [below](#-layer-2-cloudflare-gateway-security-filtering-cgps).)

`Update DNS Blocklists` checks its sources every 3 hours, applies minimum-count and maximum-drop guards, then opens or updates a **draft PR**. Review the draft PR, click **Ready for review** to trigger CI, then merge only after all checks pass. It does not push rule changes straight to `main`. While a rule-review PR is open, scheduled refreshes are skipped so its reviewed HEAD cannot silently move.

The `Compile and Publish Rules to R2` workflow is **manual-only** and defaults to `dry-run`. Choose `publish` explicitly only when you have approved a ruleset and intend to write Production R2.

### 2. Deploy to Cloudflare Workers
1. Connect the repository to Cloudflare Workers using the Workers build/deployment flow.
2. Set the required Worker variables/secrets described below.
3. Deploy with Wrangler or your configured Workers build pipeline.

---

## ⚙️ Configuration

Per-deployment settings (upstreams, access token, CORS) are read from **environment variables** — set them in Cloudflare Workers under **Settings > Variables and Secrets**, then redeploy. Feature toggles (adblock, ECS, query-type filtering) are configured in `src/index.ts` and `wrangler.jsonc`.

### Environment Variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `UPSTREAM_PRIMARY` | `https://cloudflare-dns.com/dns-query` | Main resolver URL. |
| `UPSTREAM_FALLBACK` | `https://dns.google/dns-query` | Backup resolver (use a *different* provider so failover actually helps). |
| `UPSTREAM_GEO_BYPASS`| `https://dns.mullvad.net/dns-query` | Used when upstream returns loopback (127.0.0.1). |
| `DOH_TOKEN` | *(empty)* | Optional access token. When set, all endpoints require it as a path segment: `/dns-query/<token>`, `/apple/<token>`, `/debug/<token>`. Untokened paths return 404. |
| `CORS_ORIGIN` | *(empty)* | Optional CORS origin. Native browser/OS DoH does **not** need CORS; set `*` only if you want websites to query the endpoint via JavaScript. |
| `DEBUG_ENABLED` | *(empty)* | Set `true` to enable the `/debug` endpoint. |

> [!IMPORTANT]
> Only **Cloudflare Gateway** ensures the most accurate CDN resolution for services like Akamai. Create your own [DNS location](https://dash.cloudflare.com/?to=/:account/one/networks/resolvers-proxies) in your Cloudflare account and set its DoH URL as `UPSTREAM_PRIMARY`.

> [!WARNING]
> **Never commit your personal Gateway URL to the repository.** This repo is public — anyone who forks it inherits your hardcoded upstream, routing *their* DNS traffic through *your* account (it fills your Gateway logs and attributes their lookups to you). If a Gateway URL ever leaks into git history, rotate it: create a new DNS location, update the `UPSTREAM_PRIMARY` environment variable, and delete the old location.

### Edge Filtering (Optimization)
| Constant | Default | Description |
| :--- | :--- | :--- |
| `BLOCK_AAAA` | `false` | Forces IPv4 routing by blocking AAAA. |
| `BLOCK_HTTPS` | `false` | Prevents Type 65 lookups (speeds up resolution). |
| `BLOCK_ANY` | `false` | Blocks resource-heavy ANY queries. |
| `BLOCK_PTR` | `false` | Blocks reverse DNS queries. |
| `BLOCK_PRIVATE_TLD` | `true` | Blocks internal/router domains. |
| `ECS_INJECTION_ENABLED` | `true` | Enables ECS Injection (Required for accurate CDN). |

---

## 🛠 Rule Management (`rules/`)

Rules are located in the `rules/` folder. After reviewing and merging rule changes to `main`, run `Compile and Publish Rules to R2` manually. Its default action is `dry-run`; choose `publish` explicitly to write a new Production R2 snapshot.

Detailed rules:

*   **`blocklists.txt`**: A scheduled GitHub Actions workflow checks source lists every 3 hours and creates or refreshes a draft PR; it never commits directly to `main`.
    *   **Matching is wildcard**: an entry blocks that domain *and every subdomain under it*, walking from the queried name up to the apex and stopping at the first hit. This mirrors how the sources are published — hagezi's `wildcard/<list>-onlydomains.txt` strips subdomains on purpose, and only ~1.5% of the merged list are subdomains of another entry, so exact matching used to let most real ad hostnames through (`doubleclick.net` was blocked while `googleads.g.doubleclick.net` resolved normally).
    *   **Allowlist precedence is per level**, so the most specific rule wins: an allowlisted `foo.example.com` stays reachable under a blocked `example.com`, and a blocked `ads.example.com` stays blocked under an allowlisted `example.com`.
    *   **How to configure**: Edit the URLs in the `curl` command inside [update_lists.sh](update_lists.sh) to add or remove filtering sources.
    *   **Safety guards**: source downloads must pass the existing 50,000-domain minimum and source-failure checks. The final blocklist must remain at least 50,000 entries and the allowlist at least 100; either candidate is rejected if it shrinks by more than 20% compared with the previous committed file. Overrides: `MIN_DOMAINS`, `MIN_ALLOW_DOMAINS`, `MIN_FINAL_BLOCK_DOMAINS`, `MIN_FINAL_ALLOW_DOMAINS`, `MAX_BLOCKLIST_DROP_PERCENT`, and `MAX_ALLOWLIST_DROP_PERCENT`.
*   **`allowlists.txt`**: Generated by the same workflow, from two places: the AdGuard exclusion/exception sources, and every `@@` exception rule found in the blocklist sources themselves. Domains here override `blocklists.txt` and are subtracted from it at build time, so a domain can never be on both lists.
    *   **Why `@@` matters**: in AdBlock syntax `@@||example.com^` means *do not block* `example.com`. Feeding that rule into the blocklist would block exactly the domains a filter author deliberately exempted, so exceptions are routed to the allowlist instead.
    *   **Only whole-domain rules are used**: cosmetic rules (`site.com##.ad-box`), modifier rules (`||site.com^$popup`, `$third-party`, `$domain=`) and regex rules are skipped. Each narrows a rule to a context DNS cannot see, and stripping the qualifier would turn "hide a banner on this site" into "block this site entirely" — which is how a browser-oriented list can take a major site offline.
    *   **Note**: this file is overwritten on every run — put permanent manual entries in the filter sources or re-add them after a run.
*   **`private_tlds.txt`**: Add your custom local domains or router URLs here.
*   **`redirect_rules.txt`**: Redirects domain A to domain B using a CNAME record. Perfect for forcing specific CDN results.
    *   **Format**: `source-domain target-domain`
    *   **Example**: `www.bilibili.tv www.bilibili.tv.w.cdngslb.com`
    *   **Effect**: If `www.bilibili.tv` randomly returns multiple CDNs (e.g., GSLB or Akamai), this rule forces it to always use `www.bilibili.tv.w.cdngslb.com`.

---

## 🧱 Layer 2: Cloudflare Gateway Security Filtering (CGPS)

This project pairs naturally with [cloudflare-gateway-pihole-scripts (CGPS)](../../../cloudflare-gateway-pihole-scripts) in a **two-layer filtering architecture**, since the upstream (`UPSTREAM_PRIMARY`) is already a Cloudflare Gateway DoH endpoint:

```
Device ──DoH──▶ Cloudflare Worker (Layer 1: ads/tracking ~1M domains, ECS, redirects)
                      │
                      ▼
            Cloudflare Gateway (Layer 2: CGPS-managed malware/phishing lists
                      │          + built-in Zero Trust security categories)
                      ▼
                 Internet DNS
```

**Division of labor (avoids wasting the 300k-domain Gateway quota):**

| Layer | Handles | Lists |
| :--- | :--- | :--- |
| Edge (this project) | Ads, tracking, gambling, telemetry | HaGeZi Pro++, AdGuard DNS, etc. (`update_lists.sh`) |
| Gateway (CGPS) | Phishing, scam, ransomware | blocklistproject phishing + scam + ransomware, ~200k domains ([.github/workflows/Update_Gateway_Security_Lists.yml](.github/workflows/Update_Gateway_Security_Lists.yml)) |

> [!WARNING]
> **Do not enable this workflow if you already run CGPS elsewhere against the same Cloudflare account** — for example a separate `cloudflare-gateway-pihole-scripts` repo that pushes ad blocklists to Gateway. CGPS hardcodes its list names (`CGPS List - Chunk N`) and rule name (`CGPS Filter Lists`), so two CGPS instances on one account overwrite each other: whichever runs last claims the leading chunks. There is no namespace to keep the two sets apart. The free plan's 300,000-item quota makes it moot anyway — a ~298k ad list plus the ~200k security list is ~500k, well over the cap.
>
> In that situation, get malware/phishing coverage from the built-in **Security Categories** instead: free, maintained by Cloudflare, and exempt from the 300k quota. This workflow only makes sense when your Gateway is dedicated to security and Layer 1 handles all ad blocking at the edge.

**Setup notes:**

*   The Layer 2 workflow lives **in this repo** (it checks out the CGPS code from `mrrfv/cloudflare-gateway-pihole-scripts@v1` at runtime, so no separate repo is needed). It is **manual-only** (`workflow_dispatch`) — there is deliberately no schedule, so it cannot silently overwrite lists another CGPS instance owns. Running it requires two repository secrets: `CLOUDFLARE_API_TOKEN` (Zero Trust read/edit permissions) and `CLOUDFLARE_ACCOUNT_ID`.
*   Use the **same Cloudflare account** that owns the Gateway endpoint configured in `UPSTREAM_PRIMARY` / `UPSTREAM_FALLBACK`.
*   [rules/allowlists.txt](rules/allowlists.txt) is the **shared allowlist**: the Edge layer reads it directly and the Layer 2 workflow pulls the same file via raw URL, so both layers exempt the same domains. It is regenerated by the Layer 1 workflow, so permanent entries belong in that workflow's allowlist sources, not in the file itself. Layer 2 picks up allowlist changes the next time you run it manually.
*   The workflow **fails loudly if a source list breaks**. CGPS's downloader does not check HTTP status — a 404 silently produces an empty list and still reports success — so a verification step aborts the run when the blocklist has fewer than 50,000 domains (override with the `MIN_BLOCK_DOMAINS` Actions variable).
*   Additionally enable the built-in **Security Categories** (malware, phishing, new domains) in your Zero Trust Gateway policies — they are free and do not count against the 300k list quota.
*   Keep the Gateway block response at its default (`0.0.0.0`). Do **not** use a block response of `127.0.0.1` — the Geo-Bypass logic treats loopback answers as geo-blocking and would re-resolve (unblock) them via Mullvad.

---

## 📱 Setup Instructions

### Browsers (Chrome / Edge / Firefox)
1.  Go to **Settings** > **Privacy and Security** > **Security**.
2.  Enable **"Use secure DNS"** and select **"Custom"**.
3.  Paste your endpoint: `https://<your-worker-subdomain>.workers.dev/dns-query` (or your configured custom domain).

### Apple (iOS / macOS)
1.  Open your project URL in **Safari**.
2.  Click **Download Apple Profile** and install via system settings.

### Android (Intra App)
1.  Open Intra > **Configure custom server URL**.
2.  Paste your `/dns-query` endpoint and toggle ON.

---

## 🔎 API & Endpoints

| Endpoint | Description |
| :--- | :--- |
| `/dns-query` | The DoH resolver endpoint. |
| `/debug` | Returns a JSON summary of config, stats, and rule counts (requires `DEBUG_ENABLED=true`). |
| `/apple` | Generates a native Apple `.mobileconfig` profile for iOS/macOS. |

> [!NOTE]
> When `DOH_TOKEN` is set, append it to every endpoint: `/dns-query/<token>`, `/debug/<token>`, `/apple/<token>`. The generated Apple profile automatically embeds the tokened URL.

`/dns-query` accepts both `POST` (body `application/dns-message`) and `GET` (`?dns=<base64url>`) per RFC 8484. Each decoded DNS message is limited to **65,535 bytes**. Oversized requests receive HTTP `413`; malformed messages, response packets (`QR=1`), and queries without a question receive `400` before an upstream request is spent.

---

## 🧪 Development

The DNS layer in `src/index.ts` is a hand-written wire-format parser and serializer, with a Worker-native test suite. Node 24 and the repository's package scripts are used for local verification:

```bash
node --test 'test/*.test.mjs'
```

| File | Covers |
| :--- | :--- |
| `test/wire.test.mjs` | Name/label walking, question parsing, and the synthesized NXDOMAIN / NODATA / SERVFAIL replies. |
| `test/filtering.test.mjs` | Blocklist/allowlist precedence, private-TLD and Mullvad suffix matching, list-file parsing. |
| `test/caching.test.mjs` | TTL extraction and the `Cache-Control` header derived from it. |
| `test/ecs.test.mjs` | ECS injection, prefix masking, OPT replacement, and rejection of malformed client IPs. |
| `test/redirect.test.mjs` | QNAME rewriting and CNAME response synthesis. |
| `test/handler.test.mjs` | End-to-end routing: token gating, failover, geo-bypass, `/debug`, `/apple`, CORS. |

CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs these on every pull request, alongside `shellcheck` on `update_lists.sh` and sanity checks on the hand-maintained rule files.

### Privacy-safe request logs

Workers Logs are enabled with 5% sampling, query-string redaction, and native invocation logs disabled. The Worker emits a compact application summary containing only `method`, normalized `route`, HTTP `status`, and `durationMs`. It deliberately does not log the raw URL/path (the optional `DOH_TOKEN` is a path segment), DNS names, client IPs, or request headers. Keep `invocation_logs` disabled unless the token is moved out of the URL path and a separate privacy review approves it.

---
