# webdoom — working notes for automated contributors

The rules that keep a change honest here, and the traps that have actually
cost runs. `CONTRIBUTING.md` is the short human version; `spec.md` is the
contract.

## Where to work

- **The main checkout serves real players.** `webdoom.service` runs
  `node server/serve.js` out of the main checkout on :8666, and it serves
  `build/` and `client/` from disk. Build or branch there and LAN players get
  it. Work in a worktree (`git worktree add ../webdoom-x -b x`; symlink
  `wads/lib`, `wads/manifest.json` and `wads/zips`; run `npm ci` in
  `server/`). Never touch port 8666, and deploy only with the owner
  (`tools/deploy.sh`; `--check` reports drift and changes nothing).
- **After any engine, Makefile or engine-flag change, rebuild everything the
  suite reads** before trusting a leg: `source tools/emsdk-env.sh && bash
  tools/lint.sh --fix --c-only && make -C engine && bash tools/build-toggle.sh
  WEBDOOM_INVARIANTS build-invariants && make -C tools/native-sanitize && make
  -C tools/freestanding`. The `freshness` leg fails on a stale artifact;
  `n64-demos` builds its own ROMs.

## Verifying a gate: never read `$?` after a pipe

The most repeated mistake here is reading an exit status that belongs to the
wrong process:

```bash
node tools/demo-test.mjs | tail -1     # the gate FAILS
rc=$?                                  # rc == 0  — that is tail's status
```

**Use `tools/gate.sh`.** It runs the command outside any pipeline, trims the
output (widening the tail on failure), prints the exact code as part of the
same output, and exits with it:

```bash
bash tools/gate.sh sim -- node tools/demo-test.mjs
#   ...trimmed output...
#   GATE sim rc=0
```

A shell script that does pipe must set `pipefail`;
`tools/check-pipe-exit.mjs` enforces it from `tools/lint.sh`.

## Quote the count

A gate that verified nothing exits 0. Golden legs print how many demos they
verified (`PASS — all render goldens pixel-identical (13 demos)`). Quote that
line, count included; "rc=0" alone is not evidence that anything ran.

- **Unknown flags are ignored.** `demo-test.mjs` parses with
  `process.argv.includes(...)`, so a typo'd flag silently runs a different
  suite and passes. Copy invocations from `tools/run-tests.sh` and check the
  mode tag in the output (`[low-detail]`, or none for the vanilla path).
- **Measurements must be symmetric.** A before/after comparison with different
  flags, demos or build settings on each side manufactures its own result.
  State the build, the demo and the host on both sides.

## The engine

- **Tic-identity is the contract.** A change to the simulation keeps all 13
  sim and render goldens bit-identical. Never regold to make a change pass. A
  regold needs an external reference: the Chocolate Doom cross-check
  (`tools/build-choco-reference.sh`, `tools/choco-trace.patch`, `node
  tools/demo-test.mjs --cross <binary>`), compared on every demo before the
  golden moves.
- **A comment-only edit can change `doom.wasm`.** Vanilla's `Z_ChangeTag`
  macro puts `__FILE__:__LINE__` in its error string, so a comment that adds
  or removes lines above a `Z_ChangeTag` call moves a constant. Check the
  sha256 of `build/doom.wasm` after any edit you believe is comment-only.
- **No `printf` in `engine/web`.** stdio's buffer is written below the
  tic-array base, and `hostile-server` reports it. Diagnostics go through
  `I_Error` or an `EM_JS` call into JS.
- **Saves hold raw pointers.** A savegame's bytes change with heap layout, so
  compare what a save loads to (`save-compat`), never its bytes. Saves and
  maps are untrusted input: every index read from one is checked before use.
- **Harnesses that step the engine turn drawing off.** `NetUpdate` runs inside
  the renderer, so with drawing on, single tics and live input, the sim
  depends on wall-clock time. Use `_web_set_nodraw(1)`, and `_web_wipe_skip()`
  for the melt wipe, which is paced by wall time.

## Three ways a gate you just wrote can lie to you

- **Grade vacuity on the quantity that only rises.** After a clean quit a net
  leak count is supposed to be zero, so "the net count never moved" cannot be
  the did-not-run condition. Count gross creations for vacuity, net for the
  leak. Alarming on correct behaviour is a defect too.
- **An `uncaughtException` handler lets a test exit 0 after giving up.** Module
  evaluation aborts where it threw, the event loop drains, and node exits 0.
  Make the summary the only sanctioned exit: `tools/lib/report.mjs` fails from
  `process.on('exit')` when `summary()` never ran, and `check-test-exits.mjs`
  (from `lint.sh`) flags a handler that does not.
- **One case can disarm the next.** A malformed frame that throws out of
  `ws.onmessage` leaves that socket delivering nothing, so every later
  assertion on the same socket passes by observing nothing. Give each hostile
  case its own connection, process or tree, and assert afterwards that the
  subject is still alive, not merely quiet.

And one about the thing being gated: **a fix can ship into a branch that
cannot run it.** An optional call (`h?.dispose?.()`) or a swallowing `catch`
hides a method that does not exist. Call the method the object has, and if a
fix is worth a comment saying what it reclaims, it is worth a gate that counts
the thing reclaimed.

## A gate can test the layer next to the hole

A hostile-input gate can stay green while its defect ships, because it
verifies something real one call away from where the attacker enters: a C
export called directly while the hostile frame reaches `client/js/net.js`
first; a throw injected into the one statement inside a `try` while the
statements after the `catch` are unguarded; a hardened `net.js` while
`lobby.js`'s own handlers hold the unguarded dereferences. Ask of every
hostile-input gate whether it enters through the attacker's door, and
red-proof it there. Testing both layers is fine; testing only the inner one
reports safety nobody checked.
