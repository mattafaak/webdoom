# webdoom divergence atlas

This document catalogs the behavioral forks between vanilla DOOM, the Boom
lineage of source ports, and webdoom: where each port takes a different
position on the same piece of vanilla code, what webdoom does, and the evidence.

- [playsim.md](playsim.md) documents the vanilla mechanism. Its §15 (quirk
  catalog, Q1-Q10) and §16 (the frozen surface) are the spine this atlas hangs
  on; every family below cites the matching playsim section.
- [engine-archaeology.md](engine-archaeology.md) covers fixed-point math, the
  trig tables and the random table. webdoom keeps all of those identical to
  vanilla, so they are not forks and do not appear here.

Every webdoom position below is read from `engine/core`. Port behaviors for
Boom, MBF, MBF21, PrBoom+ and dsda-doom are general source-port community
knowledge and are marked with a dagger (†): this repo carries none of those
ports' source, so they are not verified here.

---

## Compatibility position

webdoom's simulation is vanilla-exact over its proof corpus: all 13 IWAD demos
replay tic-identical against golden traces (the `sim-goldens` leg), and the
same per-tic fingerprint matches an instrumented Chocolate Doom over 44,580
tics (`tools/build-choco-reference.sh`, then
`node tools/demo-test.mjs --cross <binary>`). That is demo-proven over the
corpus, not a claim that every input behaves as vanilla does.

The engine has no `comp_*` toggle flags (F7); every position is hardwired.
Apart from fail-soft guards that no golden demo reaches, the one sanctioned
departure from vanilla semantics is in the netcode. `G_Ticker` (g_game.c) skips
the consistency check for commands the relay fabricated for a stalled client
(`D_NetCmdFabricated`) and for a dropped-in player's first `BACKUPTICS` tics.
The check only raises `I_Error`, so skipping it changes no simulation state
(spec.md, tenet 1).

### Preserved vanilla quirks

Each of these is demo-visible: changing it would desync the golden suite.

| Quirk | Atlas | Source anchor |
|-------|-------|---------------|
| spechit[] processed in reverse order (`while (numspechit--)`) | F3 | `P_TryMove`, p_map.c |
| Wallrunning: P_SlideMove's 3-retry limit and stairstep fallback | F4 | `P_SlideMove`, p_map.c |
| Blockmap out-of-bounds cell returns `true` (map-edge truncation) | F5a | `P_BlockLinesIterator`, p_maputl.c |
| 0-length linedef: `den == 0` returns a 0 fraction in intercept math | F5b | `P_InterceptVector`, p_maputl.c |
| No runtime bounds check on 16-bit blockmap offsets | F5c | `P_BlockLinesIterator`; playsim.md §12.2 |
| P_CheckSight asymmetry: the eye is t1's only | F6 | `P_CheckSight`, p_sight.c |
| A glass-hack line (two-sided, no back side) with a raise-to-texture or lower-and-change special reads `sides[-1]` in `getSide`/`getSector`; in wasm that is the zone block header in front of `sides[]`, so the result is deterministic and never traps or writes. Chocolate Doom has the same code | — | `getSide`, `getSector`, p_spec.c; specials 30/96, 37/84 |

### Modern fixes not taken

| Fix (not applied) | Atlas | Why |
|-------------------|-------|-----|
| comp_* runtime toggle layer (the Boom/PrBoom+ selection mechanism) | F7 | webdoom targets vanilla, not Boom or MBF21; the toggle layer is complexity (spec.md, tenet 3) with no benefit to the 13-demo corpus |

### Deliberate divergences (taken, demo-transparent)

These are safety clamps on vanilla memory-corruption paths. None engages during
golden demo playback, so vanilla behavior is preserved over the proof corpus.

| Divergence | Atlas | Cover over the 13 golden demos |
|------------|-------|--------------------------------|
| MAXSPECIALCROSS raised to 64 with a silent clamp; vanilla's 8-entry overrun not reproduced | F1 | Peak numspechit **8**; the clamp at 64 is never reached |
| MAXINTERCEPTS kept at 128, intercepts past the 128th dropped; vanilla's overrun not reproduced | F2 | Peak intercept count **45**; the guard at 128 is never reached |
| A co-op player with no start of their own spawns at another player's start and steps aside | F8 | No golden demo is a co-op game on a map missing a start (vanilla crashes on one) |

