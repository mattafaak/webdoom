# Archived goldens

Superseded measurement files, kept because history is not discarded — but moved
out of `tools/golden/` so nothing gates on them.

## `browser-pipeline-wbox-2026-07-18-singlerun.json`

wbox's browser-pipeline baseline, recorded 2026-07-18 at commit `5a71e12` in the
**single-run** schema (flat `n/mean/p50/p90/p99/max` per stage).

`browser-pipeline-compare.mjs` needs `run1`/`run2` per stage to derive its
tolerance band, so every check took the `no run1/run2 in baseline` branch and the
comparator — whose `pass` flag starts true and is only cleared by a real
comparison — printed PASS having compared nothing. wbox, one of the four
reference hosts in `spec.md`, was gated by a green that measured nothing.

Task 21.10 fixed both halves: the comparator now FAILS when zero checks actually
compared, and this file moved here so the host SKIPs loudly with a reason
instead.

**To re-gate wbox**, record a two-run baseline on wbox itself:

```sh
# on wbox (needs the repo, WADs, a build, and Chrome — none present as of
# 2026-09-11; node v24.19.0 and google-chrome-stable are)
node tools/browser-pipeline.mjs --url http://127.0.0.1:8677/ --json > run1.json
node tools/browser-pipeline.mjs --url http://127.0.0.1:8677/ --json > run2.json
# merge into the run1/run2 shape of tools/golden/browser-pipeline-alder.json
```

Do not re-add a single-run baseline: it cannot gate, and it reads as if it does.
