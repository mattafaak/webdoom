# webdoom playsim internals

The simulation is the deterministic core that the project's accuracy tenet
protects. This document describes how it works, function by function, from
`engine/core/`. Where vanilla behaviour is kept for demo compatibility, the
quirk is named. §16 lists exactly what may never change.

The companion volume is [renderer.md](renderer.md). The sim/render boundary is
clean: the simulation always runs on true, unlerped fixed-point values, and the
renderer is free to interpolate for display. Renderer internals are not
repeated here.

Citations name the function, because line numbers move. A line number is given
only for a `#define` or a table, where it is the most direct pointer.

Three kinds of evidence back the figures here:

- **Source constants.** `tools/archaeology/source-constant-verify.mjs` checks
  the constants this document relies on (MAXSPECIALCROSS, MAXINTERCEPTS,
  BACKUPTICS, MAX_DEATHMATCH_STARTS, MAXHEALTH, BONUSADD,
  FLOATSPEED and the movement tables). The `archaeology` leg runs it.
- **The 13 golden demos.** The `sim-goldens` leg compares a per-tic gamestate
  hash for every demo; `render-goldens` compares per-tic framebuffer hashes.
  "Demo-visible" in this document means a change would move those hashes.
- **Measured peaks.** A few counts (spechit, intercepts, teleports) were
  measured once with an instrumented build. §17 says how, and how to repeat
  it.

---

## Contents