Other fail-soft guards follow the same rule (fail soft on input vanilla would
crash on, never on a path a golden demo reaches) and are too small to be fork
families:

| Guard | Where | Vanilla behavior |
|-------|-------|------------------|
| Donut special skips a sector with no two-sided first line, or a NULL backsector | `EV_DoDonut`, p_spec.c | NULL dereference |
| Icon of Sin target list capped at `MAXBRAINTARGETS` (32) | `A_BrainAwake`, p_enemy.c | writes past `braintargets[]` |
| Sidedef sector index and linedef sidenum checked at load, `I_Error` on out-of-range | `P_LoadSideDefs`, `P_LoadLineDefs`, p_setup.c | out-of-bounds read |
| A co-op level with no player start at all | `P_SetupLevel`, p_setup.c | NULL dereference in `P_PlayerThink` |
| A loaded monster's or missile's cleared `target` read through: a zeroed `mobj_t` stands in | `P_SpawnMissile` (p_mobj.c), `A_SpawnFly` (p_enemy.c), `A_BFGSpray` (p_pspr.c), via `P_ZeroMobj` | NULL dereference (DOS read low memory) |
| A two-sided line with no back side (the glass hack) read by a hitscan or aim: a zeroed `sector_t` stands in | `PTR_AimTraverse`, `PTR_ShootTraverse` (p_map.c), via `P_ZeroSector` | NULL dereference (DOS read its interrupt vector table) |

The two stand-ins change nothing the browser build does: doom.wasm always read
zeros at address 0 there, and the armed build asserts the stand-in equals
address 0 at every use. They stop native builds faulting.

---

## How to read a family

Each family is one class of behavior where vanilla, the Boom lineage and webdoom
differ in a mechanically significant way. Each one gives:

1. **What it is**: the behavior at source level.
2. **Mechanism**: the vanilla code, with its playsim.md section.
3. **Port matrix**: what vanilla, Boom, MBF, MBF21, PrBoom+ and dsda-doom do.
   Every non-vanilla, non-webdoom cell is †.
4. **webdoom's position**: what this engine does, cited to a function.
5. **Why**: the spec.md tenet it serves. Tenet 1 is vanilla demo accuracy;
   tenet 4 is robustness (no WAD input may corrupt memory).
6. **Evidence**: source, demo or suite leg.

---

## F1 — spechit[] overflow family

### What it is

When a thing's bounding box crosses more than `MAXSPECIALCROSS` special-tagged
linedefs in one `P_TryMove`, the engine must decide what to do with the
surplus. In vanilla the array is small and unguarded, and the surplus is
written past its end. This is the most widely discussed limit in the Boom
compatibility layer.

### Mechanism (playsim.md §4.4)

`PIT_CheckLine` (p_map.c) appends each crossed special line to `spechit[]`. In
vanilla the array holds 8 entries and nothing checks the bound. Once the move
succeeds, `P_TryMove` walks `spechit[]` in reverse to trigger the crossings
(F3).

The overrun lands in whatever globals the linker placed after `spechit[]`. It
can corrupt `numspechit` itself, so the walk either fires spurious crossings
(the count grows) or misses real ones (it shrinks).

### Port matrix

| Port | MAXSPECIALCROSS | Guard | Overflow behavior |
|------|----------------|-------|-------------------|
| vanilla (linuxdoom-1.10) | 8 | none | Writes past the array into adjacent globals, including possibly `numspechit` |
| Boom | raised† | yes† | Raises the limit and guards the write† |
| MBF | inherits Boom† | yes† | Same as Boom† |
| MBF21 | inherits MBF† | yes† | Same as MBF†; adds no new value |
| PrBoom+ | configurable† | yes† | `comp_maxscross=1` reproduces the vanilla corruption; `0` uses the raised limit† |
| dsda-doom | configurable† | yes† | Same as PrBoom+† |
| **webdoom** | **64** | **yes** | Clamps silently; surplus entries are dropped, not written |

