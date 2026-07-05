#!/bin/bash

# Định nghĩa đường dẫn tương đối trong Github Workspace
DIR="rules"
BLOCK_OUT="./$DIR/blocklists.txt"
BLOCK_TMP="/tmp/blocklists.tmp"
TEMP_DIR="/tmp/dns_lists_$$"

# Tạo thư mục rules nếu chưa có
mkdir -p "./$DIR"
mkdir -p "$TEMP_DIR"

# Cleanup khi script exit
trap "rm -rf $TEMP_DIR; exit" INT TERM EXIT

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

# Download all blocklists to temporary directory
echo "Fetching Mullvad adblock list..."
curl -fsSL --max-time 60 \
  https://raw.githubusercontent.com/mullvad/dns-blocklists/master/output/doh/doh_adblock.txt \
  -o "$TEMP_DIR/mullvad_adblock.txt" 2>/dev/null || echo "Warning: Failed to fetch Mullvad adblock"

echo "Fetching Mullvad adult content list..."
curl -fsSL --max-time 60 \
  https://raw.githubusercontent.com/mullvad/dns-blocklists/master/output/doh/doh_adult.txt \
  -o "$TEMP_DIR/mullvad_adult.txt" 2>/dev/null || echo "Warning: Failed to fetch Mullvad adult"

echo "Fetching Mullvad gambling list..."
curl -fsSL --max-time 60 \
  https://raw.githubusercontent.com/mullvad/dns-blocklists/master/output/doh/doh_gambling.txt \
  -o "$TEMP_DIR/mullvad_gambling.txt" 2>/dev/null || echo "Warning: Failed to fetch Mullvad gambling"

echo "Fetching Mullvad privacy list..."
curl -fsSL --max-time 60 \
  https://raw.githubusercontent.com/mullvad/dns-blocklists/master/output/doh/doh_privacy.txt \
  -o "$TEMP_DIR/mullvad_privacy.txt" 2>/dev/null || echo "Warning: Failed to fetch Mullvad privacy"

echo "Fetching HaGeZi Apple domains list..."
curl -fsSL --max-time 60 \
  https://cdn.jsdelivr.net/gh/hagezi/dns-blocklists@latest/wildcard/native.apple-onlydomains.txt \
  -o "$TEMP_DIR/hagezi_apple.txt" 2>/dev/null || echo "Warning: Failed to fetch HaGeZi Apple domains"

echo "Fetching HaGeZi Windows/Office domains list..."
curl -fsSL --max-time 60 \
  https://cdn.jsdelivr.net/gh/hagezi/dns-blocklists@latest/wildcard/native.winoffice-onlydomains.txt \
  -o "$TEMP_DIR/hagezi_windows.txt" 2>/dev/null || echo "Warning: Failed to fetch HaGeZi Windows/Office domains"

echo "Fetching original blocklist..."
curl -fsSL --max-time 60 \
  https://raw.githubusercontent.com/bibicadotnet/blocklist_minimal/main/blocklists.txt \
  -o "$TEMP_DIR/original_blocklist.txt" 2>/dev/null || echo "Warning: Failed to fetch original blocklist"

# Combine and deduplicate all lists
echo "Combining all lists..."
cat "$TEMP_DIR"/*.txt 2>/dev/null | extract_domains | sort -u > "$BLOCK_TMP"

# Move to final destination
mv "$BLOCK_TMP" "$BLOCK_OUT"

echo "Done. Files saved to $BLOCK_OUT"
echo "Total unique domains: $(wc -l < "$BLOCK_OUT")"
