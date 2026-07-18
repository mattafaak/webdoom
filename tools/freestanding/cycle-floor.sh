#!/usr/bin/env bash
# tools/freestanding/cycle-floor.sh — per-tic instruction-count floor for all
# 13 golden demos.  Runs every demo twice (noise characterisation), emits
# tools/golden/cycle-floor.json with per-demo stats (mean/p50/p99/max) and
# run-to-run variance for each demo.
#
# Requirements:
#   - fs-doom built (make -C tools/freestanding)
#   - /proc/sys/kernel/perf_event_paranoid <= 2
#   - WD_CYCLES=1 capability (uses perf_event_open PERF_COUNT_HW_INSTRUCTIONS)
#
# Output: tools/golden/cycle-floor.json
#
# Usage:
#   bash tools/freestanding/cycle-floor.sh [--wad-dir <path>]
#
# These are user-space retired x86-64 instructions.  Cross-ISA conversion
# factors (arm64, riscv, ...) are 13.5's job — NOT claimed here.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

WAD_DIR="$REPO_ROOT/wads/lib"
for arg in "$@"; do
    if [ "$arg" = "--wad-dir" ]; then shift; WAD_DIR="$1"; shift; fi
done

FS_DOOM="$SCRIPT_DIR/fs-doom"
GOLDEN_DIR="$REPO_ROOT/tools/golden"
OUT_JSON="$GOLDEN_DIR/cycle-floor.json"

if [ ! -x "$FS_DOOM" ]; then
    echo "error: $FS_DOOM not found — run: make -C tools/freestanding" >&2
    exit 1
fi

# Verify WD_CYCLES mode works before committing to the full run.
WD_CHECK="$(mktemp)"
trap 'rm -f "$WD_CHECK"' EXIT
if ! WD_CYCLES=1 "$FS_DOOM" "$WAD_DIR/doom.wad" -timedemo demo3 \
        -cycles "$WD_CHECK" >/dev/null 2>&1; then
    echo "error: fs-doom failed on doom-demo3 probe" >&2; exit 1
fi
if ! python3 -c "import json; d=json.load(open('$WD_CHECK')); assert d['total_instr']>0" 2>/dev/null; then
    echo "error: WD_CYCLES=1 produced zero instruction count — perf_event_open failed?" >&2
    echo "       check /proc/sys/kernel/perf_event_paranoid (need <= 2)" >&2
    exit 1
fi

# Demo manifest: same entries as run-check.sh.
DEMOS=(
    "doom.wad     doomu.wad demo1 doom-demo1"
    "doom.wad     doomu.wad demo2 doom-demo2"
    "doom.wad     doomu.wad demo3 doom-demo3"
    "doom.wad     doomu.wad demo4 doom-demo4"
    "doom2.wad    doom2.wad demo1 doom2-demo1"
    "doom2.wad    doom2.wad demo2 doom2-demo2"
    "doom2.wad    doom2.wad demo3 doom2-demo3"
    "tnt.wad      tnt.wad   demo1 tnt-demo1"
    "tnt.wad      tnt.wad   demo2 tnt-demo2"
    "tnt.wad      tnt.wad   demo3 tnt-demo3"
    "plutonia.wad plutonia.wad demo1 plutonia-demo1"
    "plutonia.wad plutonia.wad demo2 plutonia-demo2"
    "plutonia.wad plutonia.wad demo3 plutonia-demo3"
)

TMPROOT="$(mktemp -d)"
trap 'rm -rf "$TMPROOT"' EXIT

# Run all demos twice to characterise noise.
echo "cycle-floor: running 13 demos × 2 passes with WD_CYCLES=1 ..."
PASS=1
while [ $PASS -le 2 ]; do
    echo "  Pass $PASS ..."
    for entry in "${DEMOS[@]}"; do
        read -r src_file present_as demo out_prefix <<< "$entry"
        src_path="$WAD_DIR/$src_file"
        if [ ! -f "$src_path" ]; then continue; fi

        # Present the WAD under the name IdentifyVersion expects.
        wad_dir="$TMPROOT/wad/$out_prefix"
        mkdir -p "$wad_dir"
        ln -sf "$src_path" "$wad_dir/$present_as"
        wad_path="$wad_dir/$present_as"

        cycles_file="$TMPROOT/pass${PASS}_${out_prefix}.json"
        printf "    %-20s pass%d ... " "$out_prefix" "$PASS"
        if WD_CYCLES=1 "$FS_DOOM" "$wad_path" -timedemo "$demo" \
                -cycles "$cycles_file" >/dev/null 2>/dev/null; then
            echo "ok"
        else
            echo "FAIL (fs-doom exit non-zero)" >&2
            exit 1
        fi
    done
    PASS=$((PASS + 1))
done

echo "cycle-floor: aggregating results ..."

# Aggregate with Python: parse both passes, compute per-demo variance, emit JSON.
python3 - "$TMPROOT" "$WAD_DIR" "$OUT_JSON" << 'PYEOF'
import json, sys, math, os

tmproot = sys.argv[1]
wad_dir = sys.argv[2]
out_json = sys.argv[3]

