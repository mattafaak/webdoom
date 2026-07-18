#!/usr/bin/env bash
# tools/freestanding/cycle-attrib.sh — per-subsystem instruction attribution
# for all 13 golden demos.  Extends 13.1a's cycle-floor by splitting the
# whole-program count into sim / frame / bsp / planes / masked / other.
#
# "other" = whole-program − sum(sim+frame+bsp+planes+masked), the inter-bracket
# overhead (timing probe instructions, NetUpdate(), loop bookkeeping, etc.).
# Reconciliation: stages + other must equal whole-program within documented variance.
#
# Requirements:
#   - fs-doom built with 13.1b perf.c (make -C tools/freestanding)
#   - /proc/sys/kernel/perf_event_paranoid <= 2
#   - WD_CYCLES=1 capability (same as cycle-floor.sh)
#
# Output: tools/golden/cycle-attribution.json
#
# Usage:
#   bash tools/freestanding/cycle-attrib.sh [--wad-dir <path>]
#
# Notes:
#   - Runs with rendering ON (no -nodraw); render stages are meaningful.
#     13.1a whole-program numbers also ran with rendering on, so the
#     sum(stages) should approximately reconstruct 13.1a whole-program counts
#     within the documented 1.3–9.9% run-to-run variance.
#   - p50 is the preferred comparison metric; see variance note in perf.md §13.1a.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

WAD_DIR="$REPO_ROOT/wads/lib"
for arg in "$@"; do
    if [ "$arg" = "--wad-dir" ]; then shift; WAD_DIR="$1"; shift; fi
done

FS_DOOM="$SCRIPT_DIR/fs-doom"
GOLDEN_DIR="$REPO_ROOT/tools/golden"
OUT_JSON="$GOLDEN_DIR/cycle-attribution.json"

if [ ! -x "$FS_DOOM" ]; then
    echo "error: $FS_DOOM not found — run: make -C tools/freestanding" >&2
    exit 1
fi

# Verify WD_CYCLES attribution mode works before committing to the full run.
WD_CHECK_ATT="$(mktemp)"
trap 'rm -f "$WD_CHECK_ATT"' EXIT
if ! WD_CYCLES=1 "$FS_DOOM" "$WAD_DIR/doom.wad" -timedemo demo3 \
        -attrib "$WD_CHECK_ATT" >/dev/null 2>&1; then
    echo "error: fs-doom failed on doom-demo3 probe" >&2; exit 1
fi
if ! python3 -c "
import json
d = json.load(open('$WD_CHECK_ATT'))
assert d['whole']['mean'] > 0, 'whole-program count is zero — WD_CYCLES=1 not working?'
assert d['stages']['sim']['mean'] > 0, 'sim count is zero — web_perf_now() not reading fd?'
" 2>/dev/null; then
    echo "error: attribution probe produced zero sim or whole-program count" >&2
    echo "       check /proc/sys/kernel/perf_event_paranoid (need <= 2)" >&2
    exit 1
fi

# Demo manifest (same as cycle-floor.sh and run-check.sh).
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

echo "cycle-attrib: running 13 demos × 2 passes with WD_CYCLES=1 -attrib ..."
PASS=1
while [ $PASS -le 2 ]; do
    echo "  Pass $PASS ..."
    for entry in "${DEMOS[@]}"; do
        read -r src_file present_as demo out_prefix <<< "$entry"
        src_path="$WAD_DIR/$src_file"
        if [ ! -f "$src_path" ]; then continue; fi

        wad_dir="$TMPROOT/wad/$out_prefix"
        mkdir -p "$wad_dir"
        ln -sf "$src_path" "$wad_dir/$present_as"
        wad_path="$wad_dir/$present_as"

        attrib_file="$TMPROOT/pass${PASS}_${out_prefix}.json"
        printf "    %-20s pass%d ... " "$out_prefix" "$PASS"
        if WD_CYCLES=1 "$FS_DOOM" "$wad_path" -timedemo "$demo" \
                -attrib "$attrib_file" >/dev/null 2>/dev/null; then
            echo "ok"
        else
            echo "FAIL (fs-doom exit non-zero)" >&2
            exit 1
        fi
    done
    PASS=$((PASS + 1))
done

echo "cycle-attrib: aggregating results ..."

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

STAGES = ["sim", "frame", "bsp", "planes", "masked", "other"]

results = []
skipped = []

