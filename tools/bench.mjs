#!/usr/bin/env node
// Portable render+sim throughput benchmark. Runs the IWAD attract demos
// headless through the full software renderer (FixedMul/FixedDiv-heavy
// inner loops) and reports frames/sec — the real-world measure of the
// fixed-point hot path. Self-contained: needs doom.js, doom.wasm, and a
// wad in the same dir. usage: node bench.mjs [wad=doom.wad] [reps=5]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const wad = process.argv[2] ?? 'doom.wad';
const reps = Number(process.argv[3] ?? 5);
const engineName = wad === 'doom.wad' ? 'doomu.wad' : wad;

const createDoom = (await import(join(here, 'doom.js'))).default;
const wadBytes = readFileSync(join(here, wad));

// each demo, run `reps` times; keep the best (least-noisy) fps per demo
const DEMOS = ['demo1', 'demo2', 'demo3'];
const results = {};

for (const demo of DEMOS) {
    let best = 0, ticsRun = 0;
    for (let r = 0; r < reps; r++) {
        let done = null;
        const doom = await createDoom({
            print: () => {},
            printErr: t => { const m = /timed (\d+) gametics/.exec(t); if (m) done = +m[1]; },
        });
        const p = doom._malloc(wadBytes.length);
        doom.HEAPU8.set(wadBytes, p);
        doom.ccall('web_register_file', null, ['string', 'number', 'number'],
            [engineName, p, wadBytes.length]);
        doom.callMain(['-timedemo', demo, '-nodraw']);

        // ride out the screen wipe (not representative of steady-state)
        for (let i = 0; i < 40; i++) doom._web_frame();
        const start = doom._web_gametic();
        const t0 = performance.now();
        // the timedemo end raises I_Error("timed N gametics") which aborts
        // the wasm — `done` is already set from printErr; swallow the throw
        try {
            for (let i = 0; i < 300000 && done === null; i++) doom._web_frame();
        } catch { /* timedemo finished */ }
        const ms = performance.now() - t0;
        const tics = (done ?? doom._web_gametic()) - start;
        const fps = tics / ms * 1000;
        if (fps > best) { best = fps; ticsRun = tics; }
    }
    results[demo] = best;
    console.log(`  ${demo}: ${best.toFixed(0)} fps (${ticsRun} tics, best of ${reps})`);
}

const avg = Object.values(results).reduce((a, b) => a + b, 0) / DEMOS.length;
console.log(`AVG ${avg.toFixed(0)} fps  [${Object.values(results).map(f => f.toFixed(0)).join(' ')}]`);
