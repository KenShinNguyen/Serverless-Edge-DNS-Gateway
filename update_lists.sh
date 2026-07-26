#!/bin/bash

# Định nghĩa đường dẫn tương đối trong Github Workspace
DIR="rules"
BLOCK_OUT="./$DIR/blocklists.txt"
BLOCK_TMP="/tmp/blocklists.tmp"

# Tạo thư mục rules nếu chưa có
mkdir -p "./$DIR"

# Cleanup khi script exit
trap "rm -f $BLOCK_TMP; exit" INT TERM EXIT

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

echo "Downloading and processing blocklists..."
curl -fsSL --max-time 60 \
https://cdn.jsdelivr.net/gh/hagezi/dns-blocklists@latest/domains/pro.plus.txt \
https://v.firebog.net/hosts/AdguardDNS.txt \
https://cdn.jsdelivr.net/gh/hagezi/dns-blocklists@latest/wildcard/gambling-onlydomains.txt \
https://cdn.jsdelivr.net/gh/hagezi/dns-blocklists@latest/domains/native.winoffice.txt \
https://raw.githubusercontent.com/mullvad/dns-blocklists/main/output/doh/doh_privacy.txt \
https://cdn.jsdelivr.net/gh/hagezi/dns-blocklists@latest/domains/native.xiaomi.txt \
https://cdn.jsdelivr.net/gh/hagezi/dns-blocklists@latest/domains/native.apple.txt \
| extract_domains > "$BLOCK_TMP"

# Chốt an toàn: nếu tải lỗi/thiếu nguồn làm danh sách quá nhỏ,
# giữ nguyên blocklist cũ thay vì ghi đè bằng danh sách hỏng
MIN_DOMAINS=100000
DOMAIN_COUNT=$(wc -l < "$BLOCK_TMP")
if [ "$DOMAIN_COUNT" -lt "$MIN_DOMAINS" ]; then
  echo "ERROR: chỉ trích xuất được $DOMAIN_COUNT domain (< $MIN_DOMAINS). Giữ nguyên blocklist hiện tại." >&2
  exit 1
fi

# Di chuyển file tmp vào thư mục đích
mv "$BLOCK_TMP" "$BLOCK_OUT"

echo "Done. Files saved to $BLOCK_OUT"
echo "Total domains blocked: $DOMAIN_COUNT"