### webdoom's position

`p_local.h` defines `MAXSPECIALCROSS 64`. The guard is in `PIT_CheckLine`:

```c
if (numspechit < MAXSPECIALCROSS)
{
    spechit[numspechit] = ld;
    numspechit++;
}
```

The constant lives in `p_local.h` so that p_map.c and p_enemy.c declare
`spechit[]` with the same extent. Vanilla's p_enemy.c had its own local
`MAXSPECIALCROSS 8`, which gives one object two array types (a C99 §6.2.7
compatible-type violation) once p_map.c's array is raised.

### Why

Tenet 1 is met because the peak `numspechit` over all 13 golden demos is **8**
(tnt-demo2, MAP12), exactly the vanilla limit. No demo exceeds 8, so the clamp
at 64 is never reached and those demos behave as vanilla. The clamp serves
tenet 4: a large custom map that would overflow cannot corrupt memory.

### Evidence

- Source: `MAXSPECIALCROSS` in p_local.h, the guard in `PIT_CheckLine`.
- `_Static_assert(MAXSPECIALCROSS == 64)` in p_local.h under
  `WEBDOOM_INVARIANTS`, compiled by the `build-invariants` leg.
- The peak of 8 was measured with the `-DWEB_PERF_SPECHIT_STATS` counter
  (`web_perf_spechit_peak_get` in engine/web/perf.c) over the 13 demos. No leg
  re-measures it.
- See also playsim.md Q1 and the §16 frozen-surface entry.

---

## F2 — intercepts[] overflow family

### What it is

`P_PathTraverse` collects every line and thing a trace crosses into
`intercepts[]` before `P_TraverseIntercepts` sorts and processes them. In
vanilla the array has 128 entries and no bound check, so a hitscan or slide
trace that crosses more than 128 objects writes past it.

### Mechanism (playsim.md §5.1)

`PIT_AddLineIntercepts` and `PIT_AddThingIntercepts` each store an entry at
`intercept_p` and advance it. In vanilla neither checks whether `intercept_p`
has reached `intercepts + MAXINTERCEPTS`. The community-documented symptom† is
the "all-ghosts" family: corruption leaves a zero-fraction entry that the
traverser processes before the wall, so a shot can register as hitting
nothing.

### Port matrix

| Port | MAXINTERCEPTS | Guard | Overflow behavior |
|------|--------------|-------|-------------------|
| vanilla (linuxdoom-1.10) | 128 | none | Writes past the array; "all-ghosts"† |
| Boom | 128† | probable† | Boom raised many limits; an intercepts guard is likely† |
| MBF | 128† | yes† | Inherits Boom† |
| MBF21 | 128† | yes† | Inherits MBF† |
| PrBoom+ | 128† | yes† | No comp flag for intercepts overflow is documented† |
| dsda-doom | 128† | yes† | Same as PrBoom+† |
| **webdoom** | **128** | **yes** | Keeps the first 128; intercepts past the 128th are dropped |

### webdoom's position

`p_local.h` keeps vanilla's `MAXINTERCEPTS 128`. Both adders check for room
before writing the slot:

```c
if (intercept_p == intercepts + MAXINTERCEPTS)
    return true;
```

A trace keeps its first 128 intercepts in block-walk order, and drops any found
after them (`tools/fuzz/crafted-maps.mjs` `intercepts-128` pins the
boundary). The block walk runs from
the trace's origin outward, so what is lost is roughly the far end of the
trace: the "ghosts" effect in a bounded form, only at extreme density.

### Why

As F1. The peak intercept count over the 13 golden demos is **45**
(plutonia-demo3, MAP12), well below 128, so the guard never engages and vanilla
behavior holds (tenet 1). The clamp stops a dense custom map from writing past
the array (tenet 4).

### Evidence

