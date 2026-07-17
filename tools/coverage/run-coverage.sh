#!/usr/bin/env bash
# tools/coverage/run-coverage.sh — gcov coverage harness for engine/core.
#
# Runs in two passes:
#   Pass A: 13 golden demos only  → report-demos.json
#   Pass B: 13 demos + ≥50 fuzz seeds → report-full.json
#
# Delta between the two passes is reported in REPORT.md.
# The never-executed function list is the primary deliverable for task 9.2b.
#
# Prerequisites:
#   gcc (m32, gcov support)   — verified: /usr/lib/gcc/.../32/libgcov.a present
#   python3                   — for parse-gcov.py
#   node                      — for gen-demo.mjs (fuzz seed generation)
#   WADs in wads/lib/         — tools/fetch-wads.sh if missing
#
# Usage:
#   bash tools/coverage/run-coverage.sh [--seeds N] [--no-fuzz]
#
#   --seeds N   number of fuzz seeds (default 50)
#   --no-fuzz   skip Pass B fuzz seeds (demos-only mode for quick reruns)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
NS_DIR="${REPO_ROOT}/tools/native-sanitize"
COV_DIR="${SCRIPT_DIR}"
WAD_DIR="${REPO_ROOT}/wads/lib"
FUZZ_DIR="${REPO_ROOT}/tools/fuzz"

NAT_DOOM_COV="${NS_DIR}/nat-doom-cov"
COV_OBJ="${NS_DIR}/cov-obj"

NUM_SEEDS=50
NO_FUZZ=0

for arg in "$@"; do
    case "$arg" in
        --seeds) ;;          # handled by shift pattern below
        --no-fuzz) NO_FUZZ=1 ;;
    esac