DEMOS = [
    ("doom.wad",     "doomu.wad",    "demo1", "doom-demo1"),
    ("doom.wad",     "doomu.wad",    "demo2", "doom-demo2"),
    ("doom.wad",     "doomu.wad",    "demo3", "doom-demo3"),
    ("doom.wad",     "doomu.wad",    "demo4", "doom-demo4"),
    ("doom2.wad",    "doom2.wad",    "demo1", "doom2-demo1"),
    ("doom2.wad",    "doom2.wad",    "demo2", "doom2-demo2"),
    ("doom2.wad",    "doom2.wad",    "demo3", "doom2-demo3"),
    ("tnt.wad",      "tnt.wad",      "demo1", "tnt-demo1"),
    ("tnt.wad",      "tnt.wad",      "demo2", "tnt-demo2"),
    ("tnt.wad",      "tnt.wad",      "demo3", "tnt-demo3"),
    ("plutonia.wad", "plutonia.wad", "demo1", "plutonia-demo1"),
    ("plutonia.wad", "plutonia.wad", "demo2", "plutonia-demo2"),
    ("plutonia.wad", "plutonia.wad", "demo3", "plutonia-demo3"),
]

results = []
skipped = []
worst_p99 = 0
worst_demo = ""

for src, _, demo, name in DEMOS:
    if not os.path.exists(os.path.join(wad_dir, src)):
        skipped.append(name)
        continue
    p1 = json.load(open(os.path.join(tmproot, f"pass1_{name}.json")))
    p2 = json.load(open(os.path.join(tmproot, f"pass2_{name}.json")))

    # Mean of the two passes for each stat.
    def avg(a, b): return round((a + b) / 2.0, 1)

    mean_avg   = avg(p1["instr_per_tic"]["mean"], p2["instr_per_tic"]["mean"])
    p50_avg    = (p1["instr_per_tic"]["p50"] + p2["instr_per_tic"]["p50"]) // 2
    p99_avg    = (p1["instr_per_tic"]["p99"] + p2["instr_per_tic"]["p99"]) // 2
    max_avg    = max(p1["instr_per_tic"]["max"], p2["instr_per_tic"]["max"])

    # Run-to-run variance: |total_instr_run1 - total_instr_run2| / mean * 100
    t1, t2 = p1["total_instr"], p2["total_instr"]
    mean_total = (t1 + t2) / 2.0
    var_pct = round(abs(t1 - t2) / mean_total * 100.0, 3) if mean_total > 0 else 0.0

    results.append({
        "demo":         name,
        "tics":         p1["tics"],
        "total_instr":  (t1 + t2) // 2,
        "instr_per_tic": {
            "mean": mean_avg,
            "p50":  p50_avg,
            "p99":  p99_avg,
            "max":  max_avg,
        },
        "variance_pct": var_pct,
        "pass1":        p1["instr_per_tic"],
        "pass2":        p2["instr_per_tic"],
    })

    if p99_avg > worst_p99:
        worst_p99  = p99_avg
        worst_demo = name

# Per-IWAD summary: worst p99 per IWAD.
iwad_groups = {
    "doom.wad":     [r for r in results if r["demo"].startswith("doom-")],
    "doom2.wad":    [r for r in results if r["demo"].startswith("doom2-")],
    "tnt.wad":      [r for r in results if r["demo"].startswith("tnt-")],
    "plutonia.wad": [r for r in results if r["demo"].startswith("plutonia-")],
}

per_iwad = {}
for iwad, group in iwad_groups.items():
    if not group: continue
    avg_mean = round(sum(r["instr_per_tic"]["mean"] for r in group) / len(group), 1)
    max_p99  = max(r["instr_per_tic"]["p99"] for r in group)
    max_var  = max(r["variance_pct"] for r in group)
    per_iwad[iwad] = {
        "demos_measured": len(group),
        "mean_instr_per_tic": avg_mean,
        "worst_p99":          max_p99,
        "max_variance_pct":   max_var,
    }

max_var_all = max((r["variance_pct"] for r in results), default=0.0)

out = {
    "schema":       "cycle-floor.v1",
    "generated":    "tools/freestanding/cycle-floor.sh",
    "arch":         "x86-64 (user-space retired instructions; PERF_COUNT_HW_INSTRUCTIONS)",
    "note":         "Cross-ISA conversion factors are task 13.5's job — NOT claimed here.",
    "passes":       2,
    "max_variance_pct": round(max_var_all, 3),
    "worst_demo":   worst_demo,
    "worst_p99":    worst_p99,
    "per_iwad":     per_iwad,
    "demos":        results,
    "skipped":      skipped,
}

with open(out_json, "w") as f:
    json.dump(out, f, indent=2)
    f.write("\n")

# Print human-readable summary table.
print("\ncycle-floor summary (instr/tic, x86-64 user-space retired instructions):\n")
print(f"  {'demo':<20} {'tics':>5} {'mean':>9} {'p50':>9} {'p99':>9} {'max':>9}  {'var%':>6}")
print(f"  {'-'*20} {'-'*5} {'-'*9} {'-'*9} {'-'*9} {'-'*9}  {'-'*6}")
for r in results:
    s = r["instr_per_tic"]
    print(f"  {r['demo']:<20} {r['tics']:>5} "
          f"{s['mean']:>9.0f} {s['p50']:>9} {s['p99']:>9} {s['max']:>9}  "
          f"{r['variance_pct']:>5.3f}%")
if skipped:
    print(f"\n  (skipped: {', '.join(skipped)} — WAD not found)")

print("\nper-IWAD summary:")
for iwad, v in per_iwad.items():
    print(f"  {iwad:<14}  mean={v['mean_instr_per_tic']:>9.0f} /tic  "
          f"worst-p99={v['worst_p99']:>9}  max-var={v['max_variance_pct']:.3f}%")

print(f"\nworst-case demo: {worst_demo}  p99={worst_p99:,} instr/tic")
print(f"max run-to-run variance: {max_var_all:.3f}%")
print(f"\nwrote: {out_json}")
PYEOF

echo ""
echo "cycle-floor: DONE — $OUT_JSON"
