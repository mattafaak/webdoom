#!/usr/bin/env bash
# tools/fleet-bench.sh — Fleet-wide bench runner for webdoom.
#
# Ships build/doom.{js,wasm} + tools/bench.mjs + wads/lib/doom.wad to each
# remote host, runs `node bench.mjs --json`, collects results, prints a
# 4-host comparison table, and updates tools/golden/bench-baseline.json.
#
# Usage (from repo root):
#   bash tools/fleet-bench.sh [reps=N]
#
# Host SSH targets can be overridden via environment variables:
#   FLEET_WBOX   — default: wbox
#   FLEET_TANK   — default: tank
#   FLEET_PI5    — default: configure via ~/.ssh/config or set to user@pi5
#
# Requires:  ssh BatchMode access to all three remotes; build/ present.
set -euo pipefail

# ── config ────────────────────────────────────────────────────────────────────

REPS=${1:-3}
WAD=doom.wad

# SSH targets — override via environment if needed (e.g. FLEET_PI5=myuser@pi5).
# pi5 may require an explicit user if your local username differs; set FLEET_PI5.
FLEET_WBOX=${FLEET_WBOX:-wbox}
FLEET_TANK=${FLEET_TANK:-tank}
FLEET_PI5=${FLEET_PI5:-pi5}

# Host definitions: "hostkey:ssh_target" pairs.
# alder is local (no ssh); use the literal string "local" for the ssh target.
declare -a HOST_KEYS=(
    "alder-i9-12900K:local"
    "wbox-amd-g-t56n:${FLEET_WBOX}"
    "tank-i5-8350U:${FLEET_TANK}"
    "pi5-aarch64:${FLEET_PI5}"
)

# Remote working directory.
REMOTE_DIR="\$HOME/.cache/webdoom-bench"

# Timeout per remote run, seconds.  wbox is very slow — use a generous value.
SSH_TIMEOUT=660      # 11 min; bench itself can take 10 min on wbox

# ── locate repo root ──────────────────────────────────────────────────────────

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="${REPO_ROOT}/build"
TOOLS_DIR="${REPO_ROOT}/tools"
WAD_PATH="${REPO_ROOT}/wads/lib/${WAD}"
BASELINE="${TOOLS_DIR}/golden/bench-baseline.json"

# ── freshness guard ───────────────────────────────────────────────────────────

if [[ ! -f "${BUILD_DIR}/doom.wasm" ]]; then
    echo "ERROR: build/doom.wasm missing — rebuild the engine first." >&2
    exit 1
fi

stale="$(find "${REPO_ROOT}/engine" -name '*.c' -newer "${BUILD_DIR}/doom.wasm" | head -1)"
if [[ -n "${stale}" ]]; then
    echo "ERROR: build/doom.wasm is older than engine source (${stale})." >&2
    echo "       Rebuild the engine (make / emcc) before running the fleet bench." >&2
    exit 1
fi

# ── scratch dir ──────────────────────────────────────────────────────────────

SCRATCH="$(mktemp -d /tmp/fleet-bench-XXXXXX)"
trap 'rm -rf "${SCRATCH}"' EXIT

# ── helper: copy artifacts to a remote host ───────────────────────────────────
#
# Copies doom.{js,wasm}, bench.mjs every run (small files).
# The WAD (12 MB) is only re-copied when the sha256 changes.

copy_to_remote () {
    local target="$1"   # ssh host (e.g. "wbox")

    ssh -o BatchMode=yes "${target}" "mkdir -p '${REMOTE_DIR}'"

    # WAD: only copy if sha256 changed.
    local local_sha remote_sha
    local_sha="$(sha256sum "${WAD_PATH}" | awk '{print $1}')"
    remote_sha="$(ssh -o BatchMode=yes "${target}" \
        "sha256sum '${REMOTE_DIR}/${WAD}' 2>/dev/null | awk '{print \$1}' || true")"
    if [[ "${local_sha}" != "${remote_sha}" ]]; then
        echo "  [copy wad → ${target}]"
        scp -q "${WAD_PATH}" "${target}:${REMOTE_DIR}/${WAD}"
    fi

    # Engine + bench: always copy (tiny).
    scp -q \
        "${BUILD_DIR}/doom.js" \
        "${BUILD_DIR}/doom.wasm" \
        "${TOOLS_DIR}/bench.mjs" \
        "${target}:${REMOTE_DIR}/"
}

