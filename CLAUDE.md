# webdoom — working notes for automated contributors

## Verifying a gate: never read `$?` after a pipe

This project's test gates are only meaningful if their exit codes are read
correctly, and the single most repeated mistake here — **six times** — is
reading an exit status that belongs to the wrong process:

```bash
node tools/demo-test.mjs | tail -1     # the gate FAILS
rc=$?                                  # rc == 0  — that is tail's status
```

A red gate gets reported green, and the regression lands. It is not a
carelessness problem; the command and the status check are two separate steps,
so there is always an opportunity to check the wrong one.

**Use `tools/gate.sh`.** It runs the command outside any pipeline, so the code
it prints is exact, and it prints that code as part of the same output:

```bash
bash tools/gate.sh sim -- node tools/demo-test.mjs
#   ...trimmed output...
#   GATE sim rc=0
```

It trims output for you (that is why people reach for `| tail` to begin with),
widens the tail automatically on failure, and exits with the real code so it
still composes with `set -e`, `&&`, and CI.

If you do write a pipeline in a shell script, the script **must** enable
`pipefail` — with it, `cmd | tail` correctly reports `cmd`'s failure.
`tools/check-pipe-exit.mjs` enforces this and runs inside `tools/lint.sh`.

## Gates can pass vacuously — quote the count

A gate that verified nothing exits 0. A WAD-less checkout once skipped all 13
demos and still printed `PASS`, so a broken renderer change reached review with
a clean-looking gate table. Golden legs now print how many demos they actually
verified:

```
PASS — all render goldens pixel-identical (13 demos)
```

When reporting a gate as green, quote that line including the count. "rc=0" on
its own is not evidence that anything ran.

## Two related traps worth knowing

- **Unknown flags are ignored.** `demo-test.mjs` parses with
  `process.argv.includes(...)`, so a typo'd flag silently runs a *different*
  suite and passes. Copy gate invocations verbatim from `tools/run-tests.sh`
  and confirm the mode tag in the output (`[low-detail]`, `[fakeflat]`,
  `[potato]`) matches what you intended.
- **Measurements must be symmetric.** A before/after comparison with different
  flags, demos, or build settings on each side manufactures its own result.
  State the build flags, the demo, and the host on both sides.
