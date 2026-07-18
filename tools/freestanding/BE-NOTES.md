# BE-NOTES.md — Big-endian bring-up state (task 13.3a WIP capture)

## (a) Target chosen and why

**Target: `powerpc-linux-musleabi`**

Ladder evaluated:

| Rung | Target | Outcome |
|------|--------|---------|
| 1 | `m68k-linux-musl` | SKIPPED — zig 0.16 LLVM m68k backend is EXPERIMENTAL; `qemu-m68k-static` status on host not confirmed; risk of compiler-gen bugs too high to open with |
| 2 | `powerpc-linux-musleabi` | SELECTED — solid LLVM backend, `qemu-ppc-static` confirmed present, 32-bit native (no -m32 confusion), unaligned loads OK (rung A integer-only) |
| 3 | `mips-linux-musl` | Not tried yet; strict alignment requirement makes it rung B (would need all pointer casts audited) |

**Critical zig 0.16 ABI quirk**: `-target powerpc-linux-musl` fails with:

    error: unable to provide libc for target 'powerpc-linux.5.10...6.19-musl'

The fix is `-target powerpc-linux-musleabi` (explicit `-eabi` suffix).  Bare
`-musl` is not registered in zig 0.16's libc database for powerpc; `-musleabi`
is.  This is a zig version-specific detail that will burn the next session if
not recorded.

Additional flag trap: `-m32` is x86-only.  Passing it to a powerpc cross
target causes:

    fatal error: 'errno.h' file not found

Drop it entirely; powerpc-linux-musleabi is natively 32-bit.

## (b) How far it gets — boot status and divergence table

**Boot**: FULL SUCCESS.

```
DOOM Shareware Startup
V_Init: allocate screens.
M_LoadDefaults: Load system defaults.
Z_Init: Init zone memory allocation daemon.
W_Init: Init WADfiles.
 adding /path/doomu.wad
Wad file /path/doomu.wad is registered version.
...
R_Init: Init DOOM refresh daemon -...
P_Init: Init Playfield.
...
I_Init: Setting up machine state.
D_DoomLoop()
running demo1 (timedemo) ...
```

The binary (ELF 32-bit MSB executable, PowerPC or cisco 4500, statically linked)
runs under `qemu-ppc-static` without segfault or assertion.  WAD loading,
level init, and the timedemo loop all execute to completion.

**Divergence table** (4 doom.wad demos tested; doom2/tnt/plutonia untested at cap):

| Demo | Map | Golden tics | BE tics | First divergent tic | Notes |
|------|-----|------------|---------|---------------------|-------|
| doom-demo1 | E1M5 | ? | same | **tic 0** | diverges immediately |
| doom-demo2 | E2M2 | ? | same | **tic 0** | diverges immediately |
| doom-demo3 | E3M5 | 3863 | **3863** | **tic 25** | 25 tics match — most informative |
| doom-demo4 | E4M2 | ? | same | **tic 10** | 10 tics match |

Key observation: demo3 produces the SAME tic count (3863) as the golden.  This
means WAD loading, lump parsing, and the timedemo run-to-completion path are
all fundamentally correct.  The divergence is in initialization state before
or at the first affected tic.

## (c) Hypothesis list (ranked, with ruled-out evidence)

### H1 — prndindex mismatch from P_SpawnSpecials P_Random consumption (MOST LIKELY)

During `P_SpawnSpecials`, sector light effects (e.g. T_FireFlicker, T_LightFlash,
T_Glow) call `P_Random()` to seed their phase offset.  The number of such calls
is map-specific and depends on how many matching sector types exist.

If any sector special type field is read with the wrong endianness, the wrong
effect is instantiated and a different number of P_Random calls occurs, leaving
prndindex at a different value before tic 0.  The SHORT() macro covers most
struct field reads but there may be a code path that casts a raw pointer to a
struct without going through SHORT() for every field.

