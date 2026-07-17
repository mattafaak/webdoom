#!/usr/bin/env python3
"""parse-gcov.py — parse gcov --json-format output into coverage report JSON.

Usage:
    # Collect: scan gcov_dir for *.gcov.json.gz files, write report JSON
    python3 parse-gcov.py collect <gcov_dir> <out.json> [--repo-root DIR]

    # Report: read two report JSONs, write REPORT.md to stdout
    python3 parse-gcov.py report <demos.json> <full.json>
"""

import gzip, json, glob, sys, os, re
from collections import defaultdict


# ── JSON loading ──────────────────────────────────────────────────────────────

def load_gcov_gz(path):
    """Load a gcov JSON file (gzipped or plain)."""
    try:
        with gzip.open(path, "rt", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, gzip.BadGzipFile, EOFError):
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)


# ── path normalisation ────────────────────────────────────────────────────────

def normalise_path(raw, repo_root=None):
    """Return a repo-relative path like engine/core/am_map.c."""
    # Resolve if we have an absolute path and a repo_root
    if repo_root and os.path.isabs(raw):
        try:
            return os.path.relpath(raw, repo_root)
        except ValueError:
            pass

    # Walk through ../ sequences without os.path.abspath
    parts = raw.replace("\\", "/").split("/")
    stack = []
    for p in parts:
        if p == "..":
            if stack:
                stack.pop()
        elif p and p != ".":
            stack.append(p)
    joined = "/".join(stack)

    # Anchor at a known directory prefix to strip host-specific leading segments
    for anchor in ("engine/core/", "tools/native-sanitize/", "engine/web/"):
        idx = joined.find(anchor)
        if idx >= 0:
            return joined[idx:]
    return joined


# ── gcov JSON parsing ─────────────────────────────────────────────────────────

def parse_gcov_dir(gcov_dir, repo_root=None):
    """Scan gcov_dir for *.gcov.json.gz files and build a coverage dict.

    Returns:
        {
          "totals": { functions_total, functions_hit, function_pct,
                      branches_total, branches_hit, branch_pct },
          "by_file": { path: { functions_total, functions_hit, function_pct,
                                branches_total, branches_hit, branch_pct } },
          "functions": { name: { file, hit, branches_total, branches_hit } },
          "never_executed": [ name, ... ],
        }
    """
    patterns = [
        os.path.join(gcov_dir, "*.gcov.json.gz"),
        os.path.join(gcov_dir, "*.gcov.json"),
    ]
    gz_files = []
    for pat in patterns:
        gz_files.extend(glob.glob(pat))

    if not gz_files:
        print(f"WARNING: no gcov JSON files in {gcov_dir}", file=sys.stderr)

    # fn_name -> {"file", "hit", "branches_total", "branches_hit"}
    functions = {}
    by_file = {}  # normalised path -> per-file counters

    for gz in sorted(gz_files):
        try:
            data = load_gcov_gz(gz)
        except Exception as exc:
            print(f"WARNING: skipping {gz}: {exc}", file=sys.stderr)
            continue

        for file_entry in data.get("files", []):
            raw_path = file_entry.get("file", "")
            norm = normalise_path(raw_path, repo_root)

            # Skip header files (platform stubs can pull in .h coverage)
            if norm.endswith(".h"):
                continue

            if norm not in by_file:
                by_file[norm] = {
                    "functions_total": 0,
                    "functions_hit": 0,
                    "branches_total": 0,
                    "branches_hit": 0,
                }

            # ── collect branch data per function from lines ───────────────────
            fn_branch_total = defaultdict(int)
            fn_branch_hit = defaultdict(int)
            for line in file_entry.get("lines", []):
                fn_name_on_line = line.get("function_name", "")
                for br in line.get("branches", []):
                    fn_branch_total[fn_name_on_line] += 1
                    if br.get("count", 0) > 0:
                        fn_branch_hit[fn_name_on_line] += 1

            # ── process functions ─────────────────────────────────────────────
            for func in file_entry.get("functions", []):
                name = func.get("name", "") or func.get("demangled_name", "?")
                exec_count = func.get("execution_count", 0)
                hit = exec_count > 0

                bt = fn_branch_total.get(name, 0)
                bh = fn_branch_hit.get(name, 0)

                if name not in functions:
                    functions[name] = {
                        "file": norm,
                        "hit": hit,
                        "branches_total": bt,
                        "branches_hit": bh,
                    }
                    by_file[norm]["functions_total"] += 1
                    if hit:
                        by_file[norm]["functions_hit"] += 1
                    by_file[norm]["branches_total"] += bt
                    by_file[norm]["branches_hit"] += bh
                else:
                    # Duplicate (same file processed twice): merge with OR
                    if hit and not functions[name]["hit"]:
                        functions[name]["hit"] = True
                        file_key = functions[name]["file"]
                        by_file.setdefault(file_key, {
                            "functions_total": 0, "functions_hit": 0,
                            "branches_total": 0, "branches_hit": 0,
                        })["functions_hit"] += 1
                    # Accumulate branch counts if higher
                    functions[name]["branches_total"] = max(
                        functions[name]["branches_total"], bt)
                    functions[name]["branches_hit"] = max(
                        functions[name]["branches_hit"], bh)

    # ── add per-file pct ──────────────────────────────────────────────────────
    for v in by_file.values():
        ft = v["functions_total"]
        bt = v["branches_total"]
        v["function_pct"] = round(100.0 * v["functions_hit"] / ft, 1) if ft else 0.0
        v["branch_pct"] = round(100.0 * v["branches_hit"] / bt, 1) if bt else 0.0

    # ── global totals ─────────────────────────────────────────────────────────
    total_fn = sum(v["functions_total"] for v in by_file.values())
    hit_fn   = sum(v["functions_hit"]   for v in by_file.values())
    total_br = sum(v["branches_total"]  for v in by_file.values())
    hit_br   = sum(v["branches_hit"]    for v in by_file.values())

    never = sorted(n for n, v in functions.items() if not v["hit"])

    return {
        "totals": {
            "functions_total":  total_fn,
            "functions_hit":    hit_fn,
            "function_pct":     round(100.0 * hit_fn / total_fn, 1) if total_fn else 0.0,
            "branches_total":   total_br,
            "branches_hit":     hit_br,
            "branch_pct":       round(100.0 * hit_br / total_br, 1) if total_br else 0.0,
        },
        "by_file":        {k: by_file[k] for k in sorted(by_file)},
        "functions":      functions,
        "never_executed": never,
    }