1. [Tic orchestration](#1-tic-orchestration)
2. [Random number generation](#2-random-number-generation)
3. [The blockmap](#3-the-blockmap)
4. [Movement and collision — p_map.c / p_maputl.c](#4-movement-and-collision)
5. [Intercepts and traces](#5-intercepts-and-traces)
6. [Line-of-sight — p_sight.c](#6-line-of-sight)
7. [Z movement and gravity — p_mobj.c](#7-z-movement-and-gravity)
8. [Enemy AI — p_enemy.c](#8-enemy-ai)
9. [Interactions — p_inter.c](#9-interactions)
10. [Sector specials — p_spec.c, p_doors.c, p_plats.c, p_ceilng.c, p_floor.c, p_lights.c, p_switch.c, p_telept.c](#10-sector-specials)
11. [Weapons and psprites — p_pspr.c](#11-weapons-and-psprites)
12. [Map setup — p_setup.c](#12-map-setup)
13. [Save / load — p_saveg.c](#13-save--load)
14. [Player — p_user.c](#14-player)
15. [Quirk catalog](#15-quirk-catalog)
16. [The frozen surface](#16-the-frozen-surface) (§16.1 assert mapping; §16.2 the gate; §16.3 confirming an assert fires)
17. [Measured peaks in the golden demos](#17-measured-peaks-in-the-golden-demos)
18. [Function index — p_*.c](#18-function-index)
19. [Limits audit](#19-limits-audit)

---

## 1. Tic orchestration

### 1.1 Call chain

Every simulation tic is driven by `G_Ticker` (g_game.c), which:

1. Handles reborn players and deferred game actions (load, save, demo, and so
   on).
2. Copies the current tic's `ticcmd_t` from `netcmds[i][buf]` into each active
   player's `cmd`. During demo playback `G_ReadDemoTiccmd` then overwrites it;
   during recording `G_WriteDemoTiccmd` stores it.
3. In a netgame, checks and rebuilds the consistency value (§1.3).
4. Handles the special buttons (pause, save), then calls `P_Ticker` once the
   game state is `GS_LEVEL`.

`P_Ticker` (p_tick.c) is the sim tic proper:

```
return if paused, or if a single-player menu is open
(webdoom) snapshot every sector's floor/ceiling height for interpolation
for each player in game: P_PlayerThink   (p_user.c)
P_RunThinkers                            (p_tick.c)
P_UpdateSpecials                         (p_spec.c)
P_RespawnSpecials                        (p_mobj.c)
leveltime++
```

The sector-height snapshot (`oldfloorheight`, `oldceilingheight`) is
render-local state. Nothing in the sim reads it.

### 1.2 Thinker list

`thinkercap` (p_tick.c) is a sentinel node. Its `next`/`prev` form a circular
doubly-linked list of every active thinker. Every mobj, ceiling, door, floor,
platform and light effect is a thinker.

**P_AddThinker** inserts at the tail:

```c
thinkercap.prev->next = thinker;
thinker->next = &thinkercap;
thinker->prev = thinkercap.prev;
thinkercap.prev = thinker;
```

**P_RemoveThinker** does not free. It marks the thinker with a sentinel function
pointer:

```c
thinker->function.acv = (actionf_v)(-1);
```

The thinker stays linked until **P_RunThinkers** next reaches it, then is
unlinked and freed there. This deferred free is vanilla and demo-visible: a
thinker removed mid-tic keeps its place in the list for the rest of the pass.

`P_RunThinkers` reads `currentthinker->next` *before* `Z_Free` on the remove
path. Vanilla read it after the free, a use-after-free that only worked because
the zone allocator does not clear a freed block. On the think path, `next` is
read *after* the think call, as vanilla does, so a thinker that the current one
spawns is appended behind it and runs in the same tic (Chocolate Doom's form).
Do not move that read before the call.

A mobj freed inside its own callback is handled by `P_MobjThinker`, which
checks the sentinel after `P_XYMovement` and after `P_ZMovement`:

```c
if (mobj->thinker.function.acv == (actionf_v)(-1))
    return;   // mobj was removed
```

**Thinker order** is insertion order, head to tail, and it is demo-visible.
`P_SetupLevel` calls `P_LoadThings` before `P_SpawnSpecials`, so every map
thing (players included) precedes the light and timed-door thinkers, and
anything spawned during play is appended behind both. Any change that reorders
thinkers breaks demos.

### 1.3 ticcmd and consistency check

Each player's input for one tic is a `ticcmd_t` (d_ticcmd.h):

| field | type | meaning |
|-------|------|---------|
| `forwardmove` | `char` | forward/back speed; ×2048 for momentum |
| `sidemove` | `char` | strafe speed; ×2048 for momentum |
| `angleturn` | `short` | yaw delta; `<<16` gives angle units |
| `consistancy` | `short` | echo of the stored consistency value |
| `chatchar` | `byte` | in-game chat |
| `buttons` | `byte` | fire, use, weapon select, special |

In a netgame, `G_Ticker` compares `cmd->consistancy` with
`consistancy[i][buf]` and calls `I_Error` on a mismatch (a hard desync). It
then stores the new value: `players[i].mo->x` when the player mobj exists,
otherwise `rndindex`. The check is skipped for the first `BACKUPTICS` tics, as
in vanilla.

webdoom adds two more skips, both in `G_Ticker`:

- A command the relay fabricated for a stalled client (`D_NetCmdFabricated`)
  carries no valid checksum, so it is not verified. Real commands still are.
- A dropped-in player's ring is stale for its first cycle, so the check skips
  that slot until `gametic >= web_joinTic[i] + BACKUPTICS`.

`buf = (gametic/ticdup) % BACKUPTICS`. `BACKUPTICS = 35` (d_net.h:52); vanilla
used 12. The larger ring gives the browser netcode room for a jitter buffer
plus send-ahead, so WAN jitter is absorbed instead of causing catch-up
hitches.

### 1.4 Demo playback and recording

`G_ReadDemoTiccmd` reads four bytes per player per tic: `forwardmove`,
`sidemove`, `angleturn >> 8` and `buttons`. `G_WriteDemoTiccmd` writes the same
four bytes, rounding `angleturn` to its high byte, then reads them back into
`cmd` so a recording session plays exactly what the demo will replay. The full
layout is in [formats.md](formats.md) §4.

Neither random index is stored in a demo. Demo determinism rests entirely on
both sides making the same sequence of `P_Random` calls from index 0 (§2).

webdoom ends a recording when JS calls `web_demo_stop`. Vanilla ended it on the
`q` key or a full buffer, through an `I_Error` that would end the browser
session and lose the recording; a full buffer now keeps what it holds, with
room left for the end marker.

---

## 2. Random number generation

### 2.1 Two indices, one table

`rndtable[256]` (m_random.c) is a 256-byte table. It is not the output of a
standard PRNG; [engine-archaeology.md](engine-archaeology.md) §3 shows that no
seeded LCG generates it.

Two independent indices advance through the table:

| index | function | demo-visible |
|-------|----------|-------------|
| `prndindex` | `P_Random()` | yes: gameplay |
| `rndindex` | `M_Random()` | no: display only |

`P_Random`:

```c
prndindex = (prndindex+1) & 0xff;
return rndtable[prndindex];
```

`M_Random` is identical but advances `rndindex`.

`M_ClearRandom` resets both to 0. Its only caller is `G_InitNew`, so the reset
happens at a new game, at demo playback start and when a savegame is loaded
(which goes through `G_InitNew`). Moving to the next level does not reset
either index.

### 2.2 Wraparound

Both indices wrap from 255 to 0 through `& 0xff`. The table is never reseeded.
A long demo cycles through it repeatedly. This is vanilla behaviour, kept
exactly.

### 2.3 Why the split matters

`M_Random` serves only presentation: the melt wipe (f_wipe.c), the status-bar
face (st_stuff.c), sound pitch variation (s_sound.c) and intermission
animations (wi_stuff.c). Because those draw from `rndindex`, a different number
of wipes or menu sounds on two machines cannot shift the gameplay sequence.
Anything that affects gameplay must use `P_Random`, and anything that does not
must not.

---

## 3. The blockmap

### 3.1 Structure

The blockmap divides the map into a grid of 128×128-unit blocks
(`MAPBLOCKUNITS = 128`, `MAPBLOCKSIZE = 128*FRACUNIT`, p_local.h:38–39).

`P_LoadBlockMap` (p_setup.c) loads it from the `BLOCKMAP` lump; it is the first
loader `P_SetupLevel` calls. It byte-swaps the lump in place with `SHORT()` and
sets these globals:

| variable | meaning |
|----------|---------|
| `bmapwidth`, `bmapheight` | grid dimensions in blocks |
| `bmaporgx`, `bmaporgy` | world-space origin of block (0,0) |
| `blockmaplump` | the lump: header, offsets, line lists |
| `blockmap` | `blockmaplump + 4`, the offset table |
| `blocklinks` | per-block mobj list heads (a separate zone allocation, zeroed) |

The lump is `[orgx, orgy, width, height]` as 16-bit shorts, then `width*height`
16-bit offsets (one per block), then the line-index lists, each terminated by
`-1`. The format is in [formats.md](formats.md) §2.10.

### 3.2 P_BlockLinesIterator and the edge return

`P_BlockLinesIterator` (p_maputl.c) starts with:

```c
if (x<0 || y<0 || x>=bmapwidth || y>=bmapheight)
    return true;
```

An out-of-bounds block returns true with no lines checked. Objects or traces
that straddle the map boundary may therefore miss lines in the outermost
blocks. Shipped maps leave a margin, so this rarely shows, but custom maps that
pack geometry to the boundary expose it. `P_BlockThingsIterator` has the same
bounds return.

`P_CheckPosition` widens its search by `MAXRADIUS` (32 units, p_local.h:51) for
the thing pass and not for the line pass. Things are linked into the block that
holds their origin but can overlap neighbouring blocks by up to `MAXRADIUS`, so
the thing pass must look further. Lines are listed in every block they touch,
so the line pass needs no widening.

Both iterators run x outer, y inner (the nested loops in `P_CheckPosition`).
That order decides which line `PIT_CheckLine` sees first and therefore the
order of `spechit[]`. It is frozen (§16).

### 3.3 validcount

`validcount` is a global counter incremented before each sweep. A line listed
in several blocks is processed once per sweep because `P_BlockLinesIterator`
skips any line whose `ld->validcount` already equals it. Code that calls a block
iterator must increment `validcount` first, or shared lines get duplicate
`PIT_` callbacks, which can mean duplicate `spechit[]` entries or duplicate
intercepts.

---

## 4. Movement and collision

### 4.1 P_CheckPosition

`P_CheckPosition` (p_map.c) is the query half of movement. It:

1. Sets `tmthing`, `tmflags`, `tmx`, `tmy` and `tmbbox` for the proposed
   position.
2. Sets `tmfloorz` and `tmdropoffz` from the destination subsector's floor, and
   `tmceilingz` from its ceiling.
3. Increments `validcount` and clears `numspechit`.
4. Returns true at once for `MF_NOCLIP` things.
5. Runs `PIT_CheckThing` over the thing blocks, widened by `MAXRADIUS`.
6. Runs `PIT_CheckLine` over the line blocks, not widened.

It returns false at the first blocking thing or line, true if nothing blocks.
Things are checked before lines, so a move blocked by a thing never looks at
lines at all.

`PIT_CheckThing` also deals contact damage. A charging lost soul or a missile
that hits a shootable thing deals `((P_Random()%8)+1) * info->damage`, which is
demo-visible.

### 4.2 tmfloorz / tmceilingz capture

`PIT_CheckLine` returns false (blocked) for a one-sided line, and for
`ML_BLOCKING` or (for monsters) `ML_BLOCKMONSTERS` lines unless the mover is a
missile. For every other contacted line it calls `P_LineOpening` and narrows
the captured heights. After all lines are checked:

- `tmfloorz` is the highest floor contacted: the floor the thing would stand
  on.
- `tmceilingz` is the lowest ceiling contacted. `ceilingline` remembers the line
  that set it, so a missile can tell a sky-hack wall from a real one.
- `tmdropoffz` is the lowest floor contacted, used for the drop-off check.

A contacted line with a special is appended to `spechit[]` (§4.4). The id
comment in `PIT_CheckLine` notes that specials are not sorted, so two special
lines close together can be crossed in either order.

### 4.3 P_TryMove

`P_TryMove` (p_map.c) is the mutating move:

1. Calls `P_CheckPosition`. If blocked, returns false.
2. Unless `MF_NOCLIP`:
   - `tmceilingz - tmfloorz < thing->height`: does not fit, return false.
   - Sets `floatok = true` (the gap is tall enough; `P_Move` uses this for
     floaters).
   - `tmceilingz - thing->z < thing->height` (unless `MF_TELEPORT`): it would
     have to lower itself to fit, return false.
   - `tmfloorz - thing->z > 24*FRACUNIT` (unless `MF_TELEPORT`): step too high,
     return false.
   - `tmfloorz - tmdropoffz > 24*FRACUNIT` for things without `MF_DROPOFF` or
     `MF_FLOAT`: it would stand over a drop-off, return false.
3. `P_UnsetThingPosition`, update `x`, `y`, `floorz`, `ceilingz`,
   `P_SetThingPosition`.
4. Unless `MF_TELEPORT` or `MF_NOCLIP`, walk `spechit[]` in reverse
   (`while (numspechit--)`). For each line where the thing's side changed
   between the old and new position, call `P_CrossSpecialLine`.

The reverse walk is vanilla and demo-visible: it decides which of two crossed
specials fires first. [divergence-atlas.md](divergence-atlas.md) F3 covers it.

### 4.4 spechit[] — the overflow behaviour

```c
// p_local.h:67
#define MAXSPECIALCROSS  64   // vanilla: 8
// p_map.c
line_t*  spechit[MAXSPECIALCROSS];
int      numspechit;
```

Vanilla had `MAXSPECIALCROSS = 8`. When a move contacted more than 8 special
lines (possible with a wide radius in a dense special-line area), vanilla wrote
past the array into adjacent globals. That corruption often hit `numspechit`
itself, producing spurious line crossings or skipping real ones.

webdoom raises the limit to 64 and guards the write in `PIT_CheckLine`:

```c
if (numspechit < MAXSPECIALCROSS) {
    spechit[numspechit] = ld;
    numspechit++;
}
```

Specials beyond 64 are dropped. Neither behaviour reproduces vanilla above 8,
but dropping is safer than scribbling. The measured peak across the 13 golden
demos is exactly 8 (tnt-demo2, MAP12; §17), so neither the vanilla overflow nor
the webdoom clamp is reached by the corpus.

`MAXSPECIALCROSS` is defined once, in p_local.h, so `p_map.c`'s definition of
`spechit[]` and `p_enemy.c`'s `extern` see the same extent. Vanilla
`p_enemy.c` declared its own `MAXSPECIALCROSS 8` for the `extern`, two
incompatible declarations of one object (C99 §6.2.7). The change is
behaviour-identical: `P_Move`'s loop is bounded by `numspechit`, never by the
constant.

[divergence-atlas.md](divergence-atlas.md) F1 compares this with other ports.

### 4.5 P_SlideMove — the three-pass limit

`P_XYMovement` calls `P_SlideMove` (p_map.c) when a player's move is blocked.
Each pass fires three `P_PathTraverse` rays, from the two leading corners and
one trailing corner of the bounding box along the momentum, with
`PTR_SlideTraverse` to find the nearest wall:

```c
retry:
    if (++hitcount == 3)
        goto stairstep;
```

The counter starts at 0, so two passes trace; the third goes straight to
`stairstep`. A pass that finds no wall, or whose move up to the wall fails,
also goes to `stairstep`, which tries a move along y only and then along x only:

```c
stairstep:
    if (!P_TryMove (mo, mo->x, mo->y + mo->momy))
        P_TryMove (mo, mo->x + mo->momx, mo->y);
```

Otherwise the move goes up to the wall (minus a `0x800` fudge), `P_HitSlideLine`
projects the remaining momentum onto the wall, and the rest of the move is
tried. id's comment on this code reads "This is a kludgy mess." The pass limit
and the stairstep fallback are demo-visible: wallrunning (Q4) lives here.

### 4.6 P_XYMovement — momentum and friction

`P_XYMovement` (p_mobj.c) runs when a mobj has momentum or is a charging lost
soul:

1. A lost soul with no momentum left stops charging (clears `MF_SKULLFLY`,
   returns to its spawn state).
2. Momentum is clamped to `±MAXMOVE` (30 units, p_local.h:54).
3. The move is made in steps. If `xmove` or `ymove` exceeds `MAXMOVE/2`, half
   of it is tried and the rest kept for the next step. The test is on the
   positive values only, so a large negative momentum is tried in one step;
   this asymmetry is vanilla and kept.
4. A blocked step: a player slides (`P_SlideMove`); a missile explodes, or is
   silently removed if `ceilingline` has a sky ceiling behind it (the sky hack);
   anything else has its momentum zeroed.
5. Friction is applied last, and only to things on the floor that are neither
   missiles nor charging lost souls. A corpse hanging over a step with momentum
   above a quarter unit keeps sliding.

```c
// p_mobj.c:111-112
#define STOPSPEED   0x1000   // 1/16 unit per tic
#define FRICTION    0xe800   // 0.90625 as a fixed-point multiplier
```

If both momentum components are inside `±STOPSPEED` and (for a player) the
ticcmd has no forward or side movement, momentum is zeroed and a walking player
is set back to the standing state. Otherwise both components are multiplied by
`FRICTION`.

Monsters do not walk by momentum. `P_Move` (p_enemy.c) moves them directly by
`speed × xspeed/yspeed` through `P_TryMove`; their momentum comes only from
knockback, and friction decays it like a player's.

---

## 5. Intercepts and traces

### 5.1 intercepts[] array

```c
// p_local.h:195
#define MAXINTERCEPTS  128

// p_maputl.c
intercept_t  intercepts[MAXINTERCEPTS];
intercept_t* intercept_p;
```

`MAXINTERCEPTS` is vanilla's value. The array collects every line and thing a
trace passes before `P_TraverseIntercepts` processes them in order.

**Vanilla overflow.** Vanilla wrote past `intercepts[]` when a trace crossed
more than 128 objects. The overrun corrupts whatever follows the array in
memory; the "all-ghosts" family, where shots pass through monsters, is
attributed to it.

**webdoom's guard.** Both `PIT_AddLineIntercepts` and `PIT_AddThingIntercepts`
check for room before writing the slot:

```c
if (intercept_p == intercepts + MAXINTERCEPTS)
    return true;
```

All 128 slots are used, and an intercept found after the 128th is dropped. The
array is never written past its end. On a trace that really crosses more than
128 objects, the ones added last are lost, so distant objects act as if
transparent: a milder form of the vanilla effect. `tools/fuzz/crafted-maps.mjs`
(`intercepts-128`) pins the boundary with a door that is a shot's 128th
intercept.

The measured peak across the 13 golden demos is 45 (plutonia-demo3, MAP12;
§17), far below the limit. [divergence-atlas.md](divergence-atlas.md) F2
compares this with other ports.

### 5.2 P_PathTraverse

`P_PathTraverse` (p_maputl.c) walks the blockmap along a line:

1. Increments `validcount`.
2. If the start point lies exactly on a block boundary (relative to the
   blockmap origin), nudges it by `FRACUNIT` so it is not exactly on a line.
   The nudge is demo-visible.
3. Sets up `trace`, the divline from start to end.
4. Steps block to block with a DDA loop capped at 64 iterations, a guard
   against looping forever on round-off.
5. In each block, adds line intercepts if `PT_ADDLINES` and thing intercepts if
   `PT_ADDTHINGS`.
6. Calls `P_TraverseIntercepts` with the caller's traverser.

`P_TraverseIntercepts` (p_maputl.c) is a selection sort done lazily: each step
scans all accumulated intercepts for the smallest unprocessed `frac`, calls the
traverser, then stamps that intercept's `frac` with `MAXINT` to mark it done. It
stops at `maxfrac` or when the traverser returns false. The ascending order is
frozen (§16).

### 5.3 Users of P_PathTraverse

| caller | flags | purpose |
|--------|-------|---------|
| `P_SlideMove` | `PT_ADDLINES` | slide-wall detection (three rays per pass) |
| `P_LineAttack` | `PT_ADDLINES\|PT_ADDTHINGS` | hitscan (`PTR_ShootTraverse`) |
| `P_AimLineAttack` | `PT_ADDLINES\|PT_ADDTHINGS` | auto-aim (`PTR_AimTraverse`) |
| `P_UseLines` | `PT_ADDLINES` | USE activation (`PTR_UseTraverse`) |

`P_RadiusAttack` does not trace. It iterates the blockmap for things within
`damage + MAXRADIUS` and calls `PIT_RadiusAttack`, which checks
`P_CheckSight(thing, bombspot)` (the victim's eye, §6.3) and deals
`damage - distance`.

---

## 6. Line-of-sight

`P_CheckSight` (p_sight.c) uses a separate code path from `P_PathTraverse`. It
walks the BSP tree, not the blockmap.

### 6.1 REJECT table fast-out

The first check is the REJECT lump, a bit matrix with one bit per ordered
sector pair (`s1*numsectors + s2`). If the bit is set, the sectors cannot see
each other and the function returns false without walking the BSP. This skips
most monster-player checks in typical maps.

`sightcounts[0]` counts REJECT rejections and `sightcounts[1]` counts BSP
walks. Nothing reads them.

### 6.2 BSP walk — P_CrossBSPNode / P_CrossSubsector

`sightzstart` is the looker's eye: `t1->z + t1->height - (t1->height >> 2)`,
three quarters of the way up the mobj.

`topslope` and `bottomslope` start as the height differences from the eye to
the top and bottom of the target. `P_CrossSubsector` narrows them at every
two-sided line the trace crosses; once `topslope <= bottomslope`, sight is
blocked. A one-sided line, or a two-sided line with no opening, blocks at once.

`P_CrossBSPNode` recurses from the root node (`numnodes-1`). It decides sides
with p_sight.c's own `P_DivlineSide`, which returns 0 (front), 1 (back) or 2
(exactly on the line); "on" is treated as front. It crosses the start side
first and descends into the far side only if the target lies on it.

### 6.3 Asymmetry

`P_CheckSight(A, B)` is not in general equal to `P_CheckSight(B, A)`. The trace
runs from A's eye height to anywhere on B's full height, so A can see B in cases
where B, looking from its own eye, cannot see A. Monster AI calls
`P_CheckSight(actor, player->mo)`: the monster's eye looking at the player, with
no symmetric check. Explosions call it from the victim's side
(`P_CheckSight(thing, bombspot)`). Removing the asymmetry would desync demos.
[divergence-atlas.md](divergence-atlas.md) F6 has the port comparison.

### 6.4 P_InterceptVector2

`p_sight.c` has its own `P_InterceptVector2`, used by `P_CrossSubsector`. Its
body is the same fixed-point formula as `P_InterceptVector` in p_maputl.c (both
pre-shift by `>>8` to keep `FixedMul` in range). They are two copies of one
function. Both return 0 for parallel lines (`den == 0`) instead of dividing,
which is how zero-length lines avoid a division by zero
([divergence-atlas.md](divergence-atlas.md) F5b).

---

## 7. Z movement and gravity

### 7.1 P_ZMovement

`P_MobjThinker` calls `P_ZMovement` (p_mobj.c) after `P_XYMovement`, when the
mobj is off its floor or has vertical momentum:

1. **Step-up smoothing.** If a player's z is below its new `floorz` (it just
   stepped up), `viewheight` is lowered by the step and `deltaviewheight` set
   so `P_CalcHeight` raises the camera back over the next tics.
2. **Apply momz.** `mo->z += mo->momz`.
3. **Floaters** (§7.3) adjust z toward their target.
4. **Floor contact** (`mo->z <= mo->floorz`):
   - a charging lost soul has `momz` negated (§7.2);
   - if `momz` is negative: a player landing harder than `-GRAVITY*8` squats
     the view and plays `sfx_oof`; then `momz = 0`;
   - `mo->z = mo->floorz`;
   - a missile explodes (unless `MF_NOCLIP`).
5. **Gravity**, when not on the floor and not `MF_NOGRAVITY`: if `momz` is 0 it
   becomes `-GRAVITY*2`, otherwise `momz -= GRAVITY`. `GRAVITY = FRACUNIT`
   (p_local.h:53).
6. **Ceiling contact** (`mo->z + mo->height > mo->ceilingz`): upward `momz` is
   zeroed, z is clamped; a charging lost soul has `momz` negated; a missile
   explodes.

### 7.2 Lost soul bounce

A charging lost soul (`MF_SKULLFLY`) has `momz` negated at floor and ceiling
contact. The magnitude is unchanged: there is no damping.

At the floor, the negation runs before `momz` is zeroed, so the soul bounces.
This is linuxdoom-1.10's order, which matches the Ultimate Doom and Final Doom
executables. id's comment above it ("somebody left this after the setting momz
to 0") marks that the order once differed: Chocolate Doom and PrBoom+ record
that the Doom 1.9 and Doom II 1.9 executables zero first, so souls do not
bounce there, and select the behaviour by game version. webdoom always uses the
linuxdoom order.

### 7.3 Floater logic (Cacodemon, Pain Elemental and others)

An `MF_FLOAT` mobj with a target, not charging and not `MF_INFLOAT`, compares
its height with the target's. With `delta = target->z + (mo->height>>1) - mo->z`
(note: the floater's own half-height, not the target's) and `dist` the 2D
`P_AproxDistance`, it moves `FLOATSPEED` (4 units, p_local.h:30) down when
`delta < 0 && dist < -3*delta`, or up when `delta > 0 && dist < 3*delta`.

`P_Move` (p_enemy.c) handles floaters blocked horizontally: if `floatok` (the
gap was tall enough) it moves the floater `FLOATSPEED` toward `tmfloorz`, sets
`MF_INFLOAT` and reports success. A successful horizontal move clears
`MF_INFLOAT`.

### 7.4 Mobj spawn and the mobj thinker

`P_SpawnMobj` (p_mobj.c) allocates from the zone (`PU_LEVEL`), zeroes the
whole struct, fills it from `mobjinfo[type]`, sets the initial state, links it
with `P_SetThingPosition` and adds the thinker. It also sets
`lastlook = P_Random() % MAXPLAYERS`, so every spawn consumes one random number:
this is demo-visible.

`oldx/oldy/oldz/oldangle` (webdoom fields for render interpolation) are snapped
to the spawn position. `P_MobjThinker` copies the current position into them at
the start of every tic; nothing in the sim reads them.

`P_MobjThinker` then runs `P_XYMovement` and `P_ZMovement` as needed, and
advances the state: when `tics` reaches 0 it calls `P_SetMobjState` on the next
state, which may chain through zero-tic states and run their action functions
in the same tic.

### 7.5 Nightmare respawn

A mobj whose state has `tics == -1` (a corpse in its final frame) is checked
for respawn in `P_MobjThinker`. It respawns only if all of these hold:

- `MF_COUNTKILL` (a killable monster);
- `respawnmonsters` (Nightmare, or `-respawn`);
- `++movecount >= 12*35` (420 tics after reaching the final frame);
- `(leveltime & 31) == 0` (a 32-tic boundary);
- `P_Random() <= 4` (the call returns early when it is `> 4`).

`P_NightmareRespawn` then checks the spawn point with `P_CheckPosition` and
gives up if it is blocked. Otherwise it spawns teleport fog at the corpse and at
the spawn point, spawns a fresh mobj of the same type there and removes the
corpse. The `P_Random()` gate runs every 32 tics for every qualifying corpse,
so it is demo-visible.

---

## 8. Enemy AI

### 8.1 A_Look — waking up

`A_Look` (p_enemy.c) runs each tic of a monster's idle state:

1. Clears `threshold`, so any shot can wake it.
2. If the sector has a `soundtarget` that is shootable, takes it as target. An
   `MF_AMBUSH` monster also needs `P_CheckSight` to it.
3. Otherwise calls `P_LookForPlayers(actor, false)`: players in front, or
   behind within `MELEERANGE`.
4. On finding a target, plays the see sound and enters `seestate`. For the
   former-human and imp families the sound is picked with `P_Random()`
   (`sfx_posit1 + P_Random()%3`, `sfx_bgsit1 + P_Random()%2`), so it is
   demo-visible.

Sound reaches `soundtarget` through `P_NoiseAlert` and `P_RecursiveSound`, a
flood fill across two-sided lines that stops at the second `ML_SOUNDBLOCK` line.

`P_LookForPlayers` starts from `actor->lastlook` and cycles through the player
slots, skipping absent and dead players and those out of sight. It examines at
most two in-game players per call (the `c++ == 2` test) before giving up, so a
monster never runs sight checks against all four players in one tic.

### 8.2 A_Chase — the chase state

`A_Chase` (p_enemy.c):

1. Decrements `reactiontime` if nonzero.
2. Decrements `threshold`, or clears it if the target is gone or dead.
3. Turns 45 degrees per tic toward `movedir`.
4. With no shootable target: looks for one (all around); if none, returns to
   the spawn state.
5. If `MF_JUSTATTACKED`: clears it and, unless Nightmare or `-fast`, picks a new
   direction and returns. A monster never attacks two tics in a row.
6. Melee: if it has a `meleestate` and `P_CheckMeleeRange` passes, attacks.
7. Missile: if it has a `missilestate`, below Nightmare and without `-fast` it
   waits for `movecount` to run out; then `P_CheckMissileRange` decides, and a
   missile attack sets `MF_JUSTATTACKED`.
8. In a netgame, with `threshold` 0 and the target out of sight, may switch
   targets.
9. Moves: if `--movecount < 0` or `P_Move` fails, calls `P_NewChaseDir`.
10. Active sound when `P_Random() < 3`: demo-visible.

`A_FaceTarget` turns a monster to its target. Against an `MF_SHADOW` target
(partial invisibility) it adds `(P_Random()-P_Random())<<21` of error.

### 8.3 P_NewChaseDir — choosing a direction

`P_NewChaseDir` (p_enemy.c):

1. Works out the desired x and y directions (east/west, north/south), each
   `DI_NODIR` when the target is within 10 units on that axis.
2. If both are set, tries the diagonal, unless it is the reverse of the current
   direction.
3. Swaps the two axes if `P_Random() > 200` or `|deltay| > |deltax|`. The random
   call always happens: demo-visible.
4. Tries the first axis, then the second, skipping the reverse direction.
5. Tries the previous direction.
6. Sweeps all eight directions, east to south-east or the reverse, chosen by
   `P_Random() & 1` (Q10), skipping the reverse direction.
7. Tries the reverse direction.
8. Gives up with `movedir = DI_NODIR`.

Each attempt goes through `P_TryWalk`, which calls `P_Move` and on success sets
`movecount = P_Random() & 15`.

Speed tables (p_enemy.c:264–265):

```c
fixed_t xspeed[8] = {FRACUNIT,47000,0,-47000,-FRACUNIT,-47000,0,47000};
fixed_t yspeed[8] = {0,47000,FRACUNIT,47000,0,-47000,-FRACUNIT,-47000};
```

47000 is about `0.7172 * FRACUNIT`, an integer approximation of `1/sqrt(2)`
(0.7071). The error is locked in by every demo.

### 8.4 Doors monsters fail to open

When `P_TryMove` fails, `P_Move` (p_enemy.c) tries to open its way through: it
calls `P_UseSpecialLine` for every line in `spechit[]` and reports success if
any of them activated. `spechit[]` only holds what `P_CheckPosition` collected
before it stopped, and it stops at the first blocking thing or line. Things are
checked before lines, and within the line pass the blockmap order decides which
line comes first. A monster approaching a door at an angle often touches a
solid door-track wall or jamb before the door line is visited, so the door
never enters `spechit[]` and the monster stands blocked. This is vanilla
behaviour (Q7).

### 8.5 A_BossDeath — boss triggers

`A_BossDeath` (p_enemy.c) runs from a boss's death state. It does nothing
unless the map and type match a row below and at least one player is alive.
It then scans the whole thinker list; if any other mobj of the same type is
still alive, it returns. Otherwise:

| game | map | type | effect |
|------|-----|------|--------|
| Doom | E1M8 | `MT_BRUISER` (Baron) | floor tag 666 lowers to lowest |
| Doom | E2M8 | `MT_CYBORG` | exit level |
| Doom | E3M8 | `MT_SPIDER` | exit level |
| Doom | E4M6 | `MT_CYBORG` | door tag 666 blaze-opens |
| Doom | E4M8 | `MT_SPIDER` | floor tag 666 lowers to lowest |
| Doom | episode > 4, map 8 | any caller | exit level |
| Doom II | MAP07 | `MT_FATSO` (Mancubus) | floor tag 666 lowers to lowest |
| Doom II | MAP07 | `MT_BABY` (Arachnotron) | floor tag 667 raises to texture |

The scan is O(number of thinkers) and runs once per boss death.

### 8.6 Doom II monsters

The Arch-vile (`A_VileChase`, `A_VileAttack`), Pain Elemental (`A_PainAttack`,
`A_PainDie`), Revenant (`A_Tracer`), Mancubus (`A_FatAttack1..3`) and the boss
brain (`A_BrainSpit`) are Doom II only. Their action functions call
`P_SpawnMobj`, `P_RadiusAttack` and `P_Random` in fixed sequences; any change
desyncs Doom II demos. Nine of the 13 golden demos (doom2, tnt, plutonia) play
commercial IWADs, so this code is inside the gated corpus.

---

## 9. Interactions

### 9.1 P_DamageMobj — the damage pipeline

`P_DamageMobj` (p_inter.c):

1. Returns if the target is not `MF_SHOOTABLE` or already dead.
2. A charging lost soul that takes damage stops dead (all momentum zeroed).
3. A player on `sk_baby` takes half damage.
4. Knockback, unless the source is a player holding the chainsaw:
   `thrust = damage * (FRACUNIT>>3) * 100 / mass`, away from the inflictor. If
   the hit is a killing blow under 40 damage, the target is more than 64 units
   above the inflictor, and `P_Random() & 1`, the direction is reversed and the
   thrust quadrupled ("fall forwards"). The random call is short-circuited
   unless the first three conditions hold.
5. For players: on sector special 11 (the E1M8 exit) damage is capped so it
   cannot kill; under 1000 damage, god mode or invulnerability ignores it;
   armour absorbs `damage/3` (green, type 1) or `damage/2` (blue, type 2) until
   it runs out; `player->health` is reduced (floored at 0); `damagecount`
   grows, capped at 100.
6. `target->health -= damage`. At 0 or below, `P_KillMobj` and return.
7. Pain: `P_Random() < painchance` (always evaluated, so always one random
   number) and not a charging lost soul sets `MF_JUSTHIT` and the pain state.
   Demo-visible.
8. `reactiontime = 0`: the monster is awake.
9. If `threshold` is 0 (or the target is an Arch-vile), and the source exists,
   is not the target and is not an Arch-vile: the target switches to the source
   with `threshold = BASETHRESHOLD` and, if idle, enters its see state.

### 9.2 Health caps

`MAXHEALTH = 100` (p_local.h:33). `P_GiveBody` (p_inter.c) refuses when health
is already at 100 and otherwise adds and clamps to 100. The stimpack (10), the
medikit (25) and berserk (100, through `P_GivePower`) all use it, so none heals
past 100.

Three pickups bypass it in `P_TouchSpecialThing`: the health bonus adds 1 up to
200, the soulsphere adds 100 up to 200, and the megasphere sets 200. Health is
sim state and part of the per-tic gamestate hash.

### 9.3 P_TouchSpecialThing — item pickup

`P_TouchSpecialThing` (p_inter.c) runs when an `MF_PICKUP` thing (a player)
touches an `MF_SPECIAL` thing. It ignores the touch if the special is out of
vertical reach or the toucher is dead, then dispatches on the special's sprite.
On a pickup it counts the item if `MF_COUNTITEM`, removes the special,
adds `BONUSADD` (6, p_inter.c:51) to `bonuscount` (the gold palette flash) and
plays the sound. `P_GiveAmmo`, `P_GiveWeapon`, `P_GiveArmor`, `P_GiveCard` and
`P_GivePower` do the work.

---

## 10. Sector specials

### 10.1 P_UpdateSpecials — animation and timers

`P_UpdateSpecials` (p_spec.c) runs each tic. It:

- counts down the deathmatch `-timer` level timer;
- animates flats and textures. A frame is `basepic + (leveltime/speed + i) %
  numpics`, a function of `leveltime` with no state of its own;
- scrolls every line with special 48 by one unit of texture offset;
- counts down `buttonlist[]` timers and restores switch textures when they
  expire.

It makes no `P_Random` calls.

### 10.2 P_SpawnSpecials — sector thinkers

`P_SpawnSpecials` (p_spec.c) runs at the end of `P_SetupLevel`, after things
are spawned. It spawns a thinker per sector special:

| special | thinker | description |
|---------|---------|-------------|
| 1 | `T_LightFlash` | random flicker |
| 2 | `T_StrobeFlash` (`FASTDARK`) | fast strobe |
| 3 | `T_StrobeFlash` (`SLOWDARK`) | slow strobe |
| 4 | `T_StrobeFlash` (`FASTDARK`) | fast strobe; the special stays 4 for the damage floor |
| 8 | `T_Glow` | glowing light |
| 9 | none | secret; counted into `totalsecret` |
| 10 | `T_VerticalDoor` | door closes after 30 s |
| 12 | `T_StrobeFlash` (`SLOWDARK`, in sync) | synchronised slow strobe |
| 13 | `T_StrobeFlash` (`FASTDARK`, in sync) | synchronised fast strobe |
| 14 | `T_VerticalDoor` | door opens after 5 min |
| 17 | `T_FireFlicker` | fire flicker |

The damage specials (5, 7, 16, 4, 11) spawn nothing; `P_PlayerInSpecialSector`
applies their damage every 32 tics while a player stands in them. Special 4 and
16 hurt even with the radiation suit when `P_Random() < 5`.

**Light constants** (p_spec.h:176–179):

```
GLOWSPEED    = 8    light units per tic for glow
STROBEBRIGHT = 5    tics at full brightness
FASTDARK     = 15   tics dark, fast strobe
SLOWDARK     = 35   tics dark, slow strobe
```

- **Strobes** are bright for 5 tics and dark for 15 or 35. An unsynchronised
  strobe starts its count at `(P_Random()&7)+1`; a synchronised one at 1, so
  all of them change on the same tic.
- **Light flash** (special 1) picks each bright and dark period with
  `P_Random()`.
- **Glow** oscillates between the darkest neighbouring light level and the
  sector's own, 8 units per tic.
- **Fire flicker** acts every 4 tics: it drops the level by
  `(P_Random()&3)*16` from the maximum, floored at the minimum.

Spawning strobes and flashes consumes random numbers at map load, in sector
order, before the first tic. All of it is demo-visible.
[engine-archaeology.md](engine-archaeology.md) §11 covers where these constants
come from.

### 10.3 Linedef specials

`P_CrossSpecialLine` and `P_ShootSpecialLine` (p_spec.c) and
`P_UseSpecialLine` (p_switch.c) dispatch on `ld->special` to the `EV_*`
functions, which may spawn floor, ceiling, door, platform or light thinkers.

**The donut** (line special 9, `EV_DoDonut`, p_spec.c). For each tagged sector
`s1` (the hole), `s2` is the sector across `s1->lines[0]` (the ring) and `s3` a
sector across one of the ring's lines (the outside). It spawns two floor movers
in the same tic: the ring rises to `s3`'s floor height and takes `s3`'s floor
texture, and the hole lowers to the same height. The test meant to skip
one-sided ring lines is written `(!s2->lines[i]->flags & ML_TWOSIDED)`, which
by C precedence is always 0, so it never skips. On a malformed map `s2` or `s3`
can be NULL and vanilla crashes. webdoom skips the sector in either case, as
PrBoom does (§19).

### 10.4 Doors — p_doors.c

`T_VerticalDoor` moves a door sector between open and closed. Speed and wait
time come from the linedef special. The door sounds (`sfx_doropn`,
`sfx_dorcls`, `sfx_bdopn`, `sfx_bdcls`) start at state changes. A closing door
that hits a thing reopens. The sliding-door code in p_doors.c is inside
`#if 0` and not compiled.

### 10.5 Platforms — p_plats.c

`T_PlatRaise` runs lifts, perpetual platforms and raise-and-change platforms.
A perpetual platform starts in a random direction (`plat->status =
P_Random()&1` in `EV_DoPlat`): demo-visible. Active platforms are tracked in
`activeplats[MAXPLATS]` (30); `P_AddActivePlat` calls `I_Error` when it is full.

### 10.6 Ceilings and crushing — p_ceilng.c, p_map.c

`T_MoveCeiling` moves ceilings and crushers through `T_MovePlane`. It makes no
`P_Random` calls itself. Crushing happens in `P_ChangeSector` (p_map.c), which
every mover calls: `PIT_ChangeSector` re-clips each thing in the sector's
blockmap area; a thing that no longer fits takes 10 damage every fourth tic
(`!(leveltime&3)`) while crushing, and each hit spawns blood with
`(P_Random()-P_Random())<<12` momentum. Demo-visible.

### 10.7 Floors — p_floor.c

`T_MoveFloor` drives floor movers through `T_MovePlane`. `EV_BuildStairs`
finds each next step by scanning the current step sector's lines for a
two-sided line whose front sector is the current one and whose back sector has
the same floor texture. That makes stair building depend on linedef order and
direction in the map.

### 10.8 Teleportation — p_telept.c

`EV_Teleport`:

1. Missiles do not teleport.
2. Crossing from the back (side 1) does nothing, so a thing can walk off a
   teleporter pad.
3. For each sector with the line's tag, scans the thinker list for an
   `MT_TELEPORTMAN` in that sector.
4. Calls `P_TeleportMove` (p_map.c). It sets `floorz`/`ceilingz` from the
   destination subsector's sector alone (no line contacts), and telefrags with
   `PIT_StompThing`: 10000 damage to every shootable thing overlapping the
   destination. Only players telefrag, except on MAP30; a monster blocked by a
   thing does not teleport.
5. Sets `thing->z = thing->floorz` (Q5). id's comment asks "fixme: not
   needed?", but it is needed: `P_TeleportMove` sets `floorz`, not `z`, so
   without this line the thing would keep its source height.
6. Spawns teleport fog at the source and 20 units in front of the destination,
   freezes a player for 18 tics (`reactiontime`), copies the destination angle
   and zeroes all momentum.

webdoom then snaps `oldx/oldy/oldz/oldangle` to the new position so the
renderer draws no streak across the teleport. That is render-only.

---

## 11. Weapons and psprites

### 11.1 The psprite state machine

`P_SetPsprite` (p_pspr.c) drives weapon states as `P_SetMobjState` drives
things. It chains through zero-tic states in the same tic and calls each
state's `action.acp2(player, psp)`.

A player has `psprites[NUMPSPRITES]` with `NUMPSPRITES = 2`: `ps_weapon` and
`ps_flash` (the muzzle flash).

### 11.2 Weapon lifecycle

`P_BringUpWeapon` starts the new weapon at `WEAPONBOTTOM` (128 units,
p_pspr.c:47) in its up state. webdoom also sets `oldsy = WEAPONBOTTOM`, so the
interpolated raise has no streak.

`P_MovePsprites` runs once per player tic from `P_PlayerThink` (and from
`P_DeathThink`'s path). It decrements each psprite's `tics` and calls
`P_SetPsprite` when one expires.

`A_WeaponReady` fires on the attack button, starts a pending weapon change
(through the lower state), and sways the weapon from `player->bob`. `A_Lower`
and `A_Raise` move the sprite 6 units per tic; `A_Lower` switches
`readyweapon` to `pendingweapon` at the bottom and calls `P_BringUpWeapon`.

### 11.3 Refire and ammo

`A_ReFire` stays in the firing sequence while the attack button is held, the
weapon is not being changed and the player is alive; otherwise it checks ammo
and returns to ready. `P_CheckAmmo` (p_pspr.c) picks the best available weapon
when the current one is out of ammo and starts lowering the current one. The
BFG needs `BFGCELLS` (40, p_pspr.c:52).

### 11.4 Switch timing

A weapon switch completes on the tic `A_Lower` reaches the bottom, which
depends on where in its animation the old weapon was when `pendingweapon` was
set. `P_CheckAmmo` can start a lowering from inside an attack action. The tic
of a switch decides when the next weapon's firing actions, and their
`P_Random` calls, begin, so switch timing is demo-visible.

---

## 12. Map setup

### 12.1 Lump loading order

`P_SetupLevel` (p_setup.c) loads a map in this order:

```
P_LoadBlockMap → P_LoadVertexes → P_LoadSectors → P_LoadSideDefs
→ P_LoadLineDefs → P_LoadSubsectors → P_LoadNodes → P_LoadSegs
→ rejectmatrix = W_CacheLumpNum(ML_REJECT)
→ P_GroupLines
→ (webdoom) zero playerstarts[]
→ P_LoadThings
→ deathmatch: G_DeathMatchSpawnPlayer for each player
  otherwise:  (webdoom) I_Error if an in-game player has no start
→ P_SpawnSpecials
```

Each loader sizes its array as `W_LumpLength / sizeof(struct)`. Apart from the
guards below, nothing checks indices against the other lumps: the map data is
trusted.

### 12.2 Per-lump validation

| lump | what is read | checked? |
|------|--------------|----------|
| VERTEXES | `SHORT(x) << FRACBITS` | count from lump size; no upper bound |
| LINEDEFS | vertex indices | not checked against `numvertexes` |
| LINEDEFS | `sidenum[0]`, `sidenum[1]` | **checked** against `numsides` (webdoom) |
| SIDEDEFS | sector index | **checked** against `numsectors` (webdoom) |
| SEGS | linedef, side and vertex indices | not checked |
| NODES | bounding boxes, child indices | not checked; a bad child walks off the array |
| SSECTORS | `firstseg + numsegs` | not checked against `numsegs` |
| THINGS | count from lump size | no cap; spawns however many there are |
| BLOCKMAP | header counts and 16-bit offsets | trusted; a bad offset reads outside the lump |
| REJECT | bit `s1*numsectors + s2` | lump size not checked; a short REJECT reads past it |

webdoom's guards turn the two most dangerous of these into a clear error
instead of a heap overflow:

- `P_LoadSideDefs`: `I_Error("P_LoadSideDefs: sidedef N references
  out-of-range sector M (0..K)")`.
- `P_LoadLineDefs`: the same pattern for an out-of-range front or back
  `sidenum`.

A third guard covers a missing player start. `P_SetupLevel` zeroes
`playerstarts[]` before `P_LoadThings`, so a start from the previous map cannot
mask a missing one. In a non-deathmatch game it then checks every in-game
player: `I_Error("no player N start in MAPNAME")` fires before `P_PlayerThink`
could dereference a NULL `players[i].mo`.

The `adversarial-map` leg runs 30 adversarial maps natively under ASan/UBSan
and requires every one to end cleanly or in `I_Error`, with zero sanitizer
reports (`node tools/fuzz/run-map-fuzz.mjs --adversarial-gate`).
[divergence-atlas.md](divergence-atlas.md) F5c covers the blockmap-offset case.

### 12.3 The things filter

`P_LoadThings` (p_setup.c) refuses Doom II-only monster types (Arachnotron,
Arch-vile, the boss brain and shooter, Hell Knight, Mancubus, Pain Elemental,
Chaingunner, Revenant, Wolfenstein SS) when not in commercial mode. After the
`switch` it does `if (spawn == false) break;`, which leaves the *loop*, not just
the switch: the first such thing and every thing after it in the lump are not
spawned (Q8). The type is compared before the `SHORT()` byte swap.

`P_SpawnMapThing` stores up to `MAX_DEATHMATCH_STARTS` (10, p_setup.c:109)
deathmatch starts and ignores the rest.

---

## 13. Save / load

### 13.1 Save buffer

`G_DoSaveGame` mallocs the buffer before writing anything. Its size is the
50-byte header plus `P_ArchiveSize()` (p_saveg.c), an upper bound computed
from the current level. The bound counts every player slot, 14 bytes per
sector, 6 per linedef plus 10 per sidedef, and for every thinker a class byte,
3 bytes of padding and `sizeof(mobj_t)`, the largest archived struct (a
`_Static_assert` keeps it so). The buffer is freed after `M_WriteFile`.

Vanilla built the save at `screens[1] + 0x4000`, which leaves 175,616 bytes
before the end of `V_Init`'s screen block, and checked nothing first. The
biggest library levels need more at their start: Black Tower MAP25, NRFTL
MAP05 and SIGIL E5M7 save at 176–197 KB on Ultra-Violence. `save-compat` saves
and reloads all three through the menu. Loading is checked the same way; see
[formats.md](formats.md) §5.3.

### 13.2 Archive format

`G_DoSaveGame` (g_game.c) writes:

1. The description (`SAVESTRINGSIZE`, 24 bytes).
2. The version string `"webdm2 110"` (`VERSIONSIZE`, 16 bytes). Vanilla wrote
   `"version 110"`; webdoom's player and mobj structs carry extra fields, so its
   saves are a different format and `G_DoLoadGame` silently ignores a file with
   any other tag.
3. Skill, episode, map, the four `playeringame` bytes, and `leveltime` in
   three bytes.
4. `P_ArchivePlayers`: each in-game `player_t`, 4-byte aligned, with psprite
   state pointers stored as `state - states`.
5. `P_ArchiveWorld`: per sector, floor and ceiling heights, flat numbers, light,
   special and tag; per line, flags, special and tag; per side, texture offsets
   and texture numbers. Written through a `short*`.
6. `P_ArchiveThinkers`: every `P_MobjThinker` thinker as a raw `mobj_t`,
   tagged `tc_mobj`, then `tc_end`.
7. `P_ArchiveSpecials`: ceiling, door, floor, platform, light-flash, strobe and
   glow thinkers, each with a type byte, then `tc_endspecials`. A ceiling or
   platform in stasis (in its active list with a NULL function) is saved too.
8. The `0x1d` consistency marker.

Neither random index is saved. Loading calls `G_InitNew`, which resets both to
0 (§2.1), as vanilla does.

Fire-flicker thinkers (`T_FireFlicker`, special 17) are not archived.
`P_UnArchiveThinkers` removes every thinker the fresh level spawned before
restoring the saved ones, so a loaded game has no fire flicker in those
sectors. This is vanilla behaviour.

The `save-compat` leg loads savegames written by an earlier build and requires
them to replay identically.

### 13.3 Pointer serialisation

On save (`P_ArchiveThinkers`):

- `mobj->state` becomes `state - states`;
- `mobj->player` becomes `(player - players) + 1` (0 means none).

On load (`P_UnArchiveThinkers`):

- `mobj->state = &states[index]`;
- `mobj->player = &players[index - 1]` if nonzero, and the player's `mo` is
  pointed back at the mobj;
- `mobj->target = NULL`: monsters forget their targets and re-acquire them by
  looking again;
- `info`, `floorz` and `ceilingz` are recomputed, the thing is relinked with
  `P_SetThingPosition`, and (webdoom) `old*` is snapped to the position so a
  loaded game shows no interpolation streak.

`mobj->tracer` is not cleared. A Revenant's homing missile saved in flight
restores with a stale pointer, a vanilla defect kept as is.

### 13.4 What breaks saves

- Any change to `sizeof(player_t)` or `sizeof(mobj_t)`, or to field order,
  since both are copied raw.
- A new thinker type that `P_ArchiveSpecials`/`P_UnArchiveSpecials` do not know
  is silently not saved.
- Raw pointers (`snext`, `target`, ...) are stored and discarded on load, so a
  layout change alters a save's bytes without changing what it means.
  `save-compat` therefore compares what a save loads to, not its bytes.

---

## 14. Player

### 14.1 P_PlayerThink

`P_PlayerThink` (p_user.c) runs once per tic per in-game player:

1. Applies the `CF_NOCLIP` cheat to the mobj flags.
2. With `MF_JUSTATTACKED` (set by the chainsaw), replaces the command with a
   pure forward move.
3. If dead, runs `P_DeathThink` and returns.
4. Counts down `reactiontime` (the freeze after teleporting); otherwise calls
   `P_MovePlayer`.
5. `P_CalcHeight` (view height, bob, `viewz`).
6. Sector specials under the player (`P_PlayerInSpecialSector`).
7. Weapon change from the ticcmd, then the use button (`P_UseLines`, once per
   press), then `P_MovePsprites`.
8. Power-up timers, `damagecount`/`bonuscount` decay and `fixedcolormap`.

### 14.2 P_MovePlayer

`P_MovePlayer` (p_user.c):

- adds `cmd->angleturn << 16` to the mobj angle;
- sets `onground = (mo->z <= mo->floorz)`;
- if `onground`, thrusts `forwardmove*2048` along the angle and
  `sidemove*2048` at the angle minus 90 degrees (`P_Thrust`);
- switches a standing player into the run animation when there is movement.

The `onground` gate means a player cannot accelerate or strafe in the air;
momentum carried from the last tic on the ground continues. It is vanilla and
frozen (§16).

The ticcmd speeds come from tables in g_game.c (lines 175–177), indexed by the
run key:

| table | values (walk, run) | note |
|-------|--------------------|------|
| `forwardmove` | `{0x19, 0x32}` = `{25, 50}` | forward and back |
| `sidemove` | `{0x18, 0x28}` = `{24, 40}` | strafing is slower than moving forward |
| `angleturn` | `{640, 1280, 320}` | the third value is the slow turn, used while a turn key has been held for fewer than `SLOWTURNTICS` (6) tics |

`G_BuildTiccmd` uses them to build every live ticcmd, so they shape every
recorded demo. Playback reads the stored bytes and never consults them.

### 14.3 View bob

`P_CalcHeight` (p_user.c):

```c
player->bob = FixedMul(momx, momx) + FixedMul(momy, momy);
player->bob >>= 2;
if (player->bob > MAXBOB) player->bob = MAXBOB;   // MAXBOB = 0x100000, 16 units
```

The bob phase is `(FINEANGLES/20 * leveltime) & FINEMASK`, and the view offset
is `FixedMul(bob/2, finesine[phase])`, at most ±8 units. In the air or with
`CF_NOMOMENTUM` there is no bob. `P_CalcHeight` also moves `viewheight` back
toward `VIEWHEIGHT` after a step or a landing, and keeps `viewz` 4 units under
the ceiling.

`bob` and `viewz` are computed from sim state, but nothing in the sim reads
them: they feed the view and the weapon sway in `A_WeaponReady`. webdoom saves
`oldviewz` here for interpolation.

### 14.4 Step height

The step limit is 24 units for every thing, players included: `P_TryMove`
refuses a move when `tmfloorz - thing->z > 24*FRACUNIT` (§4.3). `P_ZMovement`'s
step-up smoothing (§7.1) only moves the camera: the player's z snaps up at once,
`viewheight` drops by the step height, and `P_CalcHeight` raises it back over
the following tics. It does not raise the limit.

### 14.5 Deathmatch spawns

`G_DeathMatchSpawnPlayer` (g_game.c) needs at least 4 deathmatch starts
(otherwise `I_Error`). It tries up to 20 times to pick
`P_Random() % selections` and spawns at the first spot `G_CheckSpot` accepts;
each try consumes a random number, so it is demo-visible. If all 20 fail it
falls back to the player's coop start. `P_SetupLevel` calls it for every player
at level start in deathmatch, and `G_DoReborn` on each respawn.

---

## 15. Quirk catalog

Each entry gives what the quirk is, where it lives, the demo evidence, and
webdoom's status. The F-numbers point to the matching family in
[divergence-atlas.md](divergence-atlas.md), which compares ports.

### Q1 — spechit[] overflow (vanilla: overrun; webdoom: clamp at 64)

**What**: A move that contacts more than 8 special lines makes vanilla write
past `spechit[8]` into adjacent globals, often `numspechit` itself, causing
spurious or missed line triggers.

**Where**: `MAXSPECIALCROSS` in p_local.h; the guard in `PIT_CheckLine`
(p_map.c). §4.4.

**Demo evidence**: The measured peak across the 13 golden demos is 8 (§17), so
no golden demo reaches the vanilla overrun. Other ports' trackers report it in
dense custom maps.

**webdoom status**: Limit 64, write guarded. The vanilla overrun is not
reproduced; this is a deliberate safety change with no effect on the corpus.
Family F1.

### Q2 — intercepts[] overflow (vanilla: overrun; webdoom: clamp at 127)

**What**: A trace crossing more than 128 lines and things makes vanilla write
past `intercepts[128]`. The "all-ghosts" family of shots passing through
monsters is attributed to this.

**Where**: the guards in `PIT_AddLineIntercepts` and `PIT_AddThingIntercepts`
(p_maputl.c). §5.1.

**Demo evidence**: The measured peak across the 13 golden demos is 45 (§17).
Very long autoaim traces through crowded areas can reach the limit in vanilla.

**webdoom status**: Clamped; the last slot is reused rather than writing past
the array. Family F2.

### Q3 — Blockmap edge and the MAXRADIUS asymmetry

**What**: `P_BlockLinesIterator` returns true (nothing to collide with) for any
block outside `[0, bmapwidth) × [0, bmapheight)`, so things and traces at the
map boundary can miss lines in the outermost blocks. Separately, the thing pass
of `P_CheckPosition` is widened by `MAXRADIUS` and the line pass is not.

**Where**: the bounds return at the top of `P_BlockLinesIterator` (and
`P_BlockThingsIterator`), p_maputl.c; the block ranges in `P_CheckPosition`,
p_map.c. §3.2.

**Demo evidence**: No golden demo map has geometry at the blockmap edge. The
behaviour is plain in the source: an out-of-range cell returns success and
iterates nothing. Blockmap overflow on very large maps, where coordinates wrap,
is a related but separate problem.

**webdoom status**: Vanilla behaviour kept exactly. Family F5.

### Q4 — Wallrunning

**What**: A player moving along a wall can gain speed and slip past geometry
because `P_SlideMove` traces only three corners of the bounding box and falls
back to `stairstep`, which tries the y move and the x move separately.

**Where**: `P_SlideMove` (p_map.c), the `stairstep` label in particular. §4.5.

**Demo evidence**: Wallrunning is a documented speedrunning technique (for
example along the E1M3 stairs in UV-speed demos). Any change to the three-ray
traces, the pass limit or the stairstep order would desync such demos.

**webdoom status**: Vanilla behaviour kept exactly. Family F4.

### Q5 — Teleport z snap

**What**: `EV_Teleport` always sets `thing->z = thing->floorz` after the move,
so a thing teleported in mid-air lands on the destination floor at once.

**Where**: `EV_Teleport` (p_telept.c), right after `P_TeleportMove`. §10.8.

**Demo evidence**: `EV_Teleport` succeeds in 4 of the 13 golden demos, 32 times
in total (§17):

| demo | map | teleports |
|------|-----|-----------|
| doom-demo3 | E3M5 | 3 |
| doom2-demo3 | MAP26 | 5 |
| plutonia-demo1 | MAP17 | 23 |
| plutonia-demo3 | MAP12 | 1 |

doom-demo1 (E1M5, 1710 tics) and doom-demo4 (E4M2, 818 tics) teleport zero
times. Every one of the 32 teleports runs the z snap, and `sim-goldens` hashes
every tic of those demos, so a change to the snap or the code around it would
desync them.

**webdoom status**: Vanilla behaviour kept, including id's `// fixme: not
needed?` comment.

### Q6 — P_CheckSight asymmetry

**What**: `P_CheckSight(A, B)` traces from A's eye (three quarters of A's
height) to anywhere on B's height; `P_CheckSight(B, A)` can give a different
answer. Monster AI calls `P_CheckSight(actor, player->mo)` with no symmetric
check.

**Where**: the `sightzstart` assignment in `P_CheckSight` (p_sight.c). §6.3.

**Demo evidence**: Every demo with monsters depends on it: a target seen or
missed changes the `P_Random` call sequence. Any change to the eye-height
formula desyncs them.

**webdoom status**: Vanilla behaviour kept exactly; asserted under
`-DWEBDOOM_INVARIANTS` (§16.1). Family F6.

### Q7 — Monsters failing to open doors

**What**: A blocked monster opens doors only through lines already in
`spechit[]`. `P_CheckPosition` stops at the first blocking thing or line, so a
door line visited after a blocking wall is never collected, and the monster
stays blocked.

**Where**: `P_Move` (p_enemy.c) and `P_CheckPosition` / `PIT_CheckLine`
(p_map.c). §8.4.

**Demo evidence**: Widely observed in play: monsters "ignore" doors at some
angles. The golden demos do not depend on a monster opening a particular door.

**webdoom status**: Vanilla behaviour kept.

### Q8 — P_LoadThings stops at the first Doom II-only thing

**What**: Outside commercial mode, `P_LoadThings` leaves the whole thing loop at
the first Doom II-only type, so that thing and every later thing in the lump
are not spawned.

**Where**: the `if (spawn == false) break;` after the type switch in
`P_LoadThings` (p_setup.c). §12.3.

**Demo evidence**: Never triggered by the corpus. The nine commercial demos run
in commercial mode, where the filter is off, and the four Doom demos' maps
contain no Doom II-only types.

**webdoom status**: Vanilla behaviour kept.

### Q9 — The random index is not stored in a demo

**What**: A demo stores ticcmds only. `prndindex` is reproduced implicitly by
starting at 0 and replaying the same sequence of `P_Random` calls. `rndindex`
is not stored either; it differs between runs with different presentation but
never touches gameplay.

**Where**: `G_ReadDemoTiccmd` / `G_WriteDemoTiccmd` (g_game.c); `M_ClearRandom`
from `G_InitNew`. §1.4, §2.1.

**Demo evidence**: A property of the format; all 13 demos depend on it.

**webdoom status**: Vanilla behaviour kept. Savegames do not store either
index (§13.2).

### Q10 — P_NewChaseDir's random sweep direction

**What**: When the direct, axis and previous directions all fail,
`P_NewChaseDir` sweeps all eight directions clockwise or anticlockwise, chosen
by `P_Random() & 1`. That bit decides which way a cornered monster turns, and
the sweep tries each direction through `P_TryWalk` in order.

**Where**: the `if (P_Random()&1)` sweep in `P_NewChaseDir` (p_enemy.c). §8.3.

**Demo evidence**: Any change alters monster paths in every demo where a monster
is blocked, which is all of them.

**webdoom status**: Vanilla behaviour kept.

---

## 16. The frozen surface

The frozen surface is the set of sim behaviours that demos can see. Changing
any of them desyncs existing demos. The sim is the source of truth; the
renderer is free.

### What is frozen

| behaviour | why |
|---------|-----|
| `P_Random()` call sequence | Demos contain no seed; determinism is the call order |
| `rndtable[256]` contents | The table is the seed; [engine-archaeology.md](engine-archaeology.md) §3 |
| `prndindex` starts at 0 (`M_ClearRandom`) | Demos start from index 0 |
| Thinker list insertion order | `P_RunThinkers` runs thinkers in insertion order; reordering changes which acts first |
| Thinker list traversal direction (head to tail) | Fixed by the walk in `P_RunThinkers` |
| `P_BlockLinesIterator` iteration order (x outer, y inner) | Decides which lines `PIT_CheckLine` sees first, and so `spechit[]` order |
| `P_BlockThingsIterator` order (per-block linked list) | Decides `PIT_CheckThing` order, and so damage order |
| `P_TraverseIntercepts` ascending-`frac` order | Hitscan must meet the nearest object first |
| `spechit[]` processing order (reverse, from `numspechit-1` down) | Reverse is vanilla; changing it changes which specials fire |
| Fixed-point arithmetic identities | `FixedMul`, `FixedDiv`, `P_AproxDistance`; [engine-archaeology.md](engine-archaeology.md) §2 proves FixedDiv |
| `finesine`/`finetangent` values | Every angle-dependent calculation; [engine-archaeology.md](engine-archaeology.md) §1 |
| Blockmap structure (128-unit cells, iteration bounds) | Block assignment of things and lines depends on it |
| `P_CheckSight` eye height | `t1->z + t1->height - (t1->height >> 2)` |
| `GRAVITY = FRACUNIT` | Fall speed |
| `STOPSPEED`, `FRICTION` | Momentum decay |
| `FLOATSPEED = 4*FRACUNIT` | Floater vertical rate |
| Thinker deferred-free timing | A thinker removed mid-tic survives until `P_RunThinkers` next reaches it |
| `MAXSPECIALCROSS = 64` and the behaviour above 8 | Which specials fire in crowded maps |
| `MAXINTERCEPTS = 128` and the guard | Hitscan in dense maps |
| `onground` gate on player thrust (`P_MovePlayer`) | No air control; removing it desyncs demos that carry momentum off a ledge |

### 16.1 Assert mapping — every frozen row accounted for

Building with `-DWEBDOOM_INVARIANTS` compiles 11 runtime `DOOM_ASSERT` sites
and 7 `_Static_assert`s. The table maps each of the 20 frozen rows to exactly
one class:

- **runtime assert**: a `DOOM_ASSERT(...)` in the named function, firing at the
  call site;
- **static assert**: a `_Static_assert(...)`, firing at compile time when the
  flag is on;
- **reproduced**: a script in `tools/archaeology/` recomputes the value, and
  the `archaeology` leg runs it;
- **not assertable**: no non-tautological assert exists, for the reason given.

| # | frozen row | class | evidence |
|---|-------------------|-------|----------|
| 1 | `P_Random()` call sequence | runtime assert | `P_Random()` (m_random.c): `DOOM_ASSERT(doom_in_render_path == 0 && "P_Random called from render path -- sim/render contamination")` and `DOOM_ASSERT(prndindex == doom_prnd_expected && "prndindex modified outside P_Random/M_ClearRandom")`. `R_RenderPlayerView` sets `doom_in_render_path` for its duration |
| 2 | `rndtable[256]` contents | reproduced | `tools/archaeology/rndtable-stats.c` (mean 128.85, 166 distinct values, 90 values never appear); the table is a source constant |
| 3 | `prndindex` starts at 0 | runtime assert | `M_ClearRandom()` resets `prndindex` and the shadow `doom_prnd_expected` together; the second assert in `P_Random()` fires if anything else changes `prndindex` |
| 4 | Thinker list insertion order | runtime assert | `P_AddThinker()` (p_tick.c): `DOOM_ASSERT(thinkercap.prev == thinker && "P_AddThinker: new thinker not at tail -- insertion order broken")` |
| 5 | Thinker traversal direction | runtime assert | `P_RunThinkers()` (p_tick.c): `DOOM_ASSERT(currentthinker == thinkercap.next && "P_RunThinkers: traversal start is not thinkercap.next (head)")` |
| 6 | `P_BlockLinesIterator` order | not assertable | The order is the nested x/y loop in `P_CheckPosition` plus the WAD's own line lists. An assert would either recompute the loop state or depend on map data. A swap would be a visible textual change to the loop |
| 7 | `P_BlockThingsIterator` order | not assertable | The order follows `blocklinks[]`, which changes every tic with insertion order. Asserting it needs the expected sequence, which is tautological or map-dependent |
| 8 | `P_TraverseIntercepts` ascending order | runtime assert | `P_TraverseIntercepts()` (p_maputl.c): `DOOM_ASSERT(dist >= prev_dist && "P_TraverseIntercepts: intercept processed out of ascending order")`; `prev_dist` starts at −1 |
| 9 | `spechit[]` reverse processing | runtime assert | `P_TryMove()` (p_map.c): `DOOM_ASSERT(numspechit >= 0 && numspechit <= MAXSPECIALCROSS && ...)` and `DOOM_ASSERT(_ns >= 0 && "spechit[] reverse processing: numspechit negative before loop")`. The `while (numspechit--)` loop is the order itself |
| 10 | Fixed-point identities | reproduced | `tools/archaeology/fixeddiv-proof.c` (8,388,608 guard-edge pairs, 0 mismatches), `fixedmul-proof.c`, `aprox-distance-crack.c`, `angle-roundtrip-check.c` |
| 11 | `finesine`/`finetangent` values | reproduced | `tools/archaeology/finesine-stats.mjs`: 5,377 of 10,240 entries carry a rounding deviation, 33 escapes, and a boot checksum over 16,385 entries that also covers `finetangent` ([engine-archaeology.md](engine-archaeology.md) §1) |
| 12 | Blockmap 128-unit cells | static assert | p_local.h: `_Static_assert(MAPBLOCKUNITS == 128, ...)` |
| 13 | `P_CheckSight` eye height | runtime assert | `P_CheckSight()` (p_sight.c): `DOOM_ASSERT(sightzstart == (t1->z + t1->height - (t1->height>>2)) && ...)` |
| 14 | `GRAVITY = FRACUNIT` | static assert | p_local.h: `_Static_assert(GRAVITY == FRACUNIT, ...)` |
| 15 | `STOPSPEED`, `FRICTION` | static assert | p_mobj.c: `_Static_assert(STOPSPEED == 0x1000, ...)` and `_Static_assert(FRICTION == 0xe800, ...)`, next to the `#define`s |
| 16 | `FLOATSPEED = 4*FRACUNIT` | static assert | p_local.h: `_Static_assert(FLOATSPEED == 4*FRACUNIT, ...)` |
| 17 | Thinker deferred-free timing | not assertable | See below |
| 18 | `MAXSPECIALCROSS = 64` | runtime assert | The bounds assert in `P_TryMove()` (row 9) runs every move; p_local.h also has `_Static_assert(MAXSPECIALCROSS == 64, ...)` |
| 19 | `MAXINTERCEPTS = 128` and the guard | runtime assert | `PIT_AddLineIntercepts()` and `PIT_AddThingIntercepts()` (p_maputl.c): `DOOM_ASSERT(intercept_p - intercepts <= MAXINTERCEPTS && ...)` after every add; p_local.h also has `_Static_assert(MAXINTERCEPTS == 128, ...)` |
| 20 | `onground` thrust gate | runtime assert | `P_MovePlayer()` (p_user.c): `DOOM_ASSERT(onground == (player->mo->z <= player->mo->floorz) && "onground definition mismatch -- S16 invariant: player thrust gate broken")` |

Summary: 10 runtime assert, 4 static assert, 3 reproduced, 3 not assertable:
20 rows.

**Why row 17 has no assert.** The obvious check, "a thinker being added is not
already sentinel-marked", reads uninitialised memory. `Z_Malloc` does not zero,
every non-mobj thinker caller (14 of them in the mover and light files) calls
`P_AddThinker` before assigning `.function`, and a recycled block can still
hold the sentinel. That assert fired on 10 of the 13 stock demos, so
`P_AddThinker` carries a comment saying not to add it. A post-loop "no sentinel
left" assert is also wrong: when thinker A removes thinker B that the current
pass has already visited, B stays marked and linked until the next pass, which
is valid vanilla behaviour. The guarantee is structural: `P_RunThinkers` is the
only place that unlinks and frees.

### 16.2 The gate

The `build-invariants` leg compiles the engine with `-DWEBDOOM_INVARIANTS` into
`build-invariants/`. The `sim-invariants` leg then plays all 13 demos on that
build with the renderer running, freelook and interpolation active and a
fractional tic pinned (`node tools/demo-test.mjs --sim-drawn --smooth
--fractic 32768 --pitch 40 --build-dir build-invariants`), so the render-path
`P_Random` assert is exercised on every frame.

An assert names the broken invariant at the call site. A golden mismatch is a
downstream symptom: it says which tic diverged, not why. `sim-goldens`,
`render-goldens` and `sim-freelook` (playsim untouched with freelook on) run
alongside.

### 16.3 Confirming an assert fires

A clean run of the armed build prints, for every demo:

```
PASS doom-demo1: 1710 gametics bit-identical
PASS doom-demo2: 2347 gametics bit-identical
PASS doom-demo3: 3863 gametics bit-identical
PASS doom-demo4:  818 gametics bit-identical
PASS doom2-demo1: 1205 gametics bit-identical
PASS doom2-demo2: 2001 gametics bit-identical
PASS doom2-demo3: 4471 gametics bit-identical
PASS tnt-demo1: 4531 gametics bit-identical
PASS tnt-demo2: 3653 gametics bit-identical
PASS tnt-demo3: 3433 gametics bit-identical
PASS plutonia-demo1: 7403 gametics bit-identical
PASS plutonia-demo2: 3483 gametics bit-identical
PASS plutonia-demo3: 5662 gametics bit-identical
PASS — all demos bit-identical to golden
```

To check that an assert is live, break the invariant it guards and run one
demo on the armed build. Two examples:

**Runtime: insertion order (row 4).** Change `P_AddThinker` to insert at the
head (`thinkercap.next->prev = thinker … thinkercap.next = thinker`). The armed
build aborts at the first `P_AddThinker` call, on tic 1, naming the function:

```
RuntimeError: Aborted(Assertion failed: thinkercap.prev == thinker
  && "P_AddThinker: new thinker not at tail -- insertion order broken",
  at: core/p_tick.c,<line>,P_AddThinker).
```

The plain build would only show a golden hash mismatch at the end of the demo,
with no hint of which invariant broke.

**Compile time: MAXSPECIALCROSS (row 18).** Change the `#define` in p_local.h
to 32. The armed build stops in the first translation unit that includes it:

```
core/p_local.h:84:16: error: static assertion failed due to requirement
  '32 == 64': MAXSPECIALCROSS changed -- playsim.md S16 invariant: must be 64
   84 | _Static_assert(MAXSPECIALCROSS == 64,
      |                ^~~~~~~~~~~~~~~~~~~~
core/p_local.h:67:26: note: expanded from macro 'MAXSPECIALCROSS'
   67 | #define MAXSPECIALCROSS         32
```

The plain build never includes `doomassert.h`, so the same change compiles
silently.

**A vanilla reference beyond the goldens.** `tools/build-choco-reference.sh`
clones Chocolate Doom, applies `tools/choco-trace.patch` so it prints the same
per-tic fingerprint, and builds it (it needs SDL2, SDL2_mixer and SDL2_net
development packages). `node tools/demo-test.mjs --cross <chocolate-doom
binary>` then compares webdoom with it tic by tic.

### What is free to change (render side)

[renderer.md](renderer.md) documents all of these:

- interpolation: `fractic`, `R_LerpFixed`, `R_LerpAngle`, the
  `oldx/oldy/oldz/oldangle` and `oldviewz` fields;
- sector height snapshots: `oldfloorheight`/`oldceilingheight`;
- freelook y-shear: `lookdir`, `R_ShearView`;
- frame timing: the `web_perf_*` counters;
- every `r_*.c` internal: BSP traversal for drawing, visplanes, sprite sorting,
  column and span drawing.

The sim always uses true, unlerped fixed-point coordinates. The renderer may
interpolate for display, but every gameplay calculation (movement, collision,
damage, AI) reads the sim's own values.

---

## 17. Measured peaks in the golden demos

These figures come from instrumented builds run over all 13 golden demos. They
are not gated: each needs a build with an extra flag, and no leg builds one.

| figure | value | demo |
|--------|-------|------|
| peak `numspechit` in one move | 8 (the vanilla limit; webdoom's is 64) | tnt-demo2, MAP12 |
| peak intercepts in one trace | 45 (the limit is 128) | plutonia-demo3, MAP12 |
| successful `EV_Teleport` calls | 32 in 4 demos (table in Q5) | doom-demo3, doom2-demo3, plutonia-demo1, plutonia-demo3 |

**How to repeat them.**

- spechit: compile with `-DWEB_PERF_SPECHIT_STATS`. `PIT_CheckLine` then
  tracks the peak in `web_perf_spechit_peak`, read from JS with
  `web_perf_spechit_peak_get()`.
- teleports: compile with `-DWEB_PERF_TELEPORT_STATS`. `EV_Teleport` counts
  successful teleports in `web_perf_teleport_calls`, read with
  `web_perf_teleport_calls_get()`.
- Call `web_perf_reset()` between demos so each count is per demo. All three
  live in engine/web/perf.c.
- intercepts: no flag remains. The figure was measured with a temporary counter
  in both `PIT_Add*Intercepts` functions; repeating it means adding one again.

In every case the instrumented build must still pass all 13 sim goldens; the
counters do not touch sim state.

---

## 18. Function index

Every function defined in each `p_*.c` file, with the section that covers it.

### p_tick.c
- `P_InitThinkers` — empties the list; §1.2
- `P_AddThinker` — §1.2
- `P_RemoveThinker` — §1.2
- `P_AllocateThinker` — empty body, never called
- `P_RunThinkers` — §1.2
- `P_Ticker` — §1.1

### p_map.c
- `PIT_StompThing` — telefrag; §10.8
- `P_TeleportMove` — §10.8
- `PIT_CheckLine` — §4.2
- `PIT_CheckThing` — §4.1
- `P_CheckPosition` — §4.1
- `P_TryMove` — §4.3
- `P_ThingHeightClip` — re-clips a thing's floorz/ceilingz after a sector moves
- `P_HitSlideLine` — §4.5
- `PTR_SlideTraverse` — §4.5
- `P_SlideMove` — §4.5
- `PTR_AimTraverse` — auto-aim traverser
- `PTR_ShootTraverse` — hitscan traverser; damage, puffs, blood, the sky hack
- `P_AimLineAttack` — §5.3
- `P_LineAttack` — §5.3
- `PTR_UseTraverse` — USE traverser; calls `P_UseSpecialLine`
- `P_UseLines` — §5.3, §14.1
- `PIT_RadiusAttack` — §5.3
- `P_RadiusAttack` — §5.3
- `PIT_ChangeSector` — §10.6
- `P_ChangeSector` — §10.6

### p_maputl.c
- `P_AproxDistance` — the octagonal distance approximation
  ([engine-archaeology.md](engine-archaeology.md) §5)
- `P_PointOnLineSide` — side test against a linedef
- `P_BoxOnLineSide` — bounding box against a linedef (-1 if it crosses)
- `P_PointOnDivlineSide` — side test against a divline
- `P_MakeDivline` — linedef to `divline_t`
- `P_InterceptVector` — §6.4
- `P_LineOpening` — sets `opentop`, `openbottom`, `openrange`, `lowfloor`; §4.2
- `P_UnsetThingPosition` — unlinks from sector and block lists
- `P_SetThingPosition` — links into sector and block lists
- `P_BlockLinesIterator` — §3.2
- `P_BlockThingsIterator` — §3.2
- `PIT_AddLineIntercepts` — §5.1
- `PIT_AddThingIntercepts` — §5.1
- `P_TraverseIntercepts` — §5.2
- `P_PathTraverse` — §5.2

### p_sight.c
- `P_DivlineSide` — §6.2
- `P_InterceptVector2` — §6.4
- `P_CrossSubsector` — §6.2
- `P_CrossBSPNode` — §6.2
- `P_CheckSight` — §6

### p_mobj.c
- `P_SetMobjState` — chains zero-tic states, runs action functions; §7.4
- `P_ExplodeMissile` — death state, `tics -= P_Random()&3`, death sound
- `P_XYMovement` — §4.6
- `P_ZMovement` — §7.1
- `P_NightmareRespawn` — §7.5
- `P_MobjThinker` — §7.4
- `P_SpawnMobj` — §7.4
- `P_RemoveMobj` — queues respawnable items, unlinks, removes the thinker
- `P_RespawnSpecials` — deathmatch item respawn from the `itemrespawnque`
- `P_SpawnPlayer` — player mobj at a start; `G_PlayerReborn` as needed
- `P_SpawnMapThing` — spawns one map thing; stores player and deathmatch starts; §12.3
- `P_SpawnPuff` — bullet puff (`P_Random` for height and tics)
- `P_SpawnBlood` — blood (`P_Random` for height and tics)
- `P_CheckMissileSpawn` — moves a new missile a little and explodes it if blocked
- `P_SpawnMissile` — monster missile toward its target (shadow error via `P_Random`)
- `P_SpawnPlayerMissile` — player missile with auto-aim

### p_enemy.c
- `P_RecursiveSound` — §8.1
- `P_NoiseAlert` — §8.1
- `P_CheckMeleeRange` — §8.2
- `P_CheckMissileRange` — §8.2; distance-scaled `P_Random` check
- `P_Move` — §4.6, §7.3, §8.4
- `P_TryWalk` — §8.3
- `P_NewChaseDir` — §8.3
- `P_LookForPlayers` — §8.1
- `A_KeenDie` — opens door tag 666 when every Keen is dead
- `A_Look` — §8.1
- `A_Chase` — §8.2
- `A_FaceTarget` — §8.2
- `A_PosAttack`, `A_SPosAttack`, `A_CPosAttack`, `A_CPosRefire` — zombie hitscan; `P_Random` spread and damage
- `A_SpidRefire` — Spider Mastermind refire check
- `A_BspiAttack` — Arachnotron plasma
- `A_TroopAttack` — Imp claw or fireball
- `A_SargAttack` — Demon bite
- `A_HeadAttack` — Cacodemon bite or fireball
- `A_CyberAttack` — Cyberdemon rocket
- `A_BruisAttack` — Baron/Knight claw or fireball
- `A_SkelMissile`, `A_Tracer` — Revenant homing missile; `A_Tracer` steers every 4 tics and uses `P_Random` for the smoke puff
- `A_SkelWhoosh`, `A_SkelFist` — Revenant punch
- `PIT_VileCheck`, `A_VileChase` — Arch-vile looks for corpses to raise
- `A_VileStart`, `A_StartFire`, `A_FireCrackle`, `A_Fire` — Arch-vile flame placement and sounds
- `A_VileTarget` — spawns the flame on the target
- `A_VileAttack` — blast: direct damage, `P_RadiusAttack` from the flame, upward thrust
- `A_FatRaise`, `A_FatAttack1`, `A_FatAttack2`, `A_FatAttack3` — Mancubus volleys
- `A_SkullAttack` — lost soul charge (`MF_SKULLFLY`); §7.2
- `A_PainShootSkull` — spawns a lost soul; gives up past 20 lost souls on the level
- `A_PainAttack`, `A_PainDie` — Pain Elemental: one soul, three on death
- `A_Scream` — death sound (random among variants for some types)
- `A_XScream` — gib sound
- `A_Pain` — pain sound
- `A_Fall` — corpse loses `MF_SOLID`
- `A_Explode` — `P_RadiusAttack` wrapper
- `A_BossDeath` — §8.5
- `A_Hoof`, `A_Metal`, `A_BabyMetal` — footstep sounds, then `A_Chase`
- `A_BrainAwake` — collects `MT_BOSSTARGET` spots (§19), plays the sight sound
- `A_BrainPain`, `A_BrainScream`, `A_BrainExplode`, `A_BrainDie` — boss brain pain and death sequence
- `A_BrainSpit` — fires a cube at the next target spot, round-robin
- `A_SpawnSound`, `A_SpawnFly` — cube flight; `A_SpawnFly` picks the monster with `P_Random` and telefrags at the spot
- `A_PlayerScream` — player death sound by severity

### p_inter.c
- `P_GiveAmmo` — §9.3
- `P_GiveWeapon` — §9.3
- `P_GiveBody` — §9.2
- `P_GiveArmor` — §9.3
- `P_GiveCard` — §9.3
- `P_GivePower` — §9.3
- `P_TouchSpecialThing` — §9.3
- `P_KillMobj` — corpse state, kill counts, item drops
- `P_DamageMobj` — §9.1

### p_spec.c
- `P_InitPicAnims` — builds the flat and texture animation table
- `getSide`, `getSector`, `twoSided`, `getNextSector` — line/sector helpers
- `P_FindLowestFloorSurrounding` through `P_FindMinSurroundingLight` — neighbour height and light queries used by movers and lights
- `P_FindSectorFromLineTag` — linear scan for the next tagged sector
- `P_CrossSpecialLine` — §10.3
- `P_ShootSpecialLine` — §10.3
- `P_PlayerInSpecialSector` — §10.2
- `P_UpdateSpecials` — §10.1
- `EV_DoDonut` — §10.3
- `P_SpawnSpecials` — §10.2

### p_switch.c
- `P_InitSwitchList` — builds switch texture pairs from `alphSwitchList[]`
- `P_StartButton` — §19 (`MAXBUTTONS`)
- `P_ChangeSwitchTexture` — swaps a switch texture and starts its timer
- `P_UseSpecialLine` — §10.3

### p_doors.c
- `T_VerticalDoor` — §10.4
- `EV_DoLockedDoor`, `EV_DoDoor` — tagged doors
- `EV_VerticalDoor` — manual (USE) doors; key checks
- `P_SpawnDoorCloseIn30`, `P_SpawnDoorRaiseIn5Mins` — §10.2
- the sliding-door functions are inside `#if 0`

### p_plats.c
- `T_PlatRaise` — §10.5
- `EV_DoPlat` — §10.5
- `P_ActivateInStasis`, `EV_StopPlat` — resume or pause perpetual platforms
- `P_AddActivePlat`, `P_RemoveActivePlat` — §19 (`MAXPLATS`)

### p_ceilng.c
- `T_MoveCeiling` — §10.6
- `EV_DoCeiling` — spawns a ceiling mover
- `P_AddActiveCeiling`, `P_RemoveActiveCeiling` — active ceiling list
- `P_ActivateInStasisCeiling`, `EV_CeilingCrushStop` — resume or stop crushers

### p_floor.c
- `T_MovePlane` — moves a floor or ceiling, calls `P_ChangeSector`; §10.6
- `T_MoveFloor` — §10.7
- `EV_DoFloor` — spawns a floor mover
- `EV_BuildStairs` — §10.7

### p_lights.c
- `T_FireFlicker`, `P_SpawnFireFlicker` — §10.2
- `T_LightFlash`, `P_SpawnLightFlash` — §10.2
- `T_StrobeFlash`, `P_SpawnStrobeFlash` — §10.2
- `EV_StartLightStrobing` — line trigger for strobes
- `EV_TurnTagLightsOff`, `EV_LightTurnOn` — line-triggered light levels
- `T_Glow`, `P_SpawnGlowingLight` — §10.2

### p_telept.c
- `EV_Teleport` — §10.8

### p_pspr.c
- `P_SetPsprite` — §11.1
- `P_CalcSwing` — computes `swingx/swingy`; never called
- `P_BringUpWeapon` — §11.2
- `P_CheckAmmo` — §11.3
- `P_FireWeapon` — enters the attack state, alerts monsters with `P_NoiseAlert`
- `P_DropWeapon` — lowers the weapon on death
- `A_WeaponReady` — §11.2
- `A_ReFire` — §11.3
- `A_CheckReload` — super shotgun reload check
- `A_Lower`, `A_Raise` — §11.2
- `A_GunFlash` — muzzle flash psprite
- `A_Punch` — fist; `P_Random` damage (×10 with berserk) and spread
- `A_Saw` — chainsaw; `P_Random` damage and spread, pulls toward the target
- `A_FireMissile` — rocket
- `A_FireBFG` — BFG ball; uses `BFGCELLS`
- `A_FirePlasma` — plasma; random flash frame
- `P_BulletSlope` — auto-aim slope for hitscan weapons
- `P_GunShot` — one bullet; `P_Random` damage, and spread unless accurate
- `A_FirePistol`, `A_FireShotgun` (7 pellets), `A_FireShotgun2` (20 pellets), `A_FireCGun` — hitscan weapons
- `A_Light0`, `A_Light1`, `A_Light2` — `extralight` for muzzle flashes
- `A_BFGSpray` — 40 tracer rays, each `P_Random`-based damage
- `A_BFGsound` — BFG charge sound
- `P_SetupPsprites` — weapon psprites at spawn
- `P_MovePsprites` — §11.2

### p_setup.c
- `P_LoadVertexes`, `P_LoadSegs`, `P_LoadSubsectors`, `P_LoadSectors`, `P_LoadNodes` — §12.1
- `P_LoadThings` — §12.3, Q8
- `P_LoadLineDefs` — §12.2
- `P_LoadSideDefs` — texture names to numbers; §12.2
- `P_LoadBlockMap` — §3.1
- `P_GroupLines` — sector line lists, sector bounding and block boxes, sound origins
- `P_SetupLevel` — §12.1
- `P_Init` — switch list, animations, sprite names (once at startup)

### p_saveg.c
- `P_ArchivePlayers`, `P_UnArchivePlayers` — §13.2, §13.3
- `P_ArchiveWorld`, `P_UnArchiveWorld` — §13.2
- `P_ArchiveThinkers`, `P_UnArchiveThinkers` — §13.2, §13.3
- `P_ArchiveSpecials`, `P_UnArchiveSpecials` — §13.2

### p_user.c
- `P_Thrust` — §14.2
- `P_CalcHeight` — §14.3
- `P_MovePlayer` — §14.2
- `P_DeathThink` — turns toward the killer, lowers the view, waits for USE to respawn
- `P_PlayerThink` — §14.1

### m_random.c (sim-relevant)
- `P_Random`, `M_Random`, `M_ClearRandom` — §2

### g_game.c (sim-relevant)
- `G_Ticker` — §1.1
- `G_BuildTiccmd` — builds a ticcmd from local input; §14.2
- `G_ReadDemoTiccmd`, `G_WriteDemoTiccmd` — §1.4
- `G_InitNew` — new game; calls `M_ClearRandom`; §2.1
- `G_DoLoadLevel` — level start; calls `P_SetupLevel`
- `G_DeathMatchSpawnPlayer` — §14.5
- `G_PlayerReborn` — resets a player struct on respawn
- `G_DoSaveGame`, `G_DoLoadGame` — §13

---

## 19. Limits audit

The policy for every fixed-size buffer: never corrupt memory, and keep the
guard a no-op on the golden paths (all 13 demos pass with every guard in
place).

| site / limit | vanilla on overflow | webdoom | reached by a golden demo? | where |
|---|---|---|---|---|
| `spechit[MAXSPECIALCROSS = 64]` | Wrote past `spechit[8]` (vanilla limit 8) into adjacent globals | Write skipped once full; limit raised to 64 | No: peak 8 (§17) | `PIT_CheckLine`, p_map.c; §4.4 |
| `intercepts[MAXINTERCEPTS = 128]` | Wrote past the array; the "all-ghosts" family | All 128 slots used; an intercept past the 128th is dropped before it is written | No: peak 45 (§17) | `PIT_AddLineIntercepts`, `PIT_AddThingIntercepts`, p_maputl.c; §5.1 |
| `solidsegs[MAXSEGS = 64]` | Wrote past the array (vanilla limit 32) | After `R_StoreWallRange`, the clip entry is dropped when full; the wall is still drawn. The array has one slot past the cap, because the crunch copies the entry at `newend` (`crafted-maps.mjs` solidsegs-full) | No: render-only, never read by the sim | `R_ClipSolidWallSegment`, r_bsp.c; [renderer.md](renderer.md) §3.4, §10 |
| `openings[MAXOPENINGS = SCREENWIDTH*64]` | Pointer overrun in a non-`RANGECHECK` build; `I_Error` in `R_DrawPlanes` with `RANGECHECK` | Each `lastopening +=` in `R_StoreWallRange` is checked first; when full, the masked midtexture is dropped (its columns too, when the sprite clips did not fit after them) or the silhouette bit cleared, never leaving a NULL clip pointer behind (`crafted-maps.mjs` masked-openings) | No: render-only | `R_StoreWallRange`, r_segs.c; [renderer.md](renderer.md) §4.3, §10 |
| save buffer | Vanilla built the save at `screens[1]+0x4000`, 175,616 bytes from the end of the screen block, with no check; big levels wrote past it | malloc'd at `P_ArchiveSize()`, a bound computed from the level, before anything is written | No: demos never save | `G_DoSaveGame`, g_game.c; `P_ArchiveSize`, p_saveg.c; §13.1 |
| `braintargets[MAXBRAINTARGETS = 32]` | No check; a map with more than 32 `MT_BOSSTARGET` things overwrote `numbraintargets` and `braintargeton` | Only the first 32 are stored; `A_BrainSpit` cycles through those | No: no golden demo plays MAP30 (which has 8) | `A_BrainAwake`, p_enemy.c |
| `EV_DoDonut` `s2`/`s3` | NULL dereference when the ring or outer sector is missing (one-sided first line, or a bad two-sided line) | Skips that sector (`if (!s2) continue;`, `if (!s3) continue;`), as PrBoom does | No: no golden demo uses line special 9 | `EV_DoDonut`, p_spec.c; §10.3 |
| `activeplats[MAXPLATS = 30]` | Vanilla already `I_Error`s | Unchanged: `I_Error("P_AddActivePlat: no more plats!")` | No | `P_AddActivePlat`, p_plats.c; §10.5 |
| `buttonlist[MAXBUTTONS = 16]` | Vanilla already `I_Error`s | Unchanged: `I_Error("P_StartButton: no button slots left!")` | No | `P_StartButton`, p_switch.c |
| chat: `chatchars[QUEUESIZE = 128]`, `hu_textline_t.l[HU_MAXLINELENGTH+1 = 81]` | Already safe: the ring drops on full; a full text line refuses the character | Unchanged | No: chat is not used in demos | hu_stuff.c, hu_lib.c; see below |

### Notes on the limits

**Two renderer out-of-bounds reads are fixed.** Both read past texture data
into the zone heap, so their output depended on heap layout: any change to the
binary's data segment could move render-golden pixels. Both are renderer code,
covered in [renderer.md](renderer.md) §6.7:

1. `R_RenderMaskedSegRange` (r_segs.c) runs after the wall loop and used
   whatever `dc_texheight` the last wall or plane draw left. For a masked
   midtexture shorter than 128 pixels, `R_DrawColumn` then wrapped with the
   wrong mask. It now sets `dc_texheight = textureheight[texnum] >> FRACBITS`
   before its column loop.
2. `R_DrawMaskedColumn` (r_things.c) now sets `dc_texheight = column->length`
   per post. `R_DrawColumn` takes a power-of-two path for walls and a true
   modulo path for other heights, so a sprite post whose top is above the
   screen wraps within its own pixels instead of reading past them.

**What the per-tic gamestate hash covers.** `web_state_hash()`
(engine/web/i_main.c) hashes `gametic`, `prndindex`, each in-game player's
`x`, `y`, `angle` and `health`, every sector's floor and ceiling height, and the
number of thinkers. It does not hash monster positions or states, or the
internals of any thinker. A sim change confined to those can pass
`sim-goldens` while changing what is drawn; `render-goldens` is the backstop
for that class. Because `prndindex` is in the hash, most such changes also move
the random sequence and are caught anyway.

**Chat input from the network is safe.** A chat character arrives from other
clients in `cmd->chatchar` (d_net.c). `HU_Ticker` passes it to
`HUlib_keyInIText` (hu_lib.c), which accepts only `' '` to `'_'` (plus
backspace and enter) before calling `HUlib_addCharToTextLine`; that refuses to
write when `len == HU_MAXLINELENGTH`. The `chatchars` queue uses
`(head + 1) & (QUEUESIZE-1)` arithmetic and drops on full. No sequence of
attacker-controlled characters can overflow either buffer.