- Source: `MAXINTERCEPTS` in p_local.h; the guards in `PIT_AddLineIntercepts`
  and `PIT_AddThingIntercepts`, each followed by a `DOOM_ASSERT` on the bound
  under `WEBDOOM_INVARIANTS` (armed by the `sim-invariants` leg).
- `_Static_assert(MAXINTERCEPTS == 128)` in p_local.h (`build-invariants`).
- The peak of 45 was measured with an instrumented build over the 13 demos. No
  counter for it remains in the tree, and no leg re-measures it.
- See also playsim.md Q2 and §16.

---

## F3 — spechit[] reverse-processing order

### What it is

After `P_TryMove` succeeds, the engine walks `spechit[]` and calls
`P_CrossSpecialLine` for each special line the thing crossed. Vanilla walks in
**reverse**, from `spechit[numspechit-1]` down to `spechit[0]`, so the last
line recorded fires first.

### Mechanism (playsim.md §4.3, §16)

The loop at the end of `P_TryMove`:

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

`while (numspechit--)` tests the count and then decrements it, so the first
iteration reads the last entry.

### Port matrix

| Port | spechit processing order |
|------|--------------------------|
| vanilla (linuxdoom-1.10) | reverse (last in, first processed) |
| Boom | reverse† (loop unchanged for vanilla compat†) |
| MBF | reverse† |
| MBF21 | reverse† |
| PrBoom+ | reverse†; no comp flag for this ordering† |
| dsda-doom | reverse† |
| **webdoom** | **reverse** |

### webdoom's position

The loop is linuxdoom-1.10's, unmodified. Under `WEBDOOM_INVARIANTS`,
`P_TryMove` asserts before the loop that `numspechit` is in
`[0, MAXSPECIALCROSS]` and non-negative, so the reverse walk can only touch
valid slots.

### Why

Tenet 1. The order is demo-visible: if line A fires before line B, and A's
effect changes sector state that B's effect reads, reversing the order changes
gameplay. playsim.md §16 lists "spechit[] processing order (reverse, from
numspechit-1 downward)" as frozen.

### Evidence

- Source: the `while (numspechit--)` loop in `P_TryMove`.
- The `DOOM_ASSERT` block before it, armed by the `sim-invariants` leg over the
  13 demos.
- `sim-goldens`: the 13 demos replay tic-identical through the unmodified
  loop.

---

## F4 — Wallrunning (P_SlideMove stairstep)

### What it is

`P_SlideMove` finds the wall to slide along by firing three traces, from the
three leading corners of the mover's bounding box. It makes two passes; the
third entry to its `retry:` label goes straight to a `stairstep` fallback, as
does a pass whose traces find no wall. The fallback tries the move on one axis
at a time with the mover's current momentum. Whether that move is allowed is decided by `P_TryMove`'s
bounding-box check, not by the slide traces, which lets a player keep speed or
get through corners that a true slide would stop. Speedrunners exploit this†;
"wallrunning" is the community name.

### Mechanism (playsim.md §4.5)

In `P_SlideMove` (p_map.c), whose own comment reads `// This is a kludgy mess.`:

1. Three `P_PathTraverse` calls with `PTR_SlideTraverse` locate the closest wall
   (`bestslideline`).
2. At the `retry:` label, `if (++hitcount == 3) goto stairstep;`, so the third
   pass never traces.
3. `stairstep:` tries `P_TryMove(mo, mo->x, mo->y + mo->momy)`, then
   `P_TryMove(mo, mo->x + mo->momx, mo->y)` if the first fails.

The fallback is also taken when no wall was found
(`bestslidefrac == FRACUNIT+1`) and when the move up to the wall fails.

### Port matrix

| Port | Wallrunning | Notes |
|------|-------------|-------|
| vanilla (linuxdoom-1.10) | yes | `hitcount == 3` limit, stairstep fallback |
| Boom | yes† | preserved for demo compat† |
| MBF | yes† | preserved† |
| MBF21 | yes† | preserved† |
| PrBoom+ | yes† | no comp flag to disable it; doing so would break speedrun demos† |
| dsda-doom | yes† | preserved; dsda-doom is the main speedrun port† |
| **webdoom** | **yes** | preserved exactly |

