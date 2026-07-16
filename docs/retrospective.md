# webdoom refinement-pass retrospective

*Covers tasks 1.x–5.x from the spec.md refinement tenets.*
*Written at commit HEAD of the 5.1 pass, 2026-07-16.*

---

## What the pass set out to do

`spec.md` framed three tenets:

1. **Measure first, optimize second** — no optimization without a number.
2. **The frozen surface is sacred** — sim hash + render hash are the two
   correctness gates; neither regresses under any change.
3. **Document to spec-quality** — the reference docs become the project's
   long-term memory.

The refinement pass was structured as: archaeology + baseline → opt queue →
hardening → docs.

---

## The load-bearing findings

### 1. Tutti-Frutti: the single biggest discovery (task 3.1 / 3.2)

The render goldens (task 0.3 / c1288ce) surfaced a latent out-of-window
texture read that had been in the vanilla DOOM source since 1993. The
symptom: three specific render goldens (tnt-demo1 tic 1684, plutonia-demo1
tic 5909, plutonia-demo3 tic 1469) failed whenever a new BSS global shifted
the wasm `__heap_base` by as little as 16 bytes. The root cause was
`R_DrawColumn`'s hardcoded `& 127` mask, which wraps at 128 texels
regardless of the actual texture height — for textures shorter than 128 px
(e.g. 64 px walls), the mask allows reads past the end of the composite
column buffer into adjacent zone memory. The bytes read there are whatever
the allocator left behind, which is heap-layout-dependent.

**Fix** (task 3.1, commit 818ff27): `dc_texheight` field added; every
caller sets it to the actual texture height before each column loop.
Secondary fixes: `sprnames[NUMSPRITES+1]` NULL sentinel, `finetangent`
index clamp at 90° walls, `P_SpawnMapThing` type-0 guard.

**Task 3.2** (a0c67c1) completed the unpinning: two additional call sites
in `R_RenderMaskedSegRange` and `R_DrawMaskedColumn` had stale or wrong
`dc_texheight`, fixed the same way. Both BSS-probe and RODATA-probe now
pass 13/13, confirming layout sensitivity eliminated.

**Why this matters**: this bug is undetectable by sim hashes (render state
is sim-invisible) and invisible in practice when the heap layout never
changes. Render goldens are the only gate that catches it. Any project that
does not gate on per-tic framebuffer hashes will carry this class of bug
indefinitely.

### 2. Wasm render is ~2% of the 35 Hz budget (task 2.1, perf.md §B)

The bench harness (bench.mjs v2, fleet-bench.sh, bench-baseline.json schema
v2; commits 15770d9 / caa81fe / f251367) quantified what the wasm renderer
actually costs. On the weakest browser host (wbox, AMD G-T56N): total render
0.49 ms/frame = 1.7% of the 28.57 ms / 35 Hz budget.

This reframed the entire optimization case. A 50% speedup in the hottest
stage (bsp+segs) saves 0.13 ms/frame = 0.46% of budget — unmeasurable by
the user at 35 Hz. The correct motivation for the queue is:
- **bare-metal fps** (ESP32/Cortex-M PSRAM latency; column-stride cache
  misses dominate; this is where the stage ranking is the right proxy)
- **headless CI throughput** (timedemo runs faster)
- not browser fps

The column-loop opt (task 2.2, commit 10c9d62) was correctly framed by
this data: hoist + 4-wide unroll gives -3.5% bsp+segs on wbox, verified
real by a 3-rep interleaved A/B/C bench. Retained because it is correct
and improves CI and bare-metal, not because it moves browser fps.

### 3. Measure-first nogos as legitimate outcomes (tasks 2.3, 2.4, 2.7)

Three tasks closed without code changes:

- **Visplane hash (task 2.3)**: measured peak 451.5 R_FindPlane
  iterations/frame on the heaviest demo (tnt demo2, 68 peak visplanes).
  Ceiling analysis: 4.5 µs/frame = 2.9% of the planes stage. Below the
  noise bar at the system level; the hash's own overhead (multiply + bucket
  chase) would likely erase the win. NOGO. Counter infrastructure kept
  permanently for future profiling (perf.md §Q3).

