#!/bin/bash
# verify-all.sh — regenerates every documented figure and drift-checks docs/*.md.
#
# Each verified claim is checked three ways:
#   doc figure (parsed from docs/*.md) == manifest.expected (claims.json) == script output
#
# Tiers:
#   default (fast): source-constant, wad-data, recipe-crack, derived-check families.
#                   Target: seconds; safe to run on every dev cycle.
#   --full:         adds runtime-stat (needs instrumented build: build-perf/doom.js)
#                   and measurement-stamp (needs build/doom.wasm).
#                   Target: minutes; run before release or on CI with perf build.
#
# Wire-in: run-tests.sh calls the fast (default) tier.
#
# What the DEFAULT gate does NOT cover (--full or excluded):
#   - runtime-stat (ps-003, ps-029..032, perf-034..035, perf-037..038, perf-045..050):
#     requires EXTRA_CFLAGS instrumented build; omitted from default to keep CI fast.
#   - measurement-stamp (perf-001..005, perf-009, perf-011, ps-033..034, perf-059):
#     some are commit-pinned (legitimate drift); ps-033/034 need golden JSON files.
#   - unverifiable: noted in claims.json with reason.  The count is computed
#     by claims-summary.mjs and printed below — never typed here (task 21.9).
#
# Usage:
#   bash tools/archaeology/verify-all.sh          # fast tier
#   bash tools/archaeology/verify-all.sh --full   # full tier (slow)
set -eo pipefail
cd "$(dirname "$0")/../.."

FULL=0
if [ "${1:-}" = "--full" ]; then FULL=1; fi

SCRIPT_VALUES_FILE="$(mktemp /tmp/verify-all-values-XXXXXX.json)"
trap 'rm -f "$SCRIPT_VALUES_FILE"' EXIT

MERGED_VALUES='{}'
FAMILIES_FAILED=0
FAMILIES_SKIPPED=0
SKIPPED_NAMES=""

