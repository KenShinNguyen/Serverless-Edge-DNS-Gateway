#!/bin/bash
set -o pipefail

# Định nghĩa đường dẫn tương đối trong Github Workspace
DIR="rules"
BLOCK_OUT="./$DIR/blocklists.txt"
BLOCK_TMP="/tmp/blocklists.tmp"
STATS_FILE="/tmp/blocklists_stats.txt"

# Tạo thư mục rules nếu chưa có
mkdir -p "./$DIR"

# Cleanup khi script exit
trap "rm -f $BLOCK_TMP $STATS_FILE; exit" INT TERM EXIT

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
# Trả về nội dung qua stdout; mã lỗi curl ghi ra file /tmp/last_curl_exit
# ============================================================================
download_blocklist() {
  local url="$1"
  local max_retries=3
  local retry=0
  local response=""
  local exit_code=1

  while [ $retry -lt $max_retries ]; do
    # Không gộp 2>&1 vào response để tránh nhét thông báo lỗi vào nội dung
    response=$(curl -fsSL --connect-timeout 15 --max-time 120 --compressed "$url" 2>/dev/null)
    exit_code=$?

    if [ $exit_code -eq 0 ]; then
      echo "$response"
      echo 0 > /tmp/last_curl_exit
      return 0
    fi

    retry=$((retry + 1))
    if [ $retry -lt $max_retries ]; then
      echo "  ⚠️  Retry $retry/$max_retries in 5s... (curl exit $exit_code)" >&2
      sleep 5
    fi
  done

  echo "$exit_code" > /tmp/last_curl_exit
  return 1
}

# ============================================================================
# Main
# ============================================================================
echo "📥 Downloading and processing blocklists..."
echo ""

# Danh sách URLs (thêm/xóa URL tại đây)
declare -a URLS=(
  "https://cdn.jsdelivr.net/gh/hagezi/dns-blocklists@latest/domains/pro.txt"
  "https://v.firebog.net/hosts/AdguardDNS.txt"
  "https://cdn.jsdelivr.net/gh/hagezi/dns-blocklists@latest/wildcard/gambling-onlydomains.txt"
  "https://cdn.jsdelivr.net/gh/hagezi/dns-blocklists@latest/domains/native.winoffice.txt"
  "https://raw.githubusercontent.com/mullvad/dns-blocklists/main/output/doh/doh_privacy.txt"
  "https://cdn.jsdelivr.net/gh/hagezi/dns-blocklists@latest/domains/native.xiaomi.txt"
  "https://cdn.jsdelivr.net/gh/hagezi/dns-blocklists@latest/domains/native.apple.txt"
)

# Khởi tạo file tmp và stats
> "$BLOCK_TMP"
> "$STATS_FILE"

TOTAL_DOMAINS=0
SUCCESS_COUNT=0
FAILED_COUNT=0
TOTAL_URLS=${#URLS[@]}

# Tải từng URL riêng biệt
for url in "${URLS[@]}"; do
  url_name=$(basename "$url" .txt)
  echo "⏳ Fetching: $url_name"

  # Tải và extract domains
  content=$(download_blocklist "$url")
  dl_exit_code=$?

  if [ $dl_exit_code -eq 0 ]; then
    # Extract và đếm domains từ source này
    domain_count=$(echo "$content" | extract_domains | tee -a "$BLOCK_TMP" | wc -l)
    echo "   ✅ Success: $domain_count domains" | tee -a "$STATS_FILE"
    SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
    TOTAL_DOMAINS=$((TOTAL_DOMAINS + domain_count))
  else
    curl_exit=$(cat /tmp/last_curl_exit 2>/dev/null || echo "?")
    echo "   ❌ Failed ($url_name, curl exit $curl_exit)" | tee -a "$STATS_FILE"
    FAILED_COUNT=$((FAILED_COUNT + 1))
  fi
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

# ============================================================================
# Cảnh báo khi có nguồn fail (không dừng build, chỉ báo)
# ============================================================================
if [ "$FAILED_COUNT" -gt 0 ]; then
  echo ""
  echo "⚠️  WARNING: $FAILED_COUNT/$TOTAL_URLS nguồn thất bại — blocklist có thể thiếu dữ liệu."
fi

# ============================================================================
# Safety guard: nếu tổng domain quá nhỏ, giữ nguyên blocklist cũ
# ============================================================================
MIN_DOMAINS=50000
if [ "$TOTAL_DOMAINS" -lt "$MIN_DOMAINS" ]; then
  echo ""
  echo "⚠️  ERROR: Chỉ trích xuất được $TOTAL_DOMAINS domain (< $MIN_DOMAINS)"
  echo "   Có thể tất cả nguồn đều timeout/fail."
  echo "   Giữ nguyên blocklist hiện tại." >&2
  exit 1
fi

# ============================================================================
# Safety guard: nếu quá nửa số nguồn fail, cũng giữ nguyên list cũ
# ============================================================================
if [ "$FAILED_COUNT" -gt $((TOTAL_URLS / 2)) ]; then
  echo ""
  echo "⚠️  ERROR: Hơn nửa số nguồn thất bại ($FAILED_COUNT/$TOTAL_URLS)."
  echo "   Giữ nguyên blocklist hiện tại để tránh publish list thiếu." >&2
  exit 1
fi

# Loại bỏ duplicates và sắp xếp
echo ""
echo "🧹 Removing duplicates and sorting..."
sort -u "$BLOCK_TMP" -o "$BLOCK_OUT"

# Đếm lại sau khi remove duplicates
FINAL_COUNT=$(wc -l < "$BLOCK_OUT")
REMOVED=$((TOTAL_DOMAINS - FINAL_COUNT))

echo "✅ Done! Files saved to $BLOCK_OUT"
echo "📌 Final count: $FINAL_COUNT unique domains"
if [ "$REMOVED" -gt 0 ]; then
  echo "🔄 Removed $REMOVED duplicates"
fi
fix: tăng timeout + dùng mirror GitHub cho blocklist`