### webdoom's position

`P_SlideMove` is linuxdoom-1.10's: the `hitcount` check, the trace count and
the `stairstep` fallback are unmodified.

### Why

Tenet 1. Wallrunning is demo-visible player movement. Any change to the pass
limit or the fallback alters the trajectory every time a player touches a wall,
which desyncs any demo that does so, speedrun demos most of all.

### Evidence

- Source: `P_SlideMove` in p_map.c.
- `sim-goldens`: the 13 demos replay tic-identical through the unmodified
  slide code.
- See also playsim.md Q4: "If P_SlideMove's 3-ray approach or the stairstep
  fallback were changed, all such demos would desync."

---

## F5 — Blockmap family (edge truncation, 0-length linedefs, 16-bit offsets)

Three related behaviors with one root cause: the blockmap is a lossy,
16-bit-indexed structure that the engine trusts without checking.

### F5a — Out-of-bounds block truncation at the map edge

**What it is.** `P_BlockLinesIterator` returns `true` (success, no collision)
for any block outside `[0, bmapwidth) × [0, bmapheight)`. Objects or traces
near the map boundary can miss geometry in the outermost block column or row.

**Mechanism** (playsim.md §3.2). The top of `P_BlockLinesIterator`, p_maputl.c:

```c
if (x<0 || y<0 || x>=bmapwidth || y>=bmapheight)
    return true;
```

A caller iterating an out-of-bounds cell gets "no lines here" and continues.
Vanilla maps leave a margin inside the blockmap boundary, so this rarely
matters; custom maps that put geometry right at the edge expose it.

`P_CheckPosition` (p_map.c) widens the block range by `MAXRADIUS` for its thing
pass but not for its line pass. That is vanilla too: a thing is filed in the
block of its origin and can overlap neighbours by up to `MAXRADIUS`, while a
line is filed in every block it touches.

**Port matrix.**

| Port | Out-of-bounds block |
|------|---------------------|
| vanilla | returns true |
| Boom | returns true† (vanilla compat) |
| MBF, MBF21 | returns true† |
| PrBoom+, dsda-doom | returns true† |
| **webdoom** | **returns true (vanilla, unmodified)** |

**webdoom's position and evidence.** Vanilla behavior, unmodified. The source
shows it directly: the bounds test followed by `return true`. See playsim.md
Q3.

### F5b — 0-length linedef in a trace

**What it is.** A linedef whose two vertices coincide has `dx = dy = 0`. When
`P_MakeDivline` turns it into a divline and `P_InterceptVector` intersects it
with the trace, the denominator of the intersection formula is zero.

**Mechanism.** `P_InterceptVector` (p_maputl.c):

```c
den = FixedMul (v1->dy>>8,v2->dx) - FixedMul(v1->dx>>8,v2->dy);
if (den == 0)
    return 0;
```

The guard covers the parallel case, which includes zero-length lines, by
returning 0. A zero fraction places the intercept at the trace origin, so the
traverser callback can run with wrong position data. `P_InterceptVector2`
(p_sight.c) has the same guard.

**Port matrix.** All ports inherit the vanilla `den == 0` guard†. Boom and
later ports improve the blockmap *builder*†; webdoom has no builder and uses
the WAD's prebuilt blockmap. Whether any port adds its own 0-length linedef
validation in the block iterator or intercept routines is not known here.

**webdoom's position.** Vanilla, unmodified. A 0-length linedef in WAD data can
still produce odd intercepts, but it does not crash.

**Evidence.** The guard in `P_InterceptVector`. No golden demo is known to
cross a 0-length linedef.

### F5c — Blockmap 16-bit offset overflow (very large maps)

**What it is.** The BLOCKMAP lump stores each block's line-list offset as a
16-bit word, counted from the start of the lump. p_setup.c loads the lump as
`short*`, and `P_BlockLinesIterator` reads the offset into an `int`, so it is
sign-extended: once the offset table plus the line lists pass 32,767 words
(about 64 KB), offsets go negative and point before the lump. Lump builders
cause this on very large maps; the engine trusts the data as given.

