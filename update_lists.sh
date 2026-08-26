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
trap 'rm -f "$BLOCK_TMP" "$BLOCK_TMP.sorted" "$ALLOW_TMP" "$STATS_FILE" "$LAST_CURL_EXIT"' INT TERM EXIT

# ============================================================================
# Chuẩn hoá một dòng filter thành domain trần (adblock, hosts, plain domains).
#
# KHÔNG xử lý tiền tố "@@" ở đây: trong cú pháp AdBlock, "@@||example.com^" là
# rule NGOẠI LỆ ("đừng chặn example.com"). Nếu chỉ cắt bỏ "@@" rồi trộn chung,
# mọi domain mà tác giả filter cố ý mở chặn sẽ bị đẩy ngược vào blocklist.
# Việc tách @@ do extract_block_domains / extract_allow_domains đảm nhiệm.
# ============================================================================
normalize_domains() {
  awk '{
    if (/^[[:space:]]*$/ || /^[!#]/) next
    line = tolower($0)
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

# Chỉ giữ những rule THỰC SỰ chặn cả domain — hợp lệ ở tầng DNS.
#
# normalize_domains cắt bỏ mọi thứ sau ^ # / :, nên nếu không lọc trước thì các
# rule dưới đây đều bị rút gọn thành một domain trần và biến thành lệnh chặn
# toàn bộ trang, dù ý nghĩa gốc hẹp hơn nhiều:
#
#   vnexpress.net##.box-quangcao       (ẩn phần tử)        → chặn cả vnexpress.net
#   vnexpress.net#@#.banner            (ngoại lệ cosmetic) → chặn cả vnexpress.net
#   ||vnexpress.net^$popup             (chỉ chặn popup)    → chặn cả vnexpress.net
#   ||shopee.vn^$third-party           (chỉ khi bên thứ 3) → chặn cả shopee.vn
#   ||ads.com^$script,domain=other.vn  (chỉ trên other.vn) → chặn cả ads.com
#
# List dành cho trình duyệt (ABPVN, AdGuard base) đầy rule kiểu này, nên bỏ qua
# chúng là bắt buộc. Đánh đổi: vài domain quảng cáo chỉ được khai báo kèm
# modifier sẽ lọt lưới — chấp nhận được, vì chặn nhầm một trang lớn gây hậu quả
# nặng hơn nhiều so với sót một domain quảng cáo.
DNS_INCOMPATIBLE='#[@?$%]?#|\$|^[[:space:]]*/'

# Từ một nguồn filter: lấy các domain BỊ CHẶN (bỏ rule ngoại lệ @@ và rule hẹp).
extract_block_domains() {
  { grep -vE "^[[:space:]]*@@|$DNS_INCOMPATIBLE" || true; } | normalize_domains
}

# Từ một nguồn filter: lấy các domain ĐƯỢC MỞ CHẶN (chỉ rule ngoại lệ @@).
extract_allow_domains() {
  { grep '^[[:space:]]*@@' || true; } \
    | { grep -vE "$DNS_INCOMPATIBLE" || true; } \
    | sed 's/^[[:space:]]*@@//' | normalize_domains
}

# Nguồn allowlist thuần: chấp nhận cả domain trần lẫn rule @@.
extract_any_domains() {
  { grep -vE "$DNS_INCOMPATIBLE" || true; } | sed 's/^[[:space:]]*@@//' | normalize_domains
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
  # hostsVN — hai nguồn Việt Nam duy nhất còn lại sau khi gỡ ABPVN.
  # Đã kiểm chứng: cả hai ở định dạng hosts thuần, 0/5.738 dòng là rule cosmetic
  # hoặc rule có modifier, nên chúng KHÔNG dính lỗi chặn nhầm cả trang mà ABPVN
  # gây ra. threat/filter.txt còn là lớp chặn malware/phishing nhắm vào người
  # dùng Việt mà các list quốc tế phủ không tốt.
  "https://raw.githubusercontent.com/bigdargon/hostsVN/master/filters/adservers.txt"
  "https://raw.githubusercontent.com/bigdargon/hostsVN/master/extensions/threat/filter.txt"
  "https://cdn.jsdelivr.net/gh/hagezi/dns-blocklists@latest/wildcard/pro-onlydomains.txt"
  "https://cdn.jsdelivr.net/gh/hagezi/dns-blocklists@latest/wildcard/popupads-onlydomains.txt"
  "https://raw.githubusercontent.com/mullvad/dns-blocklists/refs/heads/main/output/doh/doh_gambling.txt"
  "https://raw.githubusercontent.com/mullvad/dns-blocklists/main/output/doh/doh_privacy.txt"
  "https://raw.githubusercontent.com/mullvad/dns-blocklists/refs/heads/main/output/doh/doh_adult.txt"
)

# Khởi tạo file tmp và stats. ALLOW_TMP khởi tạo ngay tại đây (không phải ở
# phần allowlist bên dưới) vì các rule ngoại lệ @@ thu được từ chính nguồn
# blocklist sẽ được ghi dồn vào đó.
: > "$BLOCK_TMP"
: > "$ALLOW_TMP"
: > "$STATS_FILE"

TOTAL_BLOCK_DOMAINS=0
BLOCK_SUCCESS_COUNT=0
BLOCK_FAILED_COUNT=0
EXCEPTIONS_FOUND=0
TOTAL_BLOCK_URLS=${#BLOCK_URLS[@]}

# MIN_DOMAINS có thể override bằng biến môi trường
MIN_DOMAINS=${MIN_DOMAINS:-50000}

# Tải từng URL riêng biệt (stream, không lưu lớn vào biến)
for url in "${BLOCK_URLS[@]}"; do
  echo "⏳ Fetching: $url"

  DL_TMP=$(mktemp)
  if download_list "$url" > "$DL_TMP"; then
    # Extract và đếm domains từ source này (stream từ file tạm)
    domain_count=$(extract_block_domains < "$DL_TMP" | tee -a "$BLOCK_TMP" | wc -l)
    # Rule ngoại lệ (@@) của chính nguồn này → allowlist, KHÔNG phải blocklist
    exc_count=$(extract_allow_domains < "$DL_TMP" | tee -a "$ALLOW_TMP" | wc -l)
    if [ "$exc_count" -gt 0 ]; then
      echo "   ✅ Success: $domain_count domains (+$exc_count ngoại lệ → allowlist)" | tee -a "$STATS_FILE"
    else
      echo "   ✅ Success: $domain_count domains" | tee -a "$STATS_FILE"
    fi
    EXCEPTIONS_FOUND=$((EXCEPTIONS_FOUND + exc_count))
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
# Use LC_ALL=C for consistent, faster sorting.
# Ghi ra file tạm: blocklist chỉ được chốt sau khi có allowlist đầy đủ, để
# còn trừ đi phần allowlist (xem bước "Chốt blocklist" ở cuối script).
LC_ALL=C sort -u "$BLOCK_TMP" -o "$BLOCK_TMP.sorted"

DEDUPED_BLOCK_COUNT=$(wc -l < "$BLOCK_TMP.sorted")
REMOVED=$((TOTAL_BLOCK_DOMAINS - DEDUPED_BLOCK_COUNT))

echo "📌 Sau khi khử trùng lặp: $DEDUPED_BLOCK_COUNT domain"
if [ "$REMOVED" -gt 0 ]; then
  echo "🔄 Removed $REMOVED duplicates"
fi
if [ "$EXCEPTIONS_FOUND" -gt 0 ]; then
  echo "🔓 Thu được $EXCEPTIONS_FOUND rule ngoại lệ (@@) từ nguồn blocklist → allowlist"
fi

# ============================================================================
# Main - ALLOWLISTS (AdGuard)
# ============================================================================
echo ""
echo "📥 Downloading and processing allowlists..."
echo ""

# Danh sách URLs allowlist từ AdGuard
# Mọi URL dưới đây đã được kiểm chứng trả HTTP 200 và soi nội dung thật.
# Trước khi thêm nguồn mới, hãy curl thử: một URL 404 KHÔNG làm workflow đỏ ngay
# ở bước tải (chỉ retry rồi cảnh báo), nhưng nếu mọi nguồn hỏng thì chốt an toàn
# MIN_ALLOW_DOMAINS sẽ exit 1 và chặn luôn việc cập nhật blocklist.
declare -a ALLOW_URLS=(
  # AdGuard DNS filter — domain mà chính tác giả filter loại trừ (~1.100 + ~420)
  "https://raw.githubusercontent.com/AdguardTeam/AdGuardSDNSFilter/master/Filters/exclusions.txt"
  "https://raw.githubusercontent.com/AdguardTeam/AdGuardSDNSFilter/master/Filters/exceptions.txt"
  # Ngân hàng & tài chính (~4.000) — có sẵn ngân hàng VN: vietcombank.com.vn,
  # vietinbank.vn, bidv.vn, agribank.com.vn, tpb.vn, eximbank.com.vn...
  # Cùng nguồn mà workflow CGPS lớp 2 đang dùng → allowlist 2 lớp nhất quán.
  "https://raw.githubusercontent.com/AdguardTeam/HttpsExclusions/master/exclusions/banks.txt"
  # Dịch vụ có dữ liệu nhạy cảm: xác thực, thanh toán, y tế (~180)
  "https://raw.githubusercontent.com/AdguardTeam/HttpsExclusions/master/exclusions/sensitive.txt"
)
# CỐ Ý KHÔNG dùng:
#   - hagezi .../whitelist/whitelist-onlydomains.txt (raw + jsdelivr): 404, đường
#     dẫn không tồn tại trên branch main (đã dò 15 biến thể đường dẫn).
#   - AdguardTeam/cname-trackers .../combined_whitelist.txt: 404, nguồn đã chết.
#   - anudeepND/referral-sites.txt: whitelist cả doubleclick.net → mở chặn quảng cáo.
#   - anudeepND/optional-list.txt: chứa acdn.adnxs.com (CDN quảng cáo).

# KHÔNG reset ALLOW_TMP ở đây: nó đang giữ các rule ngoại lệ @@ thu được từ
# nguồn blocklist bên trên. Chỉ reset bảng thống kê.
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
    domain_count=$(extract_any_domains < "$DL_TMP" | tee -a "$ALLOW_TMP" | wc -l)
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
# Chốt blocklist: loại bỏ mọi domain có trong allowlist
#
# Edge function vốn đã ưu tiên allowlist khi tra cứu, nên bước này không đổi
# hành vi lọc — nó chỉ khiến dữ liệu tự nhất quán (một domain không thể vừa
# bị chặn vừa được mở) và giảm số phần tử phải nạp vào RAM của Pages Function.
# ============================================================================
echo ""
echo "🧹 Loại bỏ domain nằm trong allowlist khỏi blocklist..."
LC_ALL=C comm -23 "$BLOCK_TMP.sorted" "$ALLOW_OUT" > "$BLOCK_OUT"
rm -f "$BLOCK_TMP.sorted"

FINAL_BLOCK_COUNT=$(wc -l < "$BLOCK_OUT")
OVERLAP=$((DEDUPED_BLOCK_COUNT - FINAL_BLOCK_COUNT))

echo "✅ Done! Blocklist saved to $BLOCK_OUT"
echo "📌 Final count: $FINAL_BLOCK_COUNT unique domains"
if [ "$OVERLAP" -gt 0 ]; then
  echo "🔓 Gỡ chặn $OVERLAP domain vì có trong allowlist"
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
