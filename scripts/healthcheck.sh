#!/usr/bin/env bash
# ============================================================================
# Kiểm tra endpoint DoH sau khi Cloudflare Pages deploy xong.
#
# Xác nhận hai điều — mỗi điều bắt một kiểu hỏng khác nhau mà việc chỉ ping
# trang chủ không phát hiện được:
#   1. Phân giải bình thường: example.com phải trả NOERROR kèm ít nhất 1 answer
#      → chứng tỏ upstream, ECS injection và đường đi tới resolver còn sống.
#   2. Chặn quảng cáo: doubleclick.net phải trả NXDOMAIN
#      → chứng tỏ rules/blocklists.txt thực sự được nạp. Nếu file list hỏng
#        hoặc fetch thất bại, function vẫn phục vụ bình thường nhưng không
#        chặn gì cả — kiểu hỏng âm thầm mà bước (1) không thấy.
#
# Cấu hình (đều tuỳ chọn — thiếu HEALTHCHECK_ENDPOINT thì bỏ qua êm):
#   HEALTHCHECK_ENDPOINT  URL gốc của deployment, ví dụ https://abc.pages.dev
#   DOH_TOKEN             token nếu endpoint bật DOH_TOKEN (path /dns-query/<token>)
#   HEALTHCHECK_RETRIES   số lần thử (mặc định 5)
# ============================================================================
set -euo pipefail

ENDPOINT="${HEALTHCHECK_ENDPOINT:-}"
if [ -z "$ENDPOINT" ]; then
  echo "::notice::Bỏ qua health check: chưa đặt biến HEALTHCHECK_ENDPOINT."
  echo "Đặt nó ở Settings > Secrets and variables > Actions > Variables, giá trị là URL deployment của bạn (vd https://your-project.pages.dev)."
  exit 0
fi

ENDPOINT="${ENDPOINT%/}"
DOH_PATH="/dns-query"
[ -n "${DOH_TOKEN:-}" ] && DOH_PATH="${DOH_PATH}/${DOH_TOKEN}"
URL="${ENDPOINT}${DOH_PATH}"
RETRIES="${HEALTHCHECK_RETRIES:-5}"

# Truy vấn DNS dựng sẵn (wire format, base64url không padding), QTYPE=A.
Q_RESOLVE="q80BAAABAAAAAAAAB2V4YW1wbGUDY29tAAABAAE"           # example.com
Q_BLOCKED="q80BAAABAAAAAAAAC2RvdWJsZWNsaWNrA25ldAAAAQAB"      # doubleclick.net

# Đọc RCODE (4 bit thấp của byte 3) và ANCOUNT (byte 6-7) từ phản hồi DNS.
# In ra "<rcode> <ancount>", hoặc "err" nếu phản hồi quá ngắn/không hợp lệ.
parse_dns() {
  local file="$1"
  local size
  size=$(wc -c < "$file")
  [ "$size" -lt 12 ] && { echo "err"; return; }
  local bytes
  bytes=$(od -An -tu1 -N8 "$file" | tr -s ' ' '\n' | grep -v '^$')
  local b3 b6 b7
  b3=$(echo "$bytes" | sed -n '4p')
  b6=$(echo "$bytes" | sed -n '7p')
  b7=$(echo "$bytes" | sed -n '8p')
  echo "$((b3 & 15)) $((b6 * 256 + b7))"
}

# Gửi 1 truy vấn DoH, trả về "<http_code>|<rcode> <ancount>"
probe() {
  local dns="$1" out http
  out=$(mktemp)
  http=$(curl -sS -o "$out" -w '%{http_code}' --max-time 20 \
    -H 'accept: application/dns-message' "${URL}?dns=${dns}" || echo "000")
  echo "${http}|$(parse_dns "$out")"
  rm -f "$out"
}

# Không in URL đầy đủ: nó chứa DOH_TOKEN, mà log Actions của repo public thì
# ai cũng đọc được (GitHub chỉ tự che giá trị đến từ secrets).
if [ -n "${DOH_TOKEN:-}" ]; then
  echo "🔎 Health check: ${ENDPOINT}/dns-query/<token>"
else
  echo "🔎 Health check: ${ENDPOINT}/dns-query"
fi

attempt=1
while [ "$attempt" -le "$RETRIES" ]; do
  resolve=$(probe "$Q_RESOLVE")
  blocked=$(probe "$Q_BLOCKED")
  r_http="${resolve%%|*}"; r_dns="${resolve#*|}"
  b_http="${blocked%%|*}"; b_dns="${blocked#*|}"
  r_rcode="${r_dns%% *}"; r_ancount="${r_dns##* }"
  b_rcode="${b_dns%% *}"

  ok=1
  [ "$r_http" = "200" ] && [ "$r_rcode" = "0" ] && [ "$r_ancount" -gt 0 ] 2>/dev/null || ok=0
  [ "$b_http" = "200" ] && [ "$b_rcode" = "3" ] || ok=0

  if [ "$ok" = "1" ]; then
    echo "✅ Phân giải OK (example.com: NOERROR, $r_ancount answer)"
    echo "✅ Chặn quảng cáo OK (doubleclick.net: NXDOMAIN)"
    exit 0
  fi

  echo "⏳ Lần $attempt/$RETRIES chưa đạt — resolve[http=$r_http rcode=$r_rcode answers=$r_ancount] blocked[http=$b_http rcode=$b_rcode]"
  attempt=$((attempt + 1))
  [ "$attempt" -le "$RETRIES" ] && sleep $((10 * (attempt - 1)))
done

echo "::error::Health check thất bại sau $RETRIES lần thử."
echo "  resolve example.com  → http=$r_http rcode=$r_rcode answers=$r_ancount (mong đợi http=200 rcode=0 answers>0)"
echo "  blocked doubleclick.net → http=$b_http rcode=$b_rcode (mong đợi http=200 rcode=3/NXDOMAIN)"
echo "  rcode=3 ở truy vấn đầu thường là sai DOH_TOKEN; http=000 là deploy chưa xong hoặc sai HEALTHCHECK_ENDPOINT;"
echo "  blocked trả rcode=0 nghĩa là blocklist không được nạp."
exit 1
