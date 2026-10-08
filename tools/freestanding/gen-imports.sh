#!/usr/bin/env bash
# tools/freestanding/gen-imports.sh — check IMPORTS.md against the built fs-doom.
#
# IMPORTS.md holds `nm -u fs-doom | sort` and, after it, a disposition for
# every symbol written by hand.  This script used to regenerate the whole file
# in another format, which threw the dispositions away, so nobody ran it and
# the list drifted (55 symbols recorded, 65 imported, 2026-10-08).  Now it
# only checks, and exits 1 naming what differs:
#   1. the recorded list equals what the binary imports (`U` and `w`);
#   2. every imported symbol is named in a disposition below the list.
# usage: make -C tools/freestanding imports   (or: bash gen-imports.sh)
# Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BINARY="$SCRIPT_DIR/fs-doom"
DOC="$SCRIPT_DIR/IMPORTS.md"
if [[ ! -x "$BINARY" ]]; then
    echo "FAIL imports: fs-doom not found — run 'make -C tools/freestanding' first"
    exit 1
fi
# symbol names without their @GLIBC_x version
names() { awk '{print $2}' | sed 's/@.*//' | sort -u; }
now="$(nm -u "$BINARY" | names)"
# the recorded list: the first fenced block after "## Undefined symbols"
recorded="$(awk '/^## Undefined symbols/ {f = 1; next}
                 f && /^```/ {c++; if (c == 2) exit; next}
                 f && c == 1' "$DOC" | names)"
# everything after that block: the dispositions
dispositions="$(awk '/^## Undefined symbols/ {f = 1; next}
                     f && /^```/ {c++; next}
                     c >= 2' "$DOC")"
fail=0
[[ -n "$now" ]] || { echo "FAIL imports: nm -u found no symbols in $BINARY"; exit 1; }
[[ -n "$recorded" ]] || { echo "FAIL imports: no recorded list in $DOC"; exit 1; }
added="$(comm -13 <(echo "$recorded") <(echo "$now"))"
gone="$(comm -23 <(echo "$recorded") <(echo "$now"))"
if [[ -n "$added" ]]; then
    echo "FAIL imports: fs-doom imports what IMPORTS.md does not list: $(echo $added)"
    fail=1
fi
if [[ -n "$gone" ]]; then
    echo "FAIL imports: IMPORTS.md lists what fs-doom no longer imports: $(echo $gone)"
    fail=1
fi
missing=""
while IFS= read -r sym; do
    # a _ITM_* row covers both transactional-memory hooks
    [[ "$sym" == _ITM_* ]] && sym="_ITM_"
    # named in backticks, or as a whole word in a summary row
    grep -qE "(\`$sym|(^|[^A-Za-z0-9_])$sym([^A-Za-z0-9_]|$))" <<< "$dispositions" || missing="$missing $sym"
done <<< "$now"
if [[ -n "$missing" ]]; then
    echo "FAIL imports: no disposition in IMPORTS.md for:$missing"
    fail=1
fi
if [[ "$fail" -eq 0 ]]; then
    echo "PASS imports: IMPORTS.md lists exactly the $(wc -l <<< "$now") symbols fs-doom imports, each with a disposition"
fi
exit "$fail"
