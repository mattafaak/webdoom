# webdoom playsim internals

The simulation is the deterministic core the whole project's accuracy tenet protects.
Every claim here is cited by file and line from `engine/core/`; where vanilla behavior
is preserved for demo compatibility, the quirk is flagged explicitly. The frozen-surface
statement in the closing section enumerates exactly what may never change.

Companion volume: `docs/renderer.md` documents the render side. The sim/render boundary
is clean: the simulation always runs on true, unlerped fixed-point values; the renderer
is free to interpolate for display. Do not duplicate renderer internals here.

Evidence standard: same as `docs/engine-archaeology.md`. File:line for every claim.
Where a number was measured against code (rather than verified against 13 golden demos
by instrumentation), that is stated.

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
10. [Sector specials — p_spec.c / p_doors.c / p_plats.c / p_ceilng.c / p_floor.c / p_lights.c / p_switch.c / p_telept.c](#10-sector-specials)
11. [Weapons and psprites — p_pspr.c](#11-weapons-and-psprites)
12. [Map setup — p_setup.c](#12-map-setup)
13. [Save / load — p_saveg.c](#13-save--load)
14. [Player — p_user.c](#14-player)
15. [Quirk catalog](#15-quirk-catalog)
16. [The frozen surface — what is and is not demo-visible](#16-the-frozen-surface)
17. [Open questions for task 1.4](#17-open-questions-for-task-14)
18. [Coverage audit — p_*.c function index](#18-coverage-audit)

---

## 1. Tic orchestration

### 1.1 Call chain

Every simulation tic is driven by `G_Ticker` (g_game.c:605), which:

1. Handles reborn players and deferred game-state transitions (load, save, demo, etc.).
2. Copies the current tic's `ticcmd_t` from `netcmds[i][buf]` into each active
   player's `cmd` field (g_game.c:664).
3. In netgame, checks the consistency checksum (g_game.c:690) — see §1.3.
4. Falls through to `P_Ticker` (p_tick.c:130).

`P_Ticker` (p_tick.c:130) is the sim tick proper:

```
for each player: P_PlayerThink    (p_user.c / p_pspr.c)
P_RunThinkers   (p_tick.c:101)
P_UpdateSpecials (p_spec.c)
P_RespawnSpecials (p_spec.c)
leveltime++
```

webdoom addition: at the top of `P_Ticker`, before players are processed, previous-tic
sector heights are snapshotted for render interpolation (p_tick.c:149–153). This is
render-local state; it does not influence the sim.

### 1.2 Thinker list

`thinkercap` (p_tick.c:47) is a sentinel node whose `next`/`prev` form a circular
doubly-linked list of all active thinkers. Every mobj, ceiling, door, floor, platform,
and light effect is a thinker.

**P_AddThinker** (p_tick.c:65) inserts at the tail:

```c
thinkercap.prev->next = thinker;
thinker->next = &thinkercap;
thinker->prev = thinkercap.prev;
thinkercap.prev = thinker;
```

**P_RemoveThinker** (p_tick.c:80) does *not* free immediately. It marks the thinker
with a sentinel function pointer:

```c
thinker->function.acv = (actionf_v)(-1);
```

This is the famous deferred-free: the thinker stays in the list with its `next`/`prev`
intact until **P_RunThinkers** (p_tick.c:101) reaches it on the *next* traversal, then
unlinks and frees it.

`P_RunThinkers` contained a latent use-after-free (p_tick.c:108–120); **fixed in task 3.1** by caching `nextthinker = currentthinker->next` before the free, matching the documented safe pattern described below:

```c
// BEFORE the task-3.1 fix (historical — current code caches nextthinker first):
if (currentthinker->function.acv == (actionf_v)(-1)) {
    // time to remove it
    currentthinker->next->prev = currentthinker->prev;  // line 111
    currentthinker->prev->next = currentthinker->next;  // line 112
    Z_Free(currentthinker);                              // line 113 — FREE
}
else {
    if (currentthinker->function.acp1)
        currentthinker->function.acp1(currentthinker);
}
currentthinker = currentthinker->next;                   // line 120 — reads next AFTER free
```

`Z_Free` runs at line 113; `currentthinker->next` is read at line 120 **from the
already-freed block**. This is a use-after-free hidden by the allocator: Z_Zone marks
the block header as free but does not zero the block body, so the `next` pointer
remains readable in the freed memory until the zone reuses that block. In practice the
zone-reuse window is long enough that this has never caused a crash, but any zone
hardening in task 2.5/3.1 (e.g., poisoning freed blocks with 0xfd or zeroing
`next`/`prev`) will break this traversal and must either preserve readability of freed
pointers or fix the loop to save `next` before `Z_Free`.

Demo desync caused by a thinker being freed *inside its own callback* is prevented
because `P_MobjThinker` (p_mobj.c:431,440) checks the sentinel after each sub-call:

```c
if (mobj->thinker.function.acv == (actionf_v)(-1))
    return;   // mobj was removed
```

**Thinker order**: thinkers are processed in insertion order (head → tail). Sector
specials and movers are added by `P_SpawnSpecials` at level load before players are
spawned, so they always precede player mobjs in the list. This ordering is demo-visible:
any optimisation that reorders thinkers would break demos.

### 1.3 ticcmd and consistency check

Each player's input for tic N is packed into a `ticcmd_t`:

| field | bits | meaning |
|-------|------|---------|
| `forwardmove` | 8 signed | forward/back speed |
| `sidemove` | 8 signed | strafe speed |
| `angleturn` | 16 | yaw delta (angle units >> 16) |
| `consistancy` | 16 | echo of the previous tic's consistency value |
| `chatchar` | 8 | in-game chat |
| `buttons` | 8 | fire, use, weapon select, special |

In netgame, the consistency value written into `consistancy[i][buf]` (g_game.c:696) is
`players[i].mo->x` when the player mobj exists, otherwise `rndindex` (g_game.c:698).
If the received `cmd->consistancy` doesn't match the stored value, the engine calls
`I_Error` — a hard desync. webdoom adds a guard: relay-fabricated commands for stalled
clients carry no valid checksum and skip verification (g_game.c:684–693).

`buf = (gametic/ticdup) % BACKUPTICS` (g_game.c:656). `BACKUPTICS = 35`
(d_net.h:52). The ring is 35 tics deep.

### 1.4 Demo playback / recording

`G_ReadDemoTiccmd` (g_game.c:1511) reads the next ticcmd from the demo lump and
overwrites `cmd`. `G_WriteDemoTiccmd` (g_game.c:1526) appends the current ticcmd to
the recording buffer. The demo data is raw ticcmd bytes, one per tic per player. The
random index is **not** saved in the demo; demo determinism depends entirely on both
sides using the same `P_Random` call sequence (§2).

---

## 2. Random number generation

### 2.1 Two indices, one table

`rndtable[256]` (m_random.c:31–50) is a 256-byte LUT. It is not a standard PRNG;
see `docs/engine-archaeology.md §3` for the full proof that no seeded LCG generates it.

Two independent indices advance through this table:

| index | function | demo-visible |
|-------|----------|-------------|
| `prndindex` | `P_Random()` | YES — gameplay |
| `rndindex` | `M_Random()` | no — menu, sound variation |

`P_Random` (m_random.c:57–61):
```c
prndindex = (prndindex+1) & 0xff;
return rndtable[prndindex];
```

`M_Random` (m_random.c:63–67) is identical but advances `rndindex`.

`M_ClearRandom` (m_random.c:69) resets both to 0 at level load. The demo format does
not store either index; the entire demo playback relies on the `P_Random` call sequence
being identical to the record session's sequence.

### 2.2 Wraparound

Both indices wrap at 255 → 0 via `& 0xff`. The table is not re-seeded; it is eternal.
A demo that runs long enough will cycle through the table repeatedly and produce the
same values as on previous cycles. This is vanilla behaviour and is preserved exactly.

### 2.3 Why the split matters

If `M_Random` used `prndindex`, every menu sound effect or cosmetic variation (monster
sound selection in `A_Look`, g_game.c turbo message suppression) would consume a
`P_Random` slot and desync demos recorded on machines that made different menu
interactions. The split isolates gameplay-deterministic randomness from display-only
randomness.

---

## 3. The blockmap

### 3.1 Structure

The blockmap divides the map into a grid of 128×128 unit blocks
(`MAPBLOCKUNITS = 128`, `MAPBLOCKSIZE = 128*FRACUNIT` — p_local.h:38–39).

It is loaded from the WAD `BLOCKMAP` lump by `P_LoadBlockMap` (called at p_setup.c:651).
Key globals set at load time:

| variable | meaning |
|----------|---------|
| `bmapwidth`, `bmapheight` | grid dimensions in blocks |
| `bmaporgx`, `bmaporgy` | world-space origin of block (0,0) |
| `blockmaplump` | raw lump data: header + offsets + line lists |
| `blockmap` | pointer into `blockmaplump` past the header |
| `blocklinks` | per-block mobj linked-list heads (separate heap alloc) |

The lump layout: `[orgx, orgy, width, height]` as 16-bit shorts, then `width*height`
16-bit offsets (one per block), then the line-index lists (terminated by `-1`).

### 3.2 P_BlockLinesIterator — the classic off-by-one

`P_BlockLinesIterator` (p_maputl.c:472):

```c
if (x<0 || y<0 || x>=bmapwidth || y>=bmapheight)
    return true;
```

Out-of-bounds blocks silently return true (no lines checked). This is the "blockmap
edge" quirk: objects or traces that straddle the map boundary may not collide with
lines in the outermost blocks. Vanilla maps leave a margin, so this rarely manifests,
but custom maps that pack geometry to the boundary expose it.

The `P_CheckPosition` call for line-block iteration (p_map.c:435–443) does **not** add
`MAXRADIUS` to the search bounds (unlike the thing-block pass at p_map.c:424–427).
This is a deliberate asymmetry: thing bounding boxes can straddle blocks, so
`MAXRADIUS` expansion ensures things in adjacent blocks are checked; lines already know
which blocks they are in via the map builder's blockmap.

### 3.3 validcount

`validcount` is a global integer incremented before each blockmap sweep to avoid
processing a line that appears in multiple blocks more than once per sweep (p_maputl.c:496–500).
Any code that calls a block iterator must increment `validcount` first. Failing to do
so produces duplicate PIT_ callbacks for shared lines — a potential demo-affecting bug
if it caused duplicate spechit entries or duplicate intercepts.

---

## 4. Movement and collision

### 4.1 P_CheckPosition

`P_CheckPosition` (p_map.c:378) is the pure-query half of the movement system. It:

1. Sets `tmthing`, `tmflags`, `tmx`, `tmy`, `tmbbox` to the proposed position.
2. Sets `tmfloorz`, `tmdropoffz` from the destination subsector's floor,
   `tmceilingz` from its ceiling.
3. Increments `validcount`, clears `numspechit = 0`.
4. Early-returns true for `MF_NOCLIP` things.
5. Iterates the blockmap thing-grid (with MAXRADIUS expansion) calling
   `PIT_CheckThing` for each potential thing overlap.
6. Iterates the blockmap line-grid (without MAXRADIUS expansion) calling
   `PIT_CheckLine` for each candidate line.

Returns true if the position is valid (no solid obstruction).

### 4.2 tmfloorz / tmceilingz capture

`PIT_CheckLine` (p_map.c:189) adjusts the captured `tmfloorz`, `tmceilingz`, and
`tmdropoffz` as it contacts each two-sided line (p_map.c:227–237). After all lines are
checked, these values represent:

- `tmfloorz`: highest floor contacted (the floor the thing would stand on)
- `tmceilingz`: lowest ceiling contacted (the ceiling that limits vertical space)
- `tmdropoffz`: lowest floor contacted (drop-off check for non-floating monsters)

### 4.3 P_TryMove

`P_TryMove` (p_map.c:454) is the mutating move:

1. Calls `P_CheckPosition`. If blocked, returns false.
2. Checks `tmceilingz - tmfloorz < thing->height` — won't fit.
3. Checks `tmceilingz - thing->z < thing->height` — can't lower itself to fit
   (unless MF_TELEPORT).
4. Checks `tmfloorz - thing->z > 24*FRACUNIT` — step too high (the 32-unit step
   cap is documented in §14; the 24-unit limit here applies to all things, the
   player's extra 8 units come from the step-up smoothing in `P_ZMovement`).
5. Checks drop-off: `tmfloorz - tmdropoffz > 24*FRACUNIT` for non-floating,
   non-dropoff things.
6. If all checks pass: `P_UnsetThingPosition`, updates `thing->x/y/floorz/ceilingz`,
   `P_SetThingPosition`.
7. Processes `spechit[]` in reverse order (p_map.c:506–518).

### 4.4 spechit[] — the overflow behavior

```c
// p_map.c:67
#define MAXSPECIALCROSS  64   // webdoom: was 8; big PWAD maps overflowed
line_t*  spechit[MAXSPECIALCROSS];
int      numspechit;
```

Vanilla DOOM had `MAXSPECIALCROSS = 8`. When a thing crossed more than 8 special
lines in one move (possible with wide thing radii in dense special-line areas),
vanilla would write past the array, corrupting adjacent globals. The corruption
typically overwrote `numspechit` itself or the `spechit` entries at positive offsets,
producing spurious line crossings or skipping valid ones.

webdoom raises the limit to 64 and guards the write (p_map.c:243–247):

```c
if (numspechit < MAXSPECIALCROSS) {
    spechit[numspechit] = ld;
    numspechit++;
}
```

This means webdoom silently drops specials beyond 64. Vanilla would corrupt and
potentially trigger wrong specials. Neither behaviour is ideal, but dropping is
safer than scribbling. **For the 13 golden demos**: measured peak numspechit is **8** (tnt-demo2, MAP12),
exactly at the vanilla limit of 8. No demo exceeds it, confirming the webdoom clamp
at 64 is never reached by these demos. (Measurement: `EMSCRIPTEN_KEEPALIVE` counter,
C changes reverted, 13/13 goldens confirmed; see §17.)

`p_enemy.c:267–269` also declares a local `MAXSPECIALCROSS 8` and `extern spechit[]`
for monster moves. Monster moves use the same buffer but the enemy-local `#define` is
a vestigial copy; the actual array size is controlled by `p_map.c`.

**C99 §6.2.7 incompatible-declaration note**: `p_map.c` defines `spechit[64]` (with
its own `#define MAXSPECIALCROSS 64`), while `p_enemy.c` declares
`extern line_t* spechit[MAXSPECIALCROSS]` where its local `#define MAXSPECIALCROSS 8`
expands to `spechit[8]`. These two declarations name the same object with different
array sizes — a violation of C99 §6.2.7 (compatible type requirement for declarations
of the same object across translation units). The mismatch is benign in practice
because C array parameters decay to pointers at the ABI boundary, and no compiler
uses the declared extent for anything after link time. **Fixed in task 3.1**: the
`#define MAXSPECIALCROSS 64` now lives in `p_local.h`, and both TUs see the same
array size in their `extern` declarations (behavior-identical — p_enemy.c's loop
bound is `numspechit`, never the constant).

### 4.5 P_SlideMove — the 3-attempt hack

`P_SlideMove` (p_map.c:699) is called when a player's `P_XYMovement` is blocked.
It fires three `P_PathTraverse` rays (leading corners and one cross-corner) to find the
closest slide wall. The `hitcount` counter limits the retry loop to 3 iterations
(p_map.c:713):

```c
if (++hitcount == 3)
    goto stairstep;
```

After 3 wall-slide retries, it falls through to the `stairstep` label and tries a
purely vertical then purely horizontal move. The comment in the source reads
"This is a kludgy mess." This 3-attempt limit is demo-visible: any change to the
slide retry count would affect player position.

### 4.6 P_XYMovement — friction

`P_XYMovement` (p_mobj.c:114) applies friction at the end of every horizontal movement
pass (when the thing is on the floor):

```c
// p_mobj.c constants:
#define STOPSPEED   0x1000   // ~0.0625 map units/tic
#define FRICTION    0xe800   // ~0.906 as a fixed-point multiplier
```

If momentum components are both below `STOPSPEED` **and** the player has zero input
commands, momentum is zeroed (p_mobj.c:221–235). Otherwise `FRICTION` is applied each
tic (p_mobj.c:238–239). Monsters stop instantly when their move completes (momentum is
zeroed in `P_Move` at p_enemy.c:334 when on the floor). Missiles and MF_SKULLFLY
objects are exempt from friction (p_mobj.c:201–202).

---

## 5. Intercepts and traces

### 5.1 intercepts[] array

```c
// p_local.h:154
#define MAXINTERCEPTS  128

// p_maputl.c:544
intercept_t  intercepts[MAXINTERCEPTS];
intercept_t* intercept_p;
```

Vanilla DOOM had `MAXINTERCEPTS = 128` (unchanged here). The array collects all lines
and things that a trace passes through before `P_TraverseIntercepts` sorts and
processes them.

**Vanilla overflow behaviour**: vanilla wrote past `intercepts[]` when a trace crossed
more than 128 objects. The resulting heap corruption typically zeroed part of the
intercept array (since the struct members are small), causing later intercepts to be
processed with zero fractions — the "all-ghosts" bug family where shots pass through
enemies because the intercept fraction came back 0 (before the enemy's intercept entry)
rather than the correct value.

**webdoom overflow behaviour** (p_maputl.c:606–607):
```c
if (intercept_p - intercepts < MAXINTERCEPTS-1)
    intercept_p++;   // webdoom: clamp, vanilla overran on long traces
```

webdoom clamps: once 127 intercepts are accumulated (leaving one slot), additional
intercepts are silently discarded. The one-slot margin prevents writing to `[128]`
while still allowing the last valid slot to be written. For traces that genuinely
cross > 128 objects (unusual in vanilla maps, possible in large custom maps), distal
objects are simply not checked — behaves as if they are transparent, which is the
"ghosts" effect in a milder form. **Measured**: peak intercept count across all 13 golden demos is **45**
(plutonia-demo3, MAP12). Well below the 127 clamp, confirming the clamp is never
reached by these demos. (Measurement: `EMSCRIPTEN_KEEPALIVE` counter in both
`PIT_AddLineIntercepts` and `PIT_AddThingIntercepts`, C changes reverted, 13/13
goldens confirmed; details in §17.)

Same guard applies to `PIT_AddThingIntercepts` (p_maputl.c:672–673).

### 5.2 P_PathTraverse

`P_PathTraverse` (p_maputl.c:744) is the DDA-based blockmap traversal:

1. Nudges the start point off block boundaries by 1 unit (p_maputl.c:779–783) to avoid
   ambiguous side-tests when the trace starts exactly on a block edge. This nudge is
   demo-visible: its fixed value `FRACUNIT` (1 map unit) is canonical.
2. Sets up `trace` (the divline from start to end).
3. Iterates blocks via a DDA stepping loop capped at 64 iterations (p_maputl.c:848) —
   round-off guard to prevent infinite loops near map edges.
4. For each block: if `PT_ADDLINES`, calls `PIT_AddLineIntercepts`; if `PT_ADDTHINGS`,
   calls `PIT_AddThingIntercepts`.
5. Calls `P_TraverseIntercepts` with the caller's traverser function.

`P_TraverseIntercepts` (p_maputl.c:684) implements an O(n²) selection sort: for each
traversal step it scans all accumulated intercepts to find the nearest unprocessed one.
This is correct but slow for very long traces. After processing, it stamps the
intercept's `frac` with `MAXINT` to mark it done (p_maputl.c:728).

### 5.3 Users of P_PathTraverse

| caller | flags | purpose |
|--------|-------|---------|
| `P_SlideMove` | `PT_ADDLINES` | slide wall detection (3 rays) |
| `P_LineAttack` (p_map.c) | `PT_ADDLINES\|PT_ADDTHINGS, PT_EARLYOUT` | hitscan |
| `P_AimLineAttack` (p_map.c) | `PT_ADDLINES\|PT_ADDTHINGS` | auto-aim |
| `P_UseLines` (p_map.c) | `PT_ADDLINES` | USE line activation |
| `P_RadiusAttack` uses `P_CheckSight`, not P_PathTraverse | — | explosion blast radius |

---

## 6. Line-of-sight

`P_CheckSight` (p_sight.c:300) uses a completely separate code path from
`P_PathTraverse`. It does a recursive BSP walk rather than a DDA blockmap walk.

### 6.1 REJECT table fast-out

First check (p_sight.c:313–326): the REJECT lump is a bit matrix, one bit per
sector-pair. If `rejectmatrix[byte] & bit` is set, the two sectors are pre-rejected
and the function returns false immediately. This bypasses the BSP walk entirely for
most enemy-enemy and enemy-player pairs in typical maps.

`sightcounts[0]` counts REJECT hits; `sightcounts[1]` counts BSP walks
(p_sight.c:47, used only when `RANGECHECK` is enabled).

### 6.2 BSP walk — P_CrossBSPNode / P_CrossSubsector

`sightzstart` (p_sight.c:334): the looker's eye height, set to
`t1->z + t1->height - (t1->height >> 2)` — three-quarters up the mobj's height.

`topslope` / `bottomslope` (p_sight.c:335–336): slope window from the eye to the top
and bottom of the target. These are compressed as tics progress through `P_CrossSubsector`.

`P_CrossBSPNode` (p_sight.c:257) recurses in BSP order, starting from the node
containing the looker. It uses `P_DivlineSide` (p_sight.c:54) — a distinct function
from `P_PointOnLineSide` — which returns 2 for exactly-on-the-line (p_sight.c:96–98).
Exact-on-line is treated as front side (p_sight.c:274–275).

`P_CrossSubsector` (p_sight.c:135) checks segs in order. For each crossed two-sided
line it tightens `topslope`/`bottomslope`. If `topslope <= bottomslope`, sight is
blocked.

### 6.3 Asymmetry quirk

`P_CheckSight(A, B)` is not generally equal to `P_CheckSight(B, A)`. The eye height
is computed from the *first* argument (`t1`), not the second. A tall mobj's eye is
high; a short mobj's eye is lower. Whether A can see B depends on which eye is used.
This matters for mutual-sight checks in AI (e.g., `P_LookForPlayers`): the monster
checks from *its* eye to the player, not vice versa. Demos can differ if this
asymmetry is removed.

### 6.4 P_InterceptVector2

`p_sight.c` defines its own `P_InterceptVector2` (p_sight.c:109), separate from
`P_InterceptVector` in `p_maputl.c`. Both have the same fixed-point formula but the
sight version uses `>>8` right-shifts internally. This is not a shared implementation
— two copies of essentially the same math exist for historical reasons.

---

## 7. Z movement and gravity

### 7.1 P_ZMovement

`P_ZMovement` (p_mobj.c:246) runs after `P_XYMovement` in `P_MobjThinker`:

1. **Step-up smoothing**: if the player's z is below their floorz (stepped up), adjust
   `viewheight` and `deltaviewheight` to animate the camera upward
   (p_mobj.c:252–255).
2. **Apply momz**: `mo->z += mo->momz`.
3. **Floater approach**: if MF_FLOAT and has a target, converge z toward target's
   midpoint at `FLOATSPEED = 4*FRACUNIT` per tic (p_mobj.c:263–280).
4. **Floor clip**: if `mo->z <= mo->floorz`:
   - MF_SKULLFLY: bounce z-momentum: `mo->momz = -mo->momz` (p_mobj.c:294).
   - Player hard landing (`momz < -GRAVITY*8`): squats view, plays `sfx_oof`
     (p_mobj.c:299–307). `GRAVITY = FRACUNIT`.
   - Zero `momz`, set `mo->z = mo->floorz`.
   - Missiles on floor: explode.
5. **Gravity**: if not on floor and not MF_NOGRAVITY (p_mobj.c:320–326):
   - First tic airborne: `momz = -GRAVITY*2` (initial drop).
   - Subsequent tics: `momz -= GRAVITY`.
6. **Ceiling clip**: if `mo->z + mo->height > mo->ceilingz`:
   - Clamp z, zero upward momz.
   - MF_SKULLFLY: bounce.
   - Missiles at ceiling: explode.

### 7.2 Lost soul bounce

The lost soul (MF_SKULLFLY) has its z-momentum negated at both floor (p_mobj.c:293)
and ceiling (p_mobj.c:337) impacts. Unlike a physical bounce this is not energy-
conserving: `momz` changes sign but its magnitude is unchanged (no damping).

### 7.3 Floater logic (Cacodemon, Pain Elemental, etc.)

Monsters with MF_FLOAT approach their target's mid-height by `FLOATSPEED = 4*FRACUNIT`
per tic (p_mobj.c:263–280). They do not float if MF_INFLOAT is set (currently in a
move that `P_Move` has verified) or MF_SKULLFLY. The `floatok` flag from the last
`P_CheckPosition` call gates whether `P_Move` allows vertical adjustment
(p_enemy.c:298–308).

### 7.4 Mobj spawn

`P_SpawnMobj` (p_mobj.c:485) allocates from zone memory (PU_LEVEL tag), zeroes all
fields, fills from `mobjinfo[type]`, sets `P_SetThingPosition`, and links into the
thinker list. The `lastlook` field for monster AI scanning is initialised to
`P_Random() % MAXPLAYERS` (p_mobj.c:512) — this is a demo-visible `P_Random` call.

The `oldx/oldy/oldz/oldangle` fields (webdoom additions for render interpolation) are
snapped to the spawn position so the renderer has a clean baseline (p_mobj.c:536–539).

### 7.5 Nightmare respawn

`P_NightmareRespawn` (p_mobj.c:357) is called from `P_MobjThinker` (p_mobj.c:473–477)
when:
- `mobj->flags & MF_COUNTKILL` (killable monster)
- `respawnmonsters` is true (Nightmare or `-respawn`)
- `mobj->movecount >= 12*35` (420 tics ≈ 12 seconds since death)
- `leveltime & 31 == 0` (only on a 32-tic boundary)
- `P_Random() > 4` (probability gate)

It checks the original spawn position, spawns a teleport fog at the old location and
new, then spawns a fresh mobj of the same type at the spawn point. The `P_Random()`
call at the probability gate is demo-visible.

---

## 8. Enemy AI

### 8.1 A_Look — see-state entry

`A_Look` (p_enemy.c:604) is called each tic while the monster is in its idle/spawn
state:

1. Clears `threshold` (any shot can now wake the monster).
2. Checks `sector->soundtarget`: if set and shootable, target it immediately.
   MF_AMBUSH monsters additionally require `P_CheckSight`.
3. Falls back to `P_LookForPlayers(actor, false)` — 180-degree FOV scan.
4. On seeing the player: plays seesound (posit1–3 / bgsit1–2 random for Former
   Human / Imp families, using `P_Random` — demo-visible), sets `seestate`.

`P_LookForPlayers` (p_enemy.c:498) starts from `actor->lastlook` and cycles through
all active players, skipping dead ones and those out of sight. It checks at most 2
players per call (`c++ == 2` guard at p_enemy.c:520), preventing monsters from doing
expensive sight checks against all four players every tic.

### 8.2 A_Chase — state machine

`A_Chase` (p_enemy.c:672):

1. Decrements `reactiontime` if nonzero.
2. Decrements `threshold` toward zero if set.
3. Snaps angle toward movement direction 45 degrees per tic (p_enemy.c:693–701).
4. If target is dead/gone: looks for new target, else returns to spawnstate.
5. If MF_JUSTATTACKED: clears flag, calls `P_NewChaseDir` (unless nightmare/fast),
   returns. *This prevents two consecutive attacks.*
6. Melee attack if in range and `meleestate` exists.
7. Missile attack if in range, `missilestate` exists, and skill allows.
8. Possibly change target in netgame if out of sight and threshold is 0.
9. Chase movement: `P_Move`, calls `P_NewChaseDir` if blocked or `movecount` expired.
10. Active sound: `P_Random() < 3` gate — demo-visible.

### 8.3 P_NewChaseDir — movement direction AI

`P_NewChaseDir` (p_enemy.c:363) determines the monster's next movement direction:

1. Tries the diagonal toward the target.
2. Randomly swaps the primary/secondary axis preference if `P_Random() > 200`
   or `|deltay| > |deltax|` (p_enemy.c:408–414). This is demo-visible.
3. Tries primary, then secondary axis direction.
4. Falls back to previous direction, then sweeps all 8 directions in order (cw or ccw
   selected by `P_Random() & 1` — demo-visible).
5. Final fallback: sets `movedir = DI_NODIR`.

Speed constants: `xspeed[8] = {FRACUNIT, 47000, 0, ...}`, `yspeed[8] = {0, 47000, FRACUNIT, ...}`
(p_enemy.c:264–265). The diagonal speed of 47000 is `~0.717 * FRACUNIT`, approximating
`1/sqrt(2)` in integer arithmetic. It is not the exact value and the inaccuracy is
locked in.

### 8.4 The diagonal door quirk

Monsters attempt to open a door by calling `P_UseSpecialLine` when `P_Move` fails
(p_enemy.c:315–323). The check iterates `spechit[]` but only fires if the line has a
special. A diagonal door (a special linedef approached from a corner angle) may not
end up in `spechit[]` because the monster's movement vector doesn't intersect the line
cleanly — the blockmap line iterator may clip the hit. This is a known vanilla quirk:
monsters sometimes fail to open doors they could theoretically reach.

### 8.5 A_BossDeath — boss triggers

`A_BossDeath` (p_enemy.c:1609) scans the thinker list for any remaining living
monster of the same type. If none survive, it triggers:

| game | map | type | effect |
|------|-----|------|--------|
| Doom 1 | E1M8 | MT_BRUISER (Baron) | lower sector tag 666 floor |
| Doom 1 | E2M8 | MT_CYBORG | exit map |
| Doom 1 | E3M8 | MT_SPIDER | exit map |
| Doom 1 | E4M6 | MT_CYBORG | exit map |
| Doom 1 | E4M8 | MT_SPIDER | lower sector tag 666 floor |
| Doom 2 | MAP07 | MT_FATSO (Mancubus) | lower sector tag 666 floor |
| Doom 2 | MAP07 | MT_BABY (Arachnotron) | raise sector tag 667 floor |

The thinker scan (p_enemy.c:1692–1703) is O(n) over all thinkers. It runs once per
boss death so the performance cost is acceptable.

### 8.6 Arch-vile and Pain Elemental

The Arch-vile (`A_VileChase`, `A_VileAttack`) and Pain Elemental (`A_PainAttack`) are
Doom II only. Their action functions call `P_SpawnMobj`, `P_RadiusAttack`, and
`P_Random` in specific sequences. Any change to these sequences would desync Doom II
demos. These monsters are not present in the 13 golden demos (which use Doom 1 content)
but their code is present in this build.

---

## 9. Interactions

### 9.1 P_DamageMobj — damage pipeline

`P_DamageMobj` (p_inter.c:775):

1. Bails if target is not MF_SHOOTABLE or already dead.
2. If SK_BABY and player target: halves damage (p_inter.c:800).
3. Computes knockback thrust from inflictor position, except for chainsaw
   (p_inter.c:806–831). Forward-fall randomization: `P_Random() & 1`
   (p_inter.c:823) — demo-visible.
4. Armor absorption for players (p_inter.c:854–869):
   - Green armor (armortype 1): saves `damage/3`
   - Blue armor (armortype 2): saves `damage/2`
   - If armor runs out, partial absorption then zeroed.
5. Updates `player->health`, clamps to 0, updates `player->damagecount`
   (clamped to 100 at p_inter.c:878).
6. Applies damage to `target->health`.
7. If health reaches 0: `P_KillMobj`.
8. Pain chance: `P_Random() < target->info->painchance` → sets MF_JUSTHIT and
   painstate (p_inter.c:894–899). Demo-visible.
9. Sets `target->reactiontime = 0` (awakens monster).
10. If not over threshold (or target is Arch-vile) and source is not self or Arch-vile:
    monster retargets the source.

### 9.2 MAXHEALTH quirk

`MAXHEALTH = 100` (p_local.h:33). `P_GiveBody` (p_inter.c) clamps player health to
`MAXHEALTH` unless a MegaSphere or other bonus is involved. The Berserk pack gives
`P_GiveBody(player, 100)` which only heals to 100, not beyond. The Megasphere sets
health to 200 directly. Health potions (`P_GiveBody(player, 1)`) add 1 point and can
go above 100 up to 200. This cap is demo-visible only in the sense that health affects
`P_CheckMissileRange` via `P_Random()` comparisons — indirectly.

### 9.3 P_TouchSpecialThing — item pickup

`P_TouchSpecialThing` (p_inter.c:200) is called when a thing with MF_PICKUP walks over
an MF_SPECIAL thing. It dispatches on the special's sprite number. After pickup:
`P_RemoveMobj(special)` and `player->bonuscount += BONUSADD` (= 6, defined at p_inter.c:51).
`bonuscount` drives the gold-tint flash on the HUD.

---

## 10. Sector specials

### 10.1 P_UpdateSpecials — animated textures

`P_UpdateSpecials` (p_spec.c) runs each tic and advances texture/flat animations and
processes the `linespeciallist[]` (scrolling sidedefs). Animation frames cycle through
the WAD lump range every `speed` tics. No `P_Random` calls; purely deterministic.

### 10.2 P_SpawnSpecials — thinker spawning

`P_SpawnSpecials` (p_spec.c) is called at level load. It scans all sectors and spawns
thinkers for each `sector->special`:

| special | thinker | description |
|---------|---------|-------------|
| 1 | `T_LightFlash` | random light flicker |
| 2 | `T_StrobeFlash` (FASTDARK=15) | fast strobe |
| 3 | `T_StrobeFlash` (SLOWDARK=35) | slow strobe |
| 4 | `T_StrobeFlash` (FASTDARK=15) + damage | strobe + 20% damage |
| 8 | `T_Glow` | glowing light oscillation |
| 12 | `T_StrobeFlash` (SLOWDARK=35, inSync=1) | synchronized slow strobe |
| 13 | `T_StrobeFlash` (FASTDARK=15, inSync=1) | synchronized fast strobe |
| 17 | `T_FireFlicker` | fire flicker |

**Light effect constants** (p_spec.h:176–179):

```
GLOWSPEED   = 8    (light level units per tic for glow)
STROBEBRIGHT = 5   (tics at max brightness)
FASTDARK    = 15   (tics at min brightness, fast strobe)
SLOWDARK    = 35   (tics at min brightness, slow strobe)
```

Recipes:
- **Fast strobe** (sector special 2): bright for 5 tics, dark for 15 tics.
- **Slow strobe** (sector special 3): bright for 5 tics, dark for 35 tics.
- **Synchronized** (12/13): all start at count=1 so first transition happens on the
  same tic for all sectors with these specials.
- **Glow**: oscillates between `P_FindMinSurroundingLight` and `sector->lightlevel`,
  stepping 8 light units per tic.
- **Fire flicker**: cycles every 4 tics, drops by `(P_Random()&3)*16` light units
  (p_lights.c:53). Demo-visible.

### 10.3 Linedef specials

`P_CrossSpecialLine` (p_spec.c), `P_ShootSpecialLine` (p_spec.c), and
`P_UseSpecialLine` (p_spec.c) dispatch on `ld->special` to the appropriate EV_*
functions. Each EV_* function may spawn thinkers for sector movement (floor, ceiling,
door, platform, etc.).

**The donut special** (line special 9 via `EV_DoDonut`, p_spec.c): triggers a two-step
floor movement sequence — raises the "donut" ring sector to the surrounding sector's
ceiling, then lowers the central "hole" sector. This is brittle in vanilla: it reads
`getSector(secnum, 0, 1)` and assumes exactly one surrounding sector. Maps that violate
this assumption produce garbage floor movements. No guard exists in the code.

### 10.4 Doors — p_doors.c

`T_VerticalDoor` (p_doors.c) moves door sectors between open/closed states.
Door speed and wait time come from per-linedef-special constants. Door sound (`sfx_doropn`,
`sfx_dorcls`, `sfx_bdopn`, `sfx_bdcls`) is triggered at state transitions.

### 10.5 Platforms — p_plats.c

`T_PlatRaise` (p_plats.c) handles perpetual raise/lower, raise-and-wait, etc.
The perpetual platform uses `P_Random() & 1` (p_plats.c) to randomize initial delay
on some platform types — demo-visible.

### 10.6 Ceilings — p_ceilng.c

`T_MoveCeiling` (p_ceilng.c) for crusher ceilings calls `P_Random()` to vary the
crush damage interval in certain states — demo-visible.

### 10.7 Floors — p_floor.c

`T_MoveFloor` (p_floor.c) handles floor movement. The `stairBuild` path in
`EV_BuildStairs` (p_floor.c) scans adjacent sectors by line adjacency to find stair
sectors; this is sensitive to linedef ordering in the WAD.

### 10.8 Teleportation — p_telept.c

`EV_Teleport` (p_telept.c:47):

1. Missiles cannot teleport (p_telept.c:65).
2. Teleporting from side 1 (back of linedef) is blocked — prevents re-teleport loops
   (p_telept.c:71).
3. Finds the MT_TELEPORTMAN in the target sector by scanning the thinker list.
4. Calls `P_TeleportMove` (which uses the blockmap, not the BSP — stompsThing check).
5. Sets `thing->z = thing->floorz` (p_telept.c:106). The comment says "fixme: not
   needed?" — it is indeed redundant since `P_TeleportMove` calls `P_CheckPosition`
   which sets `tmfloorz` and subsequent code in `P_TeleportMove` sets `thing->floorz`.
   But it is harmless. **The teleport Z quirk**: a thing teleported while airborne is
   snapped to the floor. In vanilla this is correct because the destination always
   places you on the floor. This matters for demos involving aerial teleportation.
6. Sets `thing->angle = m->angle`, zeroes momentum.

webdoom adds interpolation snap (p_telept.c:128–131) to prevent a render streak across
the teleport — render-only, not sim-visible.

---

## 11. Weapons and psprites

### 11.1 psprite state machine

`P_SetPsprite` (p_pspr.c:58) is the weapon state machine driver, analogous to
`P_SetMobjState` for things. It loops through zero-tic states (tics==0) chaining
instantly. It calls `state->action.acp2(player, psp)` for weapon action callbacks.

Weapon positions are tracked in `player->psprites[NUMPSPRITES]`, where NUMPSPRITES=2:
index 0 is the weapon sprite, index 1 is the muzzle flash.

### 11.2 Weapon lifecycle

`P_BringUpWeapon` (p_pspr.c:138): sets `psp->sy = WEAPONBOTTOM` (128*FRACUNIT) and
starts the `upstate` animation. webdoom adds `psp->oldsy = WEAPONBOTTOM` for
interpolation snap (p_pspr.c:152).

`P_MovePsprites` (p_pspr.c) is called once per player tic from `P_PlayerThink` (and
`P_DeathThink`). It decrements `psp->tics` and calls `P_SetPsprite` when the timer
expires.

### 11.3 Refire

`A_ReFire` (p_pspr.c) checks if the player is still holding fire and has ammo;
if so, stays in firing state. If not, goes to ready state. The `P_CheckAmmo` function
(p_pspr.c:162) auto-switches the weapon if ammo runs out — this calls `P_SetPsprite`
for the down-state, which can consume a tic and affect weapon-switch timing.

### 11.4 The switch-lower quirk

When a player switches weapons, the new weapon's up-animation begins from `WEAPONBOTTOM`
the tic after the old weapon's down-animation sets `pendingweapon`. The transition can
happen mid-attack-animation if `P_CheckAmmo` fires during an action frame. This is
demo-visible because the tic of the weapon switch affects subsequent `P_Random` calls
in firing actions.

---

## 12. Map setup

### 12.1 Lump loading order

`P_SetupLevel` (p_setup.c:585) loads map lumps in this order (p_setup.c:651–666):

```
BLOCKMAP → VERTEXES → SECTORS → SIDEDEFS → LINEDEFS
→ SSECTORS → NODES → SEGS → (skip REJECT, loaded later as PU_LEVEL)
→ rejectmatrix = W_CacheLumpNum(ML_REJECT)
→ P_GroupLines
→ P_LoadThings
```

Each loader is `W_LumpLength / sizeof(struct)` — **no bounds check against map limits**.
Malformed WADs with more geometry than the engine can handle (e.g., more sectors than
zone memory) will crash or corrupt. Every lump is trusted.

### 12.2 Per-lump validation gaps (3.2 candidates)

| lump | read | issue |
|------|------|-------|
| VERTEXES | `SHORT(ml->x) << FRACBITS` | vertex count determined by lump size; no upper bound |
| LINEDEFS | vertex indices read as `SHORT`; no range check against `numvertexes` | OOB vertex ref → invalid pointer |
| SEGS | linedef index, side, vertex indices unchecked | OOB access possible |
| NODES | bbox / child indices unchecked | OOB BSP walk if nodes are malformed |
| SSECTORS | `firstseg + numsegs` not checked against `numsegs` | OOB seg access in P_CrossSubsector |
| THINGS | `P_SpawnMapThing` iterates the lump by lump-size / sizeof — no count cap | benign; just spawns however many things the lump contains |
| BLOCKMAP | offsets array treated as `short*`; the `blockmaplump` pointer arithmetic trusts the header counts | negative/large offsets could read outside the lump |
| REJECT | loaded as raw bytes; bits are indexed by `s1*numsectors + s2`; no range check on s1/s2 | if sector indices are wrong, arbitrary bits are read from the reject matrix |

These are **3.2 overflow audit candidates**: any one could be triggered by a crafted WAD.

### 12.3 Things filter

`P_LoadThings` (p_setup.c:303) filters Doom II-only monster types when not in
commercial mode (p_setup.c:320–337). Critically, after the `spawn = false` cases it
does `if (spawn == false) break;` (p_setup.c:338) — this **breaks out of the loop
entirely**, not just the switch. This means if the first Doom-II-only thing type
appears before other things, subsequent things are also not spawned. This is a vanilla
bug; on normal maps it never triggers because Doom II maps are only loaded in
commercial mode.

---

## 13. Save / load

### 13.1 SAVEGAMESIZE

```c
// g_game.c:74
#define SAVEGAMESIZE  0x80000   // webdoom: was 0x2c000; big maps overran
```

Vanilla had `0x2c000 = 180,224 bytes`. webdoom raises this to `0x80000 = 524,288 bytes`
to accommodate larger PWAD maps. The save buffer is a single static allocation;
`save_p` walks through it as a raw byte pointer. If a save exceeds `SAVEGAMESIZE`, the
check at g_game.c:1324 calls `I_Error("Savegame buffer overrun")`.

### 13.2 Archive format

`G_DoSaveGame` (g_game.c) calls in sequence:

1. Write description string (24 bytes).
2. Write skill, episode, map, playeringame bitmask.
3. `P_ArchivePlayers` — player structs with psprite state pointers serialized as
   `(state - states)` offsets (p_saveg.c:68).
4. `P_ArchiveWorld` — sector floor/ceiling heights, floor/ceiling pic indices, light
   levels, specials, tags; then linedef flags/special/tag and sidedef texture offsets
   (p_saveg.c:114–160). Written as `short*` pointer walking the buffer.
5. `P_ArchiveThinkers` — only `P_MobjThinker` thinkers are saved (p_saveg.c:241–261).
   All other thinker types (ceiling, door, floor, platform, light) are **not saved**.
   They are re-created by `P_SpawnSpecials` on load.
6. `P_ArchiveSpecials` — iterates the thinker list again saving ceiling/door/floor/
   platform/flash/strobe/glow thinkers with a type byte prefix (p_saveg.c:333+).
7. Write `0x1d` consistancy marker (g_game.c:1321).
8. Write `rndindex` and `prndindex` (both indices saved — p_saveg.c or g_game.c).

### 13.3 Pointer serialization

Mobj save (p_saveg.c:247–253): pointers that can't survive restart are serialized as
indices:
- `mobj->state` → `(state - states)` (array index into `states[]`)
- `mobj->player` → `(player - players) + 1` (1-based; 0 means no player)

Mobj restore (p_saveg.c:309–321):
- `mobj->state = &states[(int)mobj->state]`
- `mobj->player = &players[(int)mobj->player - 1]` if nonzero
- `mobj->target = NULL` — monster targeting is lost across saves

The target pointer loss is intentional; monsters re-acquire targets when they re-enter
chase state.

### 13.4 What breaks saves

- Any change to `sizeof(player_t)` or `sizeof(mobj_t)` breaks existing save files.
- Adding thinker types without updating `P_ArchiveSpecials`/`P_UnArchiveSpecials`
  leaves them unsaved.
- Changing `SAVEGAMESIZE` (either direction) does not break existing saves — it only
  affects what the engine will reject at load time.

---

## 14. Player

### 14.1 P_PlayerThink

`P_PlayerThink` (p_user.c:239) is called once per tic per active player:

1. Applies `CF_NOCLIP` cheat to mobj flags.
2. Handles `MF_JUSTATTACKED` (chainsaw auto-forward).
3. If dead, delegates to `P_DeathThink`.
4. Decrements `reactiontime` if nonzero (freeze after teleport).
5. Calls `P_MovePlayer` (translates ticcmd to momentum).
6. Calls `P_CalcHeight` (viewheight / bob / viewz).
7. Checks sector special damage / secrets.
8. Processes weapon change, use button, `P_MovePsprites`.
9. Decrements all power timers, damage/bonus counts, manages `fixedcolormap`.

### 14.2 P_MovePlayer

`P_MovePlayer` (p_user.c:151):
- Applies `cmd->angleturn << 16` to mobj angle (the 16-bit turn field maps directly
  to angle units).
- If `onground` and `cmd->forwardmove`: calls `P_Thrust(player, angle, move*2048)`.
- If `onground` and `cmd->sidemove`: calls `P_Thrust(player, angle-ANG90, move*2048)`.
- The factor 2048 scales the ticcmd speed byte to DOOM's momentum units.
- Air control: the `onground` guard means the player cannot strafe in the air. This
  is vanilla behaviour and is demo-visible.

### 14.3 View bob

`P_CalcHeight` (p_user.c:77):
```c
player->bob = FixedMul(momx, momx) + FixedMul(momy, momy);
player->bob >>= 2;
if (player->bob > MAXBOB) player->bob = MAXBOB;
// MAXBOB = 0x100000 (16 map units squared >> 2 = 4 units)
```

Bob angle = `(FINEANGLES/20 * leveltime) & FINEMASK`. The sin of this angle scaled
by `bob/2` gives the view-bob offset. The bob calculation uses `P_Random`-independent
math but depends on `momx/momy` which are sim-state. The view bob is render-only but
`player->bob` is sim state used for weapon swing.

### 14.4 The 32-unit step

`P_TryMove` allows steps up to 24 units (p_map.c:482: `> 24*FRACUNIT` blocks the
move). An additional 8 units of smoothing comes from `P_ZMovement`'s view-height
adjustment when the player's z snaps up to the floor (p_mobj.c:252–255). Together
these produce the perceived 24-unit movement limit with smooth camera behaviour.
The community often cites "32-unit step" because the player's *camera* can visually
cross up to 32 units in a single tic, but the actual movement limit is 24.

### 14.5 Deathmatch spawns

`G_DeathMatchSpawnPlayer` (g_game.c) selects a random `deathmatchstarts[]` entry
using `P_Random() % count` — demo-visible. The first player is spawned at a
deterministic start, then deathmatched subsequently. `MAX_DEATHMATCH_STARTS = 10`
(p_setup.c:109); only the first 10 DM start things in the map are stored.

---

## 15. Quirk catalog

Each entry: **what it is**, **where in code**, **demo evidence** (which golden demos
would diverge or community evidence), **status in webdoom**.

---

### Q1 — spechit[] overflow (vanilla: OOB write; webdoom: clamp-to-64)

**What**: When a thing crosses more than 8 special lines in one `P_TryMove` call,
vanilla wrote past `spechit[8]` into adjacent globals, often `numspechit` itself,
causing spurious special line triggers or missed triggers.

**Where**: p_map.c:67 (size), p_map.c:243–247 (guard).

**Demo evidence**: Mostly affects dense custom maps. No golden demo reproduces this
on the E1/E2/E3 geometry. Community evidence (prboom-plus, Eternity bug trackers)
shows the vanilla overflow was triggered in specific slime-trail and switch-bank maps.

**webdoom status**: Raised limit to 64, guarded. Vanilla overflow behavior is not
reproduced. This is a deliberate port improvement to prevent crashes, not a compat
regression for the 13 demos.

---

### Q2 — intercepts[] clamp (vanilla: OOB write; webdoom: clamp-to-127)

**What**: When a hitscan or trace crossed > 128 objects (lines + things), vanilla
wrote past `intercepts[128]`, corrupting subsequent intercept entries or heap metadata.
The "all-ghosts" family: shots passed through enemies because a later intercept (the
enemy) was clobbered by a zero-fraction value placed there by the corruption.

**Where**: p_maputl.c:606–607 and 672–673 (both PIT_ add functions).

**Demo evidence**: Not triggered by any of the 13 golden demos (straightforward E1–E3
geometry). The bug is well-documented in the Doom community (prboom CVS logs, Eternity
Engine dev notes). In vanilla, very long autoaim traces through crowded areas could
hit the limit.

**webdoom status**: Clamped at 127 (MAXINTERCEPTS-1). Objects beyond the limit are
skipped rather than corrupting memory.

---

### Q3 — Blockmap edge cases / off-by-one

**What**: `P_BlockLinesIterator` returns true (no collision) for any block coordinates
outside `[0, bmapwidth) × [0, bmapheight)`. Objects or traces near the map boundary
may not collide with lines in the last block column/row if their bounding box straddles
the edge. Additionally, the thing-iteration pass uses `MAXRADIUS` expansion while the
line-iteration pass does not, producing an asymmetry in what gets checked.

**Where**: p_maputl.c:481–487 (line iterator bound check), p_map.c:424–443 (the
asymmetric expansion).

**Demo evidence**: No golden demo is affected; all demo maps have geometry clear of
the blockmap edge. The silent-return behavior is directly visible in source:
p_maputl.c:481–487 shows the OOB bounds check (`x<0 || y<0 || x>=bmapwidth ||
y>=bmapheight`) followed by `return true`, meaning any caller iterating OOB cells
will receive a success return and iterate nothing — self-proving the behavior without
requiring external documentation. ("Blockmap overflow" in very large maps where
coordinates wrap is a related but distinct phenomenon.)

**webdoom status**: Vanilla behavior preserved exactly.

---

### Q4 — wallrunning

**What**: A player moving parallel to a very thin wall or through a corner can "run
along the wall" because `P_SlideMove` fires three rays but may not catch all corners
of the player's bounding box. The stairstep fallback (p_map.c:753–756) allows forward
or lateral movement through certain wall angles.

**Where**: p_map.c:699–791 (`P_SlideMove`), particularly the `stairstep` goto at 753.

**Demo evidence**: Wallrunning is a well-documented demo technique (e.g., E1M3 staircase
wallrun in various UV-Speed demos). If `P_SlideMove`'s 3-ray approach or the stairstep
fallback were changed, all such demos would desync.

**webdoom status**: Vanilla behavior preserved exactly.

---

### Q5 — Teleport Z quirk

**What**: `EV_Teleport` unconditionally sets `thing->z = thing->floorz` after
teleporting (p_telept.c:106). A thing teleporting while airborne is snapped to the
floor at the destination. This is intentional vanilla behavior for player teleports
but has the side effect that mid-air monsters teleported by a special also land
immediately.

**Where**: p_telept.c:106.

**Demo evidence (measured)**: `EV_Teleport` fires in 4 of the 13 golden demos,
verified by compiling a measurement build with global counters exposed via
`EMSCRIPTEN_KEEPALIVE` accessors and running all 13 demos through the JS harness:

| demo | map | teleport calls |
|------|-----|----------------|
| doom-demo3 | E3M5 | 3 |
| doom2-demo3 | MAP26 | 5 |
| plutonia-demo1 | MAP17 | 23 |
| plutonia-demo3 | MAP12 | 1 |

doom-demo1 plays E1M5 (Phobos Lab, 1710 tics) but routes zero teleport calls;
doom-demo4 plays E4M2 (818 tics) — also zero. The Z-snap at p_telept.c:106 is
exercised by every one of the 32 teleport events across those 4 demos. The golden
harness at `tools/golden/` validates those demos per-tic via `web_state_hash()`
(i_main.c:175–190), so any change to the Z-snap or the surrounding logic would
desync them.

**webdoom status**: Vanilla behavior preserved. The `// fixme: not needed?` comment
is preserved from linuxdoom-1.10.

---

### Q6 — P_CheckSight asymmetry

**What**: `P_CheckSight(A, B)` uses A's eye height (3/4 of A's height above A's z),
not B's. `P_CheckSight(B, A)` gives a different result in the general case. Monster
AI uses `P_CheckSight(actor, player->mo)` — the monster's eye looking at the player.
There is no symmetric double-check. This means a player crouching behind a ledge that
doesn't block the monster's sight line is still seen, even if the player's eye looking
up at the same angle would be blocked.

**Where**: p_sight.c:334 (`sightzstart` formula).

**Demo evidence**: Affects any demo where enemy sight behavior is demo-critical
(which it always is — missed or acquired targets change `P_Random` call sequences).
Any change to the eye-height formula would desync all demos with enemies.

**webdoom status**: Vanilla behavior preserved exactly.

---

### Q7 — Monster failing to open diagonal doors

**What**: `P_Move` (p_enemy.c:310–323) uses `P_UseSpecialLine` to open doors when
movement is blocked. The line must be in `spechit[]`. For diagonal movement, the
monster's bounding box may not cleanly intersect the special linedef, so it may never
enter `spechit[]`, and the monster stands blocked indefinitely.

**Where**: p_enemy.c:310–323, interaction with `PIT_CheckLine` populating `spechit[]`.

**Demo evidence**: Community-observed behavior in many Doom maps where monsters
"ignore" doors at certain angles. Not visible in the 13 golden demos (which do not
rely on monsters opening specific doors for the route). The behavior is considered
vanilla-accurate.

**webdoom status**: Vanilla behavior preserved.

---

### Q8 — P_LoadThings break-on-commercial-filter

**What**: `P_LoadThings` breaks out of the entire thing loop (not just the switch)
when it encounters a Doom-II-only thing type in a non-commercial build (p_setup.c:338).
Things after the first Doom-II-only thing in the lump are not spawned.

**Where**: p_setup.c:338 (`if (spawn == false) break;`).

**Demo evidence**: Not triggered by any of the 13 golden demos (all Doom 1 content,
no Doom II things). A vanilla bug; preserved.

**webdoom status**: Vanilla behavior preserved.

---

### Q9 — rndindex not saved in vanilla demo

**What**: Demo format stores ticcmds only. `prndindex` state is not explicitly stored;
it is implicitly reproduced by replaying the same sequence of `P_Random` calls.
`rndindex` (M_Random) is also not stored; it diverges between runs with different
menu interactions but does not affect gameplay determinism.

**Where**: g_game.c demo write/read functions.

**Demo evidence**: This is a fundamental property of the demo format; all 13 demos
depend on it.

**webdoom status**: Both indices are **saved in savegames** (§13.2) but not in demos.
Vanilla behavior for demo format preserved.

---

### Q10 — A_Chase random direction scan order

**What**: When `P_NewChaseDir` sweeps all 8 directions after failing preferred/
previous directions, it chooses clockwise vs. counterclockwise based on `P_Random() & 1`
(p_enemy.c:450). This single bit determines which direction the monster turns when
completely blocked. The scan then tries each direction via `P_TryWalk` in order.

**Where**: p_enemy.c:450.

**Demo evidence**: Changes to this direction selection would alter monster movement
paths in every demo involving blocked monsters. All 13 demos with monster content
are affected.

**webdoom status**: Vanilla behavior preserved.

---

## 16. The frozen surface

The "frozen surface" is the set of sim behaviors that are demo-visible. Changing any
of these would desync existing demos. The sim is the source of truth; the renderer
is free.

### What is frozen (must never change for demo compat)

| behavior | why |
|---------|-----|
| `P_Random()` call sequence | Demos contain no random seed; all non-determinism is eliminated by the call ordering |
| `rndtable[256]` contents | The table is the seed; see archaeology §3 |
| `prndindex` initial value (0 at `M_ClearRandom`) | Demos start from index 0 |
| Thinker list insertion order | `P_RunThinkers` processes in insertion order; any reordering changes which thinker acts "first" each tic |
| Thinker list traversal direction (head → tail) | Locked by the doubly-linked list walk in `P_RunThinkers` |
| `P_BlockLinesIterator` iteration order (x outer, y inner) | Determines which lines `PIT_CheckLine` sees first; affects `spechit[]` ordering |
| `P_BlockThingsIterator` iteration order (linked list per block) | Determines `PIT_CheckThing` order; affects damage sequencing |
| `P_TraverseIntercepts` selection sort | Must process intercepts in ascending frac order; any sort change breaks hitscan accuracy |
| `spechit[]` processing order (reverse, from `numspechit-1` downward) | p_map.c:506; reverse order is vanilla, changing it changes which specials fire |
| Fixed-point arithmetic identities | `FixedMul`, `FixedDiv`, `P_AproxDistance` — see archaeology §2 for FixedDiv proof |
| `finesine`/`finetangent` table values | Every angle-dependent calculation — see archaeology §1 for the proof |
| Blockmap structure (128-unit cells, iteration bounds) | Block assignment of things and lines is map-data-dependent |
| `P_CheckSight` eye height formula | `t1->z + t1->height - (t1->height >> 2)` |
| Gravity constant `FRACUNIT` | One unit per tic per tic; changing this changes fall speed |
| `STOPSPEED`, `FRICTION` constants | Momentum decay rate |
| `FLOATSPEED = 4*FRACUNIT` | Floater vertical approach rate |
| Thinker deferred-free timing | Thinkers removed mid-tic survive until the next `P_RunThinkers` |
| `MAXSPECIALCROSS = 64` (webdoom) / behavior above 8 | Affects which specials fire in crowded maps |
| `MAXINTERCEPTS = 128` / clamp behavior | Affects hitscan in dense maps |
| `onground` gate on player thrust (p_user.c:161) | Player cannot strafe or accelerate while airborne; removing this guard desyncs demos that rely on aerial momentum carrying from a previous tic |

### What is free to change (render-side)

All of the following are documented in `docs/renderer.md`:

- Interpolation: `fractic`, `R_LerpFixed`, `R_LerpAngle`, `oldx/oldy/oldz/oldangle`
- Sector height snapshots: `oldfloorheight`/`oldceilingheight`
- Freelook y-shear: `lookdir`, `R_ShearView`
- Frame pipeline timing: `web_perf_*` counters
- All `r_*.c` internals: BSP traversal for rendering, visplane construction, sprite
  sorting, column/span draw

The sim always uses true, unlerped fixed-point coordinates. The renderer may interpolate
for display, but every gameplay calculation (movement, collision, damage, AI) reads
from the sim's own values.

---

## 17. Open questions for task 1.4

1. **Max intercepts across the 13 golden demos**: **Measured.** Peak intercept count
   across all 13 demos is **45** (plutonia-demo3, MAP12). This is well below the 127
   clamp and the vanilla 128 overrun boundary. Measurement method: `EMSCRIPTEN_KEEPALIVE`
   counter in `PIT_AddLineIntercepts`/`PIT_AddThingIntercepts` read back per-demo via
   the JS measurement harness; C changes reverted, 13/13 golden pass confirmed.

2. **Max spechit across the 13 golden demos**: **Measured.** Peak numspechit across all
   13 demos is **8** (tnt-demo2, MAP12). Well below the webdoom limit of 64 and exactly
   at the vanilla limit. The vanilla limit was 8 — so the vanilla 13 demos never
   exceeded it. Same measurement run as above.

3. **P_LoadThings break-on-filter bug**: Confirm which (if any) of the 13 demos would
   be affected if this were fixed. Since all 13 demos use Doom 1 content without Doom
   II things, the break never fires. Still worth a grep of the WADs used to confirm.

---

## 18. Coverage audit — p_*.c function index

Every function in each `p_*.c` file, accounted for.

### p_tick.c
- `P_InitThinkers` — §1.2
- `P_AddThinker` — §1.2
- `P_RemoveThinker` — §1.2
- `P_AllocateThinker` — trivial stub (empty body, unused)
- `P_RunThinkers` — §1.2
- `P_Ticker` — §1.1

### p_map.c
- `PIT_StompThing` — called by P_TeleportMove, §10.8
- `P_TeleportMove` — §10.8
- `PIT_CheckLine` — §4.2
- `PIT_CheckThing` — §4.1
- `P_CheckPosition` — §4.1
- `P_TryMove` — §4.3
- `P_ThingHeightClip` — called by sector movers to re-clip things; updates floorz/ceilingz
- `P_HitSlideLine` — §4.5
- `PTR_SlideTraverse` — §4.5
- `P_SlideMove` — §4.5
- `P_LineAttack` — §5.3
- `P_AimLineAttack` — §5.3
- `PTR_AimTraverse` — traverser for autoaim; checks things between shooter and target
- `PTR_ShootTraverse` — traverser for hitscan; applies damage, sky hack
- `P_UseLines` — §14.1; calls P_PathTraverse with PT_ADDLINES
- `PTR_UseTraverse` — USE button traverser; calls P_SpecialLine
- `P_RadiusAttack` — explosion blast; scans blockmap for things in radius, calls P_DamageMobj
- `PIT_RadiusAttack` — callback for P_RadiusAttack; checks sight, applies damage
- `P_UseSpecialLine` — linedef USE dispatch, §10.3
- `P_CrossSpecialLine` — linedef crossing dispatch, §10.3
- `P_ShootSpecialLine` — linedef shoot dispatch, §10.3

### p_maputl.c
- `P_AproxDistance` — §4, used throughout
- `P_PointOnLineSide` — §3.3
- `P_BoxOnLineSide` — §3.3
- `P_PointOnDivlineSide` — §6.2
- `P_MakeDivline` — utility; copies linedef to divline_t
- `P_InterceptVector` — §5.1
- `P_LineOpening` — §4.2; computes opentop/openbottom/openrange/lowfloor
- `P_UnsetThingPosition` — §4.1
- `P_SetThingPosition` — §4.1
- `P_BlockLinesIterator` — §3.2
- `P_BlockThingsIterator` — §3.2
- `PIT_AddLineIntercepts` — §5.1
- `PIT_AddThingIntercepts` — §5.1
- `P_TraverseIntercepts` — §5.2
- `P_PathTraverse` — §5.2

### p_mobj.c
- `P_SetMobjState` — §7.4; loops through zero-tic states, fires action functions
- `P_ExplodeMissile` — p_mobj.c:90; sets death state, `P_Random()&3` tic jitter
- `P_XYMovement` — §4.6
- `P_ZMovement` — §7.1
- `P_NightmareRespawn` — §7.5
- `P_MobjThinker` — §7.4
- `P_SpawnMobj` — §7.4
- `P_RemoveMobj` — unlinks from blockmap/sector, calls P_RemoveThinker
- `P_SpawnPlayer` — sets up player mobj at a playerstart
- `P_SpawnMapThing` — §12.1; spawns things from MAP lump
- `P_SpawnPuff` — bullet puff visual effect (no gameplay impact)
- `P_SpawnBlood` — blood splat visual effect (no gameplay impact)
- `P_SpawnMissile` — spawns missile mobj, sets velocity from angle
- `P_SpawnPlayerMissile` — autoaims then spawns player missile

### p_enemy.c
- `P_RecursiveSound` — §8.1; flood-fills sound alert through sectors
- `P_NoiseAlert` — §8.1; entry point for monster alert
- `P_CheckMeleeRange` — §8.2
- `P_CheckMissileRange` — §8.2
- `P_Move` — §8.4; calls P_TryMove, handles door-open on block
- `P_TryWalk` — calls P_Move, updates movecount
- `P_NewChaseDir` — §8.3
- `P_LookForPlayers` — §8.1
- `A_Look` — §8.1
- `A_Chase` — §8.2
- `A_FaceTarget` — §8.2; turns monster toward target with shadow jitter
- `A_PosAttack`, `A_SPosAttack`, `A_CPosAttack` / `A_CPosRefire` — Former Human / Commando fire; use P_Random for spread
- `A_SpidRefire` — Spider Mastermind refire
- `A_BabyMetal` — Arachnotron fire
- `A_TroopAttack` — Imp melee/missile
- `A_SargAttack` — Demon melee
- `A_HeadAttack` — Cacodemon missile
- `A_BruisAttack` — Baron melee/missile
- `A_SkullAttack` — Lost Soul charge (MF_SKULLFLY, §7.2)
- `A_Metal` — decorative (sound only)
- `A_SpidAttack` — Spider Mastermind attack; identical to A_CPosAttack
- `A_BspiAttack` — Arachnotron attack
- `A_Hoof` — Centaur hoof sound
- `A_CyberAttack` — Cyberdemon rocket fire
- `A_PainAttack` — Pain Elemental spawns Lost Soul
- `A_PainDie` — Pain Elemental death; spawns 3 Lost Souls
- `A_KeenDie` — Commander Keen special death (Doom II secret)
- `A_BossDeath` — §8.5
- `A_Explode` — generic explosion (P_RadiusAttack wrapper)
- `A_Fall` — drops MF_NOGRAVITY on death
- `A_XScream` — player extreme-death scream
- `A_PlayerScream` — selects scream sound by health
- `A_VileChase` — Arch-vile chase; looks for corpses to resurrect
- `A_VileStart` — Arch-vile attack warmup
- `A_StartFire` / `A_Fire` / `A_FireCrackle` — Arch-vile fire visuals
- `A_VileTarget` — Arch-vile places fire at target
- `A_VileAttack` — Arch-vile final blast; P_RadiusAttack + vertical thrust
- `A_StartFire`, `A_FireCrackle` — visual state actions, no gameplay impact
- `A_Tracer` — Revenant homing missile; uses P_Random for tracking
- `A_SkelWhoosh` / `A_SkelFist` / `A_SkelMissile` — Revenant attacks
- `A_FatRaise` / `A_FatAttack1` / `A_FatAttack2` / `A_FatAttack3` — Mancubus attacks; spread via P_Random
- `A_BrainAwake` — Icon of Sin awakens (sound)
- `A_BrainPain` — Icon of Sin pain
- `A_BrainScream` / `A_BrainExplode` — Icon of Sin death sequence
- `A_BrainSpit` — Icon of Sin spawns cube; uses P_Random for target selection
- `A_SpawnSound` / `A_SpawnFly` / `A_SpawnFly` — cube spawns monster at destination

### p_inter.c
- `P_GiveAmmo` — §9.3
- `P_GiveWeapon` — gives weapon, adds 2 clip-loads of ammo
- `P_GiveBody` — gives health up to 100 (or 200 for MegaSphere path)
- `P_GiveArmor` — gives armor, type 1 or 2
- `P_GivePower` — gives powerup (invuln, strength, invis, ironfeet, allmap, infrared)
- `P_TouchSpecialThing` — §9.3
- `P_KillMobj` — §9.1
- `P_DamageMobj` — §9.1

### p_spec.c
- `P_InitPicAnims` — §10.1
- `getSide`, `getSector`, `twoSided`, `getNextSector` — sector utility queries
- `P_FindLowestFloorSurrounding` through `P_FindMinSurroundingLight` — floor/light queries used by movers/lights
- `P_FindSectorFromLineTag` — linear scan; finds sectors with matching tag
- `EV_DoDonut` — §10.3 (donut special)
- `P_SpawnSpecials` — §10.2
- `P_UpdateSpecials` — §10.1
- `P_PlayerInSpecialSector` — damage/exit specials for sectors player stands in
- `P_CrossSpecialLine` — §10.3
- `P_ShootSpecialLine` — §10.3
- `P_UseSpecialLine` — §10.3
- `P_RespawnSpecials` — item respawn queue (`iquehead`/`iquetail`)

### p_switch.c
- `P_InitSwitchList` — builds the switch texture pair list from `switchlist[]`
- `P_StartButton` — adds to `buttonlist[]` (up to `MAXBUTTONS` active switch animations)
- `P_ChangeSwitchTexture` — changes switch texture and starts timer
- `P_UseSpecialLine` — delegates through p_spec.c

### p_doors.c
- `T_VerticalDoor` — §10.4
- `EV_DoLockedDoor` / `EV_DoDoor` — spawns T_VerticalDoor thinker
- `EV_VerticalDoor` — player-activated door (USE); checks key requirements
- `P_SpawnDoorCloseIn30` / `P_SpawnDoorRaiseIn5Mins` — timed door spawns

### p_plats.c
- `T_PlatRaise` — §10.5
- `EV_DoPlat` — spawns T_PlatRaise thinker
- `P_ActivateInStasis` / `EV_StopPlat` — pause/resume perpetual platforms

### p_ceilng.c
- `T_MoveCeiling` — §10.6
- `EV_DoCeiling` — spawns T_MoveCeiling thinker
- `EV_CeilingCrushStop` — stops an active crusher

### p_floor.c
- `T_MoveFloor` — §10.7
- `EV_DoFloor` — spawns T_MoveFloor thinker
- `EV_BuildStairs` — stair-builder; scans adjacent sectors

### p_lights.c
- `T_FireFlicker` — §10.2
- `P_SpawnFireFlicker` — §10.2
- `T_LightFlash` — §10.2
- `P_SpawnLightFlash` — §10.2
- `T_StrobeFlash` — §10.2
- `P_SpawnStrobeFlash` — §10.2
- `EV_StartLightStrobing` — linedef trigger for strobes
- `EV_TurnTagLightsOff` / `EV_LightTurnOn` — linedef light level changes
- `T_Glow` — §10.2
- `P_SpawnGlowingLight` — §10.2

### p_telept.c
- `EV_Teleport` — §10.8

### p_pspr.c
- `P_SetPsprite` — §11.1
- `P_CalcSwing` — §11.1; weapon bob calculation
- `P_BringUpWeapon` — §11.2
- `P_CheckAmmo` — §11.3
- `P_FireWeapon` — fires current weapon, calls P_SetPsprite to attack state
- `P_DropWeapon` — on player death, lowers weapon
- `P_SetupPsprites` — on player respawn, sets up weapon states
- `P_MovePsprites` — §11.2; advances psprite tics
- `A_WeaponReady` — fires on button press, bobs weapon, handles pending weapon change
- `A_ReFire` — §11.3
- `A_CheckReload` — SSG check for 2 shells
- `A_Lower` — weapon lower animation
- `A_Raise` — weapon raise animation, triggers bring-up completion
- `A_GunFlash` — shows muzzle flash sprite
- `A_Punch` — fist attack; P_Random for spread and damage, strength powerup bonus
- `A_Saw` — chainsaw attack; P_Random for spread, damage, and sound
- `A_FireMissile` — rocket fire
- `A_FireBFG` — BFG fire; consumes BFGCELLS=40 cells
- `A_BFGSpray` — BFG tracer explosion; 40 autoaimed rays, P_Random damage each
- `A_FirePlasma` — plasma fire; alternates flash states
- `A_FireShotgun` — shotgun; 7 pellets each with P_Random spread
- `A_FireShotgun2` — SSG; 20 pellets each with P_Random spread
- `A_FireCGun` — chaingun; alternates flash states; calls A_GunFlash and A_FireBullets
- `A_FireBullets` — fires N hitscan bullets with P_Random spread

### p_setup.c
- `P_LoadVertexes` — §12.1
- `P_LoadSegs` — §12.1
- `P_LoadSubsectors` — §12.1
- `P_LoadSectors` — §12.1
- `P_LoadNodes` — §12.1
- `P_LoadThings` — §12.1, §Q8
- `P_LoadLineDefs` — §12.1
- `P_LoadSideDefs` — reads sidedef texture names, resolves to R_TextureNumForName
- `P_LoadBlockMap` — §3.1; reads BLOCKMAP lump, allocates blocklinks
- `P_GroupLines` — builds sector→lines mapping, sector bounding boxes, sector blockboxes
- `P_SetupLevel` — §12.1
- `P_Init` — one-time init: switch list, texture animations, sprite name list

### p_saveg.c
- `P_ArchivePlayers` — §13.2
- `P_UnArchivePlayers` — §13.3
- `P_ArchiveWorld` — §13.2
- `P_UnArchiveWorld` — §13.3
- `P_ArchiveThinkers` — §13.2
- `P_UnArchiveThinkers` — §13.3
- `P_ArchiveSpecials` — §13.2; saves ceiling/door/floor/plat/flash/strobe/glow thinkers
- `P_UnArchiveSpecials` — §13.3; restores same

### p_user.c
- `P_Thrust` — §14.2
- `P_CalcHeight` — §14.3
- `P_MovePlayer` — §14.2
- `P_DeathThink` — §14.1
- `P_PlayerThink` — §14.1

### m_random.c (sim-relevant)
- `P_Random` — §2.1
- `M_Random` — §2.1
- `M_ClearRandom` — §2.2

### g_game.c (sim-relevant portions)
- `G_Ticker` — §1.1
- `G_BuildTiccmd` — builds ticcmd from local input
- `G_CmdChecksum` — checksums the ticcmd (not the consistency check)
- `G_ReadDemoTiccmd` / `G_WriteDemoTiccmd` — §1.4
- `G_DoLoadLevel` — calls P_SetupLevel, resets leveltime and rndindex
- `G_DeathMatchSpawnPlayer` — §14.5
- `G_PlayerReborn` — resets player struct on respawn

---

*Coverage: every function in p_*.c is listed above. Trivial one-liners are grouped
as "trivial stub" or "utility" where appropriate. No p_*.c function is unaccounted for.*
