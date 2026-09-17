# Wide-mode (854 px Hor+) render cost — task 18.4

**Archived 2026-09-17 (round 13).** This was `docs/perf.md §18.4`. It is moved
rather than deleted because the measurements are real and dated, and because
its sibling — [decision-18.1-wide-limits.md](decision-18.1-wide-limits.md), the
BSS arithmetic the widescreen revert was checked against — already lives here.
Neither describes the shipping engine.

> **SUPERSEDED 2026-09-12 — widescreen was removed** (spec.md §"Widescreen view
> — REVERSED"). The measurements below are real and stay as dated evidence, but
> they describe a mode that no longer exists: `bench.mjs` has no `--wide` pass
> and the engine has no `web_set_wide`. Nothing here is reproducible on the
> current tree.

*Task 18.4 — measured 2026-07-22 on harness-work/18.4, base commit f402d5c.*
*Reproduce (on a tree before 2026-09-12): `node tools/bench.mjs doom.wad 3 --wide` on each host.*
*bench.mjs Pass 3 (`--wide`) runs doom.wad demo1/demo2/demo3 at 854 px*
*(Hor+) and reports per-stage µs/frame; delta vs. the 320-px Pass 1 baseline*
*is printed inline. Three reps; best-of-3 by rendered-frame count.*

### Per-demo results (ms/frame)

#### alder (i9-12900K)

| demo | 320 px sum | 854 px sum | Δ (ms) |
|------|-----------|-----------|--------|
| demo1 | 0.062 | 0.140 | +0.078 |
| demo2 | 0.049 | 0.120 | +0.071 |
| demo3 | 0.049 | 0.122 | +0.074 |
| **avg** | **0.053** | **0.127** | **+0.074** |

#### wbox (AMD G-T56N Bobcat, 1.65 GHz)

| demo | 320 px sum | 854 px sum | Δ (ms) |
|------|-----------|-----------|--------|
| demo1 | 0.568 | 1.876 | +1.308 |
| demo2 | 0.500 | 1.505 | +1.005 |
| demo3 | 0.487 | 1.504 | +1.018 |
| **avg** | **0.518** | **1.628** | **+1.110** |

#### pi5 (Raspberry Pi 5, ARM Cortex-A76)

| demo | 320 px sum | 854 px sum | Δ (ms) |
|------|-----------|-----------|--------|
| demo1 | 0.164 | 0.379 | +0.216 |
| demo2 | 0.147 | 0.346 | +0.199 |
| demo3 | 0.135 | 0.342 | +0.207 |
| **avg** | **0.149** | **0.356** | **+0.207** |

### Fleet summary

| host | 320 px avg (ms) | 854 px avg (ms) | Δ (ms) | wide/narrow | % of 28.57 ms budget (wide) |
|------|----------------|----------------|--------|-------------|------------------------------|
| alder | 0.053 | 0.127 | +0.074 | 2.40× | 0.44% |
| pi5 | 0.149 | 0.356 | +0.207 | 2.39× | 1.25% |
| wbox | 0.518 | 1.628 | +1.110 | 3.14× | 5.70% |

**Wide/narrow ratio** is 2.4× on alder and pi5 (typical for
~2.67× pixel-column count increase at same scene density) and 3.1× on wbox
(Bobcat in-order core sees more cache pressure from the wider
BSP+planes traversal than the column-draw math alone would predict).

**Wide mode is still within the 35 Hz budget on all measured hosts**:
the worst case (wbox) sits at 5.70% of the 28.57 ms tic budget —
well clear of the 100% ceiling even before accounting for the
JS/browser pipeline that dominates wall time.

**Stage breakdown at 854 px (wbox, demo1):**
bsp+segs 0.626 ms, planes 1.110 ms, masked 0.131 ms, frame-setup 0.009 ms.
Planes becomes the dominant stage at wide (1.110 ms vs 0.192 ms at 320),
overtaking bsp+segs (0.626 ms vs 0.282 ms at 320). This is expected:
`R_DrawSpan` covers more floor/ceiling columns at wider FOV while the
BSP walk cost grows more modestly (same depth, more visible spans).

**Sim cost is unaffected**: wide mode is purely a render concern.
`node tools/mixed-width-net-test.mjs` (task 18.4) confirmed 366 tics,
0 mismatches between a 320-px client and an 854-px client in the same
2-player lockstep session.

**Both halves of that sentence are history.** Widescreen was removed on
2026-09-12, so there is no 854-px client, and `tools/mixed-width-net-test.mjs`
was deleted with it. It is also one of two records of the same run that
disagree: `docs/optimization-ledger.md` says 368 tics where this says 366.
Neither can be re-derived, so neither is corrected — and the disagreement is
worth more as a marker than a silently chosen winner would be.

---
