# Contributing

Thanks for looking. This is a small, opinionated project; the rules below
are what keep it small.

## The short version

1. `bash tools/run-tests.sh` before you open anything. It is ~19 minutes
   on a host with a WAD library, a built engine and Chrome.
2. A change to the simulation must be **tic-identical**: 13/13 demo
   goldens, byte for byte. If it is not, it is wrong, however good it
   looks.
3. A fix lands **with the gate that fails without it**. Run that gate
   against the unfixed tree and put the number in the commit message.

## Setting up

```sh
WAD_SRC=host:~/doom-wads tools/fetch-wads.sh   # your own IWADs; none ship here
source tools/emsdk-env.sh && make -C engine    # build the wasm engine
node server/serve.js                           # http://127.0.0.1:8666/
bash tools/run-tests.sh --quick                # 19 legs, no WAD or browser needed
```

`tools/run-tests.sh --list` prints every leg and what it needs. A leg that
cannot run SKIPs and says why; `--require-complete` turns any skip into a
failure, which is what you want before claiming a clean run.

## The rules that actually bite

**Accuracy is non-negotiable.** `spec.md` tenet 1. Any change that moves a
single `P_Random` call is a regression. `sim-goldens` is the gate and it
is not negotiable either — never regold a golden to make a change pass.
`docs/optimization-ledger.md` records a regold that encoded a real bug.

**Never read `$?` after a pipe.** This project's single most repeated
mistake, six times. Use `bash tools/gate.sh <name> -- <cmd>`; see
`CLAUDE.md`, which exists for contributors as much as for agents.

**Quote the count, not `rc=0`.** A gate that verified nothing exits 0. Say
"13 demos", "29 assertions", "47 fuzz cases" — the number is the evidence.

**Prefer deleting code to adding it.** `spec.md` tenet 3. A patch that
removes more than it adds gets read first.

**Measure, don't assume.** `spec.md` tenet 2. No optimisation lands
without before/after numbers on the reference hosts, stated with the
build flags, the demo and the host on both sides.

## Commit messages

Say what was wrong, how you know, and what proves it is fixed. The number
that was red before the change belongs in the message. Long is fine;
vague is not.

## What will be declined

- Gameplay-visible changes beyond vanilla (render-side is fine, and
  opt-in render-side is how freelook landed — though note widescreen came in
  the same way and was removed again in 2026-09-12 for not being used).
- Safari/iOS support — an explicit non-goal with a decision record.
- A new dependency, unless it replaces more code than it adds.
- Anything that needs game data to be redistributed.

## Licence

GPL-2.0-or-later, like the id Software source this is built from. By
contributing you agree your work ships under it.
