# Retro targets

What this engine runs on besides the browser, what it provably cannot run on,
and the arithmetic behind each verdict. The rule in
[spec.md](../spec.md)'s hardware-targets table still holds: no hardware target
is attempted before its arithmetic exists.

Terms such as *leg* and *golden* are defined in [glossary.md](glossary.md). The
platform contract a no-OS port implements is [bare-metal.md](bare-metal.md).

| target | status | basis |
|---|---|---|
| Freestanding core (x86-32, ARM32, PowerPC) | **runs**, 13/13 demos tic-exact | legs `freestanding-sim`, `ro-wad`, `arm-cross`, `be-cross` |
| N64 (VR4300, emulated) | **simulation runs**, 13/13 demos, 44,580 tics bit-identical | leg `n64-demos`; no display, input or sound yet |
| RP2040 | **parked** | SRAM: 1,082,104 B needed vs 270,336 B, 4.00× over |
| 386-class | **no harness** | about 3× short of 35 Hz; nothing here measures this code on one |
| Sega 32X | **open** | simulation fits one SH-2; render 1.5–3.4× over both |
| ESP32-S3 | **plausible, untested** | CPU 0.28–0.54× of one core; needs PSRAM |
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

It exists to prove that the core is a platform-layer-only port target. Four
legs hold it to the same 13 golden demos the browser build is graded on:

| leg | what it proves | needs |
|---|---|---|
| `freestanding-sim` | fs-doom's per-tic hashes equal the goldens, 13/13 ([run-check.sh](../tools/freestanding/run-check.sh)) | `fs-doom`, IWADs |
| `ro-wad` | the engine never writes the WAD: the blob is `mprotect(PROT_READ)` and any write faults with its address, so the WAD can execute in place from ROM or flash | `fs-doom`, IWADs |
| `arm-cross` | the core cross-built for `arm-linux-musleabihf` by zig and run under `qemu-arm-static` is 13/13 | zig ≥ 0.16, `qemu-arm-static` |
| `be-cross` | the same on big-endian `powerpc-linux-musleabi` under `qemu-ppc-static`, with `-fsigned-char`; the cheapest big-endian cover in the suite | zig ≥ 0.16, `qemu-ppc-static` |

Two details a porter needs. First, the doom.wad demos must be presented as
`doomu.wad`: `IdentifyVersion()` tries `doomu.wad` before `doom.wad`, the
goldens were recorded as Ultimate DOOM, and `demo4` desyncs from tic 0
otherwise. Second, these legs check correctness only. Emulated cycles are not
hardware cycles, so no timing comes from qemu.

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
software renderer never runs on the N64.

Not done:

- **Display.** `i_video_n64.c` is a headless stub that copies each frame into a
  64,000-byte shadow buffer. No RDP path exists.
- **Input.** No controller support (libdragon `joypad.h` is the route).
- **Sound.** `i_sound_n64.c` is all stubs.
- **Real hardware.** A SummerCart64 and an Analogue 3D are owned (per
  [spec.md](../spec.md)); the emulator leg is the gate, and hardware runs would
  be evidence, not the gate.
- **Speed.** No frame or tic timing exists for the N64. Section 4 has the
  estimate.

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
`--jobs` it may overlap other legs. It is the longest leg in the suite: 435 s
for all 13 demos on alder (`7f5c682`, 2026-10-05). A filter that matches no demo is an error, and a filtered pass
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

Footprint build (`N64_WAD=`, default zone) with 256 visplanes, measured on
alder 2026-10-06 with `mips64-elf-size` and `mips64-elf-nm`:

