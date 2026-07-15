#!/usr/bin/env node
// tools/zone-measure.mjs — Z_Zone high-water-mark + heap-base audit.
// Runs each IWAD's attract demos headless, samples zone usage each tic,
// and reports peak zone usage per IWAD plus __heap_base for the headroom
// calculation.  Used once (task 0.5) to populate docs/perf.md; retained
// for future re-measurement (task 2.5 Z_Zone review, 2.6 knob sweep).
//
// Usage: node tools/zone-measure.mjs
//
// Requires build/doom.wasm with web_zone_sample / web_zone_hwm /
// web_zone_hwm_reset / web_heap_base exports (added task 0.5).
// Reads from wads/lib/ (symlink); skips missing IWADs.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const createDoom = (await import(join(root, 'build/doom.js'))).default;

// IWADs to measure — [wad-file, engine-name, demo-lumps]
const MATRIX = [
    ['doom.wad', 'doomu.wad', ['demo1', 'demo2', 'demo3', 'demo4']],
    ['doom2.wad', 'doom2.wad', ['demo1', 'demo2', 'demo3']],
    ['tnt.wad', 'tnt.wad', ['demo1', 'demo2', 'demo3']],
    ['plutonia.wad', 'plutonia.wad', ['demo1', 'demo2', 'demo3']],
];

let heapBaseOnce = null; // captured from first engine instance
const results = [];

for (const [wad, engineName, demos] of MATRIX) {
    const path = join(root, 'wads/lib', wad);
    if (!existsSync(path)) {
        console.log(`skip ${wad}: not found`);
        continue;
    }
    const wadBytes = readFileSync(path);

    let iwadHwm = 0; // peak across all demos for this IWAD

    for (const demo of demos) {
        // Fresh engine instance per demo (matches demo-test.mjs pattern).
        let done = null;
        const doom = await createDoom({
            print: () => {},
            printErr: t => {
                const m = /timed (\d+) gametics/.exec(t);
                if (m) done = +m[1];
            },
            onDoomError: msg => {
                if (!/timed \d+ gametics/.test(msg)) done = `error: ${msg}`;
            },
        });

        // Register the WAD bytes as a virtual file.
        const p = doom._malloc(wadBytes.length);
        doom.HEAPU8.set(wadBytes, p);
        doom.ccall('web_register_file', null, ['string', 'number', 'number'],
            [engineName, p, wadBytes.length]);

        // Capture __heap_base once (same across all instances).
        if (heapBaseOnce === null) heapBaseOnce = doom._web_heap_base();

        try {
            // -nodraw: skip renderer, pure sim (same as demo-test.mjs sim path).
            doom.callMain(['-timedemo', demo, '-nodraw']);
            let lastTic = -1;
            for (let i = 0; i < 200000 && done === null; i++) {
                doom._web_frame();
                // Sample zone once per unique gametic to keep measurements
                // proportional to actual engine work, not JS frame rate.
                const tic = doom._web_gametic();
                if (tic !== lastTic) {
                    doom._web_zone_sample();
                    lastTic = tic;
                }
            }
        } catch (_e) {
            // timedemo I_Error unwinds here; done is already set by printErr.
        }

        if (typeof done !== 'number') {
            console.error(`  ${wad} ${demo}: ${done ?? 'never finished'}`);
            continue;
        }

        const hwm = doom._web_zone_hwm();
        const zoneSize = doom._web_zone_size();
        const pct = ((hwm / zoneSize) * 100).toFixed(1);
        console.log(
            `  ${(wad + ' ' + demo).padEnd(22)} HWM ${(hwm / 1048576).toFixed(2)} MB` +
            ` / ${(zoneSize / 1048576).toFixed(0)} MB zone  (${pct}%)`,
        );
        if (hwm > iwadHwm) iwadHwm = hwm;
    }

    if (iwadHwm > 0) {
        results.push({ wad, hwm: iwadHwm, wadBytes: wadBytes.length });
    }
}

if (results.length === 0) {
    console.error('No IWADs measured — are wads/lib/*.wad present?');
    process.exit(1);
}

// Summary table
console.log('\n=== Zone high-water marks (per-IWAD peak across all demos) ===');
const ZONE_MB = 32;
const worst = results.reduce((a, b) => (b.hwm > a.hwm ? b : a));
for (const r of results) {
    const pct = ((r.hwm / (ZONE_MB * 1048576)) * 100).toFixed(1);
    const flag = r.wad === worst.wad ? '  ← worst' : '';
    console.log(`  ${r.wad.padEnd(14)} ${(r.hwm / 1048576).toFixed(2)} MB  (${pct}%)${flag}`);
}

// Heap headroom
if (heapBaseOnce !== null) {
    const INITIAL_MB = 64;
    const hb = heapBaseOnce;
    // Peak heap usage after engine fully loaded with the largest IWAD:
    //   heap_base   (static data + C shadow stack, measured from __heap_base)
    //   + zone      (one malloc(ZONESIZE) from I_ZoneBase in i_system.c)
    //   + wad_copy  (one malloc(wad.length) from zone-measure registration)
    // Note: the WAD copy in production is done the same way (doom._malloc in JS).
    const zoneBytes = ZONE_MB * 1048576;
    const peakAddr = hb + zoneBytes + worst.wadBytes;
    const headroom = INITIAL_MB * 1048576 - peakAddr;

    console.log('\n=== Heap headroom (INITIAL_MEMORY=64 MB, ALLOW_MEMORY_GROWTH=0) ===');
    console.log(`  __heap_base       : ${hb} B  (${(hb / 1048576).toFixed(2)} MB)`);
    console.log(`    of which stack  : 4 MB  (STACK_SIZE in engine/Makefile)`);
    console.log(`    of which static : ${((hb - 4 * 1048576) / 1024).toFixed(0)} KB  (DATA + BSS)`);
    console.log(`  Zone pool         : ${ZONE_MB} MB  (ZONESIZE in engine/web/i_system.c)`);
    console.log(`  Worst WAD malloc  : ${(worst.wadBytes / 1048576).toFixed(2)} MB  (${worst.wad})`);
    console.log(`  Peak heap address : ~${(peakAddr / 1048576).toFixed(2)} MB`);
    console.log(`  Headroom vs 64 MB : ~${(headroom / 1048576).toFixed(2)} MB`);
    console.log(`\n  Floor estimate (round up to 64 KB boundary):` +
        ` ${Math.ceil(peakAddr / 65536) * 64} KB = ` +
        `${(Math.ceil(peakAddr / 65536) / 16).toFixed(1)} MB`);
}