- **Sim hot paths (task 2.4)**: wbox sim = 0.0706 ms/tic = 0.25% of the
  35 Hz budget. The frozen surface (playsim.md §16) means any sim change
  risks desyncing all 13 golden demos. Risk/reward disproportionate.
  NOGO. Reopen only if Q0 (browser pipeline profile) or a bare-metal
  profile reveals JS-side sim invocation overhead dominating.

- **Tank deep-dive (task 2.7)**: the v2 per-stage data showed tank render
  is only 1.15× alder — not abnormally slow. The v1 fps gap (~2×) was
  general i9-vs-i5 throughput, stable across the FixedDiv implementation
  change. Document-only; nothing to optimize.

These are correct engineering outcomes. A measure-first protocol that never
produces "don't do this" is not really measure-first.

### 4. The adversarial review was where the quality came from

Looking back at what review steps caught in this pass:

- **task 1.x archaeology reviews**: false attributions for the COLORMAP
  recipe and lighting constants; verified against the DOS binary at
  f92fc05.
- **task 2.5 zone review**: the initial bisect blamed the task 2.2
  R_DrawColumn unroll for layout-sensitive render failures; the review
  designed a controlled BSS-probe experiment that disproved the attribution
  and correctly pointed to a pre-existing engine bug. Two probes (+16 bytes
  BSS, +~53 bytes RODATA) confirmed it.
- **harden tasks**: SIL-guard NULL-deref in r_things.c; net upgrade() crash
  on concurrent connections during drop-in; WAD-retry stuck menu on fetch
  error; ESC-countdown stuck overlay on abort path.
- **Every cycle had something**: the pattern held consistently — the first
  implementation was correct in the main path, and the review found
  either a crash path, a false root-cause attribution, or a correctness
  edge case that the author had not exercised.

The review step was not ceremony. It found real bugs in essentially every
cycle.

---

## Estimation notes

- **The ZONESIZE reduction (task 2.5)** was estimated as a small, safe
  change (§2 HWM = 1.36 MB, zone = 32 MB → projected safe at 4 MB). The
  measurement with rendering enabled (render gate) invalidated that estimate
  immediately: 4 MB and 8 MB both fail the render golden gate because the
  render path fills the purgeable texture cache far beyond the -nodraw HWM.
  The -nodraw measurement is a lower bound, not a safe floor for a rendering
  build. ZONESIZE stays at 32 MB until a render-path cache peak measurement
  is taken.

- **Browser fps framing**: Plans.md framed task 2.2 as a browser-fps win.
  Measurement showed wasm render is < 2% of budget; the framing was wrong.
  Measure first caught this before optimization was deployed with a wrong
  claim.

---

## What remains open

- **Q0 (browser pipeline profile)**: the UNMEASURED JS/browser side
  (`video.js` palette expand + WebGL texSubImage2D, rAF jitter,
  AudioWorklet) is still unknown. This is the prerequisite for any
  browser-fps claim from wasm changes.
- **ZONESIZE reduction**: requires render-path texture cache peak
  measurement before a safe floor can be established.
- **browser-lobby-test T07 flake**: pre-existing timing race on some CI
  hosts; ~1/3 pass rate. Not caused by fire canvas or any change in this
  pass. Deferred to task 5.2.

---

## Key commit arc

| commit | what |
|--------|------|
| 15770d9 | per-stage timing hooks + bench.mjs v2 |
| caa81fe | fleet-bench.sh + four-host baseline v2 |
| c1288ce | render goldens: per-tic framebuffer hashes, all 13 demos |
| 6de6256 | lint.sh: clang-format + JS syntax gate |
| 10c9d62 | column/span loop opt (-3.5% bsp+segs on wbox) |
| 2992e02 | perf: correct heap-sensitivity attribution (predates 2.2) |
| 818ff27 | Tutti-Frutti fix + UAF + extern mismatches + native ASan target |
| a0c67c1 | 3.1 review minors: untrack artifacts, honest mask comments |
| f5c2b32 | client resilience: fetch/sw/visibility/gamepad/storage failures |
| 1f425c9 | net fuzz: server survives hostile clients, caps enforced |
| 7d4eff7 | lobby state-machine: enumerated, impossible states guarded |
| f6d6c0a | PSX fire launcher background |
| 8f05c4f | flare-up on menu transitions |