for src, _, demo, name in DEMOS:
    if not os.path.exists(os.path.join(wad_dir, src)):
        skipped.append(name)
        continue

    p1 = json.load(open(os.path.join(tmproot, f"pass1_{name}.json")))
    p2 = json.load(open(os.path.join(tmproot, f"pass2_{name}.json")))

    def avg_stat(s1, s2):
        return {
            "mean": round((s1["mean"] + s2["mean"]) / 2, 1),
            "p50":  (s1["p50"] + s2["p50"]) // 2,
            "p99":  (s1["p99"] + s2["p99"]) // 2,
            "max":  max(s1["max"], s2["max"]),
        }

    stages = {s: avg_stat(p1["stages"][s], p2["stages"][s]) for s in STAGES}
    whole  = avg_stat(p1["whole"], p2["whole"])

    # Reconciliation: sum(stages mean) vs whole mean (both runs averaged).
    sum_stages = sum(stages[s]["mean"] for s in STAGES)
    if whole["mean"] > 0:
        delta_pct = abs(sum_stages - whole["mean"]) / whole["mean"] * 100.0
    else:
        delta_pct = 0.0

    # Stage shares of whole-program mean (p50-based for robustness).
    render_total_p50 = (stages["frame"]["p50"] + stages["bsp"]["p50"]
                        + stages["planes"]["p50"] + stages["masked"]["p50"])
    sim_pct = (stages["sim"]["p50"] / whole["p50"] * 100.0
               if whole["p50"] > 0 else 0.0)
    render_pct = (render_total_p50 / whole["p50"] * 100.0
                  if whole["p50"] > 0 else 0.0)

    # Variance (run-to-run) on whole-program mean.
    t1, t2 = p1["whole"]["mean"] * p1["tics"], p2["whole"]["mean"] * p2["tics"]
    mean_total = (t1 + t2) / 2.0
    var_pct = round(abs(t1 - t2) / mean_total * 100.0, 3) if mean_total > 0 else 0.0

    results.append({
        "demo":           name,
        "tics":           p1["tics"],
        "stages":         stages,
        "whole":          whole,
        "render_total_p50": render_total_p50,
        "sim_pct_of_whole_p50": round(sim_pct, 1),
        "render_pct_of_whole_p50": round(render_pct, 1),
        "reconciliation_delta_pct": round(delta_pct, 4),
        "reconciliation_ok": delta_pct < 5.0,  # within twice the documented variance
        "variance_pct":   var_pct,
        "pass1":          p1["stages"],
        "pass2":          p2["stages"],
    })

# Per-IWAD summary.
iwad_groups = {
    "doom.wad":     [r for r in results if r["demo"].startswith("doom-")],
    "doom2.wad":    [r for r in results if r["demo"].startswith("doom2-")],
    "tnt.wad":      [r for r in results if r["demo"].startswith("tnt-")],
    "plutonia.wad": [r for r in results if r["demo"].startswith("plutonia-")],
}

per_iwad = {}
for iwad, group in iwad_groups.items():
    if not group: continue
    avg_sim_p50    = sum(r["stages"]["sim"]["p50"]   for r in group) // len(group)
    avg_whole_p50  = sum(r["whole"]["p50"]           for r in group) // len(group)
    avg_render_p50 = sum(r["render_total_p50"]       for r in group) // len(group)
    avg_sim_pct    = round(sum(r["sim_pct_of_whole_p50"] for r in group) / len(group), 1)
    per_iwad[iwad] = {
        "demos_measured":    len(group),
        "sim_p50":           avg_sim_p50,
        "render_total_p50":  avg_render_p50,
        "whole_p50":         avg_whole_p50,
        "sim_pct_of_whole":  avg_sim_pct,
    }

# Worst stage across all demos (highest p99 non-other stage).
worst_stage = ""
worst_p99   = 0
for r in results:
    for s in ["sim", "bsp", "planes", "masked", "frame"]:
        if r["stages"][s]["p99"] > worst_p99:
            worst_p99   = r["stages"][s]["p99"]
            worst_stage = f"{r['demo']}/{s}"

max_recon_delta = max((r["reconciliation_delta_pct"] for r in results), default=0.0)
all_recon_ok    = all(r["reconciliation_ok"] for r in results)

out = {
    "schema":    "cycle-attribution.v1",
    "generated": "tools/freestanding/cycle-attrib.sh",
    "arch":      "x86-64 (user-space retired instructions; PERF_COUNT_HW_INSTRUCTIONS)",
    "note":      ("Rendering ON (no -nodraw); render stages are meaningful. "
                  "Cross-ISA conversion factors are task 13.5's job."),
    "passes":    2,
    "reconciliation_ok_all": all_recon_ok,
    "max_reconciliation_delta_pct": round(max_recon_delta, 4),
    "worst_stage": worst_stage,
    "per_iwad":  per_iwad,
    "demos":     results,
    "skipped":   skipped,
}

with open(out_json, "w") as f:
    json.dump(out, f, indent=2)
    f.write("\n")

# Print human-readable summary.
print("\ncycle-attrib summary (instr/tic p50, x86-64 user-space retired instructions):\n")
print(f"  {'demo':<20} {'tics':>5} {'sim':>9} {'frame':>7} {'bsp':>9} "
      f"{'planes':>8} {'masked':>8} {'other':>8} {'whole':>9}  {'recon%':>7}")
print(f"  {'-'*20} {'-'*5} {'-'*9} {'-'*7} {'-'*9} "
      f"{'-'*8} {'-'*8} {'-'*8} {'-'*9}  {'-'*7}")
for r in results:
    s = r["stages"]
    print(f"  {r['demo']:<20} {r['tics']:>5} "
          f"{s['sim']['p50']:>9} {s['frame']['p50']:>7} {s['bsp']['p50']:>9} "
          f"{s['planes']['p50']:>8} {s['masked']['p50']:>8} {s['other']['p50']:>8} "
          f"{r['whole']['p50']:>9}  {r['reconciliation_delta_pct']:>6.3f}%")
if skipped:
    print(f"\n  (skipped: {', '.join(skipped)} — WAD not found)")

print("\nper-IWAD summary (p50 instr/tic):")
for iwad, v in per_iwad.items():
    print(f"  {iwad:<14}  sim={v['sim_p50']:>9}  render={v['render_total_p50']:>9}"
          f"  whole={v['whole_p50']:>9}  sim%={v['sim_pct_of_whole']:>5.1f}%")

print(f"\nmax reconciliation delta: {max_recon_delta:.4f}%  "
      f"({'OK' if all_recon_ok else 'WARNING: some demos > 5%'})")
print(f"worst high-p99 stage: {worst_stage}  p99={worst_p99:,}")
print(f"\nwrote: {out_json}")
PYEOF

echo ""
echo "cycle-attrib: DONE — $OUT_JSON"
