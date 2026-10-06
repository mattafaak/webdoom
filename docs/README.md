# webdoom documentation

The reference documents for the engine, the web port and the targets beyond
it. The product contract is [../spec.md](../spec.md); how to build, test and
contribute is in [../CONTRIBUTING.md](../CONTRIBUTING.md).

## Reading order

1. [glossary.md](glossary.md), for the words the other pages use without
   explaining them.
2. [playsim.md](playsim.md), then [renderer.md](renderer.md): how the
   simulation and the drawing work, and what must never change.
3. Whichever of the rest your work touches.

## The documents

| document | what it is for |
|---|---|
| [glossary.md](glossary.md) | DOOM's vocabulary, this project's own terms, and the identifier schemes |
| [playsim.md](playsim.md) | the simulation: thinkers, `P_Random`, and the frozen surface the demo goldens depend on |
| [renderer.md](renderer.md) | the software renderer: BSP walk, walls, planes, sprites, low detail |
| [formats.md](formats.md) | every byte format the engine reads or writes, field by field |
| [engine-archaeology.md](engine-archaeology.md) | where DOOM's hard-coded tables and constants came from, each with a reproducer |
| [divergence-atlas.md](divergence-atlas.md) | where other ports diverge from vanilla, and where this one stands on each |
| [bare-metal.md](bare-metal.md) | what the core demands from a platform with no OS: the contract a port starts from |
| [netcode.md](netcode.md) | multiplayer: lockstep over the server relay, drop-in, spectators, and the measured figures |
| [state-machine.md](state-machine.md) | the launcher's screens and every transition between them |
| [perf.md](perf.md) | the current performance, size and memory baseline, and how to measure it |
| [optimization-ledger.md](optimization-ledger.md) | every optimisation considered, landed or killed, with its number, so killed ideas stay dead |
| [retro.md](retro.md) | the N64 port, the freestanding core, and the arithmetic behind each other retro target's verdict |
| [LICENSE.TXT](LICENSE.TXT), [README.TXT](README.TXT) | id Software's originals, shipped with the 1997 source release |