# ── REPORT.md generation ──────────────────────────────────────────────────────

def make_report(demos, full):
    dt = demos["totals"]
    ft = full["totals"]

    fn_demos = dt["functions_hit"]
    fn_full  = ft["functions_hit"]
    fn_total = ft["functions_total"]
    br_demos_pct = dt["branch_pct"]
    br_full_pct  = ft["branch_pct"]
    fn_delta = fn_full - fn_demos
    br_delta = round(br_full_pct - br_demos_pct, 1)

    never_list = full["never_executed"]
    never_count = len(never_list)

    # Files sorted by branch coverage ascending (least covered first)
    all_files = sorted(
        full["by_file"].items(),
        key=lambda kv: (kv[1]["branch_pct"], kv[1]["function_pct"]),
    )
    top10_least = all_files[:10]

    # Per-file delta (functions gained by fuzz)
    demos_fn_by_file = {}
    for name, info in demos["functions"].items():
        f = info["file"]
        demos_fn_by_file.setdefault(f, set())
        if info["hit"]:
            demos_fn_by_file[f].add(name)

    full_fn_by_file = {}
    for name, info in full["functions"].items():
        f = info["file"]
        full_fn_by_file.setdefault(f, set())
        if info["hit"]:
            full_fn_by_file[f].add(name)

    file_delta = {}
    for f in set(list(demos_fn_by_file) + list(full_fn_by_file)):
        d = len(demos_fn_by_file.get(f, set()))
        x = len(full_fn_by_file.get(f, set()))
        if x > d:
            file_delta[f] = x - d

    top_delta = sorted(file_delta.items(), key=lambda kv: -kv[1])[:5]

    # Notable summary string
    if top_delta:
        notable_files = ", ".join(os.path.basename(f) for f, _ in top_delta[:3])
        notable = f"fuzz corpus unlocked {fn_delta} function(s) incl. {notable_files}"
    else:
        notable = f"fuzz corpus added {fn_delta} function(s) beyond demos"

    lines = []
    lines.append("# Coverage Report — engine/core + native-sanitize platform\n")
    lines.append("Generated by `bash tools/coverage/run-coverage.sh`.\n")
    lines.append("Numbers come directly from that script's output — not hand-edited.\n")
    lines.append("")

    lines.append("## Overall Totals\n")
    lines.append("| Pass | Functions hit | Functions total | Function % | Branches hit | Branches total | Branch % |")
    lines.append("|------|--------------|----------------|-----------|-------------|---------------|---------|")
    lines.append(
        f"| Demos only (13 golden) | {fn_demos} | {fn_total} | {dt['function_pct']}% "
        f"| {dt['branches_hit']} | {dt['branches_total']} | {br_demos_pct}% |"
    )
    lines.append(
        f"| Demos + fuzz corpus (50+ seeds) | {fn_full} | {fn_total} | {ft['function_pct']}% "
        f"| {ft['branches_hit']} | {ft['branches_total']} | {br_full_pct}% |"
    )
    lines.append("")

    lines.append("## Fuzz Corpus Delta\n")
    lines.append(
        f"Adding fuzz seeds to the demos uncovered **{fn_delta} additional function(s)** "
        f"and increased branch coverage by **{br_delta:+.1f} pp** "
        f"({br_demos_pct}% → {br_full_pct}%).\n"
    )
    if top_delta:
        lines.append("Files with the most new functions from fuzz corpus:\n")
        lines.append("| File | New functions from fuzz |")
        lines.append("|------|------------------------|")
        for f, cnt in top_delta:
            lines.append(f"| `{os.path.basename(f)}` | +{cnt} |")
        lines.append("")

    lines.append("## Per-File Coverage (sorted by branch %, ascending)\n")
    lines.append("| File | Fn hit | Fn total | Fn % | Br hit | Br total | Br % |")
    lines.append("|------|--------|---------|------|--------|---------|------|")
    for path, v in all_files:
        lines.append(
            f"| `{os.path.basename(path)}` ({path}) "
            f"| {v['functions_hit']} | {v['functions_total']} | {v['function_pct']}% "
            f"| {v['branches_hit']} | {v['branches_total']} | {v['branch_pct']}% |"
        )
    lines.append("")

    lines.append("## Top-10 Least-Covered Files (by branch %)\n")
    for path, v in top10_least:
        lines.append(f"- `{path}`: {v['function_pct']}% fn, {v['branch_pct']}% branch")
    lines.append("")

    lines.append(f"## Never-Executed Functions ({never_count} total)\n")
    lines.append("These functions were not called by any of the 13 demos or the fuzz corpus.")
    lines.append("Sound/menu/net/automap code dominates — expected for a headless timedemo run.\n")
    for name in never_list:
        info = full["functions"].get(name, {})
        f = info.get("file", "?")
        lines.append(f"- `{name}` ({os.path.basename(f)})")
    lines.append("")

    return "\n".join(lines)