| item | bytes |
|---|---|
| `.text` (code + rodata) | 396,116 |
| `.data` | 57,032 |
| `.bss` | 3,401,132 |
| **RDRAM in use (`.data` + `.bss`)** | **3,458,164** of 4,194,304 (736,140 free on a stock console) |
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
the 13 demos. Two passes agreed within 3% per demo.

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
WD_CYCLES=1 ./tools/freestanding/fs-doom <wad> -timedemo demoN -cycles cyc.json           # whole program
WD_CYCLES=1 ./tools/freestanding/fs-doom <wad> -timedemo demoN -nodraw -cycles cyc.json   # simulation only
make -C tools/freestanding EXTRA_CFLAGS="-DWEB_PERF_ZONE_STATS -DFS_ZONE_SIZE_OVERRIDE=33554432"
./tools/freestanding/fs-doom <wad> -timedemo demoN -zonestats zs.json                     # zone peaks
```

(Present doom.wad as `doomu.wad`, and build the zone-stats binary into a
separate copy so it does not replace the gated one.)

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
| N64 VR4300 | 93.75 MHz | 2,678,571 | 1.2–2 | 1.56 M–2.94 M | **0.58–1.10×** | 4 MB, fits |
| ESP32-S3 | 240 MHz/core | 6,857,143 | 1.5–2.5 | 1.95 M–3.68 M | **0.28–0.54×** | 512 KB SRAM; PSRAM required |
| RP2040 | 270 MHz/core | 7,714,286 | 3–5 | 3.90 M–7.36 M | **0.51–0.95×** | 264 KB; **4.00× short** (measured) |
| Sega 32X | 2 × 23 MHz | 657,143 per SH-2 | 1.5–3 | 1.95 M–4.41 M | **3.0–6.7×** one SH-2, 1.5–3.4× both | 256 KB; 6.6× short |
| GBA | 16.8 MHz | 480,000 | 2–4 | 2.60 M–5.89 M | **5.4–12.3×** | 288 KB; 5.9× short |
| SNES + Super FX 2 | 21 MHz | 600,000 | 4–8 | 5.20 M–11.77 M | **8.7–19.6×** | well under 1 MB |
| Genesis + Sega CD | 7.67 + 12.5 MHz | 576,286 combined | 6–12 | 7.80 M–17.66 M | **13.5–30.6×** | 896 KB; 1.9× short |
| SNES | 3.58 MHz | 102,286 | 20–100 | 26.0 M–147 M | **254–1,438×** | 128 KB; 13× short |

Each range pairs the lightest IWAD (doom.wad) with the low *F* and the
heaviest (plutonia.wad) with the high *F*. RAM shortfalls are against the
1.65 MiB floor in section 3.

**N64.** The simulation is proven tic-exact. Its cost, 77–125 K instructions
per tic, is 3–9% of the VR4300's budget at the estimated *F*. The full game is
0.58–1.10× of the budget on the CPU alone: marginal, and unmeasured. The high
end of *F* is the 8 KB data cache missing into RDRAM. The RDP rasterizes
textured primitives in hardware, which could take most of the render off the
CPU; it is the open work. Prior art: jnmartin84's 64doom runs linuxdoom on the
N64, playable, with demo compatibility not verified.

**RP2040 (parked).** A Cortex-M0+ link of the core (arm-none-eabi-gcc 16.1,
`-O1`, 320-wide, a 256 KB token zone), measured 2026-07-23, needs 1,082,104 B
of SRAM against 270,336 B: **4.00× over**. The token zone is below the
1,081,972 B non-purgeable peak, so the real deficit is larger. Today's N64 link
makes the same point on the current tree: its statics outside the zone are
751,628 B, 2.8× the RP2040's entire SRAM. Flash fails too: doom.wad
gzip-compressed is 5,536 KB against the 1,761 KB a 2 MB Pico has left after
code. The CPU would fit (0.51–0.95× of one core at 270 MHz). kilograham's
rp2040-doom runs on this chip by replacing the asset pipeline (WHD) and the
memory layout; this code would need the same plus external PSRAM, and buying a
board does not change that. The build is no longer in the tree. The sanctioned
sub-100 MHz MCU floor measurement depended on it and is parked with it; at
100 MHz one core is 1.4–2.6× short by the same arithmetic.

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

The measured performance of the browser build is in [perf.md](perf.md).
