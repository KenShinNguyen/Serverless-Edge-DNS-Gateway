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
https://raw.githubusercontent.com/bibicadotnet/blocklist_minimal/main/blocklists.txt \
https://github.com/mullvad/dns-blocklists/blob/main/output/doh/doh_privacy.txt \
https://cdn.jsdelivr.net/gh/hagezi/dns-blocklists@latest/domains/pro.plus.txt \
https://cdn.jsdelivr.net/gh/hagezi/dns-blocklists@latest/wildcard/gambling-onlydomains.txt \
| extract_domains > "$BLOCK_TMP"

# Di chuyển file tmp vào thư mục đích
mv "$BLOCK_TMP" "$BLOCK_OUT"

# Đếm số lượng domain trong blocklist
DOMAIN_COUNT=$(wc -l < "$BLOCK_OUT")
echo "Done. Files saved to $BLOCK_OUT"
echo "Total domains blocked: $DOMAIN_COUNT"
