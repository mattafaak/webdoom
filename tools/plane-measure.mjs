#!/usr/bin/env node
// plane-measure.mjs — webdoom task 2.3: measure R_FindPlane probe depth.
//
// Requires a build compiled with -DWEB_PERF_PLANE_STATS; the three
// web_perf_findplane_*_get() exports return 0 in normal builds.
//
// Reports per-frame averages for:
//   findplane_calls/frame  — how many times R_FindPlane is called
//   findplane_iters/frame  — total linear-search comparisons (= O(n) cost)
//   visplane_peak          — max live visplanes in any single frame (across demos)
//
// Runs doom.wad demo1/demo2/demo3 + tnt.wad demo2 + plutonia.wad demo3
// (heavy cases from perf.md §2 — highest zone HWM = more open geometry).
//
// usage:
//   node tools/plane-measure.mjs
//
// Artifacts (doom.js, doom.wasm, <wad>) must be in tools/ or wads/ directory.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

const createDoom = (await import(join(here, 'doom.js'))).default;

// WAD cases: (file, engineName, demo)
const CASES = [
    { wad: 'doom.wad',     engine: 'doomu.wad', demo: 'demo1', label: 'doom demo1' },
    { wad: 'doom.wad',     engine: 'doomu.wad', demo: 'demo2', label: 'doom demo2' },
    { wad: 'doom.wad',     engine: 'doomu.wad', demo: 'demo3', label: 'doom demo3' },
    { wad: 'tnt.wad',      engine: 'tnt.wad',   demo: 'demo2', label: 'tnt  demo2 (heavy)' },
    { wad: 'plutonia.wad', engine: 'plutonia.wad', demo: 'demo3', label: 'plut demo3 (heavy)' },
];

// Locate a WAD file: try tools/ then wads/lib/
function findWad(name) {
    for (const dir of [here, join(here, '..', 'wads', 'lib')]) {
        try { return readFileSync(join(dir, name)); } catch {}
    }
    throw new Error(`WAD not found: ${name}`);
}

// Cache WAD buffers so we don't reload for each demo
const wadCache = {};
function loadWad(name) {
    if (!wadCache[name]) wadCache[name] = findWad(name);
    return wadCache[name];
}

function registerWad(doom, engineName, wadBytes) {
    const p = doom._malloc(wadBytes.length);
    doom.HEAPU8.set(wadBytes, p);
    doom.ccall('web_register_file', null, ['string', 'number', 'number'],
        [engineName, p, wadBytes.length]);
}

console.log('\nplane-measure — R_FindPlane probe depth (requires -DWEB_PERF_PLANE_STATS build)');
console.log('─'.repeat(72));

let overallPeak = 0;
const results = [];

for (const { wad, engine, demo, label } of CASES) {
    let wadBytes;
    try { wadBytes = loadWad(wad); }
    catch (e) { console.log(`  [SKIP] ${label}: ${e.message}`); continue; }

    let done = null;
    const doom = await createDoom({
        print: () => {},
        printErr: t => { const m = /timed (\d+) gametics/.exec(t); if (m) done = +m[1]; },
    });
    registerWad(doom, engine, wadBytes);

    doom.callMain(['-timedemo', demo]);

    // Run one frame, skip the melt wipe, then reset counters.
    doom._web_frame();
    doom._web_wipe_skip();
    doom._web_perf_reset();

    try {
        for (let i = 0; i < 300000 && done === null; i++) doom._web_frame();
    } catch { /* timedemo finished */ }

    const frames = doom._web_perf_frames();
    if (frames < 1) { console.log(`  [SKIP] ${label}: no frames measured`); continue; }

    const calls = doom._web_perf_findplane_calls_get();
    const iters = doom._web_perf_findplane_iters_get();
    const peak  = doom._web_perf_visplane_peak_get();

    const callsPerFrame = calls / frames;
    const itersPerFrame = iters / frames;
    if (peak > overallPeak) overallPeak = peak;

    results.push({ label, frames, callsPerFrame, itersPerFrame, peak });

    console.log(
        `  ${label.padEnd(22)} ${frames} frames` +
        `  calls/frame=${callsPerFrame.toFixed(1)}` +
        `  iters/frame=${itersPerFrame.toFixed(1)}` +
        `  peak-planes=${peak}`
    );
}

console.log('─'.repeat(72));
if (results.length > 0) {
    const maxCalls = Math.max(...results.map(r => r.callsPerFrame));
    const maxIters = Math.max(...results.map(r => r.itersPerFrame));
    console.log(`  MAX across cases:  calls/frame=${maxCalls.toFixed(1)}  iters/frame=${maxIters.toFixed(1)}  peak-planes=${overallPeak}`);
    console.log();

    // Hash ceiling estimate: if hash eliminates the linear scan and replaces
    // it with O(1) lookup, max saving ≈ iters/frame * cost-per-comparison.
    // R_FindPlane is inside the planes stage (0.1566 ms/frame on wbox).
    // With ~itersPerFrame comparisons each touching 3 fields (height/picnum/light)
    // the hash ceiling is at most a tiny fraction of the planes stage.
    // We compute: iters/frame / (planes_stage_cost_per_iter_estimate).
    console.log('  Interpretation:');
    console.log(`    Each linear-search iter touches 3 int comparisons + loop branch.`);
    console.log(`    Max iters/frame = ${maxIters.toFixed(1)} → even if each iter cost 10 ns,`);
    console.log(`    total search cost ≈ ${(maxIters * 10 / 1000).toFixed(1)} µs/frame`);
    console.log(`    planes stage baseline = 156.6 µs/frame (wbox, perf.md Q3).`);
    console.log(`    Ceiling on possible win from hash ≈ ${((maxIters * 10 / 1000) / 156.6 * 100).toFixed(1)}%.`);
    console.log(`    (Assumes 10 ns/comparison — generous; actual may be 2–5 ns in tight loop.)`);
}
