#!/usr/bin/env node
// bench.mjs — webdoom per-stage timing benchmark.
//
// Two passes per demo:
//   1. Render pass (no -nodraw): harvests per-stage µs via _web_perf_*
//      accumulators: frame-setup, BSP+segs, planes, masked sprites.
//   2. Sim-only pass (-nodraw): measures raw sim throughput (fps) so the
//      legacy fps metric remains comparable to the v1 baseline.
//
// Per-stage numbers: each stage's total µs / rendered frames = µs/frame.
// stages sum ≈ total frame time (sanity check).
//
// usage:
//   node tools/bench.mjs [wad=doom.wad] [reps=3]
//   node tools/bench.mjs doom.wad 5 --json
//
// --json: emit a machine-readable result object (consumed by fleet runner,
//         task 0.2, which will branch on schemaVersion == 2).
//
// Artifacts must live alongside this file: doom.js, doom.wasm, wad.
// The engine's _web_perf_* exports are populated only when nodrawers == 0.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here     = dirname(fileURLToPath(import.meta.url));
const jsonFlag = process.argv.includes('--json');
const args     = process.argv.slice(2).filter(a => a !== '--json');
const wad      = args[0] ?? 'doom.wad';
const reps     = Number(args[1] ?? 3);
const engineName = wad === 'doom.wad' ? 'doomu.wad' : wad;

const createDoom = (await import(join(here, 'doom.js'))).default;
const wadBytes   = readFileSync(join(here, wad));

const DEMOS = ['demo1', 'demo2', 'demo3'];

// ── helpers ──────────────────────────────────────────────────────────────────

function registerWad (doom) {
    const p = doom._malloc(wadBytes.length);
    doom.HEAPU8.set(wadBytes, p);
    doom.ccall('web_register_file', null, ['string', 'number', 'number'],
        [engineName, p, wadBytes.length]);
}

// Run N frame ticks; swallow timedemo-end exception; return true if demo ended.
function runFrames (doom, n) {
    try {
        for (let i = 0; i < n; i++) doom._web_frame();
    } catch (e) { return true; }
    return false;
}

// ── Pass 1: render pass — per-stage µs ──────────────────────────────────────
//
// Do NOT pass -nodraw: every bucket must be non-zero.
// Use web_wipe_skip() to instantly clear the time-gated melt wipe so the
// tight loop reaches the measurement frames without needing wall-clock delay.
// Run `reps` reps per demo; keep the rep with the most rendered frames
// (least OS jitter).

if (!jsonFlag)
    console.log(`\nbench — render pass (per-stage µs/frame) — ${reps} rep(s)`);

const renderResults = {};

for (const demo of DEMOS) {
    let best = null;

    for (let r = 0; r < reps; r++) {
        let done = null;
        const doom = await createDoom({
            print: () => {},
            printErr: t => { const m = /timed (\d+) gametics/.exec(t); if (m) done = +m[1]; },
        });
        registerWad(doom);

        // timedemo without -nodraw so render stages run
        doom.callMain(['-timedemo', demo]);

        // Let one frame run so the demo starts (wipe arms on this frame).
        // Then skip the melt wipe — it is purely cosmetic and time-gated
        // by wall-clock; the tight loop would spin indefinitely otherwise.
        doom._web_frame();
        doom._web_wipe_skip();

        // Reset counters: discard the wipe-start frame.
        doom._web_perf_reset();

        // Run the demo — timedemo end raises I_Error which throws.
        try {
            for (let i = 0; i < 300000 && done === null; i++) doom._web_frame();
        } catch { /* timedemo finished */ }

        const frames = doom._web_perf_frames();
        if (frames < 1) continue;

        const candidate = {
            frames,
            sim_us:    doom._web_perf_sim(),
            frame_us:  doom._web_perf_frame(),
            bsp_us:    doom._web_perf_bsp(),
            planes_us: doom._web_perf_planes(),
            masked_us: doom._web_perf_masked(),
        };

        if (!best || frames > best.frames) best = candidate;
    }

    if (!best) { renderResults[demo] = null; continue; }

    const f = best.frames;
    const res = {
        frames:    f,
        sim_ms:    best.sim_us    / f / 1000,
        frame_ms:  best.frame_us  / f / 1000,
        bsp_ms:    best.bsp_us    / f / 1000,
        planes_ms: best.planes_us / f / 1000,
        masked_ms: best.masked_us / f / 1000,
    };
    res.sum_ms = res.frame_ms + res.bsp_ms + res.planes_ms + res.masked_ms;
    renderResults[demo] = res;

    if (!jsonFlag) {
        console.log(`  ${demo} (${f} frames):`);
        console.log(`    frame-setup ${res.frame_ms.toFixed(3)} ms  bsp+segs ${res.bsp_ms.toFixed(3)} ms  planes ${res.planes_ms.toFixed(3)} ms  masked ${res.masked_ms.toFixed(3)} ms`);
        console.log(`    stages-sum ${res.sum_ms.toFixed(3)} ms  sim ${res.sim_ms.toFixed(3)} ms/tic`);
    }
}

// ── Pass 2: sim-only fps (-nodraw) — legacy v1 metric ───────────────────────
// Keep this pass so the legacy fps number is not silently redefined.

if (!jsonFlag)
    console.log(`\nbench — sim-only pass (-nodraw fps) — ${reps} rep(s)`);

const fpsResults = {};

for (const demo of DEMOS) {
    let best = 0, ticsRun = 0;
    for (let r = 0; r < reps; r++) {
        let done = null;
        const doom = await createDoom({
            print: () => {},
            printErr: t => { const m = /timed (\d+) gametics/.exec(t); if (m) done = +m[1]; },
        });
        registerWad(doom);
        doom.callMain(['-timedemo', demo, '-nodraw']);

        for (let i = 0; i < 40; i++) doom._web_frame();
        const start = doom._web_gametic();
        const t0 = performance.now();
        try {
            for (let i = 0; i < 300000 && done === null; i++) doom._web_frame();
        } catch { /* timedemo finished */ }
        const ms  = performance.now() - t0;
        const tics = (done ?? doom._web_gametic()) - start;
        const fps  = tics / ms * 1000;
        if (fps > best) { best = fps; ticsRun = tics; }
    }
    fpsResults[demo] = best;
    if (!jsonFlag)
        console.log(`  ${demo}: ${best.toFixed(0)} fps (${ticsRun} tics, best of ${reps})`);
}

const avg = Object.values(fpsResults).reduce((a, b) => a + b, 0) / DEMOS.length;
if (!jsonFlag)
    console.log(`AVG ${avg.toFixed(0)} fps  [${Object.values(fpsResults).map(f => f.toFixed(0)).join(' ')}]`);

// ── JSON output ───────────────────────────────────────────────────────────────
if (jsonFlag) {
    const out = {
        schemaVersion: 2,
        wad,
        reps,
        renderStages: renderResults,
        simFps: fpsResults,
        simFpsAvg: avg,
    };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}