**Mechanism.** `P_BlockLinesIterator`:

```c
offset = *(blockmap+offset);
for (list = blockmaplump+offset; *list != -1; list++)
```

Nothing bounds `offset` against the lump size (playsim.md §12.2).

**Port matrix.** Vanilla and early ports are affected on very large custom
maps. Boom and later ports ship improved blockmap builders that avoid the
overflow†, and PrBoom+ and dsda-doom document
workarounds in their extended node builders†. Whether either adds a runtime
bounds check on the offset read is not known here.

**webdoom's position.** No runtime bounds check on blockmap offsets, as in
vanilla. A crafted WAD with a bad offset makes the read undefined.

F5c is one instance of the wider unguarded-index surface in playsim.md §12.2:
vertex, seg, node and REJECT indices in map lumps are also used unchecked.
p_setup.c checks only the sidedef sector index and the linedef sidenums (the
fail-soft table above). On such malformed input the release wasm build reads
whatever is there and carries on, while the native ASan build traps on the
same read. `tools/fuzz/run-map-fuzz.mjs` classifies that as the expected
sanitizer-vs-release difference on invalid input, not a simulation divergence.

**Evidence.** The source of `P_BlockLinesIterator` and `P_LoadBlockMap`. The
`adversarial-map` leg (30 mutated maps, zero ASan/UBSan reports) does not cover
F5c: the map fuzzer never mutates BLOCKMAP or the other geometry lumps.

---

## F6 — Sight asymmetry (P_CheckSight)

### What it is

`P_CheckSight(A, B)` is not in general equal to `P_CheckSight(B, A)`. The sight
ray starts at A's eye, three quarters of A's height above A's base, and looks
for any part of B, top to bottom. Swapping the arguments changes the eye height
and the slope window.

### Mechanism (playsim.md §6.3)

In `P_CheckSight` (p_sight.c):

```c
sightzstart = t1->z + t1->height - (t1->height>>2);
topslope    = (t2->z + t2->height) - sightzstart;
bottomslope = (t2->z)              - sightzstart;
```

The eye always comes from `t1`. A tall monster looking at a short player uses
the monster's high eye; the reverse uses the player's low eye. These are
different line-of-sight tests.

### Consequences

Monster AI asks from the monster's side: `P_LookForPlayers` calls
`P_CheckSight(actor, player->mo)`, and the chase and attack code calls
`P_CheckSight(actor, actor->target)`. A player behind a ledge that blocks the
player's own view up to the monster can still be seen, because the monster's
higher eye looks over the ledge. Radius damage asks from the victim's side:
`PIT_RadiusAttack` calls `P_CheckSight(thing, bombspot)`.

Changing the eye-height formula, or adding a symmetric second check, would
alter enemy sight acquisition in every demo with enemies.

### Port matrix

