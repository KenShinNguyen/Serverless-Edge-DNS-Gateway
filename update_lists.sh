#!/usr/bin/env bash
set -euo pipefail
set -o pipefail

# Định nghĩa đường dẫn tương đối trong Github Workspace
DIR="rules"
BLOCK_OUT="./$DIR/blocklists.txt"
ALLOW_OUT="./$DIR/allowlists.txt"

# Tạo thư mục rules nếu chưa có
mkdir -p "./$DIR"

# Temp files an toàn
BLOCK_TMP=$(mktemp)
ALLOW_TMP=$(mktemp)
STATS_FILE=$(mktemp)
LAST_CURL_EXIT=$(mktemp)

# Cleanup khi script exit (không gọi exit trong trap)
trap 'rm -f "$BLOCK_TMP" "$ALLOW_TMP" "$STATS_FILE" "$LAST_CURL_EXIT"' INT TERM EXIT

# ============================================================================
# Extract domains từ các định dạng khác nhau (adblock, hosts, plain domains)
# ============================================================================
extract_domains() {
  awk '{
    if (/^[[:space:]]*$/ || /^[!#]/) next
    line = tolower($0)
    sub(/^@@\|\|?/, "", line)
    sub(/^\|\|?/, "", line)
    sub(/\^.*/, "", line)
    sub(/[#!].*/, "", line)
    sub(/\/.*/, "", line)
    sub(/:.*/, "", line)
    sub(/^[0-9.]+[[:space:]]+/, "", line)
    gsub(/^[[:space:]]+|[[:space:]]+$/, "", line)
    if (line ~ /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/ && !seen[line]++) print line
  }'
}

# ============================================================================
# Download list từ một URL với retries
# Ghi exit code vào $LAST_CURL_EXIT, trả về nội dung qua stdout
# ============================================================================
download_list() {
  local url="$1"
  local max_retries=4
  local retry=0
  local exit_code=1
  local ua="Serverless-Edge-DNS-Gateway/1.0 (+https://github.com/KenShinNguyen/Serverless-Edge-DNS-Gateway)"

  while [ $retry -lt $max_retries ]; do
    # tăng timeout và giữ --compressed và -L (đã có -S in -fsSL)
    if curl -fsSL --connect-timeout 30 --max-time 180 --compressed -A "$ua" "$url"; then
      echo 0 > "$LAST_CURL_EXIT"
      return 0
    else
      exit_code=$?
      retry=$((retry + 1))
      if [ $retry -lt $max_retries ]; then
        # exponential backoff nhẹ
        sleep_time=$((5 * retry))
        echo "  ⚠️  Retry $retry/$max_retries in ${sleep_time}s... (curl exit $exit_code)" >&2
        sleep "$sleep_time"
      fi
    fi
  done

  echo "$exit_code" > "$LAST_CURL_EXIT"
  return 1
}

# ============================================================================
# Main - BLOCKLISTS
# ============================================================================
echo "📥 Downloading and processing blocklists..."
echo ""

# Danh sách URLs blocklist (thêm/xóa URL tại đây). Có thể thêm mirror GitHub/raw.githubusercontent để dự phòng.
declare -a BLOCK_URLS=(
  "https://raw.githubusercontent.com/mullvad/dns-blocklists/refs/heads/main/output/doh/doh_adblock.txt"
  "https://adguardteam.github.io/AdGuardSDNSFilter/Filters/filter.txt"
  "https://raw.githubusercontent.com/bigdargon/hostsVN/master/filters/adservers.txt"
  "https://cdn.jsdelivr.net/gh/hagezi/dns-blocklists@latest/wildcard/pro-onlydomains.txt"
  "https://cdn.jsdelivr.net/gh/hagezi/dns-blocklists@latest/wildcard/popupads-onlydomains.txt"
  "https://raw.githubusercontent.com/mullvad/dns-blocklists/refs/heads/main/output/doh/doh_gambling.txt"
  "https://raw.githubusercontent.com/mullvad/dns-blocklists/main/output/doh/doh_privacy.txt"
  "https://abpvn.com/filter/abpvn-3qgDm6.txt"
)

# Khởi tạo file tmp và stats
: > "$BLOCK_TMP"
: > "$STATS_FILE"

TOTAL_BLOCK_DOMAINS=0
BLOCK_SUCCESS_COUNT=0
BLOCK_FAILED_COUNT=0
TOTAL_BLOCK_URLS=${#BLOCK_URLS[@]}

# MIN_DOMAINS có thể override bằng biến môi trường
MIN_DOMAINS=${MIN_DOMAINS:-50000}

# Tải từng URL riêng biệt (stream, không lưu lớn vào biến)
for url in "${BLOCK_URLS[@]}"; do
  echo "⏳ Fetching: $url"

  DL_TMP=$(mktemp)
  if download_list "$url" > "$DL_TMP"; then
    # Extract và đếm domains từ source này (stream từ file tạm)
    domain_count=$(extract_domains < "$DL_TMP" | tee -a "$BLOCK_TMP" | wc -l)
    echo "   ✅ Success: $domain_count domains" | tee -a "$STATS_FILE"
    BLOCK_SUCCESS_COUNT=$((BLOCK_SUCCESS_COUNT + 1))
    TOTAL_BLOCK_DOMAINS=$((TOTAL_BLOCK_DOMAINS + domain_count))
  else
    curl_exit=$(cat "$LAST_CURL_EXIT" 2>/dev/null || echo "?")
    echo "   ❌ Failed ($url, curl exit $curl_exit)" | tee -a "$STATS_FILE"
    BLOCK_FAILED_COUNT=$((BLOCK_FAILED_COUNT + 1))
  fi
  rm -f "$DL_TMP"
done

echo ""
echo "─────────────────────────────────────────"
echo "📊 Blocklists Download Summary:"
echo "─────────────────��───────────────────────"
cat "$STATS_FILE"
echo "─────────────────────────────────────────"
echo "✅ Success: $BLOCK_SUCCESS_COUNT URLs"
echo "❌ Failed:  $BLOCK_FAILED_COUNT URLs"
echo "📈 Total domains extracted: $TOTAL_BLOCK_DOMAINS"
echo "─────────────────────────────────────────"

if [ "$BLOCK_FAILED_COUNT" -gt 0 ]; then
  echo ""
  echo "⚠️  WARNING: $BLOCK_FAILED_COUNT/$TOTAL_BLOCK_URLS nguồn thất bại — blocklist có thể thiếu dữ liệu."
fi

if [ "$TOTAL_BLOCK_DOMAINS" -lt "$MIN_DOMAINS" ]; then
  echo ""
  echo "⚠️  ERROR: Chỉ trích xuất được $TOTAL_BLOCK_DOMAINS domain (< $MIN_DOMAINS)"
  echo "   Có thể tất cả nguồn đều timeout/fail."
  echo "   Giữ nguyên blocklist hiện tại." >&2
  exit 1
fi

if [ "$BLOCK_FAILED_COUNT" -gt $((TOTAL_BLOCK_URLS / 2)) ]; then
  echo ""
  echo "⚠️  ERROR: Hơn nửa số nguồn thất bại ($BLOCK_FAILED_COUNT/$TOTAL_BLOCK_URLS)."
  echo "   Giữ nguyên blocklist hiện tại để tránh publish list thiếu." >&2
  exit 1
fi

echo ""
echo "🧹 Removing duplicates and sorting blocklists..."
# Use LC_ALL=C for consistent, faster sorting
LC_ALL=C sort -u "$BLOCK_TMP" -o "$BLOCK_OUT"

FINAL_BLOCK_COUNT=$(wc -l < "$BLOCK_OUT")
REMOVED=$((TOTAL_BLOCK_DOMAINS - FINAL_BLOCK_COUNT))

echo "✅ Done! Blocklist saved to $BLOCK_OUT"
echo "📌 Final count: $FINAL_BLOCK_COUNT unique domains"
if [ "$REMOVED" -gt 0 ]; then
  echo "🔄 Removed $REMOVED duplicates"
fi

# ============================================================================
# Main - ALLOWLISTS (AdGuard)
# ============================================================================
echo ""
echo "📥 Downloading and processing allowlists..."
echo ""

# Danh sách URLs allowlist từ AdGuard
declare -a ALLOW_URLS=(
  "https://raw.githubusercontent.com/AdguardTeam/AdguardFilters/master/SafebrowsingFilter/whitelist.txt"
  "https://raw.githubusercontent.com/AdguardTeam/AdGuardSDNSFilter/master/Filters/exceptions.txt"
  "https://raw.githubusercontent.com/AdguardTeam/cname-trackers/master/combined_whitelist.txt"
)

# Khởi tạo file tmp allowlist
: > "$ALLOW_TMP"
: > "$STATS_FILE"

TOTAL_ALLOW_DOMAINS=0
ALLOW_SUCCESS_COUNT=0
ALLOW_FAILED_COUNT=0
TOTAL_ALLOW_URLS=${#ALLOW_URLS[@]}

MIN_ALLOW_DOMAINS=${MIN_ALLOW_DOMAINS:-100}

# Tải allowlist URLs
for url in "${ALLOW_URLS[@]}"; do
  echo "⏳ Fetching: $url"

  DL_TMP=$(mktemp)
  if download_list "$url" > "$DL_TMP"; then
    # Extract và đếm domains từ source này
    domain_count=$(extract_domains < "$DL_TMP" | tee -a "$ALLOW_TMP" | wc -l)
    echo "   ✅ Success: $domain_count domains" | tee -a "$STATS_FILE"
    ALLOW_SUCCESS_COUNT=$((ALLOW_SUCCESS_COUNT + 1))
    TOTAL_ALLOW_DOMAINS=$((TOTAL_ALLOW_DOMAINS + domain_count))
  else
    curl_exit=$(cat "$LAST_CURL_EXIT" 2>/dev/null || echo "?")
    echo "   ❌ Failed ($url, curl exit $curl_exit)" | tee -a "$STATS_FILE"
    ALLOW_FAILED_COUNT=$((ALLOW_FAILED_COUNT + 1))
  fi
  rm -f "$DL_TMP"
done

echo ""
echo "─────────────────────────────────────────"
echo "📊 Allowlists Download Summary:"
echo "─────────────────────────────────────────"
cat "$STATS_FILE"
echo "─────────────────────────────────────────"
echo "✅ Success: $ALLOW_SUCCESS_COUNT URLs"
echo "❌ Failed:  $ALLOW_FAILED_COUNT URLs"
echo "📈 Total domains extracted: $TOTAL_ALLOW_DOMAINS"
echo "─────────────────────────────────────────"

if [ "$ALLOW_FAILED_COUNT" -gt 0 ]; then
  echo ""
  echo "⚠️  WARNING: $ALLOW_FAILED_COUNT/$TOTAL_ALLOW_URLS nguồn allowlist thất bại."
fi

if [ "$TOTAL_ALLOW_DOMAINS" -lt "$MIN_ALLOW_DOMAINS" ]; then
  echo ""
  echo "⚠️  ERROR: Chỉ trích xuất được $TOTAL_ALLOW_DOMAINS domain allowlist (< $MIN_ALLOW_DOMAINS)"
  echo "   Có thể tất cả nguồn đều timeout/fail." >&2
  exit 1
fi

echo ""
echo "🧹 Removing duplicates and sorting allowlists..."
LC_ALL=C sort -u "$ALLOW_TMP" -o "$ALLOW_OUT"

FINAL_ALLOW_COUNT=$(wc -l < "$ALLOW_OUT")
ALLOW_REMOVED=$((TOTAL_ALLOW_DOMAINS - FINAL_ALLOW_COUNT))

echo "✅ Done! Allowlist saved to $ALLOW_OUT"
echo "📌 Final count: $FINAL_ALLOW_COUNT unique domains"
if [ "$ALLOW_REMOVED" -gt 0 ]; then
  echo "🔄 Removed $ALLOW_REMOVED duplicates"
fi

# ============================================================================
# Final Summary
# ============================================================================
echo ""
echo "═════════════════════════════════════════"
echo "🎉 FINAL SUMMARY"
echo "═════════════════════════════════════════"
echo "Blocklists: $FINAL_BLOCK_COUNT unique domains"
echo "Allowlists: $FINAL_ALLOW_COUNT unique domains"
echo "═════════════════════════════════════════"