# Run a family node/bash command.
# Captures CLAIMS_JSON footer (if present) and merges into MERGED_VALUES.
# Non-zero exit → increments FAMILIES_FAILED.
capture_run() {
    local label="$1"; shift
    echo ""
    echo "── $label ──────────────────────────────────────────────────"
    local outfile
    outfile="$(mktemp /tmp/verify-family-XXXXXX.out)"
    local rc=0
    "$@" > "$outfile" 2>&1 || rc=$?
    cat "$outfile"
    local jline
    jline=$(grep -o 'CLAIMS_JSON {.*}' "$outfile" | head -1 | sed 's/^CLAIMS_JSON //' || true)
    if [ -n "$jline" ]; then
        MERGED_VALUES=$(node -e "
const a = ${MERGED_VALUES};
try { const b = ${jline}; console.log(JSON.stringify(Object.assign({}, a, b))); }
catch(e) { console.log(JSON.stringify(a)); }
" 2>/dev/null || echo "$MERGED_VALUES")
    fi
    rm -f "$outfile"
    if [ $rc -ne 0 ]; then
        FAMILIES_FAILED=$((FAMILIES_FAILED + 1))
    fi
}

# Compile a C script, run it, capture CLAIMS_JSON (same as capture_run).
# compile_and_run <label> <src> [gcc-flags...] [-- binary-args...]
# Args before `--` go to gcc; args after `--` are passed to the compiled binary
# (the colormap crackers take PLAYPAL/COLORMAP lump paths that way).
compile_and_run() {
    local label="$1"
    local src="$2"
    shift 2
    local gccflags=() binargs=() seen_sep=0
    for a in "$@"; do
        if [ "$a" = "--" ] && [ "$seen_sep" = "0" ]; then seen_sep=1; continue; fi
        if [ "$seen_sep" = "1" ]; then binargs+=("$a"); else gccflags+=("$a"); fi
    done
    local bin
    bin="$(mktemp /tmp/verify-c-XXXXXX)"
    echo ""
    echo "── $label ──────────────────────────────────────────────────"
    # -lm MUST come after $src.  A library listed before the object that needs
    # it is dropped under `ld --as-needed`, which Debian/Ubuntu default to and
    # Arch does not -- so `gcc -O2 -lm src.c` links here and fails there.  It
    # bites specifically because gcc at -O2 fuses a sin()/cos() pair on one
    # argument into a single call to `sincos`, which lives in libm and NOT in
    # libc (checked: nm -D libc.so.6 has no sincos; libm.so.6 does).  The first
    # CI run this repo ever had died on exactly this, in aprox-distance-crack
    # and angle-roundtrip-check -- seven claims (ea-015..017, ea-044..047) that
    # had never once been verified on a Debian-family machine.
    if ! gcc -O2 ${gccflags[@]+"${gccflags[@]}"} "$src" -o "$bin" -lm 2>&1; then
        echo "FAIL  compile error: $src"
        FAMILIES_FAILED=$((FAMILIES_FAILED + 1))
        return
    fi
    local outfile
    outfile="$(mktemp /tmp/verify-family-XXXXXX.out)"
    local rc=0
    "$bin" ${binargs[@]+"${binargs[@]}"} > "$outfile" 2>&1 || rc=$?
    cat "$outfile"
    local jline
    jline=$(grep -o 'CLAIMS_JSON {.*}' "$outfile" | head -1 | sed 's/^CLAIMS_JSON //' || true)
    if [ -n "$jline" ]; then
        MERGED_VALUES=$(node -e "
const a = ${MERGED_VALUES};
try { const b = ${jline}; console.log(JSON.stringify(Object.assign({}, a, b))); }
catch(e) { console.log(JSON.stringify(a)); }
" 2>/dev/null || echo "$MERGED_VALUES")
    fi
    rm -f "$outfile" "$bin"
    if [ $rc -ne 0 ]; then
        FAMILIES_FAILED=$((FAMILIES_FAILED + 1))
    fi
}

# ── Fast families ──────────────────────────────────────────────────────────────

capture_run "source-constant (40 claims)" \
    node tools/archaeology/source-constant-verify.mjs

# wad-data needs an IWAD.  Game data is not distributable, so on a fresh clone
# its absence is an EXPECTED condition, not a defect -- the one case where a
# skip-on-missing is legitimate.  It is COUNTED and named like the colormap
# families below, so "the WADs are not here" can never read as "these 23 claims
# were checked".  wad-verify.mjs itself stays strict: run directly without a
# WAD it still errors, which is right on a dev box.
if [ -f "wads/lib/doom.wad" ]; then
    capture_run "wad-data (23 claims)" \
        node tools/archaeology/wad-verify.mjs
else
    echo ""
    echo "SKIP  wad-data: wads/lib/doom.wad not found (23 claims)"
    FAMILIES_SKIPPED=$((FAMILIES_SKIPPED + 1))
    SKIPPED_NAMES="${SKIPPED_NAMES:+$SKIPPED_NAMES, }wad-data"
fi

capture_run "recipe-crack / finesine-stats (3 claims: ea-001..003)" \
    node tools/archaeology/finesine-stats.mjs

capture_run "recipe-crack / gamma-crack (5 claims: ea-010..014)" \
    node tools/archaeology/gamma-crack.mjs

compile_and_run "recipe-crack / rndtable-stats (3 claims: ea-007..009)" \
    tools/archaeology/rndtable-stats.c

compile_and_run "recipe-crack / fixeddiv-proof (3 claims: ea-004..006)" \
    tools/archaeology/fixeddiv-proof.c

compile_and_run "recipe-crack / fixedmul-proof (2 claims: ea-042..043)" \
    tools/archaeology/fixedmul-proof.c

compile_and_run "recipe-crack / aprox-distance-crack (5 claims: ea-015..017, ea-044..045)" \
    tools/archaeology/aprox-distance-crack.c

compile_and_run "recipe-crack / angle-roundtrip-check (2 claims: ea-046..047)" \
    tools/archaeology/angle-roundtrip-check.c

capture_run "derived-check (4 claims: perf-036, perf-039, ps-018, ps-022)" \
    node tools/archaeology/derived-check.mjs

capture_run "recipe-crack / checkcoord-verify (1 claim: ea-027)" \
    node tools/archaeology/checkcoord-verify.mjs

capture_run "recipe-crack / zlight-distmap (1 claim: ea-028)" \
    node tools/archaeology/zlight-distmap.mjs

capture_run "recipe-crack / ledger-count (5 claims: ea-029..033)" \
    node tools/archaeology/ledger-count.mjs

# 8.1c (FINDING-10): file:line citations rot when code shifts — 844c3d6 moved
# lines under ~120 of them. This bounds-checks all engine/core citations and
# verifies doc-named identifiers actually sit near the cited lines.
capture_run "doc-citations (bounds + identifier adjacency; count is the tool's own)" \
    node tools/archaeology/check-citations.mjs

# ── COLORMAP crackers (task 6.3) ───────────────────────────────────────────────
# These cover the flagship claims — ea-018 (the 0/8192 universal recipe quoted in
# the public writeup) and ea-023 (the 241/256 figure that shipped WRONG until the
# 6.1 inventory caught it). They were the LAST claims left unprotected, which is
# exactly backwards, so they belong in the default gate.
# They need PLAYPAL + COLORMAP as raw lumps, extracted from the IWAD.
WAD_PATH="wads/lib/doom.wad"
if [ -f "$WAD_PATH" ]; then
    PLAYPAL_TMP="$(mktemp /tmp/PLAYPAL-XXXXXX.lmp)"
    COLORMAP_TMP="$(mktemp /tmp/COLORMAP-XXXXXX.lmp)"
    trap 'rm -f "$SCRIPT_VALUES_FILE" "$PLAYPAL_TMP" "$COLORMAP_TMP"' EXIT
    node -e "
const {readFileSync, writeFileSync} = require('fs');
const wad = readFileSync('$WAD_PATH');
const nl = wad.readUInt32LE(4), dofs = wad.readUInt32LE(8);
for (let i = 0; i < nl; i++) {
  const e = dofs + i*16, ofs = wad.readUInt32LE(e), sz = wad.readUInt32LE(e+4);
  const n = wad.toString('ascii', e+8, e+16).replace(/\0.*\$/, '');
  if (n === 'PLAYPAL')  writeFileSync('$PLAYPAL_TMP',  wad.subarray(ofs, ofs+sz));
  if (n === 'COLORMAP') writeFileSync('$COLORMAP_TMP', wad.subarray(ofs, ofs+sz));
}"
    compile_and_run "recipe-crack / colormap-crack (4 claims: ea-018..021)" \
        tools/archaeology/colormap-crack.c -- "$PLAYPAL_TMP" "$COLORMAP_TMP"
    compile_and_run "recipe-crack / colormap-invuln-crack (4 claims: ea-023..026)" \
        tools/archaeology/colormap-invuln-crack.c -- "$PLAYPAL_TMP" "$COLORMAP_TMP"
    # FINDING-5 (task 7.3): the recipe is id's, NOT universal. This guards the
    # corrected claim — that doom2/plutonia/tnt/chex are byte-identical copies
    # (so they were never independent evidence), and that HACX falsifies
    # universality at 3517/8192 while still corroborating the (32-L)/32 curve.
    compile_and_run "recipe-crack / colormap-cross-palette (2 claims: ea-048..049)" \
        tools/archaeology/colormap-cross-palette.c -- wads/lib
else
    echo ""
    echo "SKIP  colormap crackers: $WAD_PATH not found (ea-018..021, ea-023..026, ea-048..049)"
    # A skip nobody counts is coverage that silently shrank: this drops TEN
    # claims — including ea-018, the universal-recipe figure quoted in the
    # public writeup — while the coverage line below still said 107 (task 21.8).
    FAMILIES_SKIPPED=$((FAMILIES_SKIPPED + 3))
    SKIPPED_NAMES="colormap-crack, colormap-invuln-crack, colormap-cross-palette"
fi

# ── Full families (--full only) ────────────────────────────────────────────────
if [ "$FULL" = "1" ]; then
    echo ""
    echo "── FULL TIER ──────────────────────────────────────────────────────────"

    if [ -f "build-perf/doom.js" ]; then
        capture_run "runtime-stat (15 claims) [requires instrumented build]" \
            node tools/archaeology/runtime-stat-verify.mjs
    else
        echo ""
        FAMILIES_SKIPPED=$((FAMILIES_SKIPPED + 1))
        SKIPPED_NAMES="${SKIPPED_NAMES:+$SKIPPED_NAMES, }runtime-stat"
        echo "SKIP  runtime-stat: build-perf/doom.js not found"
        echo "      Build it with:"
        echo "        source tools/emsdk-env.sh && (cd engine && make -j8 \\"
        echo "          EXTRA_CFLAGS=\"-DWEB_PERF_COL_STATS -DWEB_PERF_PLANE_STATS \\"
        echo "                       -DWEB_PERF_SPECHIT_STATS -DWEB_PERF_TELEPORT_STATS \\"
        echo "                       -DWEB_PERF_DRAWSEG_STATS -DWEB_PERF_OPENINGS_STATS\" \\"
        echo "          BUILD=../build-perf OUT=../build-perf/doom.js)"
    fi

    capture_run "measurement-stamp / stamp-check (7 claims)" \
        node tools/archaeology/stamp-check.mjs

    if [ -f "build/doom.wasm" ]; then
        capture_run "measurement-stamp / wasm-stamp (3 claims)" \
            node tools/archaeology/wasm-stamp.mjs

        capture_run "size-ledger (4 claims: size-001..004; budget gate + README KB)" \
            node tools/archaeology/size-ledger.mjs
    else
        echo ""
        FAMILIES_SKIPPED=$((FAMILIES_SKIPPED + 2))
        SKIPPED_NAMES="${SKIPPED_NAMES:+$SKIPPED_NAMES, }wasm-stamp, size-ledger"
        echo "SKIP  wasm-stamp: build/doom.wasm not found (run make first)"
        echo "SKIP  size-ledger: build/doom.wasm not found (run make first)"
    fi
fi

# ── claims.json self-consistency (task 21.9) ──────────────────────────────────
# The manifest carries a `_summary` block whose own note says "computed from
# claims … do not hand-edit".  It was hand-edited out of date: verified read 136
# where the claims compute 137.  Nobody gated the gate's own numbers.
capture_run "claims _summary (manifest self-consistency)" \
    node tools/archaeology/claims-summary.mjs --check

# ── Three-way doc drift check ──────────────────────────────────────────────────
echo "$MERGED_VALUES" > "$SCRIPT_VALUES_FILE"
echo ""
echo "── doc drift (three-way: doc == manifest == script) ────────────────────"
DOC_ARGS="--script-values $SCRIPT_VALUES_FILE"
if [ "$FULL" = "1" ]; then DOC_ARGS="$DOC_ARGS --full"; fi
if ! node tools/archaeology/doc-drift.mjs $DOC_ARGS; then
    FAMILIES_FAILED=$((FAMILIES_FAILED + 1))
fi

# ── Coverage summary ───────────────────────────────────────────────────────────
echo ""
# Computed from claims.json, never typed (task 21.9).  The three constants that
# used to live here had all drifted from the manifest they described:
# FULL_CLAIMS said 29 against 30, UNVERIFIABLE said 13 against 17 (and the
# header comment said 16), and an inline breakdown put recipe-crack at 38
# against 40.  A coverage line nobody can check is a claim, not a measurement.
_COUNTS="$(node tools/archaeology/claims-summary.mjs --counts)" || {
    echo "FAIL  verify-all: could not compute claim counts from claims.json"
    exit 1
}
eval "$_COUNTS"
: "${FAST_CLAIMS:?claims-summary did not set FAST_CLAIMS}"
: "${FULL_CLAIMS:?claims-summary did not set FULL_CLAIMS}"
: "${UNVERIFIABLE:?claims-summary did not set UNVERIFIABLE}"

if [ "$FULL" = "1" ]; then
    COVERED=$((FAST_CLAIMS + FULL_CLAIMS))
else
    COVERED=$FAST_CLAIMS
fi

echo "Coverage: ${COVERED} claims checked"
echo "  Fast gate: ${FAST_CLAIMS} (source-constant, wad-data, recipe-crack, derived-check)"
if [ "$FULL" = "1" ]; then
    echo "  Full gate: +${FULL_CLAIMS} (runtime-stat, measurement-stamp)"
else
    echo "  Full gate: +${FULL_CLAIMS} (run with --full; needs instrumented build)"
fi
echo "  Unverifiable: ${UNVERIFIABLE} (see claims.json — hand-checked at doc-write time)"
if [ "$FAMILIES_SKIPPED" -gt 0 ]; then
    echo "  NOT RUN: ${FAMILIES_SKIPPED} verifier famil(ies) skipped — ${SKIPPED_NAMES}"
    echo "           the coverage figure above is the CEILING, not what this run checked"
fi
echo ""

# ── Final verdict ──────────────────────────────────────────────────────────────
if [ "${FAMILIES_FAILED}" -gt 0 ]; then
    echo "FAIL  verify-all: ${FAMILIES_FAILED} check(s) failed"
    exit 1
fi
if [ "$FAMILIES_SKIPPED" -gt 0 ]; then
    echo "PASS (INCOMPLETE)  verify-all: checks that ran are green, ${FAMILIES_SKIPPED} famil(ies) skipped"
    exit 0
fi
echo "ALL PASS  verify-all: all checks green"