| Port | P_CheckSight |
|------|--------------|
| vanilla | asymmetric (t1's eye only) |
| Boom | asymmetric† (vanilla compat†) |
| MBF | asymmetric† |
| MBF21 | asymmetric† |
| PrBoom+ | asymmetric†; no comp flag for sight symmetry† |
| dsda-doom | asymmetric† |
| **webdoom** | **asymmetric (vanilla, unmodified)** |

No port in this lineage is known† to offer optional symmetric sight; the
asymmetry is too deeply embedded in demo playback to toggle.

### webdoom's position

The `sightzstart` formula is linuxdoom-1.10's, unmodified. Under
`WEBDOOM_INVARIANTS` a `DOOM_ASSERT` recomputes it independently, so an edit to
the formula fires in the `sim-invariants` leg.

### Why

Tenet 1. playsim.md §16 freezes "P_CheckSight eye height formula:
`t1->z + t1->height - (t1->height >> 2)`". A change moves the tic on which a
monster acquires a target, which shifts the `P_Random` call sequence and
desyncs every demo with enemies.

### Evidence

- Source: `P_CheckSight` in p_sight.c, and its `DOOM_ASSERT`.
- `sim-goldens` and `sim-invariants` over the 13 demos.
- See also playsim.md Q6.

---

## F7 — comp_* flag system (PrBoom+/dsda-doom compatibility toggles)

### What it is

PrBoom+ added an array of `comp_*` booleans that let players and demo playback
tools switch individual vanilla quirks on or off at runtime†. The flags default
to vanilla-compatible (1 = emulate the vanilla behavior) for demo playback and
can be overridden for play†. dsda-doom inherits and extends the system†.

It is a meta-fork: a mechanism for *selecting* behaviors rather than a position
on any one of them.

### Commonly cited flags (unverified)

These flags are commonly attributed to PrBoom+ or its ancestors and correspond
to the families above or to other well-known quirks. Every name, meaning and
default in this table is general knowledge, not checked against PrBoom+ or
dsda-doom source. Verify from those ports' source if the exact list matters.

| Flag | Controls | Vanilla value |
|------|----------|---------------|
| `comp_maxscross` | Whether the spechit[] overflow (8-entry overrun) is reproduced | 1 (emulate) |
| `comp_soul` | Lost-soul collision with other things | 1 (emulate) |
| `comp_vile` | Arch-vile resurrects former humans into crusher state | 1 (emulate) |
| `comp_pain` | Pain elemental spawning with -nomonsters | 1 (emulate) |
| `comp_zombie` | Player zombie can activate exit specials | 1 (emulate) |
| `comp_pursuit` | Monster target switch on infighting | 1 (emulate) |
| `comp_dropoff` | Monsters avoid drop-offs | 1 (emulate) |
| `comp_falling` | Falling damage | 0 (no vanilla falling damage) |
| `comp_staylift` | Monsters follow the player off lifts | 1 (emulate) |
| `comp_stairs` | Stair-building sector scan | 1 (emulate) |
| `comp_infcheat` | Infinite-ammo cheat interaction | 1 (emulate) |
| `comp_zerotags` | Zero-tag linedef special activation | 1 (emulate) |
| `comp_model` | Linedef activation model (closest vs. any) | 1 (emulate) |
| `comp_god` | God-mode invulnerability interaction | 1 (emulate) |
| `comp_blazing` | Fast-door double-sound bug | 1 (emulate) |
| `comp_doorlight` | Door lighting effects | 1 (emulate) |
| `comp_maskedanim` | Animated textures on two-sided linedefs | 1 (emulate) |

### webdoom's position

**webdoom has no comp_* system**: no flag array, no runtime toggle, no
configuration for choosing vanilla or fixed behavior per quirk.
`grep -rn comp_ engine/` finds nothing. Every position is hardwired:

| Behavior | webdoom's position |
|----------|--------------------|
| spechit[] overflow | clamped at 64 (vanilla overrun not reproduced) |
| intercepts[] overflow | intercepts past the 128th dropped (vanilla overrun not reproduced) |
| sight asymmetry | vanilla (t1's eye) |
| wallrunning | vanilla (`hitcount` limit, stairstep) |
| blockmap edge | vanilla (out-of-bounds cell returns true) |
| lost-soul collision | vanilla code, no toggle |
| arch-vile resurrection | vanilla code, no toggle |
| zero-tag specials | vanilla code, no toggle; which Boom behavior a `comp_zerotags=0` would select is not examined here |

Not implementing comp_* is deliberate:

1. **Accuracy** (tenet 1). The 13 golden demos never reach the vanilla overruns
   (peaks 8 and 45, against vanilla limits of 8 and 128), so the guards cost no
   demo compatibility and there is nothing to toggle back.
2. **Simplicity** (tenet 3). A toggle layer is significant code, and webdoom
   does not target Boom, MBF21 or PrBoom+ maps that depend on comp_* behavior.
3. **The netcode exception is not a toggle.** The consistency-check skip in
   `G_Ticker` is the one sanctioned semantic departure, and it is unconditional.

---

## F8 — A co-op player with no start of their own

### What it is

A co-op level gives each player a start (thing types 1–4). Some maps carry
fewer: Chex Quest's E1M3, E1M4 and E1M5 have player 1's only. Vanilla spawns
nobody for a player whose start is missing, and the first `P_PlayerThink`
dereferences a NULL `mo`. Chocolate Doom refuses the level instead
(`P_LoadThings: Player %d start missing`).

### webdoom's position

A player in the game with no start of their own is spawned at another
player's start, faked as their own (`G_SpawnAtAnyStart`, g_game.c). The
same happens at level load (`P_SetupLevel`) and on a drop-in or respawn
(`G_DoReborn`). A start whose spot is free comes first, as in `G_DoReborn`'s
vanilla fallback for a blocked spot. With none free, the player is spawned on
the first start present and moved to the nearest free spot beside it
(`G_StepAside`): 48 then 96 units away in eight directions, reached in a
straight line that crosses no linedef, and accepted by `P_TryMove`. Two solid
players on one spot block each other's every move, so a plain stack would
leave both stuck. Only a co-op level with no player start at all is refused.

### Why

The lobby offers Chex Quest for co-op and lets the host pick any map, so
"vanilla crashes here" was a session ending on E1M3. No demo is affected,
because vanilla cannot run one on such a map. A deathmatch keeps vanilla's
rule: four deathmatch starts or an `I_Error`.

### Evidence

`net-reborn`: a two-player demo on chex E1M3 loads and runs, and player 2
walks free (the world after 35 tics of walking differs from 35 tics of
standing). A drop-in on a map with player 1's start only spawns.
`demo-verify` Gate E: a co-op demo header for such a map is accepted, and a
level with no player start at all is refused.

---

## Deliberately out of scope

These are real forks in the source-port landscape, outside this atlas, which
covers only the major forks of vanilla code:

| What | Why excluded |
|------|--------------|
| Boom extended linedef and sector specials | Not implemented in webdoom; a new feature, not a fork of existing vanilla code |
| MBF21 codepointer extensions | Same; webdoom does not implement MBF21 |
| Deep water and other Boom transfer effects | Render-side, not simulation forks |
| MUSINFO / MAPINFO lumps | Not in linuxdoom-1.10 or webdoom; format extensions, not forks |
| Advanced node builders (ZDBSP, ZNoNodes) | Map builders, not engine runtime behavior |
| Heretic / Hexen / Strife compatibility | Out of scope for a Doom 1/2 engine |
| WebAssembly/JS platform-layer differences | webdoom-specific; not a vanilla-vs-port fork |
| Savegame format differences | Covered in playsim.md §13; not a gameplay fork |
| Music / OPL synthesis differences | Audio side; not sim-visible |
| Individual comp_* flags beyond the F7 overview | Per-flag analysis needs those ports' source, which this repo does not carry |

---

## Summary

| ID | Fork | webdoom position | Verified from source |
|----|------|------------------|----------------------|
| F1 | spechit[] overflow | MAXSPECIALCROSS = 64 with a clamp; vanilla 8-entry overrun not reproduced | yes |
| F2 | intercepts[] overflow | MAXINTERCEPTS = 128, intercepts past the 128th dropped; overrun not reproduced | yes |
| F3 | spechit[] reverse processing | vanilla reverse order (`while (numspechit--)`) | yes |
| F4 | Wallrunning | vanilla (`hitcount == 3` limit, `stairstep` goto) | yes |
| F5a | Blockmap edge truncation | vanilla (out-of-bounds cell returns true) | yes |
| F5b | 0-length linedef in a trace | vanilla (`den == 0` guard in `P_InterceptVector`) | yes |
| F5c | Blockmap 16-bit offset overflow | vanilla (no runtime bounds check) | yes (no guard added) |
| F6 | Sight asymmetry | vanilla (t1's eye height in `P_CheckSight`) | yes |
| F7 | comp_* flag system | not implemented; positions are hardwired | yes (by absence) |
| F8 | A co-op player with no start | spawned at another player's start, stepping aside if it is taken | yes |
