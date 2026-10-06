# webdoom documentation index

Every document in this project, with a line saying what it is for.

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

## Reference — how the engine works

| document | what it is |
|---|---|
| [playsim.md](playsim.md) | **long** (1,812). The simulation: thinkers, P_Random, the frozen surface the demo goldens depend on |
| [renderer.md](renderer.md) | **long** (1,154). BSP, segs, planes, sprites, the low-detail variant and the retired toggles |
| [formats.md](formats.md) | **long** (1,146). WAD, lump and asset formats as this engine reads them |
| [engine-archaeology.md](engine-archaeology.md) | where every magic constant and table came from, each with a committed reproducer |
| [magic-data.md](magic-data.md) | the published, readable version of the above — 16 figures, 14 gated through PUBLIC_HINTS |
| [netcode.md](netcode.md) | the protocol SSOT: deterministic lockstep over a server tic relay |
| [state-machine.md](state-machine.md) | the JS lobby state machine, enumerated — the `state-machine` leg checks the code against this |

## Performance, and what was decided about it

| document | what it is |
|---|---|
| [perf.md](perf.md) | **long** (1,869). The memory, size and per-stage baseline. Note: still describes a four-host fleet in places; `spec.md`'s 2026-09-11 amendment retired pi5 |
| [optimization-ledger.md](optimization-ledger.md) | every candidate considered, measured, and landed or killed — with the kill rule it was judged against |
| [divergence-atlas.md](divergence-atlas.md) | where this port diverges from vanilla, and why each one is sanctioned |
| [bare-metal.md](bare-metal.md) | **long** (1,198). The core ↔ platform contract a no-OS port starts from |

## The verification machinery

| document | what it is |
|---|---|

## Hardware bring-ups

Each is a status document for a target that is not a suite leg, or not yet one.
Read the banner first — all three carry a dated status.

| document | what it is |
|---|---|

## Archive

| document | what it is |
|---|---|

These eight live under `archive/` (round 8, plus the round-11 retirement and the
round-13 move); the five `Plans-*` files are closed
task tables that made the front door look like a planning directory. They
are the record of how each initiative actually went, and `Plans.md` links
them from its first paragraph.

## Not webdoom's

| document | what it is |
|---|---|
| [LICENSE.TXT](LICENSE.TXT), [README.TXT](README.TXT) | id Software's originals, shipped with the source |
