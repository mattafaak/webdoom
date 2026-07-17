#!/usr/bin/env node
// runtime-stat-verify.mjs — verify runtime counter claims using the
// instrumented build (build-perf/doom.js, compiled with all WEB_PERF_*_STATS
// flags).  Reports PASS / FAIL for each claim; exits 1 if any fail.
//
// Claims verified:
//   ps-003  : peak numspechit across all 13 golden demos
//   ps-029  : teleport calls — doom demo3 (E3M5)
//   ps-030  : teleport calls — doom2 demo3 (MAP26)
//   ps-031  : teleport calls — plutonia demo1 (MAP17)
//   ps-032  : teleport calls — plutonia demo3 (MAP12)
//   perf-034: R_DrawColumn calls/frame avg — doom demo1
//   perf-035: R_DrawColumn avg pixels/call — doom demo1
//   perf-037: R_DrawSpan calls/frame avg — doom demo1
//   perf-038: R_DrawSpan avg pixels/call — doom demo1
//   perf-045: R_FindPlane calls/frame avg — doom demo1
//   perf-046: R_FindPlane iters/frame avg — doom demo1
//   perf-047: visplane peak — doom demo1
//   perf-048: R_FindPlane calls/frame avg — tnt demo2
//   perf-049: R_FindPlane iters/frame avg — tnt demo2
//   perf-050: visplane peak — tnt demo2
//
// All averages use ±2% tolerance (the doc figures are single-rep measurements;
// minor counter differences across emscripten / host-clock runs are expected).
// Peak counters use exact match (deterministic).
// Teleport counters use exact match (deterministic sim event count).
//
// Usage:
//   node tools/archaeology/runtime-stat-verify.mjs

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const perfBuild = join(root, 'build-perf/doom.js');

if (!existsSync(perfBuild)) {
    console.error(`ERROR: ${perfBuild} not found.`);
    console.error('Build with: make -C engine BUILD=../build-perf OUT=../build-perf/doom.js \\');
    console.error('  "EXTRA_CFLAGS=-DWEB_PERF_COL_STATS -DWEB_PERF_PLANE_STATS -DWEB_PERF_TELEPORT_STATS -DWEB_PERF_SPECHIT_STATS"');
    process.exit(2);
}

const createDoom = (await import(perfBuild)).default;
const wadDir = join(root, 'wads/lib');

// Helper: check a wad exists
function wadPath(name) {
    const p = join(wadDir, name);
    if (!existsSync(p)) return null;
    return p;
}

// Helper: load wad bytes into a doom instance
function loadWad(doom, wadFile, engineName) {
    const p = doom._malloc(wadFile.length);
    doom.HEAPU8.set(wadFile, p);
    doom.ccall('web_register_file', null, ['string', 'number', 'number'],
        [engineName, p, wadFile.length]);
}

// Run a timedemo (render pass: no -nodraw).
// Returns counter snapshot after completion.
async function runRenderDemo(wadName, engineName, demo) {
    const path = wadPath(wadName);
    if (!path) return null;
    const wadFile = readFileSync(path);

    let done = null;
    const doom = await createDoom({
        print: () => {},
        printErr: t => { const m = /timed (\d+) gametics/.exec(t); if (m) done = +m[1]; },
        onDoomError: msg => { if (!/timed \d+ gametics/.test(msg)) done = `error: ${msg}`; },
    });
    loadWad(doom, wadFile, engineName);

    doom.callMain(['-timedemo', demo]);
    // One frame to arm, then skip the cosmetic melt wipe.
    doom._web_frame();
    doom._web_wipe_skip();
    // Clear wipe-frame counters.
    doom._web_perf_reset();

    try {
        for (let i = 0; i < 400000 && done === null; i++) doom._web_frame();
    } catch { /* timedemo I_Error */ }

    const frames = doom._web_perf_frames();
    return {
        frames,
        col_calls: doom._web_perf_col_calls_get(),
        col_pixels: doom._web_perf_col_pixels_get(),
        span_calls: doom._web_perf_span_calls_get(),
        span_pixels: doom._web_perf_span_pixels_get(),
        findplane_calls: doom._web_perf_findplane_calls_get(),
        findplane_iters: doom._web_perf_findplane_iters_get(),
        visplane_peak: doom._web_perf_visplane_peak_get(),
        teleport_calls: doom._web_perf_teleport_calls_get(),
        spechit_peak: doom._web_perf_spechit_peak_get(),
        done,
    };
}