Evidence supporting H1:
- E3M5 matches for 25 tics.  This means the prndindex at the start of E3M5's
  demo3 is CORRECT.  Some maps' sector specials consume zero P_Random calls
  (or the same number on BE as LE if no swap bug exists for that map's specials).
- E1M5 (demo1) diverges at tic 0, suggesting E1M5's P_SpawnSpecials consumes
  a different number of P_Random calls under BE.
- The 4 doom.wad demos show map-specific divergence onset (0, 0, 25, 10 tics)
  which is consistent with map-varying P_Random consumption.

### H2 — Residual unswapped short somewhere in level data path (POSSIBLE)

A short field read via a raw struct cast (not through a SHORT() call) would
appear correct on LE but read the bytes reversed on BE.  P_LoadSectors,
P_LoadLineDefs, P_LoadSideDefs, P_LoadThings all cast from raw lump bytes.
Most go through SHORT() but vanilla DOOM has occasional direct field reads.

Distinguishing from H1: if H2 is the cause, the wrong data corrupts game state
in a way that shows up as wrong prndindex (via sector specials reading wrong
type) — so H1 and H2 may be the same root cause observed from different angles.

### H3 — Something in the BE calling convention / struct padding differs (UNLIKELY)

All map structs (mapvertex_t, maplinedef_t, mapsector_t, mapside_t, etc.) are
packed byte sequences in WAD format.  Verified via sizeof() that x86-32 and
powerpc-32 agree on all sizes (4-byte int on both, 2-byte short, etc.).
No struct padding issue has been found.

**Ruled out.**

### H4 — Hash function itself is endian-sensitive (RULED OUT)

`fs_state_hash()` mixes: `gametic` (int, same value), `prndindex` (int, same
value if prndindex were identical), `mo->x / mo->y / mo->angle / mo->health`
(all fixed_t / int).  No memcpy/reinterpret of raw bytes.  The arithmetic is
endian-neutral.

**Ruled out.**

### H5 — `long` is 64-bit on powerpc target (RULED OUT)

`powerpc-linux-musleabi` is ILP32: int=32, long=32, pointer=32.  Verified with
`_Static_assert(sizeof(long)==4, ...)` in a test compile.  `SwapLONG` operates
on 32-bit values as intended.

**Ruled out.**

### H6 — `__BIG_ENDIAN__` not defined, SwapSHORT/SwapLONG never called (RULED OUT)

Verified by compiling a minimal test:
```c
#ifdef __BIG_ENDIAN__
int be = 1;
#else
int be = 0;
#endif
```
Under `zig cc -target powerpc-linux-musleabi`, `be == 1` at runtime.

**Ruled out.**

### H7 — perf_event_open header guards needed for BE (RULED OUT)

`linux/perf_event.h` and `sys/syscall.h` compile cleanly for
powerpc-linux-musleabi.  The WD_CYCLES runtime path is gated on `WD_CYCLES=1`
env var and never executes in normal demo runs.

**Ruled out.**

### H8 — timedemo tic-0 offset: gametic != 0 at first hash call (OPEN)

Attempted to verify via debug fprintf inside fs_state_hash() when gametic==0.
The debug output did not appear.  Two possible causes:
1. C89 mixed declaration/statement issue in the debug patch (int declared after
   if statement, undefined behavior in C89)
2. gametic is nonzero at the first fs_state_hash() call (timedemo may start
   at gametic=1 after one loop iteration)

This is a secondary investigation; even if true it doesn't explain map-specific
divergence onset.

## (d) Next experiment

**Step 1: Print prndindex immediately after level load in both LE and BE builds.**

Add to `i_main.c` immediately after `D_DoomMain()` returns (before the timedemo
loop), using the already-declared `extern int prndindex;`:

```c
fprintf(stderr, "BE_PRND_AFTER_INIT: prndindex=%d gametic=%d\n",
        prndindex, gametic);
fflush(stderr);
```

Run with `-timedemo demo1` (E1M5) on both LE and BE builds.  If the values
differ, H1/H2 is confirmed (prndindex is wrong before the first demo tic).
If they match, the divergence is in tic execution, not initialization.

**Step 2: If H1/H2 confirmed, isolate which sector special is wrong.**

Add a fprintf loop in `P_SpawnSpecials` to print each case and the
sector->special value that selects it.  Compare LE vs BE output to find the
first sector where the special value differs — that's the unswapped field.

**Toolchain note for debug builds:**
The C89 `int i;` declaration placement issue that silenced previous debug
output: ensure all new variable declarations are at the TOP of the function
body, before any executable statements (strict C89).

## Iteration 2 findings (2026-07-18)

### (a) prndindex/gametic experiment results

Executed the "next experiment" from iteration 1: print prndindex+gametic after
`D_DoomMain()` returns, then print again at each tic boundary in the for(;;)
loop.  Ran with `-timedemo demo1` (E1M5) on both LE (x86) and BE (qemu-ppc).

**Results:**

| Point | LE value | BE value |
|-------|----------|----------|
| After D_DoomMain() | prndindex=0, gametic=0 | prndindex=0, gametic=0 |
| Tic boundary 1 | prndindex=201, gametic=1 | prndindex=201, gametic=1 |
| Tic boundary 2 | prndindex=201, gametic=2 | prndindex=201, gametic=2 |
| Tic boundary 3–5 | prndindex=201 | prndindex=201 |

prndindex is **IDENTICAL** on both platforms at every point.

Clarification of timing: `D_DoomMain()` returns *before* level load (WAD
header/lump table, but not map geometry).  The level loads during the
first calls to `D_DoomFrame()`.  `P_SpawnSpecials` runs during that load
and consumes exactly 201 P_Random calls on E1M5 — identically on LE and BE.

### (b) Hypotheses killed or confirmed

**H1 KILLED**: prndindex mismatch from P_SpawnSpecials — RULED OUT.
prndindex=201 at tic 1 on both platforms.  P_SpawnSpecials consumed the
same number of P_Random calls, proving all sector-special type fields
were read identically by SHORT() on BE.

**H2 PARTIALLY KILLED**: a residual unswapped short in the level-load
path that affects P_SpawnSpecials — RULED OUT for the P_SpawnSpecials path
specifically (since prndindex is correct).  However H2 as a general "some
field is wrong on BE" remains open; the unswapped field would have to be in
a path that affects movement (not P_SpawnSpecials).

**H3 (struct padding) CONFIRMED RULED OUT**: verified independently with
`sizeof()` diagnostic: maplinedef_t=14, mapsidedef_t=30, mapsector_t=26,
mapvertex_t=4, mapthing_t=10 — all identical on x86 and powerpc-linux-musleabi.
No compiler padding differences.

**H4 (hash endianness) CONFIRMED RULED OUT.**
**H5 (long=64-bit) CONFIRMED RULED OUT.**
**H6 (__BIG_ENDIAN__ undefined) CONFIRMED RULED OUT.**

### (c) Why investigation pivoted to line fields

After H1/H2 (prndindex path) were ruled out, the investigation focused on
what actually DIFFERS at tic 1.  Observed values from the debug hash output:

- **LE tic 1**: player at x=-14686059, y=-40976164, momx=-5433, momy=-74041
  → expected: spawn(-14680064,-40894464) + thrust(-5994,-81700) - friction → ✓
  P_TryMove SUCCEEDED; player moved in thrust direction.

- **BE tic 1**: player at x=-14647691, y=-40453284, momx=29338, momy=399819
  → player moved +32373 in x (OPPOSITE direction from thrust of -5994)
  P_TryMove FAILED; P_SlideMove was called with a wrong wall normal, giving
  a 5.4× amplified velocity in the reversed direction.

Spawn position, forwardmove (-40), angleturn (253), finesine/finecosine[1952]
(4796/65360), and FixedMul were all verified IDENTICAL on both platforms.
The divergence is entirely in collision detection: P_TryMove finds a blocking
wall on BE that does not exist on LE.

Additional confirmation: demo3 (E3M5) is IDENTICAL at tic 1 because
forwardmove=0 (no movement), so no P_TryMove is called.

Blockmap data verified IDENTICAL: `P_BlockLinesIterator` for block(15,0)
returns the same line list on both platforms: [0, 655, 656, 657, 694, 704, 705].
This rules out any blockmap loading bug as the cause.

### (d) Current best root-cause hypothesis

**H9 — Wrong field data in `line_t` entries causes `PIT_CheckLine` to
falsely detect a blocking wall on BE.**

Specifically: `PIT_CheckLine` (p_map.c:203) returns false either because
(i) `!ld->backsector` (line 225) — a two-sided line appears one-sided, or
(ii) `ld->flags & ML_BLOCKING` (line 230) — a passable line appears blocking.

The `backsector` pointer is set in `P_LoadLineDefs` (p_setup.c:432,442) via
`sides[ld->sidenum[1]].sector`. If `ld->sidenum[1]` is wrong on BE (due to a
missing or incorrect SHORT() call), the pointer would be wrong or NULL.

The `flags` field is read via `SHORT(mld->flags)` (p_setup.c:377) which
should be correct, but if the engine's `maplinedef_t` struct layout mismatches
the WAD byte layout, the wrong bytes would be read.

**Key struct layout finding**: the engine's `maplinedef_t` (doomdata.h:84-93)
has fields in order `v1, v2, flags, special, tag, sidenum[2]` — v1 and v2 are
FIRST (offsets 0 and 2).  An earlier diagnostic tool had the wrong field order
(`flags, special, tag, v1, v2`) which caused garbage output.  The engine itself
uses the correct offsets via `mld->v1` etc., but this raised concern: if any
engine code or a webdoom addition reads the struct fields using a different
assumed layout, BE would see wrong data while LE (where bytes happen to be
in the right order for the swap-then-read pattern) masks the bug.

Most likely: a missing `SHORT()` on `mld->sidenum[1]` in some code path would
cause `ld->sidenum[1]` to be -28926 (byte-reversed 655) instead of 655, making
the line appear one-sided (since -28926 != -1 check passes but `sides[-28926]`
is out-of-bounds → UB → wrong sector pointer or NULL → `!ld->backsector`).

Alternatively: the `ld->bbox[]` values could be wrong if `v1`/`v2` indices are
wrong (vertex coordinates substituted from wrong vertices), placing the line
bbox over the player's movement path.

### (e) Next diagnostic being constructed when context exhausted

**Plan**: add extern declarations in `i_main.c` and at tic 1 print the
actual engine-populated `line_t` fields for lines [0, 655, 656, 657, 694,
704, 705] (the set from block(15,0)):

```c
#include "r_defs.h"
#include "r_state.h"   /* extern line_t* lines; */
#include "p_local.h"   /* extern short* blockmaplump; extern fixed_t bmaporgx; ... */

/* In the for(;;) loop, at gametic==1, first occurrence only: */
if (gametic == 1 && !diag_done) {
    int check[] = {0, 655, 656, 657, 694, 704, 705, -1};
    int ci;
    diag_done = 1;
    for (ci = 0; check[ci] != -1; ci++) {
        line_t *ld = &lines[check[ci]];
        fprintf(stderr,
            "LINE%d: v1(%d,%d) v2(%d,%d) dx=%d dy=%d slope=%d "
            "flags=%04x sn0=%d sn1=%d backsec=%s "
            "bbox L=%d R=%d B=%d T=%d\n",
            check[ci],
            ld->v1->x>>16, ld->v1->y>>16,
            ld->v2->x>>16, ld->v2->y>>16,
            ld->dx>>16, ld->dy>>16, (int)ld->slopetype,
            (unsigned short)ld->flags, ld->sidenum[0], ld->sidenum[1],
            ld->backsector ? "yes" : "NO(wall)",
            ld->bbox[BOXLEFT]>>16, ld->bbox[BOXRIGHT]>>16,
            ld->bbox[BOXBOTTOM]>>16, ld->bbox[BOXTOP]>>16);
    }
    fflush(stderr);
}
```

This diagnostic would discriminate between:
- Wrong `backsector` (a two-sided line appears as a wall on BE → H9a)
- Wrong `flags` with ML_BLOCKING set (explicitly blocking line → H9b)
- Wrong `bbox` from wrong vertex indices (false PIT_CheckLine bbox overlap → H9c)
- Correct data on both platforms (pointing to P_BoxOnLineSide or P_PointOnLineSide
  arithmetic divergence → H10, currently unexamined)

The diagnostic requires only additions to `tools/freestanding/i_main.c` (the
platform shim), not any engine/core edit beyond the already-landed m_swap.c.

## Iteration 3 findings (2026-07-18)

### (a) 7-line diagnostic result: IDENTICAL

Ran the `diag_lines()` diagnostic at gametic==1 for lines [0,655,656,657,694,
704,705] (the blockmap block(15,0) list for E1M5 tic 1) on both LE (x86-32) and
BE (qemu-ppc-static).  All 7 lines produced IDENTICAL output on both platforms:

- `v1`, `v2` coordinates: IDENTICAL
- `dx`, `dy`: IDENTICAL
- `slopetype`: IDENTICAL
- `flags`: IDENTICAL (no ML_BLOCKING mismatch)
- `sidenum[0]`, `sidenum[1]`: IDENTICAL
- `backsector`: IDENTICAL (`yes` for all two-sided lines, `NO(wall)` for walls)
- `bbox` [L,R,B,T]: IDENTICAL

**H9 RULED OUT.** No field in any of the 7 blockmap lines differs between LE
and BE.  `P_LoadLineDefs` swaps correctly; `PIT_CheckLine` receives correct data.

Also confirmed IDENTICAL:
- BSP traversal via R_PointOnSide for spawn position (-224,-624): both reach
  ss133 (same subsector) through the same node path.
- BSP traversal for target position (-225,-626): both reach ss133.
- Player angle: 1023410176 on both platforms.
- Player z, floorz, ceilingz: IDENTICAL on both platforms.

All observable data is bit-identical between LE and BE at tic 1.

### (b) H10 confirmed: arithmetic divergence inside P_XYMovement

Since all data is identical, the divergence must be inside an arithmetic
computation.  The only arithmetic that runs at tic 1 BEFORE the first
`P_TryMove` call is:

1. `P_Thrust(angle, speed)` in `p_user.c` — calls `FixedMul(finecosine[a], v)`
   and `FixedMul(finesine[a], v)`.
2. `FixedMul` itself — pure `(long long)a * b >> 16`, endian-neutral.
3. `finesine[]` / `finecosine[]` table values at index derived from `angle`.

FixedMul is endian-neutral (confirmed).  The player angle is identical (confirmed).
The only remaining variable is the finesine/finecosine table values themselves.

### (c) Root cause localised: tables.c T_GenerateTables + missing TABLES_CRC check

`engine/core/r_main.c` R_InitTables is **dead code** (`#if 0` block, comment
says "UNUSED: now getting from tables.c").

The actual table init is in `engine/core/tables.c` T_GenerateTables():

```c
for (i = 0; i < 5*FINEANGLES/4; i++)
    finesine[i] = (fixed_t)
        (sin (((double)i + 0.5) * 2.0 * M_PI / 8192.0) * 65536.0);
T_ApplyFix ((int*) finesine, 5*FINEANGLES/4, ...);
```

Design intent:
1. Compute raw values from `sin()` (may vary by libm / FPU mode).
2. Apply packed 2-bit delta stream (`tables_fix.h`) to correct raw values to
   the 1993 canonical (truncated) table.
3. Verify with FNV-1a checksum: `T_Checksum() != TABLES_CRC` → `I_Error`.

**Bug**: step 3 is gated on `#ifdef TABLES_CRC`.  The be-build.sh (and the
native Makefile) do NOT define `TABLES_CRC`.  The checksum is never verified.

The delta stream in `tables_fix.h` was generated against a specific `sin()`
output (presumably x86 glibc libm).  If PowerPC musl libm's `sin()` returns
different truncated values for some inputs (or rounds differently), the delta
correction lands the table in a DIFFERENT final state than the 1993 canon.

The finesine[1952] entry (index for angle=1023410176 >> ANGLETOFINESHIFT) is
the exact value used for the player's thrust at tic 1.  If this entry differs
by even 1 LSB, the player's momx is wrong → wrong P_TryMove result.

### (d) Fix path (not implemented — capture-only per Lead directive)

Two options:

**Option A (diagnostic)**: print `finesine[1952]` after T_GenerateTables on
both LE and BE to confirm the table diverges and by how much.

**Option B (fix)**: add `-DTABLES_CRC=0x<canonical_hash>` to be-build.sh.
This enables the boot-time checksum; if PowerPC libm produces a non-canonical
table, the binary aborts with "tables differ from 1993 canon" rather than
silently computing wrong trajectories.  Then the fix would be to ship the
canonical table values as a static array (bypassing libm entirely on BE).

Option B also requires knowing the canonical TABLES_CRC value.  It is generated
by `tools/gen-tables.mjs` and stored somewhere in the build system.

**Status**: capture-only.  Lead directive: "if all 7 lines IDENTICAL (⇒ H10
arithmetic), do NOT chase further — capture that result and stop."

