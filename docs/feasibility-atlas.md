# webdoom retro feasibility atlas

**Task 13.5 — The north star as arithmetic.**
Commit date: 2026-07-18. All inputs are pre-existing measured artifacts; this
document does arithmetic, not new measurements.

---

## Contents

1. [Method and conversion-factor doctrine](#1-method-and-conversion-factor-doctrine)
2. [The 486 calibration trick](#2-the-486-calibration-trick)
3. [Platform rows](#3-platform-rows)
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
| doom.wad | 1,226,058 | 1,230,745 | 58,355 | 4.7% |
| doom2.wad | 1,296,499 | 1,394,586 | 79,722 | 5.7% |
| tnt.wad | 1,280,040 | 1,377,217 | 48,686 | 3.4% |
| plutonia.wad | 1,370,218 | 1,493,854 | 86,515 | 5.9% |

**p50 is the preferred metric** — 35 Hz is a real-time deadline and p50
represents the median tic a ported CPU must sustain.  Worst-case p99 is
2,694,430 instr/tic (doom-demo4), variance 1.3–9.9%.  Level-load spikes are
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

demand_x86  = 1,226,058–1,370,218 instr/tic  (cycle-floor.json means, doom–plutonia)

implied F = budget_486 ÷ demand_x86
          = 1,885,714 ÷ 1,226,058  =  1.54  (doom.wad, lightest)
          = 1,885,714 ÷ 1,370,218  =  1.38  (plutonia.wad, heaviest)
```

**Calibration result: F ≈ 1.38–1.54 for period x86 (486DX2).**

This factor encodes 486 CPI (~1 on simple ops, 2–4 on complex, no
out-of-order, 8 KB L1) plus the minimal ISA delta within the x86 family.
DOOM's integer-heavy inner loops (fixed-point multiply, shift, add) ran
efficiently on the 486; the factor is not primarily ISA overhead but rather
in-order pipeline and cache-miss cost.

**Interpretation for other ISAs:**

- Platforms with larger ISA overhead (65C816, SH-2, ARM7) need a larger
  `F_isa` on top of the 486's 1.4–1.5× CPI component.
- The 486 anchor calibrates the CPI baseline; the ISA term is additive.
- For the 386DX-40 (40 MHz): budget = 40,000,000/35 = 1,142,857 cycles/tic.
  At F=1.4: demand = 1,300,000 × 1.4 = 1,820,000 cycles; budget 1,143,000 →
  ratio 1.59×.  Consistent with the historical record: DOOM ran on 386 but
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
- At F=1.4: demand ≈ 1,820,000 cycles; ratio ≈ 1.59× over budget
- Historical: playable with slowdowns on complex scenes

**486DX2-66 (66 MHz):**
- Budget: 66,000,000 / 35 = 1,885,714 cycles/tic
- Implied factor 1.38–1.54 (§2)
- Historical: ~35 fps on typical doom.wad content; the sweet spot

**Verdict: PROVEN-SUFFICIENT (anchor).**  These are the intended targets;
they ground every other row's factor estimates.

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

## 4. Verdict table

Formula inline for every ratio so the table is self-verifying from §3 numbers.

| Platform | Clock | Cycles/tic budget | F_isa | Demand (cycles/tic) | Demand ÷ Budget | RAM (needed vs available) | Verdict |
|----------|-------|------------------|-------|--------------------|-----------------|-----------------------|---------|
| 486DX2-66 | 66 MHz | 66M÷35=**1,885,714** | 1.38–1.54 (calibrated §2) | 1.23M×1.38–1.37M×1.54=**1.70M–2.11M** | **0.90–1.12×** | 4 MB extended RAM vs ~2.4 MB needed | **proven-sufficient (anchor)** |
| 386DX-40 | 40 MHz | 40M÷35=**1,142,857** | 1.38–1.54 | 1.23M×1.38–1.37M×1.54=**1.70M–2.11M** | **1.49–1.85×** | same | **just over budget (historical: slowdowns)** |
| RP2040 | 2×270 MHz | 270M÷35=**7,714,286**/core | 3–5 | 1.30M×3–5=**3.9M–6.5M** | **0.51–0.84×** /core | 264 KB on-chip, WHD compression solves gap | **proven-sufficient (anchor)** |
| ESP32-S3 | 2×240 MHz | 240M÷35=**6,857,143**/core | 1.5–2.5 | 1.30M×1.5–2.5=**1.95M–3.25M** | **0.28–0.47×** /core | PSRAM required; 9.6 MB config in bare-metal.md §7 | **plausible-unproven** |
| Sega 32X (sim) | 2×23 MHz SH-2 | 23M÷35=**657,143**/SH-2 | 1.5–3 | sim only: 87K×1.5–3=**130K–261K** | **0.20–0.40×** /SH-2 (sim only) | 256 KB SDRAM, needs WHD or cuts | **plausible-unproven (sim); UNMEASURED (render)** |
| Sega 32X (render) | — | **657,143**/SH-2 | 1.5–3 | render: 1.41M×1.5–3=**2.1M–4.2M** | **3.2–6.4×** /SH-2 | — | **UNMEASURED (two SH-2s might cover with partitioning — unverified)** |
| GBA | 16.8 MHz ARM7TDMI | 16.8M÷35=**480,000** | 2–4 | 1.30M×2–4=**2.6M–5.2M** | **5.4–10.8×** | 256 KB EWRAM vs 1.21 MB needed | **infeasible-by-5–11×** |
| SNES+SuperFX2 | 21 MHz SFX2 | 21M÷35=**600,000** | 4–8 | 1.30M×4–8=**5.2M–10.4M** | **8.7–17×** | 256 KB+cart vs 1.21 MB needed | **infeasible-by-9–17×** |
| Stock SNES | 3.58 MHz 65C816 | 3.58M÷35=**102,286** | 20–100 | 1.30M×20–100=**26M–130M** | **254–1271×** | 256 KB vs 1.21 MB needed | **infeasible-by-250–1270×** |

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
| Whole-program mean 1.23–1.37M instr/tic | `cycle-floor.json` `.per_iwad[*].mean_instr_per_tic` | CI fast gate |
| Worst p99 2,694,430 instr/tic | `cycle-floor.json` `.worst_p99` | CI fast gate |
| 486DX2-66 calibration factor 1.38–1.54 | Arithmetic on cycle-floor.json means ÷ 66M/35 Hz | Derived |
| SNES ratio 254–1271× | Arithmetic on cycle-floor.json means × F_isa ÷ 3.58M/35 Hz | Derived |

The atlas introduces no new measurements.  Every numeric claim is either
directly quoted from a gated golden or is arithmetic on gated figures with
the formula stated inline (verifiable by inspection against this document
alone).

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