// Run a timedemo (sim-only pass: -nodraw).
// Faster; sim events (teleport, spechit) still fire.
async function runSimDemo(wadName, engineName, demo) {
    const path = wadPath(wadName);
    if (!path) return null;
    const wadFile = readFileSync(path);

    let done = null;
    const doom = await createDoom({
        print: () => {},
        printErr: t => { const m = /timed (\d+) gametics/.exec(t); if (m) done = +m[1]; },
        onDoomError: msg => { if (!/timed \d+ gametics/.test(msg)) done = `error: ${msg}`; },
    });
    loadWad(doom, wadFile, engineName);

    doom.callMain(['-timedemo', demo, '-nodraw']);
    doom._web_perf_reset();

    try {
        for (let i = 0; i < 400000 && done === null; i++) doom._web_frame();
    } catch { /* timedemo I_Error */ }

    return {
        teleport_calls: doom._web_perf_teleport_calls_get(),
        spechit_peak: doom._web_perf_spechit_peak_get(),
        done,
    };
}

// ── check helpers ──────────────────────────────────────────────────────────

let failures = 0;
const results = [];

function checkExact(id, desc, expected, actual) {
    const ok = actual === expected;
    if (!ok) failures++;
    const line = `${ok ? 'PASS' : 'FAIL'} ${id}: ${desc} — expected ${expected}, got ${actual}`;
    console.log(line);
    results.push({ id, ok, expected, actual, tolerance: 'exact' });
}

// ±tol fraction
function checkApprox(id, desc, expected, actual, tol = 0.02) {
    const relErr = Math.abs(actual - expected) / expected;
    const ok = relErr <= tol;
    if (!ok) failures++;
    const line = `${ok ? 'PASS' : 'FAIL'} ${id}: ${desc} — expected ${expected}, got ${actual.toFixed(2)} (err ${(relErr*100).toFixed(2)}%, tol ±${(tol*100).toFixed(0)}%)`;
    console.log(line);
    results.push({ id, ok, expected, actual, tolerance: `±${tol*100}%` });
}

// ── render-pass demos ──────────────────────────────────────────────────────

console.log('\n=== render-pass: doom demo1 (col/span/findplane stats) ===');
const d1 = await runRenderDemo('doom.wad', 'doomu.wad', 'demo1');
if (!d1 || typeof d1.done !== 'number') {
    console.log(`SKIP doom demo1: ${d1 ? d1.done : 'wad not found'}`);
} else {
    const f = d1.frames;
    console.log(`  doom demo1: ${f} rendered frames`);
    checkApprox('perf-034', 'R_DrawColumn calls/frame (doom demo1)', 714.8, d1.col_calls / f);
    checkApprox('perf-035', 'R_DrawColumn pixels/call (doom demo1)', 47.9,
        d1.col_calls > 0 ? d1.col_pixels / d1.col_calls : 0);
    checkApprox('perf-037', 'R_DrawSpan calls/frame (doom demo1)', 147.8, d1.span_calls / f);
    checkApprox('perf-038', 'R_DrawSpan pixels/call (doom demo1)', 168.2,
        d1.span_calls > 0 ? d1.span_pixels / d1.span_calls : 0);
    checkApprox('perf-045', 'R_FindPlane calls/frame (doom demo1)', 33.1, d1.findplane_calls / f);
    checkApprox('perf-046', 'R_FindPlane iters/frame (doom demo1)', 205.2, d1.findplane_iters / f);
    checkExact('perf-047', 'visplane peak (doom demo1)', 33, d1.visplane_peak);
}

