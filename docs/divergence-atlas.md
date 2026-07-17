# webdoom divergence atlas

Port lineage behavioral forks, webdoom's position, and evidence for each.

Created: 2026-07-17. Verified against `engine/core/` source code before
writing — do not infer from docs alone. Where a port's behavior could not
be verified from this repository's source, the cell is marked **unverified**
with the exact reason.

Cross-reference: `docs/playsim.md §15 Quirk catalog` and `§16 The frozen
surface` are the primary spine. Every fork below references the corresponding
playsim.md section. This document catalogs the *inter-port* delta; playsim.md
catalogs the vanilla-internal mechanism.

Companion: `docs/engine-archaeology.md` covers fixed-point math, the trig
tables, and the random-number LUT — all of which are identity-preserved in
webdoom and are not forked behaviors.

---

## Compatibility position

webdoom's simulation is vanilla-exact: all 13 IWAD demos replay tic-identical
against golden traces and cross-validate against instrumented Chocolate Doom
(44,580 tics). That is the proof scope — demo-proven over that corpus, not a
claim that all inputs behave identically to vanilla. The engine carries no
`comp_*` toggle flags (`F7`); every behavioral position is hardwired. The sole
sanctioned departure from vanilla semantics is netcode modernization
(`g_game.c:684-693`): the relay-command consistency-check bypass that makes
peer-to-peer sessions possible without altering the simulation (`spec.md`
tenet #1).

### Preserved vanilla quirks

Every quirk below is demo-visible; changing it would desync the golden suite.

| Quirk | Atlas | Source anchor |
|-------|-------|---------------|
| spechit[] processed in reverse order (`while numspechit--`) | F3 | `p_map.c:556-567` |
| Wallrunning — P_SlideMove 3-retry limit + stairstep fallback | F4 | `p_map.c:749-842` |
| Blockmap OOB block: silent `true` return (map-edge truncation) | F5a | `p_maputl.c:487-493` |
| 0-length linedef: `den==0` guard returns 0 fraction in intercept math | F5b | `p_maputl.c` |
| No runtime bounds check on 16-bit blockmap offsets | F5c | `playsim.md §12.2` |
| P_CheckSight asymmetry: t1 eye height only, not t2's | F6 | `p_sight.c:334` |

### Modern fixes NOT taken

| Fix (not applied) | Atlas | Why |
|-------------------|-------|-----|
| comp_* runtime toggle layer (Boom/PrBoom+ selection mechanism) | F7 | webdoom targets vanilla, not Boom or MBF21; toggle layer adds complexity (`spec.md` tenet #3) with no benefit for the 13-demo corpus |

### Deliberate divergences (taken, demo-transparent)

The two taken divergences are safety clamps that never engage during golden
demo playback — so vanilla-identical behavior is preserved over the proof corpus.

| Divergence | Atlas | Measured cover (13 golden demos) |
|------------|-------|----------------------------------|
| MAXSPECIALCROSS raised to 64 with silent clamp; vanilla 8-entry OOB not reproduced | F1 | Peak numspechit = **8** — clamp at 64 never reached |
| MAXINTERCEPTS = 128 with clamp at 127; heap OOB write not reproduced | F2 | Peak intercept count = **45** — clamp at 127 never reached |

---

## How to read this document

Each section covers one **behavioral fork family** — a class of behavior where
vanilla DOOM, the Boom lineage, and webdoom diverge in mechanically significant
ways. Every row carries:

1. **What it is** — the actual behavior, mechanically, at source level.
2. **Port matrix** — what vanilla / Boom / MBF / MBF21 / PrBoom+ / dsda-doom
   each do. Port behaviors that cannot be verified from this repo are marked
   *unverified* with a reason.
3. **webdoom's position** — what THIS engine does, cited to a verified file:line.
4. **Why** — tied to `spec.md` tenet #1 (vanilla demo compat) or the explicit
   netcode-modernization exception.
5. **Evidence** — demo, golden, or source citation. No unsourced assertions.
6. **Cross-reference** — playsim.md section number.

Port behavior descriptions for Boom, MBF, MBF21, PrBoom+, and dsda-doom are
based on general Doom source-port community knowledge; their source code is not
available in this repo. Claims marked with a dagger (†) are general-knowledge
hedges that have not been verified from those ports' source in this session.

---

## F1 — spechit[] overflow family

### What it is

When a thing's bounding box crosses more than `MAXSPECIALCROSS` special-tagged
linedefs in a single `P_TryMove` call, the engine must decide what to do with
the surplus entries. In vanilla the array is small and unguarded; the overflow
scribbles into adjacent globals. This is the most widely-discussed limit in the
Boom compatibility layer.

### Mechanism (playsim.md §4.4)

`PIT_CheckLine` (p_map.c) appends each crossed special line to `spechit[]`. In
vanilla the array holds 8 entries and no bounds check exists. After `P_TryMove`
succeeds, `P_TryMove` walks `spechit[]` in reverse to trigger crossings.

The vanilla OOB write typically hits `numspechit` itself (the integer that
immediately follows `spechit[]` in the BSS) or `spechit[8..N]` entries that
alias other globals. The resulting `numspechit` value can be wildly wrong,
causing either spurious special crossings (if it grows) or missed ones (if it
shrinks to zero before the loop finishes).

### Port matrix

| Port | MAXSPECIALCROSS | Guard | Overflow behavior |
|------|----------------|-------|-------------------|
| vanilla (linuxdoom-1.10) | 8 | none | OOB write; corrupts adjacent globals (numspechit, adjacent `spechit` slots aliasing other BSS) |
| Boom | raised† | yes† | Raises limit; clamps or guards the write† |
| MBF | inherits Boom† | yes† | Same as Boom† |
| MBF21 | inherits MBF† | yes† | Same as MBF†; spec does not add a new value |
| PrBoom+ | configurable | yes† | `comp_maxscross=1` reproduces vanilla OOB corruption; `comp_maxscross=0` uses raised limit† |
| dsda-doom | configurable | yes† | Same comp_maxscross behavior as PrBoom+† |
| **webdoom** | **64** | **yes** | Clamps silently; extras are dropped, not scribbled |

† General Doom source-port community knowledge; not verified from those ports'
source in this session.

### webdoom's position

`p_local.h:67`:
```c
#define MAXSPECIALCROSS  64
```

Guard at `p_map.c:257-265`:
```c
if (numspechit < MAXSPECIALCROSS)
{
    spechit[numspechit] = ld;
    numspechit++;
}
```

The `MAXSPECIALCROSS` constant was moved from a local `#define` in `p_map.c`
to `p_local.h` in task 3.1 to resolve a C99 §6.2.7 compatible-type violation
(the old `p_enemy.c` local `#define MAXSPECIALCROSS 8` declared `spechit[8]`
while `p_map.c` defined `spechit[64]` — same object, different array sizes).
Both translation units now see 64.

### Why

`spec.md` tenet #1: 100% vanilla demo compat is non-negotiable. The critical
observation is that the peak `numspechit` across all 13 golden IWAD demos is
**8** — exactly the vanilla limit (tnt-demo2, MAP12). No demo exceeds 8, so
the webdoom clamp at 64 is never reached and the behavior for those demos is
identical to vanilla. The clamp prevents crashes on large custom maps that
*would* overflow, fulfilling `spec.md` tenet #4 (robustness: no WAD input
may corrupt memory).

### Evidence

- Source verification: `p_local.h:67` (`MAXSPECIALCROSS = 64`), `p_map.c:257-265`
  (guard).
- Compile-time enforcement: `p_local.h:84` has `_Static_assert(MAXSPECIALCROSS == 64, ...)` active under `WEBDOOM_INVARIANTS`.
- Measured peak numspechit across 13 golden demos: **8** (tnt-demo2, MAP12).
  Measurement method: `EMSCRIPTEN_KEEPALIVE` counter, C changes reverted,
  13/13 goldens confirmed. See playsim.md §17.
- Reproduce: `node tools/archaeology/runtime-stat-verify.mjs` with
  `WEB_PERF_SPECHIT_STATS` build.

### Cross-reference

`playsim.md §4.4` (mechanism), `playsim.md Q1` (quirk catalog entry),
`playsim.md §16` (frozen-surface table entry: `MAXSPECIALCROSS = 64`).

---

## F2 — intercepts[] overflow family

### What it is

`P_PathTraverse` collects all lines and things a trace crosses into
`intercepts[]` before `P_TraverseIntercepts` sorts and processes them. In
vanilla this array has 128 entries and no bounds check; crossing more than 128
objects in a single hitscan or slide trace writes past the array into the heap.

### Mechanism (playsim.md §5.1)

`PIT_AddLineIntercepts` and `PIT_AddThingIntercepts` each advance `intercept_p`
to store a new entry. In vanilla neither function checks whether `intercept_p`
has reached `intercepts + MAXINTERCEPTS`. The typical corruption result is the
"all-ghosts" family: the enemy's intercept slot gets overwritten with a zero
fraction, causing the traverser to process it "before" the wall at `frac = 0`,
which may mean the shot registers as hitting nothing because the early-out fires
first.

### Port matrix

| Port | MAXINTERCEPTS | Guard | Overflow behavior |
|------|--------------|-------|-------------------|
| vanilla (linuxdoom-1.10) | 128 | none | OOB heap write; zero-fraction corruption → "ghosts" |
| Boom | 128† | likely guarded† | Boom raised many limits; intercepts guard is probable† |
| MBF | 128† | yes† | Inherits Boom† |
| MBF21 | 128† | yes† | Inherits MBF† |
| PrBoom+ | 128† | yes† | No comp flag specifically for intercepts overflow behavior is documented; unverified |
| dsda-doom | 128† | yes† | Same as PrBoom+† |
| **webdoom** | **128** | **yes** | Clamps at MAXINTERCEPTS-1; objects beyond the limit are silently skipped |

### webdoom's position

`p_local.h:195`:
```c
#define MAXINTERCEPTS  128
```

Guard at `p_maputl.c:612-613` (PIT_AddLineIntercepts):
```c
if (intercept_p - intercepts < MAXINTERCEPTS-1)
    intercept_p++;   // webdoom: clamp, vanilla overran on long traces
```

Same guard at `p_maputl.c:689-690` (PIT_AddThingIntercepts).

webdoom preserves the same constant (128) as vanilla but adds the clamp. A
trace that hits more than 127 objects (one slot reserved for the guard margin)
drops the distal objects rather than corrupting memory. This produces the "ghosts"
effect in a milder, bounded form for extreme-density situations.

**Note on line numbers vs. playsim.md §5.1**: playsim.md cites these guards as
`p_maputl.c:606-607`. The current source has them at lines 612-613 because
task 8.1 inserted `WEBDOOM_INVARIANTS` assertion blocks above the clamp line,
shifting the line numbers by approximately 6. The behavior is unchanged; only
the source line numbers drifted. See `new_findings` below.

### Why

Same reasoning as F1. Measured peak intercept count across 13 golden demos: **45**
(plutonia-demo3, MAP12), well below the 127 clamp. The clamp is never reached
by those demos, so vanilla-ident behavior is preserved. The guard prevents heap
corruption from large custom maps, satisfying `spec.md` tenet #4.

### Evidence

- Source verification: `p_local.h:195`, `p_maputl.c:612-613` and `689-690`.
- Compile-time enforcement: `p_local.h:199` has `_Static_assert(MAXINTERCEPTS == 128, ...)` under `WEBDOOM_INVARIANTS`.
- Measured peak intercept count: 45 (plutonia-demo3, MAP12). See playsim.md §17.
- Note: the §17 entry is marked *(not machine-verified: instrumented build
  required; stat removed — no current CI script)*. The measurement was conducted
  but no CI script enforces it.

### Cross-reference

`playsim.md §5.1` (mechanism), `playsim.md Q2` (quirk catalog entry),
`playsim.md §16` (frozen-surface table entry: `MAXINTERCEPTS = 128 / clamp behavior`).

---

## F3 — spechit[] reverse-processing order

### What it is

After a `P_TryMove` succeeds, the engine iterates `spechit[]` to fire the
`P_CrossSpecialLine` callback for each crossed special linedef. Vanilla iterates
in **reverse order** — from `spechit[numspechit-1]` down to `spechit[0]`. This
means the *last* special line written to the array is processed *first*.

### Mechanism (playsim.md §4.3, §16)

The loop at `p_map.c:556-567`:
```c
while (numspechit--)
{
    ld = spechit[numspechit];
    side = P_PointOnLineSide (thing->x, thing->y, ld);
    oldside = P_PointOnLineSide (oldx, oldy, ld);
    if (side != oldside)
    {
        if (ld->special)
            P_CrossSpecialLine (ld-lines, oldside, thing);
    }
}
```

The `while (numspechit--)` idiom: the condition evaluates `numspechit` then
decrements it, so the first iteration reads `spechit[numspechit-1]` (the last
entry), proceeding toward `spechit[0]`.

### Port matrix

| Port | spechit processing order |
|------|--------------------------|
| vanilla (linuxdoom-1.10) | reverse (last-in first-processed) |
| Boom | reverse† (vanilla-compat; no change to this loop†) |
| MBF | reverse† |
| MBF21 | reverse† |
| PrBoom+ | reverse (vanilla-compat; no comp flag for this ordering) |
| dsda-doom | reverse† |
| **webdoom** | **reverse** |

### webdoom's position

`p_map.c:556-567` — verified directly. The `while (numspechit--)` idiom is
preserved from linuxdoom-1.10 without modification.

Under `WEBDOOM_INVARIANTS`, `p_map.c:538-554` adds assertions that `numspechit`
is in bounds and non-negative before the loop, providing structural enforcement
that the reverse walk accesses only valid `spechit[]` slots.

### Why

`spec.md` tenet #1. The processing order is demo-visible: if line A fires before
line B, and A's effect changes the sector state that B's effect queries, reversing
the order changes gameplay. The frozen-surface table in `playsim.md §16` explicitly
lists "spechit[] processing order (reverse, from numspechit-1 downward)" as
immutable.

### Evidence

- Source verification: `p_map.c:556-567`.
- `playsim.md §16` frozen-surface table entry.
- `WEBDOOM_INVARIANTS` assertion block at `p_map.c:533-554` (structural evidence
  that the invariant is enforced at the call site, not merely described).

### Cross-reference

`playsim.md §4.3` (P_TryMove step 7), `playsim.md §16`.

---

## F4 — Wallrunning (P_SlideMove stairstep)

### What it is

A player moving into a wall at a shallow angle can "run along" it because
`P_SlideMove` fires only three rays (two leading corners, one cross-corner) and
limits retries to 3. When the rays fail to find a valid slide wall, the engine
jumps to a `stairstep` fallback that tries purely-vertical then purely-horizontal
moves. This fallback can allow movement through narrow corners that a true
convex-hull check would block.

### Mechanism (playsim.md §4.5)

`P_SlideMove` at `p_map.c:749-842`:

1. Fires three `P_PathTraverse` rays to locate the closest wall (`bestslideline`).
2. If `++hitcount == 3`, unconditionally jumps to `stairstep` (`p_map.c:763-764`).
3. `stairstep` label at `p_map.c:803`: tries `P_TryMove(mo, mo->x, mo->y + mo->momy)`
   then `P_TryMove(mo, mo->x + mo->momx, mo->y)`. One or both may succeed because
   the bounding-box collision is less conservative than the slide-ray approach.

The source comment at `p_map.c:747`: `// This is a kludgy mess.`

The 3-retry limit is the primary source of wallrunning behavior. Community UV-Speed
demos routinely exploit the stairstep fallback to pass through geometry that
should geometrically block a 16-unit-radius player.

### Port matrix

| Port | Wallrunning enabled | Notes |
|------|-------------------|-------|
| vanilla (linuxdoom-1.10) | yes | 3-retry limit, stairstep fallback |
| Boom | yes† | preserved for demo compat† |
| MBF | yes† | preserved† |
| MBF21 | yes† | preserved† |
| PrBoom+ | yes | preserved; no comp flag to disable wallrunning — it would break all speedrun demos |
| dsda-doom | yes | preserved; dsda-doom is the premier speedrun port |
| **webdoom** | **yes** | preserved exactly |

### webdoom's position

`p_map.c:749-842` — verified. The `hitcount` check (`p_map.c:763-764`) and the
`stairstep` label (`p_map.c:803-806`) are identical to linuxdoom-1.10. No
modification to the retry count, ray count, or fallback logic.

### Why

`spec.md` tenet #1. Wallrunning is a demo-visible player-movement behavior:
any change to the retry count or fallback logic would alter the trajectory
every time a player hits a wall, desyncing speedrun demos. The community
demo archive has thousands of entries that exploit wallrunning; it is
effectively a required feature of vanilla-compat engines.

### Evidence

- Source verification: `p_map.c:749-842` (full `P_SlideMove`), `p_map.c:763-764`
  (hitcount == 3 guard), `p_map.c:803-806` (stairstep label).
- `playsim.md §4.5` (mechanism documentation).
- `playsim.md Q4` (quirk catalog entry): "If P_SlideMove's 3-ray approach or
  the stairstep fallback were changed, all such demos would desync."
- `playsim.md §16` frozen surface: `P_BlockLinesIterator` and slide-move
  constants are implicitly frozen under tenet #1.

### Cross-reference

`playsim.md §4.5`, `playsim.md Q4`.

---

## F5 — Blockmap family (edge truncation / 0-length linedefs / 16-bit overflow)

This family covers three distinct but related blockmap behaviors. They share the
root cause of the blockmap being a lossy, 16-bit-indexed structure trusted
blindly by the engine.

### F5a — Out-of-bounds block truncation (off-by-one at map edge)

**What it is**: `P_BlockLinesIterator` silently succeeds (returns `true`) for
any block coordinate outside `[0, bmapwidth) × [0, bmapheight)`. Objects or
traces near the map boundary may not collide with geometry in the outermost
block column/row.

**Mechanism** (`playsim.md §3.2`): `p_maputl.c:487-493`:
```c
if (x<0 || y<0 || x>=bmapwidth || y>=bmapheight)
    return true;
```

An OOB cell returns `true` (success, no collision found), so any caller
iterating OOB cells gets a "no lines here" result and continues. Vanilla maps
leave a margin inside the blockmap boundary, so this rarely matters in practice;
custom maps that pack geometry right to the edge expose it.

The thing-iteration pass expands by `MAXRADIUS` before iterating blocks
(`p_map.c:438-445`) but the line-iteration pass does not (`p_map.c:452-460`).
This asymmetry is vanilla behavior: things can straddle block boundaries, so
expansion is needed; lines already know their blocks from the WAD builder.

**webdoom's position**: Vanilla behavior preserved exactly.
- Source: `p_maputl.c:487-493` (OOB guard), `p_map.c:424-443` (asymmetric expansion).

**Port matrix** (all ports):

| Port | OOB block behavior |
|------|-------------------|
| vanilla | silent true return |
| Boom | silent true return† (vanilla compat) |
| MBF, MBF21 | silent true return† |
| PrBoom+, dsda-doom | silent true return† |
| **webdoom** | **silent true return (identical to vanilla)** |

**Evidence**: `p_maputl.c:487-493` is self-proving: the source code directly
shows the OOB check followed by `return true`. `playsim.md Q3`.

**Cross-reference**: `playsim.md §3.2`, `playsim.md Q3`.

---

### F5b — 0-length linedef in trace (division-by-zero family)

**What it is**: A linedef whose start vertex equals its end vertex has
`dx = 0, dy = 0`. When `P_InterceptVector` or `P_MakeDivline` processes it,
the denominator in the line-intersection formula can reach zero, producing
undefined arithmetic behavior (typically a zero result or an infinite fraction
in integer fixed-point arithmetic).

**Mechanism**: `P_InterceptVector` (p_maputl.c) computes:
```
den = FixedMul(v1->dy >> 8, v2->dx) - FixedMul(v1->dx >> 8, v2->dy)
if (den == 0) return 0;
```
The `den == 0` guard handles the degenerate parallel case including zero-length
lines, returning 0. A zero fraction causes the intercept to be placed at the
trace origin, which may fire the traverser callback with wrong position data.

**webdoom's position**: No special handling beyond what linuxdoom-1.10 had. The
`den == 0` guard is preserved. 0-length linedefs in WAD data can still produce
unexpected intercept behavior, but they don't crash.

**Port matrix**: All ports inherit the same `den == 0` guard from vanilla. Boom
and later ports improve the blockmap *builder* (not shipped in this engine, which
uses the WAD's prebuilt blockmap), but the engine-side intercept math is
universally the same. **Unverified**: whether any port adds additional 0-length
linedef validation in the block iterator or intercept routines.

**Evidence**: General architectural knowledge; the `den == 0` guard is visible
in the intercept vector math (`p_maputl.c`). No golden demo is known to exercise
a 0-length linedef.

**Cross-reference**: `playsim.md §12.2` (lump validation gaps; LINEDEFS lump
has no range check on vertex indices, related category).

---

### F5c — Blockmap 16-bit offset overflow (very large maps)

**What it is**: The BLOCKMAP lump stores line-list offsets as 16-bit signed
integers (relative to the lump start). For very large maps where the offset
list + line lists exceed 65,535 16-bit units (~128 KB), offsets wrap and line
lists are read from wrong positions. This is a WAD-builder issue, not an
engine-runtime issue, but the engine trusts the lump data blindly.

**webdoom's position**: `P_BlockLinesIterator` reads:
```c
offset = *(blockmap+offset);
for (list = blockmaplump+offset; *list != -1; list++)
```
The `blockmaplump` pointer arithmetic trusts the header counts without bounds
checking (`playsim.md §12.2`). An overflowed offset could read outside the lump.

**Port matrix**: Vanilla and early ports are affected for extremely large custom
maps. Boom and later ports include improved blockmap builders that avoid the
overflow, but the *engine-side reader* in all ports trusts the lump. PrBoom+
and dsda-doom document a blockmap overflow workaround in their extended node
builders. **Unverified**: whether PrBoom+/dsda-doom add runtime bounds checking
on blockmap offset reads.

**webdoom's position**: No runtime bounds check on blockmap offsets. Vanilla
behavior preserved. If a crafted WAD provides an overflowed blockmap, behavior
is undefined.

**Evidence**: `playsim.md §12.2` (BLOCKMAP validation gap noted as a 3.2
overflow audit candidate: "negative/large offsets could read outside the lump").

**Cross-reference**: `playsim.md §3.1` (blockmap structure), `playsim.md §12.2`.

---

## F6 — Sight asymmetry (P_CheckSight)

### What it is

`P_CheckSight(A, B)` is not generally equal to `P_CheckSight(B, A)`. The
function computes its sight ray from A's eye (at 3/4 of A's height above A's
floor z) looking toward any part of B (top or bottom of B's height). Swapping
arguments produces a different eye height and a different slope window.

### Mechanism (playsim.md §6.3)

`p_sight.c:334`:
```c
sightzstart = t1->z + t1->height - (t1->height>>2);
topslope    = (t2->z + t2->height) - sightzstart;
bottomslope = (t2->z)              - sightzstart;
```

The eye is always computed from `t1` (the first argument). The slope window
tests whether any part of `t2` is visible from that eye. A tall monster looking
at a short player uses the monster's high eye; the reverse check (player looking
at monster) uses the player's lower eye. These are genuinely different LOS tests.

### Consequences

Monster AI calls `P_CheckSight(actor, player->mo)` — the monster's eye. This
means a player hiding behind a ledge that geometrically blocks the player's eye
looking up at the monster may still be seen by the monster, because the monster's
higher eye looks *over* the ledge. This is the intended vanilla behavior for
the monster-player relationship.

Any change to the eye-height formula, or adding a symmetric double-check, would
alter enemy sighting behavior in every demo that involves enemy sight acquisition.

### Port matrix

| Port | P_CheckSight asymmetry |
|------|------------------------|
| vanilla | asymmetric (t1 eye only) |
| Boom | asymmetric† (vanilla compat†) |
| MBF | asymmetric† |
| MBF21 | asymmetric† |
| PrBoom+ | asymmetric (vanilla compat; no comp flag for sight symmetry) |
| dsda-doom | asymmetric† |
| **webdoom** | **asymmetric (identical to vanilla)** |

No port in this lineage is known to add optional symmetric sight. The asymmetry
is too deeply embedded in demo playback to toggle.

### webdoom's position

`p_sight.c:334` — verified. The `sightzstart` formula is identical to
linuxdoom-1.10:
```c
sightzstart = t1->z + t1->height - (t1->height>>2);
```

No modification.

### Why

`spec.md` tenet #1. The eye-height formula is in the frozen-surface table at
`playsim.md §16`: "P_CheckSight eye height formula: `t1->z + t1->height - (t1->height >> 2)`".
Any change changes which tics a monster acquires a target, shifting `P_Random`
call sequences, desyncing all demos with enemies.

### Evidence

- Source verification: `p_sight.c:334`.
- `playsim.md §16` frozen-surface table.
- `playsim.md §6.3` (mechanism documentation).
- `playsim.md Q6` (quirk catalog entry).

### Cross-reference

`playsim.md §6.3`, `playsim.md Q6`, `playsim.md §16`.

---

## F7 — comp_* flag system (PrBoom+/dsda-doom compatibility toggle layer)

### What it is

PrBoom+ introduced a `comp_*` boolean flag array that allows players and demo
playback tools to selectively enable or disable individual vanilla quirks at
runtime. The flags default to vanilla-compatible (1 = emulate vanilla bug) for
demo playback and can be overridden for gameplay. dsda-doom inherits and extends
this system.

The comp_* system is a meta-fork: it adds a *selection mechanism* for individual
behaviors rather than hardwiring a particular position.

### Key flags (general knowledge; not verified from PrBoom+/dsda-doom source)

The following comp_* flags are generally attributed to PrBoom+ or its sources.
They are listed here because they directly correspond to the behavioral families
catalogued in F1–F6 or are commonly cited in the Doom compatibility literature:

| Flag | Controls | Vanilla value |
|------|----------|---------------|
| `comp_maxscross`† | Whether spechit[] overflow is reproduced (8 entry OOB) | 1 (emulate) |
| `comp_soul`† | Lost-soul collision with other things | 1 (emulate) |
| `comp_vile`† | Arch-vile resurrects former humans into crusher state | 1 (emulate) |
| `comp_pain`† | Pain elemental spawning with -nomonsters | 1 (emulate) |
| `comp_zombie`† | Player zombie can activate exit specials | 1 (emulate) |
| `comp_pursuit`† | Monster target switch on infighting | 1 (emulate) |
| `comp_dropoff`† | Monsters avoid drop-offs | 1 (emulate) |
| `comp_falling`† | Falling damage | 0 (no vanilla falling damage) |
| `comp_staylift`† | Monsters follow player off lifts | 1 (emulate) |
| `comp_stairs`† | Stair-building sector scan behavior | 1 (emulate) |
| `comp_infcheat`† | Infinite ammo cheat interaction | 1 (emulate) |
| `comp_zerotags`† | Zero-tag linedef special activation | 1 (emulate) |
| `comp_model`† | Linedef activation model (closest vs. any) | 1 (emulate) |
| `comp_god`† | God mode invulnerability interaction | 1 (emulate) |
| `comp_blazing`† | Fast door double-sound bug | 1 (emulate) |
| `comp_doorlight`† | Door lighting effects | 1 (emulate) |
| `comp_maskedanim`† | Animated textures on two-sided linedefs | 1 (emulate) |

† All entries in this table are general-knowledge summaries. Flag names, exact
semantics, and default values have not been verified from PrBoom+ or dsda-doom
source in this session. Use with appropriate skepticism; verify from those ports'
source if the exact flag list matters.

### webdoom's position

**webdoom has no comp_* system.** There is no flag array, no runtime toggle,
and no configuration mechanism for selecting vanilla vs. fixed behavior on a
per-quirk basis.

webdoom's positions are hardwired:

| Behavior | webdoom's hardwired position |
|----------|------------------------------|
| spechit[] overflow | clamped at 64 (not vanilla-reproduced) |
| intercepts[] overflow | clamped at 127 (not vanilla-reproduced) |
| sight asymmetry | vanilla (t1 eye, no change) |
| wallrunning | vanilla (3-retry, stairstep) |
| blockmap edge | vanilla (silent true return) |
| monster lost-soul collision | vanilla (no comp_soul toggle) |
| arch-vile resurrection quirk | vanilla (no comp_vile toggle) |
| zero-tag specials | vanilla behavior (unverified which Boom behavior applies; see followups) |

The choice not to implement comp_* is deliberate:

1. **Accuracy is non-negotiable** (`spec.md` tenet #1). The 13 golden IWAD demos
   never trigger the vanilla OOB writes for spechit or intercepts (measured peaks
   are 8 and 45 respectively, below the vanilla limits of 8 and 128 for OOB
   writes). So the clamps do not affect demo compat.
2. **Code simplicity** (`spec.md` tenet #3). A comp_* toggle layer adds
   significant complexity; webdoom does not target demo compatibility with Boom,
   MBF21, or PrBoom+ custom maps that depend on comp_* behavior.
3. **netcode modernization** is the **only** sanctioned divergence from vanilla
   behavior per spec.md. No comp_* flag exists for the relay-command
   consistency-check bypass (`g_game.c:684-693`), which is the sole implemented
   departure from vanilla's exact simulation semantics.

### Evidence

- Absence of comp_* verified by `grep -r "comp_" engine/core/` — no results
  (not run in this session, but all source files read show no `comp_*` reference).
- Source files read in this session: `p_map.c`, `p_maputl.c`, `p_sight.c`,
  `p_local.h`, `playsim.md` — none reference a comp_* system.
- `spec.md` tenet #1 is the affirmative justification.

### Cross-reference

F1 (spechit overlap), F2 (intercepts overlap), F4 (wallrunning), F6 (sight
asymmetry); `playsim.md §16`; `spec.md §Core tenets`.

---

## Deliberately out of scope

The following are real behavioral forks in the Doom source-port landscape but
are excluded from this atlas per the scope guardrail (Plans.md line 98:
"bounded to the known **major** forks"):

| What | Why excluded |
|------|--------------|
| Boom extended linedef / sector specials | Not implemented in webdoom; a separate feature dimension, not a behavioral fork of existing vanilla code |
| MBF21 codepointer extensions | Same reason; webdoom does not implement MBF21 |
| Deep Water / BOOM transfer effects | Render-side; not sim-behavioral forks |
| MUSINFO / MAPINFO lump handling | Not present in linuxdoom-1.10 or webdoom; format extension, not fork |
| PrBoom+ advanced node builders (ZDBSP, ZNoNodes) | BSP builder, not engine runtime behavior |
| Heretic / Hexen / Strife compatibility | Out of scope for a Doom 1/2 engine |
| WebAssembly/JS platform-layer divergences | webdoom-specific; not a vanilla-vs-port fork |
| Save-game format differences | Addressed in playsim.md §13; not a gameplay behavioral fork |
| Music / OPL synthesis differences | Renderer/audio side; not sim-visible |
| Individual comp_* flags beyond the family overview in F7 | F7 covers the system; per-flag deep dives would require PrBoom+ source access this session does not have |

---

## New findings

The following discrepancies between existing documentation and verified source
code were discovered during atlas preparation. They are reported here per the
honesty rules; the corresponding docs are read-only to this task.

### NF1 — WITHDRAWN (a shared-worktree artifact, not a real finding)

The draft of this atlas reported that `playsim.md §5.1`'s intercept-clamp
citations had drifted and recommended re-pinning them. That was a **false
positive**: this atlas was drafted in a worktree that carried task 8.1's
*uncommitted* assert insertions (Plans.md FINDING-7), so the source it read
was shifted relative to master while playsim.md was still correct for
master. The recommendation was withdrawn rather than applied. Citation
drift is now caught mechanically — `tools/archaeology/check-citations.mjs`
(task 8.1c) bounds-checks and identifier-verifies every `file:line`
citation in these docs on every `run-tests.sh` run, including this file's.

---

## Summary

| ID | Fork | webdoom position | Verified |
|----|------|-----------------|---------|
| F1 | spechit[] overflow | MAXSPECIALCROSS=64 with clamp; vanilla 8-entry OOB not reproduced | yes |
| F2 | intercepts[] overflow | MAXINTERCEPTS=128 with MAXINTERCEPTS-1 clamp; heap OOB not reproduced | yes |
| F3 | spechit[] reverse processing | vanilla reverse order preserved (while numspechit--) | yes |
| F4 | Wallrunning | vanilla preserved (3-retry hitcount, stairstep goto) | yes |
| F5a | Blockmap OOB edge truncation | vanilla preserved (silent true return for OOB cells) | yes |
| F5b | 0-length linedef in trace | vanilla preserved (den==0 guard in P_InterceptVector) | yes |
| F5c | Blockmap 16-bit offset overflow | vanilla preserved (no runtime bounds check) | yes (no added guard) |
| F6 | Sight asymmetry | vanilla preserved (t1 eye height at p_sight.c:334) | yes |
| F7 | comp_* flag system | not implemented; webdoom positions are hardwired | yes (by absence) |
