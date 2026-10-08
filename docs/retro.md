# Retro targets

What this engine runs on besides the browser, what it provably cannot run on,
and the arithmetic behind each verdict. The rule in
[spec.md](../spec.md)'s hardware-targets table still holds: no hardware target
is attempted before its arithmetic exists.

Terms such as *leg* and *golden* are defined in [glossary.md](glossary.md). The
platform contract a no-OS port implements is [bare-metal.md](bare-metal.md).

| target | status | basis |
|---|---|---|
| Freestanding core (x86-32, ARM32, PowerPC, RV32, Cortex-M0+/M33) | **runs**, 13/13 demos tic-exact | legs `freestanding-sim`, `ro-wad`, `ro-wad-zc`, `arm-cross`, `be-cross`, `rv32-cross`, `armv6m-qemu`, `armv8m-qemu` |
| N64 (VR4300, emulated) | **runs, rendering every tic**, 13/13 demos, 44,580 tics bit-identical in simulation and framebuffer; 4.21× over the 35 Hz budget in ares, 4.64× showing the frame in exact colour | legs `n64-demos`, `n64-floor`, `n64-display`; no input or sound yet |
| RP2040 (2× Cortex-M0+, 133 MHz) | **predicted marginal on CPU, short on RAM** | section 5: 0.96–1.28× one core, 0.84–1.15× of core 0 split; the full memory diet links 4.92× over its SRAM |
| 386-class | **no harness** | about 3× short of 35 Hz; nothing here measures this code on one |
| Sega 32X | **open** | simulation fits one SH-2; render 1.5–3.4× over both |
| ESP32-S3 | **plausible, untested** | CPU 0.28–0.54× of one core (mean tic, section 4); needs PSRAM |
| RP2350 (2× Cortex-M33, 150 MHz) | **predicted: game fits one core; exact music does not fit the other** | section 5; worst tic measured on ARMv8-M in qemu, cycles estimated; PSRAM needed |
| Teensy 4.1 (Cortex-M7, 600 MHz) | **predicted pass, the upper bracket** | section 5; cycles estimated; PSRAM needed (the diet's 1.32 MB floor exceeds its 1 MB) |
| EFR32MG24 (Cortex-M33, 78 MHz) | **predicted fail** | section 5: 1.13–1.65× one core on the worst tic |
| Genesis + Sega CD | **infeasible** | CPU 13.5–30.6× over the combined budget |
| GBA | **infeasible** | CPU 5.4–12.3× over; RAM 5.9× short |
| SNES, SNES + Super FX 2 | **infeasible** | CPU 254–1,438× over (stock), 8.7–19.6× (Super FX 2) |

## 1. The freestanding core

`tools/freestanding/` builds `engine/core` with a platform layer that assumes
only three things: a static memory arena for the zone, a byte-out for the
per-tic hash stream, and a WAD blob already in memory. Nothing below the shim
opens a file. The result, `fs-doom`, is a 32-bit x86 binary (`gcc -m32 -O1`)
that replays a demo and writes per-tic simulation hashes:

```sh
make -C tools/freestanding                       # needs gcc with 32-bit multilib
./tools/freestanding/fs-doom wads/lib/doom2.wad -timedemo demo1 -sim out.json
```

It exists to prove that the core is a platform-layer-only port target. These
legs hold it to the same 13 golden demos the browser build is graded on (the
Cortex-M legs, `armv6m-qemu` and `armv8m-qemu`, are in section 5):

| leg | what it proves | needs |
|---|---|---|
| `freestanding-sim` | fs-doom's per-tic hashes equal the goldens, 13/13 ([run-check.sh](../tools/freestanding/run-check.sh)) | `fs-doom`, IWADs |
| `ro-wad` | the engine never writes the WAD: the blob is `mprotect(PROT_READ)` and any write faults with its address, so the WAD can execute in place from ROM or flash | `fs-doom`, IWADs |
| `ro-wad-zc` | the same with lumps read in place (`WEB_LUMPS_IN_PLACE`): no lump is ever written | `fs-doom-zc`, IWADs |
| `arm-cross` | the core cross-built for `arm-linux-musleabihf` by zig and run under `qemu-arm-static` is 13/13 | zig ≥ 0.16, `qemu-arm-static` |
| `be-cross` | the same on big-endian `powerpc-linux-musleabi` under `qemu-ppc-static`, with `-fsigned-char`; the cheapest big-endian cover in the suite. It also plays doom-demo4 with audio and requires its synth and mixer hashes to equal the x86 reference | zig ≥ 0.16, `qemu-ppc-static` |
| `rv32-cross` | the same on RV32IMAC (soft-float) and RV32GC under `qemu-riscv32-static` | zig ≥ 0.16, `qemu-riscv32-static` |

Two details a porter needs. First, the doom.wad demos must be presented as
`doomu.wad`: `IdentifyVersion()` tries `doomu.wad` before `doom.wad`, the
goldens were recorded as Ultimate DOOM, and `demo4` desyncs from tic 0
otherwise. Second, these legs check correctness only. Emulated cycles are not
hardware cycles, so no timing comes from qemu (the Cortex-M legs count
instructions, not time).

[IMPORTS.md](../tools/freestanding/IMPORTS.md) lists every libc symbol fs-doom
imports: the checklist of what a bare-metal port must provide or remove.

fs-doom is also the instrument behind the arithmetic in section 3: it counts
retired instructions per tic and zone high-water marks.

## 2. The N64 port

### What runs

`tools/n64/` cross-compiles the unmodified `engine/core` with libdragon for the
NEC VR4300 (93.75 MHz, big-endian MIPS, 16 KB instruction and 8 KB data cache,
4 MB RDRAM, 8 MB with the Expansion Pak). Nine shim files replace the core's
`i_main`, `i_system`, `i_video`, `i_sound`, `i_net` and `d_net`.

The ROM boots under the ares emulator, reads a full IWAD (12.4 MB for doom.wad)
in place out of cartridge space, plays `-timedemo demoN -nodraw`, and prints
its per-tic simulation hashes. Every one of the 13 demos (44,580 tics) is
bit-identical to the wasm goldens. Measured on alder at `7f5c682`, 2026-10-05:
13/13 PASS.

`-nodraw` is there for symmetry, not speed: the goldens are recorded with
`callMain(['-timedemo', demo, '-nodraw'])`, and a differential only means
something if both sides run the same command line. A side effect is that the
software renderer never runs in that leg.

The floor builds (`N64_FLOOR=A|B`, below) drop `-nodraw`: the renderer runs
every tic, and every tic's framebuffer hash matches the render goldens on all
13 demos too (leg `n64-floor`).

Not done:

- **Display, beyond measuring it.** The `n64-demos` build is headless (it
  copies each frame into a 64,000-byte shadow buffer). The floor builds can
  show the frame (`N64_DISPLAY=1`, below), but only to measure its cost: one
  buffer, never synchronised to the vertical blank, so it may tear. No RDP
  path exists.
- **Input.** No controller support (libdragon `joypad.h` is the route).
- **Sound.** `i_sound_n64.c` is all stubs.
- **Real hardware.** Not run. The emulator legs are the gate; a run on a
  SummerCart64 in an Analogue 3D, and then on a real console, is listed in
  [Plans.md](../Plans.md) as blocked on hardware.
- **Speed.** Measured in ares only (the next section): 4.21× over the 35 Hz
  budget on the worst graded tic. No hardware timing exists.

### The `n64-demos` leg

Prerequisites (the runner checks the toolchain, ares, `xvfb-run` and the WADs
before the leg starts):

- `source ~/toolchains/env.sh`, which sets `N64_INST` (mips64-elf-gcc 14.4.0,
  binutils, newlib), `LIBDRAGON` (the SDK source) and puts `ares` on `PATH`;
- `xvfb-run` (ares needs an X display even headless) and `python3`;
- `wads/lib/` holding doom.wad, doom2.wad, tnt.wad and plutonia.wad.

```sh
source ~/toolchains/env.sh
bash tools/run-tests.sh --only n64-demos           # as a suite leg
bash tools/n64/run-n64-demos.sh                    # directly, all 13
bash tools/n64/run-n64-demos.sh '^doom-demo1$'     # one demo (grep -E over <iwad>-<demo>)
```

The leg is tagged `slow` and `heavy`: `--no-slow` skips it by name, and under
`--jobs` it may overlap other legs. It takes 6–7 minutes for all 13 demos on
alder (435 s alone at `7f5c682`; 392 s inside the full suite at `--jobs 6`,
2026-10-08). The two ARM RAM-floor legs, about 40 minutes each, are now the
longest. A filter that matches no demo is an error, and a filtered pass
says it is not the full 13.

For each demo [run-n64-demos.sh](../tools/n64/run-n64-demos.sh):

1. deletes every shim object and rebuilds the ROM with `N64_WAD`,
   `N64_WAD_NAME` and `N64_TIMEDEMO` (make cannot see a changed `-D` flag, so
   any object it keeps would carry the previous demo's constants);
2. runs ares under `setsid timeout 600 xvfb-run`, polls the log for
   `N64_TRACE_END`, then kills the whole process group;
3. checks the ROM printed `registry name '<expected WAD name>'` before looking
   at a hash, because a ROM built with the wrong IWAD identity can still
   produce a full, plausible trace;
4. parses the trace and compares it with `tools/golden/<iwad>-<demo>.json`.

Every failure is named, never silent:

| failure | meaning |
|---|---|
| `missing-wad`, `build-fail`, `no-golden` | the input or the ROM is missing |
| `wrong-wad-identity` | the ROM registered a different IWAD name |
| `no-trace` / `no_markers` | no `N64_TRACE_END` within 600 s |
| `truncated_log` | the printed body disagrees with the length the ROM declared |
| `unparseable_trace_line` | a hex line did not parse |
| `len_mismatch` | the trace length differs from the golden |
| `hash_mismatch:first_at_tic=N` | a real divergence, with the first tic, both values and the mismatch count |

The trace leaves the console as text. `n64_dump_trace()` prints it between
`N64_TRACE_BEGIN <n>` and `N64_TRACE_END <n>` over libdragon's debug channel
(ISViewer), eight hashes per line; ares writes that channel to stdout. Use the
ares GDB stub only for a backtrace after a crash: it halts the CPU on attach and
nothing resumes it.

### The floor runs: render mode, COUNT per tic, and the `n64-floor` leg

[tools/floor/run-n64.sh](../tools/floor/run-n64.sh) builds each demo with
`N64_FLOOR=A` (render and hash every tic) and `N64_FLOOR=B` (render and record
COP0 COUNT per tic, hashing nothing), runs every ROM under ares, extracts the
FLOOR log each prints after its demo, and grades the logs with
[floor-gate.mjs](../tools/floor/floor-gate.mjs). The unit is COUNT, half the
CPU clock (46,875,000 a second), so the 35 Hz budget is 1,339,285 counts a
tic. ares is deterministic in emulated time: the two mode B runs agree to the
count, and running it unthrottled (`Audio/Blocking=false`) changes no count.

```sh
source ~/toolchains/env.sh
bash tools/floor/run-n64.sh --correctness   # the n64-floor leg: CORRECT or FAIL
bash tools/floor/run-n64.sh                 # A + B + B, the gate, floor-stats
```

Measured on alder, 2026-10-07, at `75ae491`, ares e1b0d47 (recompiler),
stock 4 MB:

- Correctness: CORRECT on all 13 demos (44,580 tics), sim and render.
- The gate FAILs on audio alone (no N64 audio yet: 78 lines, 3 per run).
- Worst graded tic 5,633,118 counts = 120.2 ms, plutonia-demo1 tic 5043
  (also the host's worst tic): **4.21×** the budget. Mean 2,323,029 (1.73×);
  95.5% of graded tics are over. Code layout alone moves these: a few
  instructions added to `I_Error` moved the worst tic by 0.14%.
- `n64-floor` took 76 s on alder alone (13 ROMs at a time), and 175 s
  inside the full suite at `--jobs 6` on 2026-10-08.
- Against the host tic for tic, 3.41 N64 cycles per x86 instruction over all
  graded tics (2.97–3.72 per demo): section 4's *F*, measured in an emulator.
- ares's own profiler (`--xprof`, at `190ce86`, ForceInterpreter, all 13
  demos; the profile build reads 8–10% more COUNT than plain mode B): CPI 3.73,
  and 63.6% of all cycles are cache fills and writebacks at ares's charges
  (40 cycles a D-cache line, 48 an I-cache line). `R_DrawSpan` alone is 30%
  of all cycles: 83 cycles a pixel, with 0.92 D-cache misses and 0.70
  writebacks a pixel, because the framebuffer is column-major and a span walks
  across it. Wall columns cost 25 cycles a pixel.
- Under ForceInterpreter (full I-cache emulation, at `190ce86`) graded tics
  read 2.9% lower (median; 1st–99th percentile −7.2% to +1.9%); the worst
  tic 5,405,025 against 5,625,078.
- Lump copies use PI DMA (`cart_read_n64.c`): 9.2 counts a byte against the
  word path's 41.0. With the word path (`fed05c4`) the worst graded tic is a
  cache-miss tic, tnt-demo2 tic 113 (106,902 B), at 6,483,742 counts; with
  DMA (`4449135`) that tic takes 3,114,892.
- With the Expansion Pak and a 6 MB zone (`4449135`; a data point, not
  graded), the tics that copy from the WAD fall from 2,663 to 259 and the
  worst tic is 5,528,612 counts (4.13×): the zone is not what limits it.

### Showing the frame: `N64_DISPLAY=1` and the `n64-display` leg

The floor's bar (decided 2026-10-07) is exact colour: every palette entry
shown as its 8:8:8 value, with the conversion inside the timed tic. The RDP cannot do that, because its
palette (TLUT) entries are 16-bit (libdragon `rdpq_mode.h`: `TLUT_RGBA16` is
5:5:5:1), so the CPU converts. Each tic, `I_FinishUpdate` turns the
column-major `screens[0]` into a 320×240 32-bit VI framebuffer (the 200 rows
letterboxed in rows 20..219) through a 256-entry table rebuilt only when the
palette changes, by the web build's rule (`gammatable[usegamma][PLAYPAL]`;
gamma 0 is not the identity in vanilla's table). Each output line is one
D-cache line: Create Dirty Exclusive, four stores, Hit Writeback Invalidate
(`fdf18a1`).

Exactness: the `n64-display` leg hashes the framebuffer every tic, read
uncached out of RDRAM, against the browser build's own frames converted on
the host (2 demos, 2,023 tics; all 13 demos, 44,580 tics, 8,647 of them under
a damage or pickup palette, pass by hand). Four wrong conversions fail it:
blue +1, a wrong palette index, a table never rebuilt (exactly the palette
flash tics) and a missing writeback (`a44b3fc`).

Cost, ares e1b0d47, all 13 demos (COUNT, half the CPU clock):

| build (zone) | worst graded tic | mean | display bracket per tic |
|---|---|---|---|
| no display (2,560 KB, as above) | 5,633,118 (**4.21×**) | 2,323,029 | — |
| no display (2,224 KB) | 5,590,814 (4.17×) | 2,339,238 | — |
| display (2,224 KB) | 6,209,424 (**4.64×**, 132.47 ms) | 3,075,973 | 672,595 mean, 687,191 max (50.2% of the budget) |

The framebuffer is 307,200 B of libdragon's heap, which is why a display ROM
needs the smaller zone. Tic for tic the display build is 736,733 counts
slower, 64,138 more than the bracket (the VI interrupt and the engine data
the conversion evicts). In ares's profiler 62% of the conversion is D-cache
writebacks and fills at 40 cycles a line, so about 400,000 counts a frame is
the floor for any cached path here. ares does not model VI scanout's RDRAM
bandwidth (320×240×4 B at 60 Hz, 18.4 MB/s on a console) nor the VR4300's
uncached write path, so both are unmeasured.

```sh
bash tools/floor/run-n64.sh --correctness --display 1       # exactness, all 13 (n64-display: 2)
bash tools/floor/run-n64.sh --timing-once --zone-kb 2224 --out A
bash tools/floor/run-n64.sh --timing-once --display 1 --against A
```

### Building by hand

```sh
source ~/toolchains/env.sh
make -C tools/n64                      # ELF + .z64 with doom.wad, prints the size table
make -C tools/n64 N64_WAD=             # footprint ROM, no WAD
make -C tools/n64 N64_TIMEDEMO=demo1   # timedemo ROM (as the leg builds it)
make -C tools/n64 boot-log             # 15 s under ares, prints the debug channel
```

Overridable: `N64_ZONE_KB` (2560), `N64_WAD` (`../../wads/lib/doom.wad`),
`N64_WAD_NAME` (`doomu.wad`), `N64_WAD_OFFSET` (2 MiB), `OBJ_DIR`, `OUT_ELF`,
`OUT_ROM`. The WAD is appended to the ROM at `N64_WAD_OFFSET` and addressed
through uncached KSEG1 at `0xB0000000 + offset`; its length is measured when
the ROM is built and compiled in, because the shim has no filesystem to ask.

### Memory

In the floor builds (render mode) the shadow framebuffer and the hash trace are
gone: statics are 3,358,304 B before the floor log's own per-tic arrays
(172,316 B in mode A, 270,660 B in mode B), measured 2026-10-07. The core's
`info[2500][10]` (100,000 B, `w_wad.c`) costs nothing here: it has its own
`.bss.info` section and `--gc-sections` drops it with the unused `W_Profile`.

Footprint build (`N64_WAD=`, default zone) with 256 visplanes, measured on
alder 2026-10-08 with `mips64-elf-size` and `mips64-elf-nm` (`make size`,
`3a8dda5`). The whole image is in RDRAM, code included, and libdragon's
stack takes the top 64 KB:

| item | bytes |
|---|---|
| `.text` (code + rodata) | 398,156 |
| `.data` | 57,040 |
| `.bss` | 3,405,260 |
| **the image, 0x80000400 to `__bss_end`** | **3,861,104** of 4,194,304 |
| heap left after the 64 KB stack | 267,664 (n64-demos ROM 267,392; floor A 195,184; floor B 96,448) |
| of which `n64_arena`, the zone | 2,621,440 |
| `n64_screenbufs` (four 320×200 screens) | 256,000 |
| `visplanes` | 169,984 |
| `n64_shadow_fb` (headless video stub) | 64,000 |
| `vissprites` | 61,440 |
| `n64_trace` (the hash trace) | 40,000 |
| footprint ROM | 475,136 |

The zone is 2,560 KB because 512 KB runs out during the attract demo; the
non-purgeable peak alone is 1,081,972 B (section 3).

### MIPS landmines

Each of these compiles cleanly and fails at run time, or fails to link with an
unhelpful message. None needs a change to `engine/core`; all are handled in
[tools/n64/Makefile](../tools/n64/Makefile) or the shim.

| landmine | what goes wrong | how this port handles it |
|---|---|---|
| **Endianness** | The core byte-swaps WAD fields only `#ifdef __BIG_ENDIAN__`. mips64-elf-gcc 14.4 defines `__BYTE_ORDER__ == __ORDER_BIG_ENDIAN__` and `__MIPSEB__`, never `__BIG_ENDIAN__`, so `SHORT()`/`LONG()` silently become no-ops. | `-D__BIG_ENDIAN__`. Dump predefined macros with `-dM -E` under the real flags; never assume one. |
| **Cartridge reads** | The PI bus returns wrong bytes for sub-word reads of cartridge space; only aligned 32-bit reads are reliable. The WAD cannot be copied to RDRAM (12.4 MB vs 4 MB). | `--wrap,memcpy` and `--wrap,strncpy` route the core's two copies out of the WAD (directory names, lump data) to [cart_read_n64.c](../tools/n64/cart_read_n64.c), which rebuilds each byte from aligned word reads. RAM-to-RAM copies fall through to libc. |
| **Alignment** | The R4300 traps on a misaligned multi-byte load. | The core already reads `maptexture_t` (`r_data.c`) and sprite names (`r_things.c`) with `read_le16`/`read_le32`. Patch `columnofs[]` loads are aligned because every lump is copied into a zone block (sizes rounded to 4 bytes) before use; a port that renders straight from ROM must revisit them. |
| **`char` signedness** | The core needs signed `char` in places; PowerPC's unsigned default desynced demos within 25 tics. | mips64-elf-gcc defaults to signed (no `__CHAR_UNSIGNED__`); `-fsigned-char` pins it anyway. |
| **Strict aliasing** | Map loading casts raw WAD bytes to struct pointers. | `-fno-strict-aliasing`, as in every other build. |
| **Lump handle as `int`** | `lumpinfo_t::handle` stores a pointer in an `int`. | `-mabi=o64` has 32-bit `int`, `long` and pointers (`__SIZEOF_POINTER__ 4`), so nothing truncates; `-Wno-int-to-pointer-cast -Wno-pointer-to-int-cast` silence the warnings. An LP64 ABI would truncate every handle. |
| **C dialects** | The core needs `-std=gnu89` (implicit `int`); libdragon's non-static `inline` functions are multiply defined under gnu89. | Two flag sets: `CORE_CFLAGS` gnu89, `PLAT_CFLAGS` gnu11. Anything appended to `COMMON_FLAGS` must come before those two `:=` lines; the Makefile stops with an error if `-DN64_TIMEDEMO` misses `PLAT_CFLAGS`. |
| **Constructors** | libdragon traps on an unpopulated constructor list before `main()`, with no output. | `-Wl,--wrap,__do_global_ctors`, as libdragon's own `n64.mk` does. |
| **Savegames** | `p_saveg.c` writes native-endian structs containing pointers. | Not handled: N64 saves are valid only for the same N64 binary. |

## 3. How the arithmetic works

For a target clocked at *C* Hz, the budget is *C* / 35 cycles per tic. Demand
is the measured instruction count per tic on x86 times *F*, an estimated
cycles-per-instruction factor for the target that folds in its CPI, ISA
density and memory system. The verdict is demand ÷ budget.

The inputs below were measured on alder at `7f5c682`, 2026-10-05, with fs-doom
(`gcc -m32 -O1`, user-space retired instructions from `perf_event_open`) over
the 13 demos, without audio. Each IWAD's figure is the mean of its demos'
per-tic means, load tics included. Two passes agreed within 3% per demo. They
predate fs-doom's virtual clock (`201c4ff`), which adds about 17 K
instructions a tic; [tools/floor/demand.mjs](../tools/floor/demand.mjs) and
its golden (`tools/golden/floor-demand.json`) are the maintained per-demo
figures, graded tics only.

| IWAD | mean instr/tic | `-nodraw` mean (simulation only) | share |
|---|---|---|---|
| doom.wad | 1,299,842 | 76,792 | 5.9% |
| doom2.wad | 1,352,280 | 120,028 | 8.9% |
| tnt.wad | 1,370,751 | 91,825 | 6.7% |
| plutonia.wad | 1,471,259 | 124,658 | 8.5% |

The worst p99 is about 2.64 M instructions per tic (doom-demo4). Rendering is
over 90% of the work, so a target that can run the simulation may still be far
from running the game.

Writable RAM has two parts. The N64 link above holds 647,628 B of statics once
its zone, shadow framebuffer and hash trace are subtracted (engine tables,
render arrays, the four screen buffers, libc). The zone's non-purgeable peak,
measured with a 32 MiB zone, is 1,081,972 B (tnt-demo2; the lowest is 612,808
B, doom-demo4). Together that is about **1.65 MiB** before any purgeable lump
cache, which a playable zone also needs. The WAD itself needs no RAM where it
can execute in place (`ro-wad`).

To re-measure:

```sh
make -C tools/freestanding
WD_AUDIO=0 WD_CYCLES=1 taskset -c 2 ./tools/freestanding/fs-doom <wad> -timedemo demoN -cycles cyc.json           # whole program
WD_AUDIO=0 WD_CYCLES=1 taskset -c 2 ./tools/freestanding/fs-doom <wad> -timedemo demoN -nodraw -cycles cyc.json   # simulation only
make -C tools/freestanding EXTRA_CFLAGS="-DWEB_PERF_ZONE_STATS -DFS_ZONE_SIZE_OVERRIDE=33554432"
WD_AUDIO=0 ./tools/freestanding/fs-doom <wad> -timedemo demoN -zonestats zs.json                                  # zone peaks
```

(Present doom.wad as `doomu.wad`, and build the zone-stats binary into a
separate copy so it does not replace the gated one. fs-doom plays sound and
OPL music unless `WD_AUDIO=0`; the figures above are without it. On a hybrid
CPU, pin to a performance core: alder's E-cores count nothing.)

**F is an estimate, not a measurement.** The one real-world anchor is id's DOS
binary on a 486DX2-66: about 21.5 fps at full detail (FastDoom's published
benchmark), or 3.07 M cycles per frame. This build retires 1.30 M instructions
per tic on the same IWAD, so a 486 would need about 2.4 cycles per instruction
of this build to match. That compares two different binaries, so it bounds
plausibility rather than calibrating anything. The per-target ranges below are
estimates in that spirit; treat their low ends as optimistic.

## 4. Verdicts

| target | clock | budget (cycles/tic) | F (est.) | demand (cycles/tic) | demand ÷ budget | writable RAM |
|---|---|---|---|---|---|---|
| N64 VR4300 | 93.75 MHz | 2,678,571 | 1.2–2; **3.41 measured in ares** | 1.56 M–2.94 M; worst tic 11.27 M measured | **0.58–1.10×**; **4.21× measured** (emulated) | 4 MB, fits |
| ESP32-S3 | 240 MHz/core | 6,857,143 | 1.5–2.5 | 1.95 M–3.68 M | **0.28–0.54×** | 512 KB SRAM; PSRAM required |
| RP2040 | 270 MHz/core | 7,714,286 | 3–5 | 3.90 M–7.36 M | **0.51–0.95×** | 264 KB; **4.00× short** (measured) |
| Sega 32X | 2 × 23 MHz | 657,143 per SH-2 | 1.5–3 | 1.95 M–4.41 M | **3.0–6.7×** one SH-2, 1.5–3.4× both | 256 KB; 6.6× short |
| GBA | 16.8 MHz | 480,000 | 2–4 | 2.60 M–5.89 M | **5.4–12.3×** | 288 KB; 5.9× short |
| SNES + Super FX 2 | 21 MHz | 600,000 | 4–8 | 5.20 M–11.77 M | **8.7–19.6×** | well under 1 MB |
| Genesis + Sega CD | 7.67 + 12.5 MHz | 576,286 combined | 6–12 | 7.80 M–17.66 M | **13.5–30.6×** | 896 KB; 1.9× short |
| SNES | 3.58 MHz | 102,286 | 20–100 | 26.0 M–147 M | **254–1,438×** | 128 KB; 13× short |

Each range pairs the lightest IWAD (doom.wad) with the low *F* and the
heaviest (plutonia.wad) with the high *F*. RAM shortfalls are against
section 3's 1.65 MiB, a demos-only estimate for the default build. Section 5
measures the floor with real play included: 3,023,193 B for the default build,
and 1,316,715 B with the memory diet on Cortex-M.

**N64.** The simulation and the renderer are proven tic-exact (`n64-demos`,
`n64-floor`). The estimate above said the full game was 0.58–1.10× of the
budget on the CPU alone; measured in ares it is 4.21× on the worst graded tic
and 1.73× on the mean, because *F* came out at 3.41, not 1.2–2 (section 2's
floor runs). The 8 KB data cache is most of it: 63.6% of all cycles are line
fills and writebacks at ares's charges, and `R_DrawSpan` over a column-major
framebuffer misses about once a pixel. Emulated cycles are not hardware
cycles, and no hardware run exists. The RDP rasterizes textured primitives in
hardware and could take much of the render off the CPU, but only if its output
were pixel-identical to the software renderer's, which nothing here has
attempted; section 5 treats the N64 as out on its CPU. Prior art: jnmartin84's 64doom runs linuxdoom on the
N64, playable, with demo compatibility not verified.

**RP2040 (link only).** Section 5 measures it on the current tree: ARMv6-M
code under qemu, and the full memory diet linked with pico-sdk 2.3.0. The
diet's play-inclusive RAM floor is 1,316,715 B, and the link is 1,051,924 B
over the 268,288 B of SRAM pico-sdk's linker script gives it (4.92×). A 2 MB
Pico cannot hold the code and tables (about 1.75 MB) and the WAD. On the CPU,
at the stock 133 MHz, the worst graded tic is 0.96–1.28× of one core, and
0.84–1.15× of core 0 with the frame split over both cores. kilograham's
rp2040-doom runs on this chip at 270 MHz by replacing the asset pipeline (WHD)
and the memory layout; this code would need the same plus external PSRAM.
(The first link, of the default build on 2026-07-23, needed 1,082,104 B
against 270,336 B, 4.00×; that build is gone.) Below 100 MHz, section 5
predicts the EFR32MG24 (78 MHz) at 1.13–1.65× of its one core.

**386-class (no harness).** A 386DX-40 has 1,142,857 cycles per tic and no
on-chip cache. At the 486's ~2.4 cycles per instruction the doom.wad demand is
2.7× its budget, and a 386 does worse per instruction than a 486. FastDoom, an
optimized fork of id's code, reaches 10–12 fps there: 2.9–3.5× short of 35 Hz.
The 86Box harness that once existed here was removed: it booted FreeDOS and ran
id's DOS `DOOM.EXE`, so it would have measured id's binary, not this code.

**Sega 32X (open).** The simulation fits one SH-2 at 18–57% of its budget.
The whole game is 3.0–6.7× one SH-2's budget, and still 1.5–3.4× over both
together with a perfect split, which DOOM's serial BSP walk does not allow. RAM is 256 KB of
SDRAM against 1.65 MiB. Prior art: D32XR, from the Jaguar code base, runs game
logic at 15 Hz. No demo-compatible vanilla port exists.

**ESP32-S3 (plausible, untested).** Two LX7 cores at 240 MHz; the whole game
is 0.28–0.54× of one core, leaving the other for audio and I/O. The 512 KB of
internal SRAM is 3.3× short, so PSRAM (2–16 MB parts exist) is mandatory, and
PSRAM latency on framebuffer column writes is the expected bottleneck.
[bare-metal.md](bare-metal.md) sketches a credible configuration. Nothing here
has been built for it.

**Genesis + Sega CD (infeasible).** The two 68000s multiply only 16×16 bits, at up
to 70 cycles each, so a 32×32 `FixedMul` is several multiplies plus shifts and
adds. The combined budget of 576,286
cycles per tic is 13.5–30.6× short. External anchor: krikzz's doom-68k reaches
1–2 fps with in-cartridge FPGA multiply/divide and 0.3–0.5 fps on the Genesis
alone. RAM is 896 KB in total against 1.65 MiB, and the VDP shows 4-bit tiles,
not a 320×200 8-bit framebuffer. A bring-up would be a stunt with named cuts,
not this engine.

**GBA (infeasible).** An ARM7TDMI at 16.8 MHz with no data cache is 5.4–12.3×
short, and 288 KB of RAM is 5.9× short. GBADoom runs on it and does not keep
vanilla demo compatibility.

**SNES (infeasible).** The 65C816 has no general multiply, so a 32×32
fixed-point multiply takes 150–400 cycles; the CPU is 254–1,438× short and its
128 KB of RAM is 13× short. The Super FX 2 coprocessor narrows the CPU gap to
8.7–19.6× and leaves RAM well under 1 MB. The 1995 SNES DOOM ran a different,
non-vanilla engine on the Super FX 2.

## 5. The floor (2026-10-07): the worst graded tic, measured per ISA

Sections 3 and 4 grade the *mean* tic against estimates. The floor bar is
stricter: all 13 demos tic-exact, full detail, every tic rendered, music and
sound effects running, and the **worst** graded tic within 1/35 s (a tic in
which a level load, intermission or finale started is not graded). The gate is
[tools/floor/floor-gate.mjs](../tools/floor/floor-gate.mjs); a verdict comes
only from hardware. What follows is measured demand and *predicted* cycles.

### Demand at the worst graded tic

The worst graded tic is the same on every ISA: plutonia-demo1 tic 5043 (sim
23% of it, against 4–6% on an average tic). Instruction counts repeat to
within a few instructions (timedemo runs on a virtual clock, one NetUpdate
iteration per tic, as on a target at 35 Hz).

| build | worst graded tic | mean tic | leg |
|---|---|---|---|
| x86 (gcc -m32 -O1), game only | 3,450,250 instructions | ~1.38 M | `floor-demand` |
| x86, with the exact OPL2 synth and 8-channel mixer | 10,485,508 instructions (18,265,778 before the synth's savings) | ~8.1 M | `floor-x86` |
| ARMv6-M (Cortex-M0+ code, qemu mps2-an385), game | 4,922,520 instructions | ~1.80 M | `armv6m-qemu` |
| ARMv8-M (Cortex-M33 code, qemu mps2-an505), game | 2,588,800 instructions | ~1.04 M | `armv8m-qemu` |
| x86, lumps read in place (zero-copy), game only | 3,444,752 instructions | ~1.37 M | `demand.mjs --compare fs-doom-zc` |
| ARMv6-M, lumps read in place | 4,934,200 instructions | ~1.80 M | `armv6m-zc` |
| ARMv8-M, lumps read in place | 2,583,150 instructions | ~1.04 M | `armv8m-zc` |
| N64 VR4300 in ares, game | 11.27 M cycles (5,633,118 COUNT) | 4.65 M | `n64-floor`, section 2 |
| ARMv6-M, fast drawers + FixedMul/FixedDiv without libgcc (below) | 3,398,520 instructions | ~1.32 M | `armv6m-fast` |
| ARMv8-M, fast drawers + FixedDiv without libgcc (below) | 2,293,850 instructions | ~0.93 M | `armv8m-fast` |
| x86, the full memory diet, with audio | 10,535,074 instructions | — | `floor-lean` |
| ARMv6-M fast, lumps in place, with the exact synth and mixer | 12,634,240 instructions | ~10.11 M | `cortexm-audio` (doom-demo4); all 13 by `audio-check.mjs --demos all` |
| ARMv8-M fast, lumps in place, with the exact synth and mixer | 8,580,950 instructions | ~6.95 M | the same |
| N64 in ares, game + the exact 32-bit display (2,224 KB zone) | 12.42 M cycles (6,209,424 COUNT) | 6.15 M | section 2 |

- The counts above are as measured on 2026-10-07, and a code change moves
  them by a few hundred instructions at most. On 2026-10-08, at the tree
  that rebuilt boss targets on a load and put DOS's null sector at glass
  lines, the four Cortex-M legs read 4,922,640 (`armv6m-qemu`), 2,588,950
  (`armv8m-qemu`), 4,934,360 (`armv6m-zc`) and 2,583,300 (`armv8m-zc`).
  Master just before that read 2,583,250 on `armv8m-zc`.
- The exact synth (byte-identical to `tools/floor/synth-ref.json`, the L2
  grade) was 14.3 M x86 instructions per tic. Its exact savings are now in
  `engine/web/opl3.c` (bank 1 skipped until it is written, the noise LFSR
  stepped once a sample, no resampler at the chip's rate), and fs-doom builds
  it position-dependent: 6.53 M mean, 6.98 M worst at fs-doom's -O1, 5.96 M
  and 6.42 M at -O2 (OPL2, `tools/floor/synth-cost.mjs`). `synth-exact` holds
  it sample-identical to the unmodified core on all 137 IWAD scores, both
  modes, and on random register streams. On a real OPL2 chip (the L1 grade,
  vanilla's own setup) the CPU only sequences.
- The sound on ARM, measured (`615a1b0`): the synth, the mixer and the
  channels cost, per graded tic over the 13 demos at -O1, 8,785,826 mean and
  9,341,360 max instructions on ARMv6-M, 6,020,706 and 6,434,200 on ARMv8-M
  (5,307,997 and 5,733,750 at -O2), against 6,707,493 and 7,250,166 on x86.
  So ARMv8-M is about 0.90 of x86 here, not the 0.75 the game shows; both
  boards build soft-float (the M33 build has no VFP instructions), and the
  sequencer's doubles are about 6.5% of the sound on ARMv8-M. The `AUDIO`
  line equals `tools/floor/audio-ref.json` on all 13 demos on both ISAs:
  the synth and mixer are sample-exact on ARM. The copying builds cannot play
  sound on the qemu boards (the mixer reads effects in place from the WAD),
  so these run lumps in place.
- The M0+ calls software helpers up to 19,646 times a tic for 64-bit multiply
  (`__aeabi_lmul`) and 3,414 for divide; their instructions are in its count.
- Memory: the default build needs a 1,216 KiB zone for the 13 demos and
  1,764 KiB for real play; the memory diet below takes a Cortex-M port's whole
  RAM floor to 1.32 MB.

### Zero-copy lumps

On a microcontroller the WAD sits in memory-mapped flash, and the engine never
writes it (`ro-wad`), so a lump can be used where it lies instead of copied
into the zone. `WEB_LUMPS_IN_PLACE` does that ([bare-metal.md](bare-metal.md)
§2.3e); it is off in the browser build, whose `doom.wasm` it leaves
byte-identical. Measured on the 13 demos, all tic-exact in sim and render:

| | copying (`fs-doom`, default Cortex-M builds) | in place (`fs-doom-zc`, `ZC=1`) | legs |
|---|---|---|---|
| smallest zone, x86 with audio | 1,216 KiB (1,212 fails) | **924 KiB** (920 fails) | `zone-min`, `zero-copy` |
| smallest zone, Cortex-M under qemu, no audio | 1,200 KiB on ARMv6-M (1,196 fails) | **924 KiB** on ARMv6-M and ARMv8-M (920 fails) | `zone-min-armv6m-zc` |
| lumps copied | every lump the game touches | COLORMAP, once, at startup | `ro-wad-zc` |
| graded tics that copy from the WAD, x86, at each build's minimum zone | 9,797 tics, 214 MB, worst 250,701 B | 134 tics, 1.32 MB, worst 42,226 B, all composite-texture fills | |
| worst graded tic, x86, game only, 8 MiB zone | 3,450,250 | 3,444,752 (−0.16%) | `demand.mjs --compare` |
| worst graded tic, x86, game only, 1,216 KiB zone | 3,518,614 | 3,444,751 (−2.10%) | |
| worst graded tic, ARMv6-M, both at a 2 MiB zone | 4,923,120 | 4,934,200 (+0.23%) | `armv6m-zc` |
| worst graded tic, ARMv8-M, both at a 2 MiB zone | 2,589,400 | 2,583,150 (−0.24%) | `armv8m-zc` |

- The ARMv6-M build pays for the byte-safe reads a lump at any offset needs
  (`LUMP_PACKED` fields become byte loads and shifts on an M0+); ARMv8-M and
  x86 read unaligned words natively. qemu's copying build pays nothing for
  the copies themselves (semihosting moves the bytes, wad_semi.c), so on a real
  board copying costs more than these counts say; on x86 it is in the count.
- The zone that is left is the engine's own data: the texture tables
  `R_InitTextures` builds (about 340 KB for tnt.wad), the level (`PU_LEVEL`)
  and the composite textures.
- RAM a Cortex-M port needs before the memory diet (the next subsection), with
  the 13 demos only, from the ARMv6-M map file and the runs' stats (harness
  buffers excluded): zone + engine `.data`/`.bss` (467,737 B) +
  screens (320,000 B) + audio state (71,676 B) + heap peak + stack peak
  (5,576 B) + newlib and platform (3,900 B). Copying: 2,221,733 B (its
  1,200 KiB zone); in place: **1,939,241 B** (1.85 MiB), 13% less; the heap
  peak is 124,176 B in both. Still 3.6× the RP2350's 520 KB: PSRAM stays
  necessary.
- The WAD: tools/cortexm's zero-copy build loads it into the qemu board's
  16 MiB PSRAM at boot, as flash would hold it. doom.wad and doom2.wad fit
  there; plutonia.wad and tnt.wad are 645,760 B and 1,422,076 B too long, and
  those bytes come from the ZONE SSRAM above a 2 MiB arena. A real board's
  flash also holds the code and tables: on a 16 MiB board with the WAD at
  3 MiB only doom.wad fits (the RAM floor's flash note below).
- Alignment is proven on the board that traps: `armv6m-zc-misaligned` replays
  the 13 demos from WADs rewritten with every lump at an odd offset.

### The memory diet and the RAM floor

Each lever is an opt-in for bare-metal builds, proven tic-exact on all 13
demos by its own leg, and leaves the browser's `doom.wasm` byte-identical:

| lever | define | what it moves | leg |
|---|---|---|---|
| vanilla's 128 visplanes and vissprites | `MAXVISPLANES`, `MAXVISSPRITES` | −138,752 B of .bss (peaks 118 and 123) | `floor-lean` |
| lookup tables as const data | `TABLES_CONST` | −65,568 B of .bss, checked by `TABLES_CRC` at boot | `floor-lean` |
| screens borrowed from the zone, a 32-row status bar | `LEAN_SCREENS` | −254,712 B of .bss | `lean-screens` |
| texture tables and composites as const data, per IWAD | `TEXTURES_CONST`, `COMPOSITES_CONST` | zone 920 → 544 KiB (lean, in place); a PWAD that changes textures falls back to building them | `textures-const` |
| lumps read in place | `WEB_LUMPS_IN_PLACE` | zone 1,216 → 924 KiB | `zero-copy`, `ro-wad-zc` |
| the level read in place and narrowed | `LEAN_LEVELS` | zone 920 → 744 KiB (lean, in place); +1.6% at the worst tic on ARMv6-M | `lean-levels` |

`LEAN=1` builds the first four together; the **full diet** is
`LEAN=1 ZERO_COPY=1 LEAN_LEVELS=1`.

**The 13 demos are not the floor.** A level change (its wipe and
intermission) and the biggest maps need more zone than any demo, and whether a
run fits is not monotone in zone size. So the floors below are play-inclusive:
the lowest size from which every 4 KiB step upward runs all 13 demos plus the
play set (each demo exited into its next level, and a scripted run on all 132
IWAD maps, every one saved and loaded), with 4 KiB less failing. At 4 KiB below
each floor the first map to fail is tnt MAP20 (plutonia MAP28 for `LEAN=1`).

| build | zone, 13 demos | zone, play-inclusive | leg |
|---|---|---|---|
| default | 1,216 KiB | 1,764 KiB | `zone-min`, `zone-min-play` |
| lumps in place | 924 KiB | 1,324 KiB | `zero-copy`, `zone-min-play-zc` |
| `LEAN=1` | — | 1,368 KiB | `zone-min-play-lean` |
| `LEAN=1`, lumps in place | 544 KiB | 920 KiB | `textures-const`, `zone-min-play-leanzc` |
| full diet | 352 KiB | **604 KiB** | `floor-lean`, `zone-min-play-full` |

The RAM floor, play-inclusive (`tools/floor/ram-floor.mjs`, held to
`tools/golden/floor-ram.json` within 1,024 B):

| target | statics | zone | heap | stack | floor |
|---|---|---|---|---|---|
| x86, default | 972,832 | 1,806,336 | 238,505 | 5,520 | 3,023,193 B |
| x86, full diet | 514,172 | 618,496 | 238,505 | 5,520 | 1,376,693 B |
| ARMv6-M, full diet | 404,299 | 618,496 | 288,264 | 5,656 | **1,316,715 B** |
| ARMv8-M, full diet | 404,299 | 618,496 | 288,264 | 5,208 | **1,316,267 B** |

- The heap includes a 158 KB savegame buffer. On tnt and plutonia the
  Cortex-M heap also holds the qemu rig's 49–50 KB copy of the WAD's
  directory. It is newlib's high-water with an 8-byte page
  (`tools/cortexm/syscalls.c`): with libc's 4 KiB page it read 11,400–12,504 B
  more on the six zero-copy Cortex-M targets, and moved with the size of the
  code.
- Flash holds the code, the const tables and the load images: 1.73–1.75 MB
  linked with doom.wad's texture tables and composites (1,400,292 B of it).
  tnt's are the largest, 2,080,980 B. With the WAD at 3 MiB on a 16 MiB flash
  board, doom.wad fits; doom2, plutonia and tnt do not, stored uncompressed
  (`pico-link`).
- **RP2350, link only:** the full diet links with pico-sdk 2.3.0 only with the
  zone, `screens[0]` and the heap in PSRAM: 354,096 of 530,432 B of SRAM.
  With the heap in SRAM it is 112,432 B over (`pico-link`). Nothing has run.
- **RP2040, link only:** 1,051,924 B over (4.92×). A 2 MB Pico cannot hold
  the code and tables (about 1.75 MB) and the WAD.
- A melt wipe costs 3.7 M instructions over 41 frames and holds 128 KB of zone
  (`wipe-probe`; wipes are not graded).

### The CPU levers

Measured under qemu (`tools/cortexm/attrib.mjs` counts every instruction by
function) at the worst graded tic, ARMv6-M / ARMv8-M:

- R_DrawSpan 868,527 / 437,218.
- The column drawers 513,195 / 414,530.
- BSP and seg code 695,170 / 583,702.
- Simulation 554,495 / 492,105.
- On ARMv6-M, the 64-bit FixedMul and FixedDiv helpers (488,004 + 712,910) and
  the 32-bit divide (413,404). On ARMv8-M, libgcc's 64-bit divide for
  FixedDiv (98,630 in 1,516 calls).

Two exact levers (`FAST=1` in tools/cortexm):
- **Drawers.** Thumb-1 and Thumb-2 R_DrawColumn and R_DrawSpan.
- **FixedMul and FixedDiv without libgcc's 64-bit helpers.**
  - ARMv6-M FixedMul is three MULS on the operands' 16-bit halves. It is
    proven equal to `(int64)a*b >> 16` for all inputs: a·b = 2¹⁶(a·bh +
    ah·bl) + al·bl exactly, with 0 ≤ al·bl < 2³². (ARMv8-M keeps
    `m_fixed.h`'s SMULL form.)
  - ARMv6-M FixedDiv is a 30-step restoring division, exact past the clamp.
  - ARMv8-M FixedDiv is two UDIV digits (`fixed_v8m.S`): the first exact,
    the second estimated from a normalised divisor, never low and at most 2
    high, corrected against an exact 64-bit remainder. 15.5 instructions a
    call at the worst tic against libgcc's 65 (`89c9155`); held to the engine's FixedDiv on
    1,000,000 random pairs, the edges and 200,000 pairs near the estimate's
    error (90,818 off by one, 10,148 by two, none by three).

| | ARMv6-M worst / mean | ARMv8-M worst / mean |
|---|---|---|
| before | 4,922,520 / 1,817,319 | 2,588,800 / 1,049,253 |
| fast | **3,398,520 / 1,320,331** (−31%) | **2,293,850 / 933,587** (−11.4%) |

**A two-core split of one frame** (`tools/cortexm/dualcore.mjs`):
- **The split:**
  - core 0 runs the simulation and BSP walk, queueing wall columns;
  - core 1 draws the queued columns;
  - both draw planes and masked by screen half.
- **The result:** core 0 still carries 82–90% of the worst tic (by ISA and by
  how plane and masked overheads split), because the simulation and the BSP
  walk are serial. The board figures below are the highest core-0 load over
  all 44,567 graded tics, measured on the FAST builds that copy lumps
  (re-measured 2026-10-08 with the ARMv8-M FixedDiv);
  the zero-copy FAST builds the design assumes differ by under 0.4% at the
  worst tic (3,410,225 and 2,360,468 instructions, 0add728).
- **Status:** a costed model from measured stage counts. Its queue and
  barrier costs are estimates.

### Predicted verdicts

*F* here is cycles per instruction **of that ISA's own build** (not of x86),
estimated from the core's pipeline: Cortex-M33 1.1–1.6 (3-stage, single
issue, code through a flash cache), Cortex-M0+ 1.2–1.6, Cortex-M7 0.6–1.0
(dual issue, zero-wait TCM). The N64's figure is measured in ares. L1 = music
on a real chip; L2 = the exact software synth on a second core where there is
one.

| target | stock clock | budget per core (cycles/tic) | game, worst tic | L2 music | RAM (floor 1.32 MB) |
|---|---|---|---|---|---|
| N64 VR4300 (ares) | 93.75 MHz | 2,678,571 | **4.21×, measured** (emulated); **4.64×** showing the frame in exact colour | RSP needed | 4 MB fits |
| Teensy 4.1 (M7) | 600 MHz | 17,142,857 | 0.08–0.13× (fast build) | 0.30–0.50× total, one core (measured ARMv8-M sound) | 1 MB on chip: PSRAM needed |
| RP2350 (2× M33) | 150 MHz | 4,285,714 | 0.59–0.86× one core; 0.48–0.75× core 0 split | **1.65–2.40×** of core 1 (measured ARMv8-M sound) | 520 KB SRAM: PSRAM needed (links, section above) |
| RP2040 (2× M0+) | 133 MHz | 3,800,000 | 0.96–1.28× one core; 0.84–1.15× core 0 split | no | 264 KB: 4.92× short (links) |
| EFR32MG24 (M33) | 78 MHz | 2,228,571 | **1.13–1.65×** | no | 256 KB: about 5× short |

So, before any hardware: the N64 is out on its CPU (the software renderer
cannot reach 35 Hz on the VR4300 even with perfect caching, about 1.5× by
ares's charges; RDP drawing would have to be pixel-exact). The likely floor
with an OPL2 chip is the RP2350, on one core, with the zone, a screen and the
heap in PSRAM, if PSRAM keeps up. The RP2040 is marginal on CPU even split
over two cores, and about 5× short on RAM. With exact software music the
RP2350 at stock is short on its second core, and the floor moves up to an
M7-class part. These are predictions: the first board's measured cycles per
instruction replace every *F* above. The RP2040 rows assume its hardware
divider at 24 cycles a call.

The measured performance of the browser build is in [perf.md](perf.md).
