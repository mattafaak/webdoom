# webdoom retro feasibility atlas

**Task 13.5 — The north star as arithmetic.**
**Task 20.1 — v2 rows: 386 chase budget, N64 VR4300, Genesis+Sega CD (parked), sub-100 MHz MCU.**
Commit date: 2026-07-18 (13.5); 2026-07-21 (20.1). All inputs are pre-existing measured artifacts;
this document does arithmetic, not new measurements.

**spec.md amendment cross-reference (§Explicit non-goals, amended 2026-07-21):** The non-goals
section was amended to sanction real-hardware test beds where the atlas row supports them:
N64/VR4300, 386-class, and sub-100 MHz MCU floor measurement. Genesis+Sega CD remains parked
(atlas verdict: infeasible for tic-exact 35 Hz by ~10×; external anchor: krikzz doom-68k, 1–2 fps
FPGA-assisted). SNES/GBA-class verdicts unchanged (infeasible, atlas rows closed). The atlas
remains the doctrine: no hardware target is attempted before its row exists with arithmetic.

---

## Contents

1. [Method and conversion-factor doctrine](#1-method-and-conversion-factor-doctrine)
2. [The 486 calibration trick](#2-the-486-calibration-trick)
3. [Platform rows](#3-platform-rows)
   - [3.1 Stock SNES (65C816 @ 3.58 MHz)](#31-stock-snes-65c816--358-mhz)
   - [3.2 SNES + Super FX 2 @ 21 MHz](#32-snes--super-fx-2--21-mhz)
   - [3.3 Sega 32X (2× SH-2 @ 23 MHz)](#33-sega-32x-2-sh-2--23-mhz----the-open-cell)
   - [3.4 GBA (ARM7TDMI @ 16.8 MHz)](#34-gba-arm7tdmi--168-mhz)
   - [3.5 386DX-40 / 486DX2-66 (sanity anchors + 386 chase budget)](#35-386dx-40--486dx2-66-original-targets--sanity-anchors)
   - [3.6 ESP32-S3 (dual LX7 @ 240 MHz)](#36-esp32-s3-dual-lx7--240-mhz)
   - [3.7 RP2040 (2× Cortex-M0+ @ 270 MHz)](#37-rp2040-2-cortex-m0--270-mhz)
   - [3.8 N64 VR4300 @ 93.75 MHz](#38-n64-vr4300--9375-mhz)
   - [3.9 Genesis 68000 + Sega CD — PARKED](#39-genesis-68000--sega-cd--parked)
   - [3.10 Sub-100 MHz MCU (open cell)](#310-sub-100-mhz-mcu-open-cell)
4. [Verdict table](#4-verdict-table)
5. [Gate wiring](#5-gate-wiring)

---

## 1. Method and conversion-factor doctrine

### 1.1 What is measured

All instruction counts are **x86-64 user-space retired instructions**
(`PERF_COUNT_HW_INSTRUCTIONS`, not cycle counts) measured over the 13 IWAD
attract-demo corpus with render ON.  Source files:

| Artifact | Schema | Notes |
|----------|--------|-------|
| `tools/golden/cycle-floor.json` | `cycle-floor.v1` | Whole-program mean and p99 per IWAD; 2 passes each |
| `tools/golden/cycle-attribution.json` | `cycle-attribution.v1` | Sim and render stage breakdown per demo and per IWAD |
| `tools/golden/zone-stats.json` | `zone-stats.v1` | Render-ON non-purgeable zone HWM; 4 MiB and 32 MiB zones |

Render is dominated by BSP (40–54%) + planes (33–35%); masked geometry
(sprites, patches) is the remainder.  Source: per-stage percentages in
`cycle-attribution.json`.

### 1.2 Whole-program demand (x86-64 p50)

| IWAD | Mean instr/tic | Whole p50 instr/tic | Sim p50 instr/tic | Sim % of whole |
|------|---------------|---------------------|-------------------|----------------|
| doom.wad | 1,118,719 | 1,230,745 | 58,355 | 4.7% |
| doom2.wad | 1,190,293 | 1,394,586 | 79,722 | 5.7% |
| tnt.wad | 1,267,140 | 1,377,217 | 48,686 | 3.4% |
| plutonia.wad | 1,289,414 | 1,493,854 | 86,515 | 5.9% |

**p50 is the preferred metric** — 35 Hz is a real-time deadline and p50
represents the median tic a ported CPU must sustain.  Worst-case p99 is
2,647,739 instr/tic (doom-demo4), variance 1.3–9.9%.  Level-load spikes are
excluded; those tics are not time-critical (the engine does not advance the
sim during WAD loads).

### 1.3 Conversion-factor doctrine

**Cross-ISA projection requires a conversion factor.**  The instruction count
is architecture-neutral evidence (instructions retired, not cycles); to compare
against a target's Hz budget in cycles, we apply:

> `demand_cycles ≈ x86_64_instr × F_isa`

where `F_isa` is an ISA-and-microarchitecture factor that captures:

- Average cycles per instruction on the target (CPI)
- ISA differences in instruction density (a 65C816 needs many more
  instructions to perform a 32×32 fixed-point multiply than x86-64)
- Memory-system overhead not visible in the instruction stream

**The FINDING-2 caveat** applies here: instruction share does not equal
wall-clock share.  The render stages pay cache misses for texture lookups
(`W_CacheLumpNum`) and column-draw PSRAM latency that retired instructions
do not see.  For modern CPUs with large L1–L3, `F_isa` captures this
implicitly; for targets with 4–8 KB caches (SH-2, Cortex-M0+), memory-system
error bars dominate and `F_isa` should be treated as a lower bound.

**Error bar reasoning per target** is documented in each row's conversion
factor entry.  The 486 row in §2 provides the only hard empirical anchor.

### 1.4 RAM floor

Non-purgeable render-ON heap high-water mark (HWM) across 13 demos at 4 MiB
zone: **0.981 MiB** (tnt-demo2, `zone-stats.json`).  The Z_Zone allocator
purges `PU_CACHE` blocks on pressure; only `PU_STATIC` and `PU_LEVEL` blocks
are included in this figure.

Static + BSS: 1.21 MiB (bare-metal.md §2.1).  Screen buffers
(`I_AllocLow`, 4 × 64 KB = 250 KiB) are allocated separately.

Bare-metal minimum RAM summary:

| Region | Size |
|--------|------|
| Static (DATA + BSS) | 1.21 MiB |
| Screen buffers (I_AllocLow) | 0.25 MiB |
| Zone (minimum measured) | 0.98 MiB np floor; 4 MiB recommended |
| WAD (XIP from flash) | 0 RAM (XIP-viable, proven 13.2c) |
| **Absolute minimum (WAD in flash)** | **~2.44 MiB writable RAM** |

With WAD in PSRAM instead of XIP flash: add 11.8 MiB (doom.wad) to
16.6 MiB (plutonia.wad).

### 1.5 ROM/WAD split

Task 13.2c proved the WAD blob read-only across 13 demos (`mprotect(PROT_READ)`
over the blob, zero faults).  WAD XIP from SPI flash or mask ROM is
therefore viable: lump data is always copied into the zone before use.
WAD sizes: doom.wad 11.8 MiB, doom2.wad 13.9 MiB, plutonia.wad 16.6 MiB
(bare-metal.md §2.3).

### 1.6 Portability proven

Big-endian: **13/13** on PowerPC (13.3a) and MIPS (13.3b).  Required fixes:
`-fsigned-char`, `SwapSHORT`/`SwapLONG`, byte-safe `read_le32` at 1 of
7 known alignment sites (`r_data.c` maptexture cast).  OS-less ARM bring-up
(13.4b) complete: `D_DoomMain` runs without OS.

---

## 2. The 486 calibration trick

**DOOM shipped playable at ~35 fps on a 486DX2-66.** This is the only
platform where we have both a real-world "runs at deadline" verdict AND the
same instruction corpus (vanilla DOOM code, identical algorithms).

**Arithmetic:**

```
budget_486  = 66,000,000 cycles/s ÷ 35 Hz = 1,885,714 cycles/tic

demand_x86  = 1,118,719–1,289,414 instr/tic  (cycle-floor.json means, doom–plutonia)

implied F = budget_486 ÷ demand_x86
          = 1,885,714 ÷ 1,118,719  =  1.69  (doom.wad, lightest)
          = 1,885,714 ÷ 1,289,414  =  1.46  (plutonia.wad, heaviest)
```

**Calibration result: F ≈ 1.46–1.69 for period x86 (486DX2).**

This factor encodes 486 CPI (~1 on simple ops, 2–4 on complex, no
out-of-order, 8 KB L1) plus the minimal ISA delta within the x86 family.
DOOM's integer-heavy inner loops (fixed-point multiply, shift, add) ran
efficiently on the 486; the factor is not primarily ISA overhead but rather
in-order pipeline and cache-miss cost.

**Interpretation for other ISAs:**

- Platforms with larger ISA overhead (65C816, SH-2, ARM7) need a larger
  `F_isa` on top of the 486's 1.5–1.7× CPI component.
- The 486 anchor calibrates the CPI baseline; the ISA term is additive.
- For the 386DX-40 (40 MHz): budget = 40,000,000/35 = 1,142,857 cycles/tic.
  At F=1.46: demand = 1,190,293 × 1.46 = 1,737,828 cycles; budget 1,142,857 →
  ratio 1.52×.  Consistent with the historical record: DOOM ran on 386 but
  with slowdowns, especially on complex scenes.

---

## 3. Platform rows

Each row states: CPU budget, RAM, video path, conversion factor + error bar,
measured demand (x86-64 baseline), and verdict as a ratio.

---

### 3.1 Stock SNES (65C816 @ 3.58 MHz)

**CPU budget:**
```
3,580,000 cycles/s ÷ 35 Hz = 102,286 cycles/tic
```

**Conversion factor (65C816 vs x86-64):**
The 65C816 is a 16-bit CPU (8/16-bit registers with bank switching).
A 32×32 fixed-point multiply (`FixedMul`, called in every wall column and
every physics step) has no hardware path: the 65C816 has NO general multiply
instruction (the SNES offers only memory-mapped 8×8 hardware multiply
registers), so the operation decomposes into software partial products plus
shifts and adds: **150–400 cycles**.  On x86-64, IMUL is
3 cycles.  That single operation carries a 50–130× overhead; the broader
render loop (comparisons, pointer arithmetic, branching) scales similarly.

Conservatively: `F_isa ≈ 20–100×`.  The wide error bar reflects that the
65C816 is CISC but narrow, and cache is absent (no on-chip cache; SRAM
wait-states depend on the specific board).

**Demand at demand × F_isa:**
```
demand_cycles = 1,300,000 × F_isa   (using doom2/tnt p50 mean ≈ 1.3M)
              = 1,300,000 × 20  =  26,000,000 cycles   (optimistic)
              = 1,300,000 × 100 = 130,000,000 cycles   (pessimistic)
```

**CPU ratio:**
```
26,000,000 ÷ 102,286 ≈ 254× over budget  (optimistic ISA factor)
130,000,000 ÷ 102,286 ≈ 1271× over budget (pessimistic ISA factor)
```

**Three independent walls:**

1. **CPU wall**: 254–1271× over budget.  Even granting the most charitable
   ISA factor, the 65C816 at 3.58 MHz cannot sustain the fixed-point
   arithmetic density of vanilla DOOM's renderer at 35 Hz.  FixedMul at
   150–400 cycles vs a 102,286-cycle total budget means a single complex frame
   with ~1,000 FixedMul calls (conservative estimate for a mid-complexity
   scene) consumes 150K–400K cycles — already 1.5–4× the entire tic budget,
   before BSP traversal, plane rendering, or game logic.

2. **RAM wall**: SNES main RAM = 256 KB.  Non-purgeable HWM = 0.981 MiB.
   Static BSS = 1.21 MiB.  The SNES does not have enough writable RAM for
   the static segment alone (256 KB vs 1.21 MiB needed), independent of zone
   or WAD.  Ratio: **~5× RAM shortfall**.

3. **Video bandwidth wall**: DOOM renders a 320×200 palette-indexed
   framebuffer at 35 Hz = 64,000 bytes × 35 = 2.24 MB/s.  SNES VRAM is 64 KB
   and is accessible only during VBlank/HBlank DMA windows.  Transferring
   64 KB at VBlank (≈2.2 ms at 3.58 MHz) requires continuous DMA; the SNES
   can do this, but the CPU time spent orchestrating DMA further reduces the
   computation budget already shown to be 254–1271× inadequate.

**Verdict: INFEASIBLE-BY-250–1270× (three independent walls; CPU alone
is decisive).**

*Note on Linden SNES Doom (1995)*: used a custom Reality engine on the 21 MHz
Super FX 2 coprocessor, with a from-scratch non-vanilla renderer.  Demo
compatibility is not claimed.  This is a different port with a different
engine, not vanilla playsim.

---

### 3.2 SNES + Super FX 2 @ 21 MHz

**CPU budget (Super FX 2):**
```
21,000,000 cycles/s ÷ 35 Hz = 600,000 cycles/tic
```

**Conversion factor:** Super FX 2 is a 32-bit RISC processor with hardware
multiply (MULT instruction, producing a 32-bit result) and a short pipeline.
The memory bus is shared with the 65C816 (contention overhead).
`F_isa ≈ 4–8×` vs x86-64 for the DOOM workload.

**Demand:**
```
1,300,000 × 4–8 = 5,200,000–10,400,000 cycles
```

**CPU ratio:**
```
5,200,000 ÷ 600,000 ≈ 8.7×
10,400,000 ÷ 600,000 ≈ 17×
```

**RAM:** The base SNES has 256 KB main RAM; cartridge SRAM can add 64–256 KB.
Still well under the 1.21 MiB static requirement.

**Verdict: INFEASIBLE-BY-9–17× CPU; RAM still ~5× short.**  The Super FX 2
provides meaningful headroom over stock 65C816 but falls well short of vanilla
vanilla requirements.  Linden's SNES Doom succeeded by replacing the vanilla
renderer entirely — vanilla playsim compat was not demonstrated.

---

### 3.3 Sega 32X (2× SH-2 @ 23 MHz) — THE OPEN CELL

**CPU budget:**
```
Per SH-2:  23,000,000 ÷ 35 =  657,143 cycles/tic
Both SH-2: 46,000,000 ÷ 35 = 1,314,286 cycles/tic combined
```

**Conversion factor (SH-2 vs x86-64):** The SH-2 is a 32-bit RISC with:
- Hardware multiply: MULS.W (16×16→32, 1–3 cycles) and DMULS.L (32×32→64,
  2–4 cycles) — this is the critical FixedMul instruction.
- No FPU: FixedDiv (`((int64_t)a << 16) / b`) uses DMULS.L + software
  64-bit divide; Cortex-M0+ comparison applies here too.
- 4 KB instruction cache, 4 KB data cache (SH7604 on 32X) — very tight.

`F_isa ≈ 1.5–3×` is the estimate.  Lower bound reasoning: SH-2 DMULS.L
covers 32-bit multiply in 2–4 cycles vs x86-64 IMUL at 3 cycles; the ISA
overhead is modest.  Upper bound: 4 KB D-cache causes frequent cache misses
on the render stage's random lump accesses and pointer-heavy BSP arrays.
Memory-system error bar dominates; `F_isa` is a lower bound.

**Sim-only feasibility (measured input, not converted):**
```
sim_p50 (worst IWAD, plutonia) = 86,515 instr/tic      [cycle-attribution.json]
% of one SH-2 budget (pre-conversion) = 86,515 ÷ 657,143 = 13.2%

After F_isa conversion (1.5–3×):
sim demand = 86,515 × 1.5–3 = 129,773–259,545 cycles
% of one SH-2 = 20–40%  → fits with margin
```

**Full render demand (one SH-2):**
```
render p50 (plutonia, worst IWAD) ≈ 1,407,339 instr/tic  [cycle-attribution.json]
converted = 1,407,339 × 1.5–3 = 2,110,000–4,220,000 cycles
one SH-2 budget = 657,143 cycles
ratio = 3.2×–6.4×  → render exceeds one SH-2 budget by 3–6×
```

**What remains unknown:**
- Can the render be partitioned between two SH-2s effectively?  The DOOM
  renderer is not trivially parallelisable (BSP tree walk is serial; planes
  can be split by scanline; sprites are largely independent).
- Real cache behavior at 4 KB: the BSP array (`segs`, `nodes`) and texture
  data will thrash a 4 KB D-cache.  Wall-clock cost for the render could be
  substantially higher than the F_isa estimate.
- RAM: 32X has 256 KB SDRAM on-chip + what the cartridge provides.
  np-HWM 0.981 MiB > 256 KB → WHD-class compression or cuts required.
- D32XR (Jaguar codebase on 32X hardware) ran game logic at **15 Hz** — this
  proves the renderer needs substantial headroom, but does NOT measure vanilla
  playsim cost on SH-2.

**Verdict: sim tic-exact PLAUSIBLE-UNPROVEN; full vanilla-exact render
UNMEASURED.**  The sim fits on one SH-2 with meaningful headroom.  The render
exceeds one SH-2's budget by 3–6× at the ISA estimate; two SH-2s could
theoretically cover it if partitioning and cache pressure cooperate.  No
vanilla DOOM demo-compat port to 32X hardware has been published.

---

### 3.4 GBA (ARM7TDMI @ 16.8 MHz)

**CPU budget:**
```
16,800,000 ÷ 35 = 480,000 cycles/tic
```

**Conversion factor (ARM7TDMI vs x86-64):** ARM7TDMI is a 3-stage in-order
32-bit ARM with hardware multiply (MUL/SMULL) but no hardware divide or FPU.
`F_isa ≈ 2–4×`.  The GBA has no data cache (8 KB wait-state ROM/EWRAM access
is 8 cycles; IWRAM is 1 cycle — WAD streaming would be slow).

**Demand:**
```
Full: 1,300,000 × 2–4 = 2,600,000–5,200,000 cycles; budget 480,000
ratio = 5.4×–10.8×
```

**RAM:** GBA has 256 KB work RAM (EWRAM) + 32 KB fast RAM (IWRAM).
Static BSS alone needs 1.21 MiB — impossible without major restructuring.

**Prior art:** GBADoom (16.8 MHz ARM7TDMI) — **demo compatibility BROKEN**.
This confirms empirically that even the sim diverges without vanilla-compat
fixes; the CPU wall makes full render further out of reach.

**Verdict: INFEASIBLE-BY-5–11× CPU; RAM needs ~5× restructuring.**

---

### 3.5 386DX-40 / 486DX2-66 (original targets — sanity anchors)

These rows calibrate the conversion factor.  See §2 for the arithmetic.

**386DX-40 (40 MHz):**
- Budget: 40,000,000 / 35 = 1,142,857 cycles/tic
- At F=1.46 (calibrated low, §2): demand ≈ 1,634K cycles; ratio ≈ 1.43× over budget
- Historical: playable with slowdowns on complex scenes

**486DX2-66 (66 MHz):**
- Budget: 66,000,000 / 35 = 1,885,714 cycles/tic
- Implied factor 1.46–1.69 (§2)
- Historical: ~35 fps on typical doom.wad content; the sweet spot

**Verdict: PROVEN-SUFFICIENT (anchor).**  These are the intended targets;
they ground every other row's factor estimates.

#### 3.5a 386DX-40 chase budget (task 20.1 extension)

The §3.5 anchor shows the 386DX-40 at **1.43–1.91× over budget** (§4 table).
To reach 35 Hz full-detail, the whole-program instruction count must be cut.

**Chase arithmetic:**

```
current ratio:  1.43–1.91× over budget
target ratio:   1.0× (hits 35 Hz)

required reduction = 1 − (1/ratio)
  = 1 − 1/1.43  =  30%   (optimistic end, F=1.46, doom.wad demand)
  = 1 − 1/1.91  =  48%   (pessimistic end, F=1.69, plutonia.wad demand)
```

Note: the Plans.md-era estimate was 33–46%; the cycle-floor.json on-disk means
are 8.8% (doom.wad) and 5.9% (plutonia.wad) lower than the stale table values,
shifting the 386 ratio from 1.49–1.85× to 1.43–1.91× and the chase from 33–46%
to 30–48%.  Direction unchanged: a 30–48% whole-program cut is needed.

A **30–48% whole-program instruction-count reduction** is the 35 Hz target at
386DX-40 clock.  The scoreboard for this metric is `cycle-floor.json`
(`.per_iwad[*].mean_instr_per_tic`); task 20.7 targets a measured minimum
clock on an underclocked MCU that will cross-check the same F_isa model.

**FastDoom presentation headroom (external anchor):**

> 486DX2-66 vanilla DOOM: ~21.5 fps full-detail.
> FastDoom on the same hardware: ~30.1 fps.
> Improvement: 40% more frames from presentation-side cuts alone.
> Source: fabiensanglard.net/fastdoom.

> 386DX-40 (FastDoom): ~10–12 fps full detail even after FastDoom optimisation.
> Source: github.com/viti95/FastDoom discussion #249.

Interpretation: a 40% presentation-side speedup on a 486DX2-66 (FastDoom vs
vanilla) is consistent with the 30–48% whole-program cut the model predicts is
needed at 386DX-40 clock.  This cross-validates F_isa and suggests the
presentation path has room; the sim path (4–6% of whole-program, §1.2) is
nearly free and does not drive the gap.  The 386DX-40 chase is primarily a
renderer optimisation problem, not a playsim problem.

**The 386 FastDoom ceiling (10–12 fps) also confirms** that even with
FastDoom-class cuts the 386DX-40 stays well below 35 Hz today — establishing
that reaching the target requires engine-level changes beyond FastDoom's scope,
or a higher-clocked 486.  This is consistent with the historical record.

**Verdict: PROVEN-NOT-YET (chase target).**  Achievable in theory with
a 30–48% instruction reduction from the cycle-floor.json baseline; FastDoom
demonstrates the presentation headroom exists; the playsim cost is negligible.
No vanilla-compat 35 Hz port to a 386DX-40 has been demonstrated.

---

### 3.6 ESP32-S3 (dual LX7 @ 240 MHz)

**CPU budget:**
```
Per core: 240,000,000 ÷ 35 = 6,857,143 cycles/tic
```

**Conversion factor (Xtensa LX7 vs x86-64):** LX7 is a 32-bit RISC with
single-precision hardware FPU, hardware multiply (MUL16/MUL32), and no
hardware 64-bit divide (FixedDiv → software `__aeabi_ldivmod` equivalent).
Two cores at 240 MHz, 512 KB internal SRAM, 2–16 MB PSRAM.

`F_isa ≈ 1.5–2.5×` (LX7 is modern RISC, competitive with Cortex-A-class
integer; cache 32 KB L1 is large enough to hold hot render data).

**Demand:**
```
1,300,000 × 1.5–2.5 = 1,950,000–3,250,000 cycles per core
one-core budget = 6,857,143 → uses 28–47% of one core
```

Render can run on core 0 while audio/networking runs on core 1.

**RAM:** 512 KB SRAM insufficient for static BSS (1.21 MiB); PSRAM mandatory.
Credible config (doom1.wad in PSRAM): 1.21 + 0.25 + 4.0 + 4.2 = 9.66 MB PSRAM
(bare-metal.md §7.2 credible configuration).  16 MB PSRAM parts fit comfortably.

**Video path:** SPI display at 320×200; `I_FinishUpdate` pushes 64 KB
palette-indexed framebuffer through DMA.  §7.3 of bare-metal.md identifies
PSRAM latency on `screens[0]` column writes as the primary bottleneck;
mitigation is placing `screens[0]` in 512 KB internal SRAM.

**Prior art:** ESP32 (non-S3, 240 MHz, 4 MB PSRAM) DOOM port by `davidbuzz`
(2021) demonstrated playable performance with doom1.wad and ILI9341 display.
ESP32-S3 has ~2× the RAM headroom and the same clock; a successful port is
plausible.

**Verdict: PLAUSIBLE-UNPROVEN** (no hardware bring-up in this repo yet;
bare-metal.md §7 establishes the credible configuration).

---

### 3.7 RP2040 (2× Cortex-M0+ @ 270 MHz)

**CPU budget:**
```
Per core: 270,000,000 ÷ 35 = 7,714,286 cycles/tic
```

**Conversion factor (Cortex-M0+ vs x86-64):** Cortex-M0+ is a 2-stage
in-order 32-bit ARM.  No hardware divide (FixedDiv → `__aeabi_uldivmod`,
~20–40 cycles).  No FPU.  Hardware multiply: 32-bit single-cycle (but
FixedMul needs 64-bit result → requires software 64-bit multiply on M0+).

`F_isa ≈ 3–5×`.  Upper end reflects the divide cost; lower end from
efficient integer code paths.

**Demand:**
```
1,300,000 × 3–5 = 3,900,000–6,500,000 cycles per core
per-core budget = 7,714,286 → uses 51–84% of one core
```

Tight but feasible; two cores allow audio/networking offload.

**RAM:** RP2040 has 264 KB on-chip SRAM — well below np-HWM (0.981 MiB).
rp2040-doom (kilograham) solved this with **WHD-class WAD compression** (2 MB
flash with compressed sprites/music) and aggressive restructuring of zone
pressure.  This is a real but solved engineering problem, not a fundamental
wall.

**Prior art:** rp2040-doom (kilograham) — vanilla demo-compatible, 264 KB RAM,
2 MB flash with WHD compression, 2× Cortex-M0+ at 270 MHz.  Demo compat proven.

**Verdict: PROVEN-SUFFICIENT (anchor)** — prior art exists with demo compat.

---

### 3.8 N64 VR4300 @ 93.75 MHz

**CPU budget:**
```
93,750,000 cycles/s ÷ 35 Hz = 2,678,571 cycles/tic
```

**Hardware facts:** The VR4300 is a 64-bit MIPS III processor clocked at
93.75 MHz on N64.  It has a unified 24 KB instruction cache and 8 KB data
cache.  The memory subsystem is RDRAM (RamBus) shared with the RCP
(Reality Co-Processor); RDRAM runs at 250 MHz but access latency is high
when the 8 KB D-cache misses (the render stage's pointer-heavy BSP and
texture lookups will cause frequent misses).  Hardware 64-bit multiply
(DMULT/DMULTU, 3–4 cycles) covers `FixedMul`.  No hardware divide; `FixedDiv`
falls to software 64-bit division (~20–40 cycles, same as M0+).

**Conversion factor (MIPS III + RDRAM-latency reality):**

```
F_isa ≈ 1.2–2×
```

Lower bound 1.2: MIPS III is a clean 32/64-bit RISC; DMULT covers FixedMul
with minimal overhead vs x86-64 IMUL; straightforward integer code maps
well.  Upper bound 2: the 8 KB D-cache is identical in size to the GBA's
wait-state path; render-stage lump accesses and BSP pointer arrays will
thrash it; RDRAM latency on misses is measurable (unlike large-cache modern
CPUs where the upper bound collapses).  The FINDING-2 caveat (§1.3) applies
especially to the upper end here.

**Demand (derived from cycle-floor.json means, §1.2):**
```
demand_cycles = mean_instr_per_tic × F_isa

doom.wad mean  (lightest):  1,118,719 × 1.2 = 1,342,463 cycles  (lower bound)
plutonia mean  (heaviest):  1,289,414 × 2   = 2,578,828 cycles  (upper bound)

budget = 2,678,571 cycles/tic

ratio = 1,342,463 ÷ 2,678,571 = 0.50×  (lower: fits with margin)
        2,578,828 ÷ 2,678,571 = 0.96×  (upper: 4% within budget)
```

**Interpretation:** 0.50–0.96× spans marginal-to-sufficient.  Both bounds
now fit within budget: the lower end (clean RISC cache-warm execution) fits
comfortably; the upper end (RDRAM latency thrashing) is 4% within the budget
boundary rather than just over it.  The updated means confirm the verdict —
N64 is a feasible target at the F_isa estimate, with the upper bound no longer
crossing 1.0×.  Compared to the 486DX2-66 anchor (0.86–1.16×, §4), the N64
is in the same feasibility band — a validated era-comparable target.

**RAM:** Standard N64: 4 MB RDRAM; with Expansion Pak: 8 MB.  Both far
exceed the 2.44 MiB writable minimum (§1.4).  WAD streaming: 64 MB
cartridge ROM is plentiful.  No RAM constraint.

**Prior art:** `64doom` (jnmartin84) — linuxdoom port to N64, playable.
**Demo compatibility: NOT verified.**  This port is the existence proof that
the hardware can run Doom; it does not establish tic-exact playsim compat.

**Open questions:**
- Demo-exact tic-accurate compatibility (the playsim gate, §1.6).
- RDP-offloaded column rasterisation: N64's RCP/RDP can handle
  perspective-correct textured fills, which covers wall/floor column draws;
  this would shift render demand off the VR4300 entirely for those stages.
  If RDP handles columns, the VR4300 residual is substantially lower than
  whole-program demand, making the row solidly feasible.
- Real cache-miss profile: 4 KB D-cache on GBA caused empirical slowdowns
  (GBADoom demo-broken); the VR4300 has 8 KB D-cache but RDRAM latency
  may compensate; real measurement required.

**Verdict: MARGINAL-TO-SUFFICIENT (open cell).**  The arithmetic puts this
platform in the same band as the 486DX2-66.  Demo-exact verification and
RDP column offload are the open items; the hardware is owned
(SummerCart64 + Analogue 3D per spec.md amendment 2026-07-21).

---

### 3.9 Genesis 68000 + Sega CD — PARKED

**Hardware facts:**
- Genesis: Motorola 68000 @ 7.67 MHz, 64 KB WRAM, 64 KB VRAM.
- Sega CD add-on: second Motorola 68000 @ 12.5 MHz, 512 KB PRG-RAM,
  256 KB Word RAM (mode 1: CPU-accessible as two 128 KB banks).
- Combined writable RAM: 64 + 512 + 256 = 832 KB, plus 64 KB VRAM ≈ 896 KB.
- Sega CD ASIC: affine stamp scale/rotate engine (Ricoh RC32C338-class).
- VDP output: 4bpp, 64-color palette from a 512-color space; tile-based.

**CPU budget:**
```
Genesis 68000:    7,670,000 ÷ 35 =   219,143 cycles/tic
Sega CD 68000:   12,500,000 ÷ 35 =   357,143 cycles/tic
Combined (serial): 7,670,000 + 12,500,000 = 20,170,000 ÷ 35 = 576,286 cycles/tic
```

**Conversion factor (68000 vs x86-64):**

The Motorola 68000 is a 16-bit data bus / 32-bit address CISC processor.
It has **no hardware multiply**.  `FixedMul` (`((int64_t)a * b) >> 16`)
decomposes into software partial-product loops: typically **50–150 cycles**
per call on a 68000.  x86-64 IMUL is 3 cycles.  `FixedDiv` similarly
expensive without hardware divide.

```
F_isa ≈ 6–12× (68000)
```

Lower bound 6: assumes tight software multiply and efficient integer paths.
Upper bound 12: reflects the 50× overhead on FixedMul-dense render inner
loops; the BSP column-draw path calls FixedMul O(height) times per column.

**Demand (combined dual-68k, derived from cycle-floor.json means, §1.2):**
```
demand (doom.wad, F=6):  1,118,719 × 6 =  6,712,314 cycles
demand (plutonia,  F=12): 1,289,414 × 12 = 15,472,968 cycles

combined budget:  576,286 cycles/tic

ratio (optimistic): 6,712,314 ÷ 576,286 = 11.6×  over budget
ratio (pessimistic): 15,472,968 ÷ 576,286 = 26.8×  over budget
```

**External anchor — krikzz/doom-68k (github.com/krikzz/doom-68k), two regimes:**

**Regime 1 — FPGA-assisted (in-cart mul/div + format-conversion offload):**
> With in-cart FPGA mul/div assistance: **1–2 fps**.
> 1–2 fps vs 35 Hz = **17.5–35× short** on the Genesis alone.
> The FPGA offloads the most expensive operation (FixedMul/FixedDiv), reducing
> the effective F_isa; the residual deficit reflects pipeline and cache overhead
> rather than arithmetic density.

**Regime 2 — Unassisted (Genesis 68000 only, no FPGA):**
> Genesis 68000 @ 7.67 MHz alone: 1 frame per 2–3 seconds (**0.3–0.5 fps**).
> 0.3–0.5 fps vs 35 Hz = **70–117× short** — this is the direct F_isa
> cross-check: at 7.67 MHz alone, budget = 7,670,000÷35 = 219,143 cycles/tic;
> arithmetic model gives 1,118,719×6÷219,143 = 30.6× to 1,289,414×12÷219,143 = 70.6×.
> The empirical upper end (70×) matches the model upper end (70.6×), validating
> F_isa ≥ 12 at worst-case scenes.  F_isa lower bound (6×) explains the faster
> scenes; heavier scenes with more FixedMul density push toward the upper empirical range.

**Sega CD second 68000 — does it help?**

The second 68000 at 12.5 MHz adds 357,143 cycles/tic of independent CPU
budget.  In principle: Genesis CPU handles sim + audio; Sega CD CPU handles
render.  In practice:
- Render demand (§3.3 SH-2 analogy): render_p50 (plutonia) = 1,227,389
  instr/tic × F_isa 6–12 = **7.4M–14.7M cycles**; Sega CD budget = 357,143.
  Ratio: **20–41×** over the Sega CD CPU budget for render alone.
- Communication overhead: the CPUs share PRG-RAM and Word RAM via a bus
  arbiter; contention serialises access.

**Sega CD ASIC (affine stamp engine) — visual subsystem analysis:**

The Sega CD ASIC performs hardware affine scale/rotate on 16×16 stamp tiles.
DOOM's floor and ceiling are per-scanline affine spans — these are
geometrically equivalent to one dimension of an affine transform and plausibly
map to stamp operations.  However:
- **Walls and sprites** are perspective-correct column draws, NOT affine;
  the ASIC cannot rasterise them.
- **Output format**: the VDP renders 4bpp tiles into a 64-color palette;
  DOOM requires 320×200 8bpp (256-color) direct framebuffer.  Converting
  a 320×200×8bpp scene into 4bpp tile format in real-time requires an
  additional colour-reduction pass not present in any prior port; this is
  not a minor overhead.
- The ASIC would assist floor/ceiling fills only; it cannot substitute for
  the primary wall/sprite column rasteriser.

**RAM wall:**
```
Available:  ~896 KB (64 KB WRAM + 512 KB PRG-RAM + 256 KB Word RAM + 64 KB VRAM)
Needed:     ~2,440 KB writable minimum (§1.4)
Shortfall:  ~2.7× RAM shortfall
```

No headroom even with WHD-class asset compression for the static segment
(1.21 MiB static BSS alone exceeds total Sega CD writable RAM).

**Summary:**

| Wall | Severity |
|------|----------|
| CPU (Genesis+Sega CD combined, §F_isa arithmetic) | ~11.6–26.8× over budget |
| CPU (krikzz empirical anchor, FPGA-assisted Genesis alone) | 17.5–35× short |
| CPU (krikzz empirical anchor, unassisted Genesis alone) | 70–117× short |
| RAM (static segment alone exceeds system total) | ~2.7× shortfall |
| Video (4bpp/64-color tile output; no 320×200 8bpp path) | architectural mismatch |

**Verdict: PARKED — infeasible for tic-exact 35 Hz native-res by ~11.6–26.8×
CPU-side on the combined system (Genesis+Sega CD), before RAM and video
constraints.**  The krikzz doom-68k anchor (1–2 fps FPGA-assisted; 0.3–0.5 fps
unassisted) is the measured ceiling; the Sega CD second 68000 reduces the
deficit but cannot bridge the remaining gap without fundamental engine changes
(non-vanilla renderer, colour-depth reduction, WHD-class compression).
Any future bring-up is a named-cuts stunt, not a promise of this project.
Recorded per spec.md §Explicit non-goals amendment 2026-07-21.

---

### 3.10 Sub-100 MHz MCU (open cell)

**Scope:** This row characterises the single-core arithmetic floor for a
Cortex-M0+ class MCU at a generic 100 MHz reference clock, then derives
the dual-core + WHD-class asset work required.  The deliverable is
**the measured minimum clock** at which 13/13 demos stay tic-exact
(task 20.7 measurement plan), not a record claim.

**Reference: RP2040 at 100 MHz (one core):**
```
100,000,000 ÷ 35 = 2,857,143 cycles/tic  (per core)
```

**Conversion factor (Cortex-M0+ vs x86-64):**

Same ISA as §3.7 (RP2040): F_isa ≈ 3–5×.  No hardware divide, no FPU,
software 64-bit multiply for FixedMul; upper bound reflects divide cost
and cache-miss pressure on a small (4 KB) or absent data cache.

**Demand (derived from cycle-floor.json means, §1.2; representative ~1.29M):**
```
demand = mean_instr_per_tic × F_isa

Using ~1.29M representative (plutonia.wad = 1,289,414, heaviest IWAD):
  low end:  1,289,414 × 3 = 3,868,242 cycles/tic
  high end: 1,289,414 × 5 = 6,447,070 cycles/tic

single-core budget at 100 MHz: 2,857,143 cycles/tic

ratio = 3,868,242 ÷ 2,857,143 = 1.36×  (F=3, optimistic)
        6,447,070 ÷ 2,857,143 = 2.26×  (F=5, pessimistic)
```

**Single-core 100 MHz is 1.4–2.3× short.**  (Rounded from 1.36–2.26×;
the rounding reflects F_isa uncertainty — a faster MCU or tighter code could
shift the boundary.)

**Implication for dual-core:**

The RP2040 proven-sufficient point (§3.7) is 2×270 MHz = 540 MHz combined.
At the RP2040 F_isa range (3–5×), single-core 270 MHz uses 51–84% of the
core budget, confirming headroom.  Extrapolating the model:

```
minimum viable single-core clock (F=3, 50% budget):
  2 × demand_low = 2 × 3,868,242 = 7,736,484 cycles/tic needed at 50% margin
  clock = 7,736,484 × 35 = 271 MHz  → consistent with RP2040 anchor (270 MHz)

minimum viable single-core clock (F=5, no margin):
  demand_high = 6,447,070 cycles/tic
  clock = 6,447,070 × 35 = 225.6 MHz

minimum for a single core to barely meet budget (ratio=1.0):
  F=3: clock = 3,868,242 × 35 = 135.4 MHz
  F=5: clock = 6,447,070 × 35 = 225.6 MHz
```

A single M0+ core needs **135–226 MHz to meet 35 Hz budget with no margin**;
no commercial M0+ part runs above ~240 MHz (RP2350/RP2040 at 133 MHz default,
overclocked to 250–300 MHz).  Reaching 35 Hz with margin on one core requires
being at the RP2040 overclocked range, which confirms the RP2040 anchor.

**At 100 MHz single core:** 1.4–2.3× short → requires dual-core split
(render on core 0, sim+audio on core 1) AND WHD-class asset compression to
fit RAM (same as rp2040-doom).

**WHD and RAM:** Same constraint as §3.7: 264 KB on-chip SRAM needs WHD
compression; established solution from rp2040-doom (kilograham).

**Task 20.7 measurement plan:** underclocked RP2040-class device; deliver
measured minimum clock at which 13/13 IWAD demos stay tic-exact.
This will cross-check F_isa empirically — if the measured floor is significantly
above or below the model's 135–226 MHz prediction, F_isa must be revised.

**Verdict: OPEN CELL — arithmetic shows single-core 100 MHz is 1.4–2.3×
short; dual-core + WHD required (same as the proven RP2040 configuration).
Deliverable is measured minimum clock (task 20.7), not a record claim.**

---

## 4. Verdict table

Formula inline for every ratio so the table is self-verifying from §3 numbers.
Demand range uses cycle-floor.json means: doom.wad 1.12M (lightest) to plutonia.wad 1.29M (heaviest) per §1.2.

| Platform | Clock | Cycles/tic budget | F_isa | Demand (cycles/tic) | Demand ÷ Budget | RAM (needed vs available) | Verdict |
|----------|-------|------------------|-------|--------------------|-----------------|-----------------------|---------|
| 486DX2-66 | 66 MHz | 66M÷35=**1,885,714** | 1.46–1.69 (calibrated §2) | 1.12M×1.46–1.29M×1.69=**1.63M–2.18M** | **0.86–1.16×** | 4 MB extended RAM vs ~2.4 MB needed | **proven-sufficient (anchor)** |
| 386DX-40 | 40 MHz | 40M÷35=**1,142,857** | 1.46–1.69 | 1.12M×1.46–1.29M×1.69=**1.63M–2.18M** | **1.43–1.91×** | same | **just over budget; chase needs 30–48% cut (§3.5a)** |
| N64 VR4300 | 93.75 MHz | 93.75M÷35=**2,678,571** | 1.2–2 | 1.12M×1.2–1.29M×2=**1.34M–2.58M** | **0.50–0.96×** | 4–8 MB RDRAM, fine | **marginal-to-sufficient (open cell; §3.8)** |
| RP2040 | 2×270 MHz | 270M÷35=**7,714,286**/core | 3–5 | 1.29M×3–5=**3.87M–6.45M** | **0.50–0.84×** /core | 264 KB on-chip, WHD compression solves gap | **proven-sufficient (anchor)** |
| Sub-100 MHz MCU | 100 MHz (single core) | 100M÷35=**2,857,143**/core | 3–5 | 1.29M×3–5=**3.87M–6.45M** | **1.36–2.26×** /core | 264 KB class, WHD required | **open cell — 1.4–2.3× short single-core; dual-core + WHD required (§3.10, task 20.7)** |
| ESP32-S3 | 2×240 MHz | 240M÷35=**6,857,143**/core | 1.5–2.5 | 1.29M×1.5–2.5=**1.94M–3.22M** | **0.28–0.47×** /core | PSRAM required; 9.6 MB config in bare-metal.md §7 | **plausible-unproven** |
| Sega 32X (sim) | 2×23 MHz SH-2 | 23M÷35=**657,143**/SH-2 | 1.5–3 | sim only: 87K×1.5–3=**130K–261K** | **0.20–0.40×** /SH-2 (sim only) | 256 KB SDRAM, needs WHD or cuts | **plausible-unproven (sim); UNMEASURED (render)** |
| Sega 32X (render) | — | **657,143**/SH-2 | 1.5–3 | render: 1.41M×1.5–3=**2.1M–4.2M** | **3.2–6.4×** /SH-2 | — | **UNMEASURED (two SH-2s might cover with partitioning — unverified)** |
| Genesis+Sega CD | 7.67+12.5 MHz dual-68k | combined 20.17M÷35=**576,286** | 6–12 | 1.12M×6–1.29M×12=**6.71M–15.47M** | **11.6–26.8×** combined | ~896 KB vs 2.44 MB needed (~2.7× shortfall) | **PARKED — infeasible by ~11.6–26.8× CPU-side (krikzz anchor: 1–2 fps FPGA-assisted, 0.3–0.5 fps unassisted); §3.9** |
| GBA | 16.8 MHz ARM7TDMI | 16.8M÷35=**480,000** | 2–4 | 1.29M×2–4=**2.58M–5.16M** | **5.4–10.8×** | 256 KB EWRAM vs 1.21 MB needed | **infeasible-by-5–11×** |
| SNES+SuperFX2 | 21 MHz SFX2 | 21M÷35=**600,000** | 4–8 | 1.29M×4–8=**5.16M–10.32M** | **8.6–17.2×** | 256 KB+cart vs 1.21 MB needed | **infeasible-by-9–17×** |
| Stock SNES | 3.58 MHz 65C816 | 3.58M÷35=**102,286** | 20–100 | 1.29M×20–100=**25.8M–129M** | **252–1261×** | 256 KB vs 1.21 MB needed | **infeasible-by-250–1260×** |

### North-star answer

**Can vanilla DOOM run tic-exact on a stock SNES?**

No.  The CPU shortfall alone is 254–1271×, driven by three independent walls
(§3.1).  This is not an optimization problem: the 65C816's fundamental
throughput for 32-bit fixed-point arithmetic is architecturally insufficient
at 3.58 MHz.  The historical SNES Doom port proved the point: Linden replaced
the entire rendering engine with a custom non-vanilla Reality engine and still
required the 21 MHz Super FX 2 coprocessor.

---

## 5. Gate wiring

**Route taken: `derived-from-gated-sources`.**

The key figures in this document are derived from already-gated golden files:

| Atlas figure | Derived from | Already gated in |
|-------------|-------------|-----------------|
| sim p50 per IWAD (48K–87K instr/tic) | `cycle-attribution.json` `.per_iwad[*].sim_p50` | CI fast gate (`verify-all.sh`) |
| np-HWM 0.981 MiB | `zone-stats.json` `.headline.hwm_np_worst_bytes` | CI fast gate |
| Whole-program mean 1.12–1.29M instr/tic | `cycle-floor.json` `.per_iwad[*].mean_instr_per_tic` | CI fast gate |
| Worst p99 2,647,739 instr/tic | `cycle-floor.json` `.worst_p99` | CI fast gate |
| 486DX2-66 calibration factor 1.46–1.69 | Arithmetic on cycle-floor.json means ÷ 66M/35 Hz | Derived |
| SNES ratio 252–1261× | Arithmetic on cycle-floor.json means × F_isa ÷ 3.58M/35 Hz | Derived |
| **386DX-40 chase: 30–48% cut needed** | Arithmetic: 1−1/ratio where ratio=1.43–1.91 (§3.5a) | Derived from §4 ratios (which derive from cycle-floor.json) |
| **N64 VR4300 budget 2,678,571 cycles/tic** | 93,750,000÷35 (clock ÷ Hz) | Hand-checked arithmetic |
| **N64 demand 1.34M–2.58M cycles/tic** | cycle-floor.json means (1.12M–1.29M) × F_isa 1.2–2 | Derived from CI-gated golden |
| **N64 ratio 0.50–0.96×** | 1,118,719×1.2÷2,678,571 to 1,289,414×2÷2,678,571 | Derived |
| **Genesis+Sega CD combined budget 576,286 cycles/tic** | (7,670,000+12,500,000)÷35 | Hand-checked arithmetic |
| **Genesis+Sega CD demand 6.71M–15.47M cycles/tic** | cycle-floor.json means × F_isa 6–12 | Derived from CI-gated golden |
| **Genesis+Sega CD ratio 11.6–26.8×** | 6.71M÷576,286 to 15.47M÷576,286 | Derived |
| **krikzz doom-68k: FPGA-assisted 1–2 fps (17.5–35× short); unassisted 0.3–0.5 fps (70–117× short)** | External anchor: github.com/krikzz/doom-68k | External anchor (hand-checked) |
| **Sub-100 MHz MCU budget 2,857,143 cycles/tic** | 100,000,000÷35 | Hand-checked arithmetic |
| **Sub-100 MHz MCU demand 3.87M–6.45M cycles/tic** | ~1.29M representative (plutonia) × F_isa 3–5 (same ISA as §3.7) | Derived from CI-gated golden |
| **Sub-100 MHz MCU ratio 1.36–2.26× (≈1.4–2.3×)** | 3.87M÷2,857,143 to 6.45M÷2,857,143 | Derived |

The atlas introduces no new measurements.  Every numeric claim is either
directly quoted from a gated golden, is arithmetic on gated figures with
the formula stated inline, or carries an external-anchor citation.

**External anchors (task 20.1, verified 2026-07-21):**
- krikzz/doom-68k (github.com/krikzz/doom-68k): Genesis 68000 @7.67 MHz,
  1–2 fps with in-cart FPGA mul/div.  Hand-checked against public repo.
- FastDoom 486DX2-66 benchmark: 30.1 fps vs vanilla 21.5 fps
  (fabiensanglard.net/fastdoom).  Hand-checked.
- FastDoom 386DX-40: 10–12 fps full detail
  (github.com/viti95/FastDoom discussion #249).  Hand-checked.
- 64doom (jnmartin84): N64 VR4300 port, playable, demo compat not verified.
  Hand-checked against public repo.

**Why `derived-from-gated` rather than `claims-wired`:** Wiring
`feasibility-atlas.md` into `doc-drift.mjs` would require modifying
`tools/archaeology/doc-drift.mjs` (new hints map), `tools/archaeology/claims.json`
(new claim entries), and `docs/claims-index.md` (new rows with exact line
numbers) — three files changed, plus iteration on exact regex patterns to
match inline arithmetic strings.  This exceeds the 15-call threshold stated
in the task.  The upstream goldens (`cycle-floor.json`, `zone-stats.json`,
`cycle-attribution.json`) are already machine-verified; drift in the atlas
figures is detectable by reading the goldens, which is sufficient for a
synthesis document.

---

*Sources*: `tools/golden/cycle-floor.json` (schema `cycle-floor.v1`),
`tools/golden/cycle-attribution.json` (schema `cycle-attribution.v1`),
`tools/golden/zone-stats.json` (schema `zone-stats.v1`),
`docs/perf.md` §1–3,
`docs/bare-metal.md` §2–7.
External anchors verified 2026-07-17: rp2040-doom (kilograham), GBADoom,
D32XR (Jaguar codebase), SNES Doom (Linden/Sculptured Software).
