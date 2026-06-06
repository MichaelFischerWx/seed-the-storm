#!/usr/bin/env bash
#
# migrate_to_r2.sh — mirror the ERA5 tiles "Seed the Storm" needs from the public
# GCS buckets to your Cloudflare R2 bucket (zero egress fees). One-time copy.
#
# Prereqs:
#   1. rclone installed                        (https://rclone.org/install/)
#   2. an rclone remote named "r2" configured  (see migrate/README.md)
#
# Usage:   ./migrate_to_r2.sh [bucket-name] [parallelism]
#   e.g.   ./migrate_to_r2.sh seedstorm-data 8
#
# Copies (≈1,064 objects, ~2.5 GB):
#   - era5_daily_1deg manifest + {u200,v200,u850,v850,shear} for months 06–12,
#     years 1991–2020   (the months the game deals, Jun–Nov, + each one's
#     next-month span)
#   - the 12 monthly SST climatology tiles + the gc-atlas manifest (SST scaling)
#
set -euo pipefail
export BUCKET="${1:-seedstorm-data}"
PAR="${2:-8}"

GCS="https://storage.googleapis.com"
DAILY="$GCS/tc-atlas-ir-cache/era5_daily_1deg"
SSTB="$GCS/gc-atlas-era5/tiles/single_levels/sst"

command -v rclone >/dev/null || { echo "Install rclone first: https://rclone.org/install/"; exit 1; }
rclone listremotes 2>/dev/null | grep -qx 'r2:' || {
  echo "No rclone remote named 'r2'. Configure one for Cloudflare R2 (see migrate/README.md)."; exit 1; }

work="$(mktemp)"
{
  echo "$DAILY/manifest.json era5_daily_1deg/manifest.json"
  echo "$GCS/gc-atlas-era5/tiles/manifest.json gc-manifest.json"
  for m in 01 02 03 04 05 06 07 08 09 10 11 12; do echo "$SSTB/$m.bin.gz sst/$m.bin.gz"; done
  for y in $(seq 1991 2020); do for m in 06 07 08 09 10 11 12; do for f in u200 v200 u850 v850 shear; do
    echo "$DAILY/$f/${y}_${m}.bin.gz era5_daily_1deg/$f/${y}_${m}.bin.gz"
  done; done; done
} > "$work"

n=$(wc -l < "$work" | tr -d ' ')
echo "Mirroring $n objects -> r2:$BUCKET  (parallel=$PAR) …"
# rclone copyurl downloads each public URL and uploads it to R2.
xargs -P "$PAR" -L 1 bash -c \
  'rclone copyurl "$1" "r2:${BUCKET}/$2" >/dev/null 2>&1 && echo "ok   $2" || echo "FAIL $1"' _ < "$work" \
  | { fails=0; while read -r line; do echo "$line"; [[ "$line" == FAIL* ]] && fails=$((fails+1)); done; \
      echo "----"; [[ $fails -eq 0 ]] && echo "Mirror complete ✓" || echo "Mirror finished with $fails failures — re-run to retry."; }
rm -f "$work"
