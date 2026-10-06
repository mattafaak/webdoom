# Glossary

Two halves. The first defines the vocabulary the rest of these documents use
without introduction: DOOM's own terms, and the handful this project invented.
The second is the key to the identifier schemes the documents still use.

---

## DOOM vocabulary

These come from the 1993 source and are used throughout `engine/core`. The
names are id Software's; the explanations are what you need to read the code.

| term | what it is |
|------|-----------|
| **WAD** | "Where's All the Data": the archive format holding every asset. An **IWAD** is a complete game (doom.wad, doom2.wad); a **PWAD** patches one (sigil.wad). |
| **lump** | One entry in a WAD: a texture, a sound, a map component, a table. Named in eight bytes, with no type field. What a lump *is* depends on where it sits in the directory. |
| **tic** | One simulation step. DOOM runs at exactly 35 per second and the number is baked into the physics constants, so it is not a tunable. "Tic-identical" means two runs produced the same state at every tic. |
| **ticcmd** | One player's input for one tic: forward, strafe, turn, buttons. Eight bytes. The netcode ships these and nothing else. |
| **mobj** | "Map object": anything in the world with a position. Monsters, the player, projectiles, dropped items. |
| **thinker** | An object that gets a function call every tic. Every mobj is one; so are moving platforms, doors and light effects. The thinker list is the simulation. |
| **BSP** | Binary space partition: the precomputed tree that splits a map into convex pieces. Walking it front-to-back is how DOOM draws walls without a depth buffer. |
| **node** | One branch of the BSP tree: a dividing line plus two children. |
| **subsector** | A leaf of the BSP tree: a convex piece of floor. |
| **seg** | A segment of a wall, produced by the BSP build. One linedef can become many segs. |
| **linedef** / **sidedef** | The map's authored wall. A linedef joins two vertices, and its sidedefs carry the textures for each side. |
| **sector** | A region with one floor height, one ceiling height and one light level. |
| **visplane** | A horizontal surface (floor or ceiling) collected during the BSP walk and drawn afterwards in one pass. |
| **drawseg** | A seg that has been clipped and queued for drawing, with the column range it occupies. |
| **psprite** | A "player sprite": the weapon drawn in the foreground, in its own coordinate space. |
| **blockmap** | A coarse grid indexing which linedefs touch which 128-unit cell, so collision does not test every line. |
| **spechit** | The list of special lines crossed during one move, processed after the move succeeds. Its fixed size is a famous vanilla overflow. |
| **intercepts** | The list of things and lines a traced line crosses, used by hitscan attacks and line-of-sight. |
| **validcount** | A monotonically increasing stamp used instead of clearing "already visited" flags. Incremented per traversal. |
| **P_Random** / **prndindex** | DOOM's random number generator: a fixed 256-byte table and an index into it. Deterministic, which is what makes demos replayable, and why any change that moves a single call is a regression. |
| **fixed_t** | 16.16 fixed-point. DOOM has no floating point in the simulation, by design and by 1993 necessity. |
| **demo** | A recording of ticcmds. Replaying one re-runs the simulation from the same inputs, so it reproduces the original exactly or the engine is wrong. |
| **MUS** | id's compact music format, converted to OPL register writes at playback. |
| **GENMIDI** | The lump mapping MIDI instruments to OPL patches. Each IWAD carries its own, and this port plays that one rather than a bundled bank. |
| **OPL2 / OPL3** | The Yamaha FM synthesis chips a 1993 sound card had. This port emulates them (Nuked OPL3) rather than substituting sampled instruments. |
| **DMX** | The commercial sound library DOOM licensed. Its PCM sound format is still what the sfx lumps use. |
| **PLAYPAL** / **COLORMAP** | The 256-colour palette, and the 34 shaded copies of it that produce light falloff and the invulnerability effect. |
| **flat** | A 64×64 floor or ceiling texture, stored raw. |
| **patch** | A column-major sprite or wall graphic with transparency. |
| **zone** | DOOM's own allocator: one block of memory carved up by tag. `PU_STATIC` survives a level change; `PU_LEVEL` does not. |

## The vocabulary this project invented

These are ours, and they appear throughout the repository.

| term | what it means |
|------|---------------|
| **leg** | One test in `tools/run-tests.sh`. Each runs in isolation and reports its own verdict and count, and a red one does not stop the others. `bash tools/run-tests.sh --list` is the roster. |
| **golden** | A committed expected result (per-tic gamestate hashes, or per-tic framebuffer hashes) that a replay is compared against. |
| **regold** | Replacing a golden with current output. Sometimes correct, often a way to make a real bug permanent, and never done to make a change pass. |
| **red-proof** | Deliberately breaking the fix and confirming the gate fails. A gate that has never been seen to fail is not known to work. |
| **vacuous gate** | A gate that passes without checking anything: no WADs, an empty input set, a skipped stage. This project treats one as a defect in its own right, which is why legs print the count they verified. |
| **the cascade** | What an engine or Makefile change drags with it: reformat, then rebuild the wasm trees and the native references before the full suite runs. The `freshness` leg fails when a build is older than its sources. |
| **the ledger** | [optimization-ledger.md](optimization-ledger.md): every optimisation considered, with its mechanism, its measurement, the rule it was judged against, and whether it landed or was killed. A killed candidate with a number is worth as much as a landed one. |
| **the fleet** | The machines measurements are taken on, named in `spec.md`. A figure without a host is not a measurement. |

---

## The identifier key

Several schemes reuse the same letters, which is why this section exists.

| scheme | where | what it numbers |
|--------|-------|-----------------|
| `ea-NNN` | [engine-archaeology.md](engine-archaeology.md) | a derived engine figure that a script in `tools/archaeology/` reproduces; `tools/archaeology/run.mjs` lists the expected value for each |
| `F1`–`F7` | [divergence-atlas.md](divergence-atlas.md) | a behavioural fork from vanilla, and webdoom's position on it |
| `Q1`–`Q10` | [playsim.md](playsim.md) §15 | a vanilla quirk, with its demo evidence |
| `T01`–`T34` | [state-machine.md](state-machine.md) | a transition in the lobby state machine; `browser-lobby` names the ones it drives |
| `C`, `K`, `NC`, `P`, `F`, `W`, `L` | [optimization-ledger.md](optimization-ledger.md) | an optimisation candidate; its row's verdict says whether it landed or was killed |
| `ws-NNN` | retired: `git show 2a6a2de:docs/web-scrutiny.md` | a client-side review finding, with its disposition; the open ones are in [Plans.md](../Plans.md) |
| `N.M`, round numbers | [Plans.md](../Plans.md), `git log` | a task, or a working pass over the repository. History; the reference documents do not cite them |

**Watch the `F`.** `F1`–`F7` in the divergence atlas are behavioural forks;
`F1`–`F4` in the optimization ledger are candidates. They are unrelated.
