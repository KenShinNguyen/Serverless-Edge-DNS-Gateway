# 🛡️ Serverless Edge DNS Gateway
[English](README.md) | [Tiếng Việt](README_VN.md)

A secure, high-performance DNS-over-HTTPS (DoH) proxy running on Cloudflare's global Edge via Pages Functions. Optimized for speed, geographic accuracy (ECS), and professional adblocking.

<p align="center">
  <img src="https://img.bibica.net/0Biaw3bp.webp" alt="ECS">
</p>

---

## ⚡ Key Features

*   **100% Free Usage**: Fully hosted on the Cloudflare Pages Free Tier with a limit of 100,000 requests per day. Given an average consumption of 200 – 4,000 requests per device daily, a single account can comfortably support 10 – 20 devices (or even 100 – 200 devices with casual usage).
*   **Custom Domain Scaling**: Attach your own domain for a professional, short DNS endpoint. You can spread usage across multiple Cloudflare accounts to multiply your quota (100k per account) while keeping your custom domains.
*   **Smart Adblocking**: Local filtering using professional lists (AdGuard, ABPVN, Bypass-VN, etc.), automatically updated **every 3 hours**.
*   **ECS Geo-Optimization (RFC 7871)**: Injects EDNS Client Subnet (IPv4 `/24`, IPv6 `/48`) to ensure CDNs (Akamai, CloudFront, Fastly, BunnyCDN, Gcore) resolve you to the nearest servers.
*   **Sequential Failover Reliability**: 
    *   **Primary/Fallback**: Tries the primary upstream first, with automatic failover to a *different* backup resolver if it fails.
    *   **Geo-Bypass**: Automatically detects geo-blocked results (127.0.0.1) and re-resolves via **Mullvad DNS**.
*   **Optional Access Token**: Set a `DOH_TOKEN` environment variable to require `/dns-query/<token>`, keeping strangers from burning your free-tier quota.
*   **Early Response Filtering**: Drops unnecessary query types (`ANY`, `AAAA`, `PTR`, `HTTPS`) at the edge to save resources and improve speed.
*   **Private TLD Shield**: Prevents local/internal domain leaks (e.g., `.local`, `.lan`, router logins) by returning `NXDOMAIN` instantly.
*   **DNS Redirection (CNAME Injection)**: Redirects domain A to domain B using a CNAME record. This allows forcing a specific CDN chain or overriding resolution (e.g., Bilibili, TikTok, Medium).
*   **Zero-App Setup**: Native Apple `.mobileconfig` generation and a clean, responsive landing page included.

---

## 🚀 Deployment

### 1. Fork & Setup Actions
1. [Fork this project](../../fork) to your GitHub account.
2. Go to the **Actions** tab in your forked repository and click **I understand my workflows, go ahead and enable them**.
3. Manually select and **Enable** the following workflows: `Update DNS Blocklists` and `Delete Old Workflow Runs`. (`Update Filter Lists` is the optional Layer 2 / CGPS workflow — leave it disabled unless you set up the secrets described [below](#-layer-2-cloudflare-gateway-security-filtering-cgps).)

### 2. Deploy to Cloudflare Pages
1. Go to [Workers & Pages > Create application > Connect to Git](https://dash.cloudflare.com/?to=/:account/pages/new/provider/github).
2. Connect your GitHub and select the forked repository.
3. **Build Settings**: Leave everything as **default** (no changes needed).
4. Click **Save and Deploy**.

---

## ⚙️ Configuration

Per-deployment settings (upstreams, access token, CORS) are read from **environment variables** — set them in Cloudflare Pages under **Settings > Environment variables**, then redeploy. Feature toggles (adblock, ECS, query-type filtering) remain at the top of [functions/[[path]].js](functions/[[path]].js).

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

Rules are located in the `rules/` folder. When you modify and commit these files on GitHub, Cloudflare Pages will automatically sync and apply the new configuration.

Detailed rules:

*   **`blocklists.txt`**: Automatically updated **every 3 hours** by the GitHub Actions workflow.
    *   **How to configure**: Edit the URLs in the `curl` command inside [update_lists.sh](update_lists.sh) to add or remove filtering sources.
    *   **Safety guard**: the update aborts and keeps the previous list if download failures would shrink it below 50,000 domains (override with the `MIN_DOMAINS` environment variable), or if more than half the sources fail.
*   **`allowlists.txt`**: Generated by the same workflow, from two places: the AdGuard exclusion/exception sources, and every `@@` exception rule found in the blocklist sources themselves. Domains here override `blocklists.txt` and are subtracted from it at build time, so a domain can never be on both lists.
    *   **Why `@@` matters**: in AdBlock syntax `@@||example.com^` means *do not block* `example.com`. Feeding that rule into the blocklist would block exactly the domains a filter author deliberately exempted, so exceptions are routed to the allowlist instead.
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
Device ──DoH──▶ Pages Function (Layer 1: ads/tracking ~1M domains, ECS, redirects)
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
| Gateway (CGPS) | Malware, phishing, scam (TIF) | HaGeZi TIF Mini ([.github/workflows/Update_Gateway_Security_Lists.yml](.github/workflows/Update_Gateway_Security_Lists.yml)) |

**Setup notes:**

*   The Layer 2 workflow lives **in this repo** (it checks out the CGPS code from `mrrfv/cloudflare-gateway-pihole-scripts@v1` at runtime, so no separate repo is needed). Enable it in the **Actions** tab and create two repository secrets: `CLOUDFLARE_API_TOKEN` (Zero Trust read/edit permissions) and `CLOUDFLARE_ACCOUNT_ID`.
*   Use the **same Cloudflare account** that owns the Gateway endpoint configured in `UPSTREAM_PRIMARY` / `UPSTREAM_FALLBACK`.
*   [rules/allowlists.txt](rules/allowlists.txt) is the **shared allowlist**: the Edge layer reads it directly, and the Layer 2 workflow pulls it via raw URL — add a domain once and it is unblocked on both layers.
*   Additionally enable the built-in **Security Categories** (malware, phishing, new domains) in your Zero Trust Gateway policies — they are free and do not count against the 300k list quota.
*   Keep the Gateway block response at its default (`0.0.0.0`). Do **not** use a block response of `127.0.0.1` — the Geo-Bypass logic treats loopback answers as geo-blocking and would re-resolve (unblock) them via Mullvad.

---

## 📱 Setup Instructions

### Browsers (Chrome / Edge / Firefox)
1.  Go to **Settings** > **Privacy and Security** > **Security**.
2.  Enable **"Use secure DNS"** and select **"Custom"**.
3.  Paste your endpoint: `https://your-project.pages.dev/dns-query`

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

---
