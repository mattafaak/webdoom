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
  and confirm the mode tag in the output (`[low-detail]`, or none for the
  vanilla path) matches what you intended.
- **Measurements must be symmetric.** A before/after comparison with different
  flags, demos, or build settings on each side manufactures its own result.
  State the build flags, the demo, and the host on both sides.

## Three ways a gate you just wrote can lie to you

All three were found by writing gates in round 5, not by theory. Each cost a
run that read green or read the wrong colour entirely.

- **Grade vacuity on the quantity that only rises.** The teardown leg's new GL
  counter first refused any run where the net count "never moved" — but after a
  clean quit the net is *supposed* to be zero, so that guard would have failed
  precisely the runs where the fix works. Net is the pass condition; it cannot
  also be the did-not-run condition. Count gross creations for vacuity, net for
  the leak. Alarming on correct behaviour is a defect too.
- **An `uncaughtException` handler lets a test exit 0 after giving up.** With
  one registered — which you need if you are *observing* throws — an uncaught
  error no longer kills the process: module evaluation aborts where it threw,
  the event loop drains, and node exits **0**. `hostile-lobby-test.mjs` printed
  14 FAIL lines, died before its own summary, and exited zero. Make the summary
  the only sanctioned exit: set a flag when it prints, and fail from
  `process.on('exit')` if it did not.
- **One case can disarm the next.** That same test reused a single socket and
  read 24 PASS / 1 FAIL against the broken client, which looked like "only the
  first frame is a problem". It was not: the first malformed frame throws out of
  `ws.onmessage`, after which that socket delivers nothing, so every later
  assertion passed by observing *nothing*. Give each hostile case its own
  connection, process or tree — and assert afterwards that the subject is still
  alive, not merely quiet.

And one about the thing being gated rather than the gate: **a fix can ship into
a branch that cannot run it.** Task 23.7b's GL `dispose()` sat in
`createRenderer2D`, whose scope has no `gl`, so the WebGL2 path — the one every
browser takes — had no `dispose` at all, and `h?.dispose?.()` skipped it in
silence. Optional-call and a swallowing `catch` will hide that indefinitely. If
a fix is worth a comment saying what it reclaims, it is worth a gate that counts
the thing reclaimed.