## Current state of m_swap.c

`engine/core/m_swap.c` has been extended with a `#ifdef __BIG_ENDIAN__` block:

```c
#else /* __BIG_ENDIAN__ */

short SwapSHORT(short x)
{
    unsigned short v = (unsigned short)x;
    return (short)((v >> 8) | (v << 8));
}

long SwapLONG(long x)
{
    unsigned long v = (unsigned long)x;
    return (long)(  ((v >> 24) & 0xffUL)
                  | ((v >>  8) & 0xff00UL)
                  | ((v <<  8) & 0xff0000UL)
                  | ((v << 24) & 0xff000000UL));
}

#endif /* __BIG_ENDIAN__ */
```

This resolves the linker error on BE targets.  The LE path is unchanged (still
`#ifndef __BIG_ENDIAN__`).  The wasm md5 is unaffected (LE-only build, no
`__BIG_ENDIAN__` in that path).

---

## RESOLUTION (lead, 2026-07-18) — ROOT CAUSE: char signedness

**The H10/tables hypothesis above is REFUTED.** `TABLES_CRC 0xddc6892cu` is
defined unconditionally in `tables_fix.h` (line 16), which `tables.c`
includes — the FNV-1a checksum gate is armed in EVERY build, including this
BE build. Had PPC musl's `sin()` diverged the tables, boot would have
aborted with "tables differ from 1993 canon"; it booted clean, so the
tables are canon on PPC. (A third libm passing the checksum is itself a
positive result for the §4.1 recipe.)

**True root cause: `char` signedness.** PowerPC's ABI defaults `char` to
unsigned; x86's to signed; the engine inherits x86's assumption. Adding
`-fsigned-char` to be-build.sh CFLAGS ⇒ **13/13 demos bit-identical**
(`be-check.sh` PASS). This also explains the divergence signature exactly:
no crash, map data identical (the 7-line diff), onset at tics 0–25
(first negative demo/table byte read through a bare `char` path per map).

Per-site audit (explicit `signed char` at each dependent use) is future
work; until then `-fsigned-char` is a port requirement, recorded in
bare-metal.md §5.1 item 6. ARM (also unsigned-char default) needs the same
flag — carried forward to task 13.4b's QEMU ARM build.
