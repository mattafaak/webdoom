#!/usr/bin/env python3
"""compare.py — diff native ASan/UBSan JSON traces against tools/golden/.

Usage:
    python3 compare.py <golden_dir> <out_dir> [sim|render|both]

Exit 0 = all checked goldens match.
Exit 1 = one or more mismatches or missing output files.
"""
import json
import os
import sys


def load(path):
    with open(path) as f:
        return json.load(f)


def compare_trace(name, golden_path, out_path):
    if not os.path.exists(out_path):
        print(f"MISSING  {name}: {out_path} not produced")
        return False
    if not os.path.exists(golden_path):
        print(f"NO-GOLDEN {name}: {golden_path} (skip)")
        return True  # not a failure — golden not yet recorded

    g = load(golden_path)
    o = load(out_path)

    if g["tics"] != o["tics"]:
        print(f"FAIL  {name}: tics {o['tics']} != golden {g['tics']}")
        return False

    gt = g["trace"]
    ot = o["trace"]
    if len(gt) != len(ot):
        print(f"FAIL  {name}: trace length {len(ot)} != golden {len(gt)}")
        return False

    for i, (gv, ov) in enumerate(zip(gt, ot)):
        # Compare as unsigned 32-bit integers (matches JS >>> 0 coercion).
        if (gv & 0xFFFFFFFF) != (ov & 0xFFFFFFFF):
            print(f"FAIL  {name}: DESYNC at tic {i} "
                  f"(native 0x{ov&0xFFFFFFFF:08x} != golden 0x{gv&0xFFFFFFFF:08x})")
            return False

    print(f"PASS  {name}: {o['tics']} gametics, {len(ot)} hashes identical")
    return True


def main():
    golden_dir = sys.argv[1] if len(sys.argv) > 1 else "../../tools/golden"
    out_dir    = sys.argv[2] if len(sys.argv) > 2 else "out"
    mode       = sys.argv[3] if len(sys.argv) > 3 else "both"

    do_sim    = mode in ("sim",    "both")
    do_render = mode in ("render", "both")

    demos = [
        ("doom-demo1",     "doom-demo1"),
        ("doom-demo2",     "doom-demo2"),
        ("doom-demo3",     "doom-demo3"),
        ("doom-demo4",     "doom-demo4"),
        ("doom2-demo1",    "doom2-demo1"),
        ("doom2-demo2",    "doom2-demo2"),
        ("doom2-demo3",    "doom2-demo3"),
        ("tnt-demo1",      "tnt-demo1"),
        ("tnt-demo2",      "tnt-demo2"),
        ("tnt-demo3",      "tnt-demo3"),
        ("plutonia-demo1", "plutonia-demo1"),
        ("plutonia-demo2", "plutonia-demo2"),
        ("plutonia-demo3", "plutonia-demo3"),
    ]

    failures = 0
    skipped  = 0

    for (label, prefix) in demos:
        if do_sim:
            gp = os.path.join(golden_dir, f"{prefix}.json")
            op = os.path.join(out_dir,    f"{prefix}.json")
            if not os.path.exists(op):
                skipped += 1
                print(f"skip  {label} sim (output missing — WAD not fetched?)")
            elif not compare_trace(f"{label} sim", gp, op):
                failures += 1

        if do_render:
            gp = os.path.join(golden_dir, f"{prefix}-render.json")
            op = os.path.join(out_dir,    f"{prefix}-render.json")
            if not os.path.exists(op):
                skipped += 1
                print(f"skip  {label} render (output missing — WAD not fetched?)")
            elif not compare_trace(f"{label} render", gp, op):
                failures += 1

    print()
    if failures:
        print(f"FAIL — {failures} golden(s) mismatched")
        sys.exit(1)
    if skipped:
        print(f"PASS — {skipped} demo(s) skipped (WADs not fetched), rest match")
    else:
        print("PASS — all goldens match")


if __name__ == "__main__":
    main()