# ── helper: run bench on a single host and write JSON to $outfile ─────────────

run_local () {
    local outfile="$1"
    # bench.mjs resolves doom.js / doom.wasm / wad relative to its own dir,
    # so stage all artifacts into a local cache dir (mirrors what remotes do).
    local local_cache="${HOME}/.cache/webdoom-bench"
    mkdir -p "${local_cache}"

    # WAD: only copy if sha256 changed.
    local local_sha remote_sha
    local_sha="$(sha256sum "${WAD_PATH}" | awk '{print $1}')"
    remote_sha="$(sha256sum "${local_cache}/${WAD}" 2>/dev/null | awk '{print $1}' || true)"
    if [[ "${local_sha}" != "${remote_sha}" ]]; then
        cp "${WAD_PATH}" "${local_cache}/${WAD}"
    fi

    cp "${BUILD_DIR}/doom.js" \
       "${BUILD_DIR}/doom.wasm" \
       "${TOOLS_DIR}/bench.mjs" \
       "${local_cache}/"

    (cd "${local_cache}" && node bench.mjs "${WAD}" "${REPS}" --json) > "${outfile}"
}

run_remote () {
    local target="$1"
    local outfile="$2"
    timeout "${SSH_TIMEOUT}" \
        ssh -o BatchMode=yes -o ConnectTimeout=30 "${target}" \
        "cd '${REMOTE_DIR}' && node bench.mjs '${WAD}' '${REPS}' --json" \
        > "${outfile}"
}

# ── run all four hosts ────────────────────────────────────────────────────────

echo "── webdoom fleet bench (reps=${REPS}) ─────────────────────"

declare -A RESULT_FILES   # hostkey → json result file
declare -A BG_PIDS        # hostkey → background pid (remotes only)

for entry in "${HOST_KEYS[@]}"; do
    hkey="${entry%%:*}"
    target="${entry##*:}"
    outfile="${SCRATCH}/${hkey}.json"
    RESULT_FILES["${hkey}"]="${outfile}"

    if [[ "${target}" == "local" ]]; then
        echo "  alder (local) — running …"
        run_local "${outfile}"
        echo "  alder done."
    else
        echo "  ${hkey} (${target}) — copying artifacts …"
        # Wrap copy+launch in a background subshell so one host's failure
        # does not abort the others (set -e applies within the subshell).
        (
            copy_to_remote "${target}" || exit 1
            run_remote "${target}" "${outfile}"
        ) &
        BG_PIDS["${hkey}"]=$!
        echo "  ${hkey} — bench started in background (pid=${BG_PIDS[${hkey}]}) …"
    fi
done

# Wait for all remotes, report per-host success/failure.
declare -A HOST_STATUS
HOST_STATUS["alder-i9-12900K"]="ok"

for hkey in "${!BG_PIDS[@]}"; do
    pid="${BG_PIDS[${hkey}]}"
    if wait "${pid}" 2>/dev/null; then
        echo "  ${hkey} — done."
        HOST_STATUS["${hkey}"]="ok"
    else
        echo "  WARNING: ${hkey} failed (pid=${pid}); will leave null in baseline." >&2
        HOST_STATUS["${hkey}"]="failed"
    fi
done

echo ""

# ── parse results and emit comparison table ───────────────────────────────────

python3 - "${BASELINE}" "${REPS}" "${REPO_ROOT}" \
    "${!RESULT_FILES[@]}" \
    -- \
    "${RESULT_FILES[@]}" \
    <<'PYEOF'
import sys, json, subprocess, datetime, os

args = sys.argv[1:]

# Split at "--"
sep = args.index("--")
header_args  = args[:sep]
result_files = args[sep+1:]

baseline_path = header_args[0]
reps          = int(header_args[1])
repo_root     = header_args[2]
host_keys     = header_args[3:]

# Map hostkey → result file (positional match)
results = {}
for hk, rf in zip(host_keys, result_files):
    if os.path.exists(rf):
        try:
            results[hk] = json.load(open(rf))
        except Exception as e:
            print(f"  WARNING: could not parse {rf}: {e}", file=sys.stderr)

