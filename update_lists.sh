#!/usr/bin/env bash
set -euo pipefail
set -o pipefail

# Định nghĩa đường dẫn tương đối trong Github Workspace
DIR="rules"
BLOCK_OUT="./$DIR/blocklists.txt"

# Tạo thư mục rules nếu chưa có
mkdir -p "./$DIR"

# Temp files an toàn
BLOCK_TMP=$(mktemp)
STATS_FILE=$(mktemp)
LAST_CURL_EXIT=$(mktemp)

# Cleanup khi script exit (không gọi exit trong trap)
trap 'rm -f "$BLOCK_TMP" "$STATS_FILE" "$LAST_CURL_EXIT"' INT TERM EXIT

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
# Download blocklist từ một URL với retries
# Ghi exit code vào $LAST_CURL_EXIT, trả về nội dung qua stdout
# ============================================================================
download_blocklist() {
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
# Main
# ============================================================================
echo "📥 Downloading and processing blocklists..."
echo ""

# Danh sách URLs (thêm/xóa URL tại đây). Có thể thêm mirror GitHub/raw.githubusercontent để dự phòng.
declare -a URLS=(
  "https://raw.githubusercontent.com/mullvad/dns-blocklists/refs/heads/main/output/doh/doh_adblock.txt"
  "https://cdn.jsdelivr.net/gh/hagezi/dns-blocklists@latest/wildcard/pro-onlydomains.txt"
  "https://cdn.jsdelivr.net/gh/hagezi/dns-blocklists@latest/wildcard/popupads-onlydomains.txt"
  "https://raw.githubusercontent.com/mullvad/dns-blocklists/refs/heads/main/output/doh/doh_gambling.txt"
  "https://raw.githubusercontent.com/mullvad/dns-blocklists/main/output/doh/doh_privacy.txt"
  "https://abpvn.com/filter/abpvn-3qgDm6.txt"
)

# Khởi tạo file tmp và stats
: > "$BLOCK_TMP"
: > "$STATS_FILE"

TOTAL_DOMAINS=0
SUCCESS_COUNT=0
FAILED_COUNT=0
TOTAL_URLS=${#URLS[@]}

# MIN_DOMAINS có thể override bằng biến môi trường
MIN_DOMAINS=${MIN_DOMAINS:-50000}

# Tải từng URL riêng biệt (stream, không lưu lớn vào biến)
for url in "${URLS[@]}"; do
  echo "⏳ Fetching: $url"

  DL_TMP=$(mktemp)
  if download_blocklist "$url" > "$DL_TMP"; then
    # Extract và đếm domains từ source này (stream từ file tạm)
    domain_count=$(extract_domains < "$DL_TMP" | tee -a "$BLOCK_TMP" | wc -l)
    echo "   ✅ Success: $domain_count domains" | tee -a "$STATS_FILE"
    SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
    TOTAL_DOMAINS=$((TOTAL_DOMAINS + domain_count))
  else
    curl_exit=$(cat "$LAST_CURL_EXIT" 2>/dev/null || echo "?")
    echo "   ❌ Failed ($url, curl exit $curl_exit)" | tee -a "$STATS_FILE"
    FAILED_COUNT=$((FAILED_COUNT + 1))
  fi
  rm -f "$DL_TMP"
done

echo ""
echo "─────────────────────────────────────────"
echo "📊 Download Summary:"
echo "─────────────────────────────────────────"
cat "$STATS_FILE"
echo "─────────────────────────────────────────"
echo "✅ Success: $SUCCESS_COUNT URLs"
echo "❌ Failed:  $FAILED_COUNT URLs"
echo "📈 Total domains extracted: $TOTAL_DOMAINS"
echo "─────────────────────────────────────────"

if [ "$FAILED_COUNT" -gt 0 ]; then
  echo ""
  echo "⚠️  WARNING: $FAILED_COUNT/$TOTAL_URLS nguồn thất bại — blocklist có thể thiếu dữ liệu."
fi

if [ "$TOTAL_DOMAINS" -lt "$MIN_DOMAINS" ]; then
  echo ""
  echo "⚠️  ERROR: Chỉ trích xuất được $TOTAL_DOMAINS domain (< $MIN_DOMAINS)"
  echo "   Có thể tất cả nguồn đều timeout/fail."
  echo "   Giữ nguyên blocklist hiện tại." >&2
  exit 1
fi

if [ "$FAILED_COUNT" -gt $((TOTAL_URLS / 2)) ]; then
  echo ""
  echo "⚠️  ERROR: Hơn nửa số nguồn thất bại ($FAILED_COUNT/$TOTAL_URLS)."
  echo "   Giữ nguyên blocklist hiện tại để tránh publish list thiếu." >&2
  exit 1
fi

echo ""
echo "🧹 Removing duplicates and sorting..."
# Use LC_ALL=C for consistent, faster sorting
LC_ALL=C sort -u "$BLOCK_TMP" -o "$BLOCK_OUT"

FINAL_COUNT=$(wc -l < "$BLOCK_OUT")
REMOVED=$((TOTAL_DOMAINS - FINAL_COUNT))

echo "✅ Done! Files saved to $BLOCK_OUT"
echo "📌 Final count: $FINAL_COUNT unique domains"
if [ "$REMOVED" -gt 0 ]; then
  echo "🔄 Removed $REMOVED duplicates"
fi
