# webdoom documentation index

Every document in this project, with a line saying what it is for.

**32 documents**, about 15,700 lines. That is 18 top-level files beside this
index, 7 in `archive/`, 5 hardware bring-ups in subdirectories, and id
Software's 2 originals.

New here? Read in this order: the root `README.md`, then `CONTRIBUTING.md`,
then `spec.md`'s tenets, then come back to this page. Keep
[glossary.md](glossary.md) open — this project has a lot of vocabulary and
most of it is not explained where it is used.

Sizes are rounded, and the documents marked **long** are worth opening at a
section heading rather than at the top.

---

## Start here

| document | what it is |
|---|---|
| [../spec.md](../spec.md) | **the product contract, and the SSOT.** Precedence: spec > sub-specs > Plans.md. Read the tenets before changing anything. |
| [../Plans.md](../Plans.md) | the current planning round: task table, statuses, verdicts, open findings |
| [glossary.md](glossary.md) | **start here if a word is doing work you cannot see.** DOOM's vocabulary, the terms this project invented (`leg`, `golden`, `regold`, `red-proof`, `vacuous gate`, `the cascade`), and the key to all fifteen identifier schemes |
| [2026-09-11-suite-baseline.md](2026-09-11-suite-baseline.md) | a **frozen** full-suite run kept as evidence, with every red and its disposition. It records 71 legs; the registry has grown since, so read it as a dated record and not as the current state |

## Reference — how the engine works

| document | what it is |
|---|---|
| [playsim.md](playsim.md) | **long** (1,812). The simulation: thinkers, P_Random, the frozen surface the demo goldens depend on |
| [renderer.md](renderer.md) | **long** (1,154). BSP, segs, planes, sprites, the low-detail variant and the retired toggles |
| [formats.md](formats.md) | **long** (1,146). WAD, lump and asset formats as this engine reads them |
| [engine-archaeology.md](engine-archaeology.md) | where every magic constant and table came from, each with a committed reproducer |
| [magic-data.md](magic-data.md) | the published, readable version of the above — 16 figures, 14 gated through PUBLIC_HINTS |
| [netcode.md](netcode.md) | the protocol SSOT: deterministic lockstep over a server tic relay |
| [netcode-numbers.md](netcode-numbers.md) | the measured jitter/HOL figures behind the no-WebRTC verdict |
| [state-machine.md](state-machine.md) | the JS lobby state machine, enumerated — the `state-machine` leg checks the code against this |

## Performance, and what was decided about it

| document | what it is |
|---|---|
| [perf.md](perf.md) | **long** (2,003). The memory, size and per-stage baseline. Note: still describes a four-host fleet in places; `spec.md`'s 2026-09-11 amendment retired pi5 |
| [optimization-ledger.md](optimization-ledger.md) | every candidate considered, measured, and landed or killed — with the kill rule it was judged against |
| [divergence-atlas.md](divergence-atlas.md) | where this port diverges from vanilla, and why each one is sanctioned |
| [feasibility-atlas.md](feasibility-atlas.md) | the retro-hardware arithmetic: what could run this, and what provably cannot. Has its own table of contents |
| [bare-metal.md](bare-metal.md) | **long** (1,198). The core ↔ platform contract a no-OS port starts from |

## The verification machinery

| document | what it is |
|---|---|
| [claims-index.md](claims-index.md) | every quantitative claim in the archaeology docs, with its status and reproducer |
| [promises-index.md](promises-index.md) | every qualitative promise in README and spec, with its disposition — including the ones with no gate |
| [web-scrutiny.md](web-scrutiny.md) | the ws-NNN review ledger: 14 findings, each with a disposition |

## Hardware bring-ups

Each is a status document for a target that is not a suite leg, or not yet one.
Read the banner first — all three carry a dated status.

| document | what it is |
|---|---|
| [n64/DEMO-GATE-STATUS.md](n64/DEMO-GATE-STATUS.md) | the N64 sim-hash gate: 13/13, 44,580 tics bit-identical, wired as leg `n64-demos` |
| [n64/BRING-UP.md](n64/BRING-UP.md) | libdragon bring-up notes; superseded by the above for gate status |
| [n64/MIPS-ABI-LANDMINES.md](n64/MIPS-ABI-LANDMINES.md) | the ABI audit done before any MIPS code was written |
| [386/BRING-UP.md](386/BRING-UP.md) | 86Box harness; the scoreboard (20.6b) is judged pursuable and unstarted |
| [rp2040/BRING-UP.md](rp2040/BRING-UP.md) | RP2040; parked on arithmetic — the build is 4.00× over SRAM |

## Archive

| document | what it is |
|---|---|
| [archive/decision-18.1-wide-limits.md](archive/decision-18.1-wide-limits.md) | widescreen: the BSS arithmetic and the limits it forced. **Archived 2026-09-12** — widescreen was removed; kept because its §5 arithmetic is what the revert was checked against |
| [archive/retrospective.md](archive/retrospective.md) | the 2026-07-16 refinement-pass retrospective. Self-declared archive: its body describes that date, not this one |
| [archive/Plans-refinement-complete.md](archive/Plans-refinement-complete.md) | the refinement initiative's task table, 26/26. Holds the regold lesson `tools/golden-provenance.mjs` cites by line |
| [archive/Plans-understanding-complete.md](archive/Plans-understanding-complete.md) | phases 6–11, understanding-on-trial |
| [archive/Plans-floor-initiative-complete.md](archive/Plans-floor-initiative-complete.md) | phases 12–15, 32/32 at `8305c4a` |
| [archive/Plans-round3-retired.md](archive/Plans-round3-retired.md) | the nine round-3 rows retired in round 11: the four FastDoom toggles (deleted from the engine in round 10) and the five N64 rows past the emulator gate, each under the verdict that retired it |
| [archive/Plans-field-fixes-complete.md](archive/Plans-field-fixes-complete.md) | round 3, phases 16–19, 22/22 at `1f9f1e5`. The tasks `Plans.md`'s round-3 planning sections rank and sequence |

These seven live under `archive/` (round 8, plus the round-11 retirement); the five `Plans-*` files are closed
task tables that made the front door look like a planning directory. They
are the record of how each initiative actually went, and `Plans.md` links
them from its first paragraph.

## About this index

Every file under `docs/` appears here, and
`tools/archaeology/docs-index-check.mjs` fails if one does not, so a new
document cannot be born orphaned. The checker also grades the document count
above, the root README's copy of it, and the line figure on every **long**
entry — all three had gone stale while every gate stayed green.

Two things this page got wrong, kept because the shape recurs. The count line
once read "26 documents" while the checker's own PASS line said "all 32
documents under docs/" in the same breath: both true about different sets, with
neither saying which set it meant. And six lines of that story used to stand
between a reader and the first link on the page, which is the other failure —
a document narrating its own repairs instead of doing its job.

## Not webdoom's

| document | what it is |
|---|---|
| [LICENSE.TXT](LICENSE.TXT), [README.TXT](README.TXT) | id Software's originals, shipped with the source |