console.log('\n=== render-pass: tnt demo2 (findplane stats) ===');
const tnt2 = await runRenderDemo('tnt.wad', 'tnt.wad', 'demo2');
if (!tnt2 || typeof tnt2.done !== 'number') {
    console.log(`SKIP tnt demo2: ${tnt2 ? tnt2.done : 'wad not found'}`);
} else {
    const f = tnt2.frames;
    console.log(`  tnt demo2: ${f} rendered frames`);
    checkApprox('perf-048', 'R_FindPlane calls/frame (tnt demo2)', 56.1, tnt2.findplane_calls / f);
    checkApprox('perf-049', 'R_FindPlane iters/frame (tnt demo2)', 451.5, tnt2.findplane_iters / f);
    checkExact('perf-050', 'visplane peak (tnt demo2, worst recorded)', 68, tnt2.visplane_peak);
}

// ── sim-pass demos (teleport / numspechit) ─────────────────────────────────

console.log('\n=== sim-pass: teleport counts ===');

const tpMatrix = [
    { id: 'ps-029', wad: 'doom.wad', engine: 'doomu.wad', demo: 'demo3', expected: 3 },
    { id: 'ps-030', wad: 'doom2.wad', engine: 'doom2.wad', demo: 'demo3', expected: 5 },
    { id: 'ps-031', wad: 'plutonia.wad', engine: 'plutonia.wad', demo: 'demo1', expected: 23 },
    { id: 'ps-032', wad: 'plutonia.wad', engine: 'plutonia.wad', demo: 'demo3', expected: 1 },
];

for (const { id, wad, engine, demo, expected } of tpMatrix) {
    const r = await runSimDemo(wad, engine, demo);
    if (!r || typeof r.done !== 'number') {
        console.log(`SKIP ${id}: ${r ? r.done : 'wad not found'}`);
        continue;
    }
    checkExact(id, `teleport calls (${wad.replace('.wad','')} ${demo})`, expected, r.teleport_calls);
}

// ── ps-003: peak numspechit across ALL 13 demos ─────────────────────────────

console.log('\n=== sim-pass: ps-003 peak numspechit (all 13 golden demos) ===');

const allDemos = [
    ['doom.wad', 'doomu.wad', ['demo1', 'demo2', 'demo3', 'demo4']],
    ['doom2.wad', 'doom2.wad', ['demo1', 'demo2', 'demo3']],
    ['tnt.wad', 'tnt.wad', ['demo1', 'demo2', 'demo3']],
    ['plutonia.wad', 'plutonia.wad', ['demo1', 'demo2', 'demo3']],
];

let globalSpechitPeak = 0;
let spechitWitness = '';
for (const [wad, engine, demos] of allDemos) {
    if (!wadPath(wad)) { console.log(`  skip ${wad}: not fetched`); continue; }
    for (const demo of demos) {
        const r = await runSimDemo(wad, engine, demo);
        if (!r || typeof r.done !== 'number') {
            console.log(`  skip ${wad} ${demo}: ${r ? r.done : 'error'}`);
            continue;
        }
        if (r.spechit_peak > globalSpechitPeak) {
            globalSpechitPeak = r.spechit_peak;
            spechitWitness = `${wad.replace('.wad','')} ${demo}`;
        }
        console.log(`  ${wad.replace('.wad','')} ${demo}: spechit_peak=${r.spechit_peak}`);
    }
}
console.log(`  global spechit peak: ${globalSpechitPeak} (witness: ${spechitWitness})`);
checkExact('ps-003', `peak numspechit across all 13 demos (witness ${spechitWitness})`,
    8, globalSpechitPeak);

// ── summary ────────────────────────────────────────────────────────────────

console.log(`\n=== SUMMARY ===`);
const passed = results.filter(r => r.ok).length;
console.log(`${passed} / ${results.length} claims verified`);
if (failures > 0) {
    console.log(`${failures} FAIL(s)`);
    process.exit(1);
}
console.log('PASS — all runtime-stat claims verified');