# Canonical host order for display
ORDER = ["alder-i9-12900K", "wbox-amd-g-t56n", "tank-i5-8350U", "pi5-aarch64"]
DEMOS = ["demo1", "demo2", "demo3"]
STAGES = ["frame_ms", "bsp_ms", "planes_ms", "masked_ms"]
STAGE_NAMES = ["frame", "bsp  ", "planes", "masked"]

# ── 4-host comparison table ────────────────────────────────────────────────

COL = 16
print("── per-stage render ms/frame (" + ", ".join(DEMOS) + ") ─────────────────────────────")
header = f"{'':20s}" + "".join(f"{h[:COL]:>{COL}s}" for h in ORDER)
print(header)

for demo in DEMOS:
    for stage_key, stage_name in zip(STAGES, STAGE_NAMES):
        row = f"  {demo} {stage_name:<8s}"
        for hk in ORDER:
            r = results.get(hk)
            if r and r.get("schemaVersion") == 2:
                d = r.get("renderStages", {}).get(demo)
                if d:
                    row += f"{d[stage_key]:>{COL}.3f}"
                else:
                    row += f"{'—':>{COL}s}"
            else:
                row += f"{'(failed)':>{COL}s}"
        print(row)
    # sum row
    row = f"  {demo} {'SUM':8s}"
    for hk in ORDER:
        r = results.get(hk)
        if r and r.get("schemaVersion") == 2:
            d = r.get("renderStages", {}).get(demo)
            if d:
                row += f"{d['sum_ms']:>{COL}.3f}"
            else:
                row += f"{'—':>{COL}s}"
        else:
            row += f"{'(failed)':>{COL}s}"
    print(row)
    print()

print("── sim fps (-nodraw, legacy metric) ──────────────────────────────────────")
row = f"{'':20s}" + "".join(f"{h[:COL]:>{COL}s}" for h in ORDER)
print(row)
for demo in DEMOS:
    row = f"  {demo}{'':16s}"
    for hk in ORDER:
        r = results.get(hk)
        if r and r.get("schemaVersion") == 2:
            fps = r.get("simFps", {}).get(demo)
            row += f"{fps:>{COL}.0f}" if fps is not None else f"{'—':>{COL}s}"
        else:
            row += f"{'(failed)':>{COL}s}"
    print(row)
print()

# ── update baseline JSON ───────────────────────────────────────────────────

commit = subprocess.check_output(
    ["git", "-C", repo_root, "rev-parse", "--short", "HEAD"],
    text=True).strip()
date = datetime.date.today().isoformat()

try:
    wasm_bytes = os.path.getsize(os.path.join(repo_root, "build", "doom.wasm"))
except OSError:
    wasm_bytes = None

with open(baseline_path) as f:
    baseline = json.load(f)

for hk in ORDER:
    r = results.get(hk)
    if r is None or r.get("schemaVersion") != 2:
        # leave existing entry untouched (keep null or prior data)
        continue

    demos_out = {}
    for demo in DEMOS:
        d = r.get("renderStages", {}).get(demo)
        if d:
            demos_out[demo] = {
                "frames":          d["frames"],
                "frame_ms":        round(d["frame_ms"],  4),
                "bsp_ms":          round(d["bsp_ms"],    4),
                "planes_ms":       round(d["planes_ms"], 4),
                "masked_ms":       round(d["masked_ms"], 4),
                "sum_ms":          round(d["sum_ms"],    4),
                "sim_ms_per_tic":  round(d["sim_ms"],    4),
            }

    fps_out = {}
    for demo in DEMOS:
        fps = r.get("simFps", {}).get(demo)
        if fps is not None:
            fps_out[demo] = round(fps, 0)
    avg = r.get("simFpsAvg")
    if avg is not None:
        fps_out["avg"] = round(avg, 0)

    entry = {
        "commit":         commit,
        "date":           date,
        "reps":           reps,
    }
    if wasm_bytes is not None:
        entry["wasmBytes"] = wasm_bytes
    entry["demos"]         = demos_out
    entry["simFpsNodraw"]  = fps_out

    baseline["perStage"][hk] = entry

with open(baseline_path, "w") as f:
    json.dump(baseline, f, indent=2)
    f.write("\n")

print(f"── baseline updated: tools/golden/bench-baseline.json (commit {commit}, {date}) ──")
PYEOF
