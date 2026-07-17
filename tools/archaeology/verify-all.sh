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
#   - unverifiable (16 claims): noted in claims.json with reason.
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
# Args: label src_file [extra gcc flags...]
compile_and_run() {
    local label="$1"
    local src="$2"
    shift 2
    local bin
    bin="$(mktemp /tmp/verify-c-XXXXXX)"
    echo ""
    echo "── $label ──────────────────────────────────────────────────"
    if ! gcc -O2 -lm "$@" "$src" -o "$bin" 2>&1; then
        echo "FAIL  compile error: $src"
        FAMILIES_FAILED=$((FAMILIES_FAILED + 1))
        return
    fi
    local outfile
    outfile="$(mktemp /tmp/verify-family-XXXXXX.out)"
    local rc=0
    "$bin" > "$outfile" 2>&1 || rc=$?
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

capture_run "wad-data (23 claims)" \
    node tools/archaeology/wad-verify.mjs

capture_run "recipe-crack / finesine-stats (3 claims: ea-001..003)" \
    node tools/archaeology/finesine-stats.mjs

capture_run "recipe-crack / gamma-crack (5 claims: ea-010..014)" \
    node tools/archaeology/gamma-crack.mjs

compile_and_run "recipe-crack / rndtable-stats (3 claims: ea-007..009)" \
    tools/archaeology/rndtable-stats.c

compile_and_run "recipe-crack / aprox-distance-crack (3 claims: ea-015..017)" \
    tools/archaeology/aprox-distance-crack.c

capture_run "derived-check (4 claims: perf-036, perf-039, ps-018, ps-022)" \
    node tools/archaeology/derived-check.mjs

# ── Full families (--full only) ────────────────────────────────────────────────
if [ "$FULL" = "1" ]; then
    echo ""
    echo "── FULL TIER ──────────────────────────────────────────────────────────"

    if [ -f "build-perf/doom.js" ]; then
        capture_run "runtime-stat (15 claims) [requires instrumented build]" \
            node tools/archaeology/runtime-stat-verify.mjs
    else
        echo ""
        echo "SKIP  runtime-stat: build-perf/doom.js not found"
        echo "      Build with EXTRA_CFLAGS=-DWEB_PERF_COL_STATS -DWEB_PERF_PLANE_STATS ..."
    fi

    capture_run "measurement-stamp / stamp-check (7 claims)" \
        node tools/archaeology/stamp-check.mjs

    if [ -f "build/doom.wasm" ]; then
        capture_run "measurement-stamp / wasm-stamp (3 claims)" \
            node tools/archaeology/wasm-stamp.mjs
    else
        echo ""
        echo "SKIP  wasm-stamp: build/doom.wasm not found (run make first)"
    fi
fi

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
FAST_CLAIMS=81   # source-constant(40) + wad-data(23) + recipe-crack(14) + derived-check(4)
FULL_CLAIMS=25   # + runtime-stat(15) + measurement-stamp(10)
UNVERIFIABLE=16

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
echo ""

# ── Final verdict ──────────────────────────────────────────────────────────────
if [ "${FAMILIES_FAILED}" -gt 0 ]; then
    echo "FAIL  verify-all: ${FAMILIES_FAILED} check(s) failed"
    exit 1
fi
echo "ALL PASS  verify-all: all checks green"