# ── CLI ───────────────────────────────────────────────────────────────────────

def cmd_collect(argv):
    # parse-gcov.py collect <gcov_dir> <out.json> [--repo-root DIR]
    gcov_dir = argv[0]
    out_json = argv[1]
    repo_root = None
    i = 2
    while i < len(argv):
        if argv[i] == "--repo-root" and i + 1 < len(argv):
            repo_root = argv[i + 1]
            i += 2
        else:
            i += 1

    report = parse_gcov_dir(gcov_dir, repo_root=repo_root)
    with open(out_json, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)
    t = report["totals"]
    print(
        f"  functions: {t['functions_hit']}/{t['functions_total']} ({t['function_pct']}%)  "
        f"branches: {t['branches_hit']}/{t['branches_total']} ({t['branch_pct']}%)",
        file=sys.stderr,
    )


def cmd_report(argv):
    # parse-gcov.py report <demos.json> <full.json>
    with open(argv[0], encoding="utf-8") as f:
        demos = json.load(f)
    with open(argv[1], encoding="utf-8") as f:
        full = json.load(f)
    print(make_report(demos, full), end="")


def main():
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        sys.exit(1)

    cmd = sys.argv[1]
    rest = sys.argv[2:]

    if cmd == "collect":
        cmd_collect(rest)
    elif cmd == "report":
        cmd_report(rest)
    else:
        print(f"unknown command: {cmd}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