done
# Re-parse for --seeds N
i=1
while [ $i -le $# ]; do
    arg="${!i}"
    if [ "$arg" = "--seeds" ]; then
        i=$(( i + 1 ))
        NUM_SEEDS="${!i}"
    fi
    i=$(( i + 1 ))
done

# ── demo matrix (mirrors tools/native-sanitize/run-all.sh) ───────────────────
DEMOS=(
    "doom.wad      demo1 doom-demo1"
    "doom.wad      demo2 doom-demo2"
    "doom.wad      demo3 doom-demo3"
    "doom.wad      demo4 doom-demo4"
    "doom2.wad     demo1 doom2-demo1"
    "doom2.wad     demo2 doom2-demo2"
    "doom2.wad     demo3 doom2-demo3"
    "tnt.wad       demo1 tnt-demo1"
    "tnt.wad       demo2 tnt-demo2"
    "tnt.wad       demo3 tnt-demo3"
    "plutonia.wad  demo1 plutonia-demo1"
    "plutonia.wad  demo2 plutonia-demo2"
    "plutonia.wad  demo3 plutonia-demo3"
)

# ── helpers ───────────────────────────────────────────────────────────────────

run_demos() {
    local failures=0
    local ran=0
    local skipped=0

    for entry in "${DEMOS[@]}"; do
        read -r wad_file demo out_prefix <<< "$entry"
        local wad_path="${WAD_DIR}/${wad_file}"

        if [[ ! -f "$wad_path" ]]; then
            echo "  skip ${out_prefix} (${wad_path} not found)"
            skipped=$(( skipped + 1 ))
            continue
        fi

        # Isolate each WAD so IdentifyVersion() picks exactly this one.
        local tmpwad
        tmpwad="$(mktemp -d)"
        ln -s "$wad_path" "${tmpwad}/${wad_file}"
        # doom.wad retail ships as doomu.wad in the JS build; supply both.
        if [[ "$wad_file" == "doom.wad" ]]; then
            ln -s "$wad_path" "${tmpwad}/doomu.wad"
        fi

        printf "  %-20s ... " "${out_prefix}"
        local ret=0
        "${NAT_DOOM_COV}" \
            -waddir "${tmpwad}" \
            -timedemo "${demo}" \
            2>/dev/null || ret=$?
        rm -rf "${tmpwad}"

        if [[ $ret -ne 0 ]]; then
            echo "FAIL (exit ${ret})"
            failures=$(( failures + 1 ))
        else
            echo "ok"
            ran=$(( ran + 1 ))
        fi
    done

    echo "  demos: ${ran} ok, ${failures} failed, ${skipped} skipped"
    return $failures
}

run_fuzz_seeds() {
    local num="${1:-50}"
    local doom2_wad="${WAD_DIR}/doom2.wad"

    if [[ ! -f "${doom2_wad}" ]]; then
        echo "  WARNING: doom2.wad not found — skipping fuzz seeds"
        return 0
    fi

    if ! command -v node >/dev/null 2>&1; then
        echo "  WARNING: node not found — skipping fuzz seeds"
        return 0
    fi

    echo "  generating and running ${num} fuzz seeds (doom2.wad MAP01)..."
    local failures=0

    for seed in $(seq 0 $(( num - 1 ))); do
        local tmpdir
        tmpdir="$(mktemp -d)"
        ln -s "${doom2_wad}" "${tmpdir}/doom2.wad"

        # Generate the PWAD for this seed
        node "${FUZZ_DIR}/gen-demo.mjs" "${seed}" "${tmpdir}/fuzz.wad" 2>/dev/null

        local ret=0
        "${NAT_DOOM_COV}" \
            -waddir "${tmpdir}" \
            -file fuzz.wad \
            -timedemo FUZZDEMO \
            2>/dev/null || ret=$?
        rm -rf "${tmpdir}"

        if [[ $ret -ne 0 ]]; then
            echo "  seed ${seed}: FAIL (exit ${ret})"
            failures=$(( failures + 1 ))
        fi
    done

    if [[ $failures -eq 0 ]]; then
        echo "  fuzz seeds: all ${num} ok"
    else
        echo "  fuzz seeds: ${failures}/${num} failed"
    fi
    return 0  # non-fatal: partial fuzz coverage is still useful
}

reset_gcda() {
    find "${COV_OBJ}" -name '*.gcda' -delete 2>/dev/null || true
}

collect_gcov() {
    local out_json="$1"
    local label="$2"

    local gcov_work="${COV_OBJ}/gcov-work"
    rm -rf "${gcov_work}"
    mkdir -p "${gcov_work}"

    echo "  collecting gcov data..."

    # Process core sources
    # gcov --json-format with -o <dir> looks for <dir>/<basename>.gcno
    # Output *.gcov.json.gz lands in the current working directory (gcov_work).
    local core_src=()
    while IFS= read -r f; do
        core_src+=("$f")
    done < <(ls "${REPO_ROOT}/engine/core/"*.c 2>/dev/null)

    if [[ ${#core_src[@]} -gt 0 ]]; then
        (cd "${gcov_work}" && \
            gcov --json-format -b \
                 -o "${COV_OBJ}/core" \
                 "${core_src[@]}" \
                 2>/dev/null) || true
    fi

    # Process platform sources (tools/native-sanitize/*.c)
    local plat_src=(
        "${NS_DIR}/i_main.c"
        "${NS_DIR}/i_system.c"
        "${NS_DIR}/i_video.c"
        "${NS_DIR}/i_sound.c"
        "${NS_DIR}/d_net.c"
        "${NS_DIR}/files.c"
        "${NS_DIR}/perf.c"
    )
    local plat_existing=()
    for f in "${plat_src[@]}"; do
        [[ -f "$f" ]] && plat_existing+=("$f")
    done

    if [[ ${#plat_existing[@]} -gt 0 ]]; then
        (cd "${gcov_work}" && \
            gcov --json-format -b \
                 -o "${COV_OBJ}/plat" \
                 "${plat_existing[@]}" \
                 2>/dev/null) || true
    fi

    local nfiles
    nfiles="$(find "${gcov_work}" -name '*.gcov.json.gz' -o -name '*.gcov.json' | wc -l)"
    echo "  gcov produced ${nfiles} coverage file(s)"

    python3 "${COV_DIR}/parse-gcov.py" collect \
        "${gcov_work}" \
        "${out_json}" \
        --repo-root "${REPO_ROOT}"

    rm -rf "${gcov_work}"
    echo "  wrote ${out_json}"
}

# ── Step 1: build nat-doom-cov ────────────────────────────────────────────────

echo "=== Step 1: Building nat-doom-cov ==="
make -C "${NS_DIR}" nat-doom-cov 2>&1 | tail -3
echo "  binary: ${NAT_DOOM_COV}"

# ── Step 2: Pass A — demos only ───────────────────────────────────────────────

echo ""
echo "=== Step 2: Pass A — 13 golden demos ==="
reset_gcda
run_demos

echo ""
echo "  --- collecting Pass A coverage ---"
collect_gcov "${COV_DIR}/report-demos.json" "demos"

# ── Step 3: Pass B — demos + fuzz corpus ──────────────────────────────────────

echo ""
echo "=== Step 3: Pass B — 13 demos + fuzz corpus ==="
reset_gcda
run_demos

if [[ $NO_FUZZ -eq 0 ]]; then
    run_fuzz_seeds "${NUM_SEEDS}"
else
    echo "  (fuzz seeds skipped via --no-fuzz)"
fi

echo ""
echo "  --- collecting Pass B coverage ---"
collect_gcov "${COV_DIR}/report-full.json" "full"

# ── Step 4: Generate REPORT.md ────────────────────────────────────────────────

echo ""
echo "=== Step 4: Generating REPORT.md ==="
python3 "${COV_DIR}/parse-gcov.py" report \
    "${COV_DIR}/report-demos.json" \
    "${COV_DIR}/report-full.json" \
    > "${COV_DIR}/REPORT.md"
echo "  wrote ${COV_DIR}/REPORT.md"

# ── Summary ───────────────────────────────────────────────────────────────────

echo ""
echo "=== Coverage summary ==="
COV_DIR="${COV_DIR}" python3 -c "
import json, sys, os

cov_dir = os.environ.get('COV_DIR', '')
if not cov_dir:
    sys.exit(0)

def load(p):
    with open(p) as f:
        return json.load(f)

try:
    d = load(os.path.join(cov_dir, 'report-demos.json'))
    x = load(os.path.join(cov_dir, 'report-full.json'))
except FileNotFoundError as e:
    print(f'  (summary unavailable: {e})')
    sys.exit(0)

dt = d['totals']
xt = x['totals']
fn_delta = xt['functions_hit'] - dt['functions_hit']
br_delta = round(xt['branch_pct'] - dt['branch_pct'], 1)
never = len(x['never_executed'])

print(f\"  demos only:      {dt['functions_hit']}/{dt['functions_total']} fns ({dt['function_pct']}%)  {dt['branch_pct']}% branches\")
print(f\"  demos+fuzz:      {xt['functions_hit']}/{xt['functions_total']} fns ({xt['function_pct']}%)  {xt['branch_pct']}% branches\")
print(f\"  fuzz delta:      +{fn_delta} functions  {br_delta:+.1f} pp branches\")
print(f\"  never executed:  {never} functions\")
"

echo ""
echo "=== Done ==="
echo "  tools/coverage/report-demos.json  — machine-readable, Pass A"
echo "  tools/coverage/report-full.json   — machine-readable, Pass B"
echo "  tools/coverage/REPORT.md          — human summary + never-executed list"
