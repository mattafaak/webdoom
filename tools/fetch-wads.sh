#!/bin/bash
# Pull the Doom-engine WAD library from your WAD host (set WAD_SRC), extract,
# and build the manifest.
# Idempotent: rsync skips zips already present, unzip refreshes extraction.
set -e
cd "$(dirname "$0")/.."
SRC="${WAD_SRC:-tank:~/Downloads/doom-wads}"

ZIPS=(
    "Ultimate Doom, The.zip"
    "Doom II - Hell on Earth (v1.9).zip"
    "Final Doom - Evilution.zip"
    "Final Doom - The Plutonia Experiment.zip"
    "SIGIL (v1.21).zip"
    "Master Levels for Doom II.zip"
    "Doom II - No Rest for the Living (BFG Edition).zip"
    "Chex Quest.zip"
    "HACX (v2.0-r61).zip"
)

mkdir -p wads/zips wads/lib
for z in "${ZIPS[@]}"; do
    rsync -t --partial "$SRC/$z" wads/zips/
done

# Extract every .wad (case-insensitive), flattened, lowercased filenames.
for z in wads/zips/*.zip; do
    unzip -j -o -qq "$z" '*.wad' '*.WAD' -d wads/lib/ 2>/dev/null || true
done
for f in wads/lib/*; do
    lc="wads/lib/$(basename "$f" | tr '[:upper:] ' '[:lower:]-')"
    [ "$f" = "$lc" ] || mv -f "$f" "$lc"
done

node tools/wad-identify.mjs wads/lib wads/manifest.json
echo "manifest: $(node -e 'console.log(JSON.parse(require("fs").readFileSync("wads/manifest.json")).wads.length)') wads"
