#!/usr/bin/env node
// sprite-witness-test.mjs — r_things.c:530 cull-pin witness golden.
//
// PURPOSE
//   Proves that the r_things.c:530 wide-angle sprite cull condition
//   (abs(tx) > tz<<2) is exercised and pinned by the golden system.
//   In wide mode (854 px) the horizontal FOV expands so sprites at
//   tx/tz ≈ 2–4 appear on screen; those same sprites are off-screen
//   in narrow (320 px) mode.
//
//   Using doom-demo3 as witness: at tic 1 the wide render already
//   includes sprites near the cull boundary that are absent from the
//   narrow render.  With the cull changed to tz<<1 (stricter), the
//   wide golden diverges at tic 1 — proving the pin is load-bearing.
//
// RED-PROOF (offline, not CI)
//   1. Change engine/core/r_things.c line 530:
//        from: if (abs(tx)>(tz<<2))
//        to:   if (abs(tx)>(tz<<1))
//   2. Rebuild: cd engine && make -j8
//   3. Run: node tools/sprite-witness-test.mjs
//   Expected: FAIL sprite-witness-wide at tic 1 (sprite culled by stricter cull)
//   Revert after red-proof.
//
// GOLDENS
//   tools/golden/sprite-witness-narrow.json — first WITNESS_TICS tics at 320 px
//   tools/golden/sprite-witness-wide.json   — first WITNESS_TICS tics at 854 px
//
// usage:
//   node tools/sprite-witness-test.mjs          # verify
//   node tools/sprite-witness-test.mjs --record # record / re-record
//
// Copyright (C) 2026, GPL-2.0-or-later.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const record = process.argv.includes('--record');
const goldenDir = join(root, 'tools/golden');
mkdirSync(goldenDir, { recursive: true });

const createDoom = (await import(join(root, 'build', 'doom.js'))).default;

// Witness demo: doom-demo3 (doom.wad, demo3).
// Chosen because: wide render diverges at tic 1 when cull is tightened to tz<<1.
// 320 render is unaffected (sprites at tx/tz 2–4 are off-screen anyway).
const WAD_FILE   = 'doom.wad';
const ENGINE_WAD = 'doomu.wad';
const DEMO       = 'demo3';

// Run this many tics (far fewer than the full demo — just enough to capture
// the witness sprite at tic 1 in wide mode with a fast wall-clock).
const WITNESS_TICS = 100;

const WIDE_WIDTH = 854;

const wadPath = join(root, 'wads/lib', WAD_FILE);
if (!existsSync(wadPath)) {
    console.log(`SKIP sprite-witness: ${WAD_FILE} not fetched`);
    process.exit(0);
}
const wadBytes = readFileSync(wadPath);

// FNV-1a 32-bit hash of the framebuffer (same as demo-test.mjs render mode).
function fnv1a(heapu8, fbPtr, palVer, w) {
    let h = 0x811c9dc5;
    const end = fbPtr + w * 200;
    for (let i = fbPtr; i < end; i++) {
        h = Math.imul(h ^ heapu8[i], 0x01000193);
    }
    h = Math.imul(h ^ ( palVer        & 0xff), 0x01000193);
    h = Math.imul(h ^ ((palVer >>> 8)  & 0xff), 0x01000193);
    h = Math.imul(h ^ ((palVer >>> 16) & 0xff), 0x01000193);
    h = Math.imul(h ^ ((palVer >>> 24) & 0xff), 0x01000193);
    return h >>> 0;
}

// Run the demo, collect hashes for the first WITNESS_TICS tics, stop early.
async function runWitness(wideWidth) {
    const doom = await createDoom({
        print: () => {},
        printErr: () => {},
        onDoomError: () => {},
    });
    const p = doom._malloc(wadBytes.length);
    doom.HEAPU8.set(wadBytes, p);
    doom.ccall('web_register_file', null, ['string', 'number', 'number'],
        [ENGINE_WAD, p, wadBytes.length]);

    const trace = [];
    try {
        doom.callMain(['-timedemo', DEMO]);
        doom._web_set_smooth(0);
        if (wideWidth) doom._web_set_wide(wideWidth);
        const actualW = wideWidth || 320;
        const fbPtr = doom._web_framebuffer();
        let lastTic = -1;
        for (let i = 0; i < 500000 && trace.length < WITNESS_TICS; i++) {
            doom._web_wipe_skip();
            doom._web_frame();
            const tic = doom._web_gametic();
            if (tic !== lastTic) {
                trace.push(fnv1a(doom.HEAPU8, fbPtr,
                    doom._web_palette_version(), actualW));
                lastTic = tic;
            }
        }
    } catch (_) {
        // timedemo I_Error; we may or may not have enough tics
    }
    return trace;
}

let failures = 0;

for (const [label, wideWidth, goldenFile] of [
    ['sprite-witness-narrow', 0,         'sprite-witness-narrow.json'],
    ['sprite-witness-wide',   WIDE_WIDTH, 'sprite-witness-wide.json'],
]) {
    const trace = await runWitness(wideWidth);
    const goldenPath = join(goldenDir, goldenFile);

    if (record || !existsSync(goldenPath)) {
        writeFileSync(goldenPath, JSON.stringify({ tics: WITNESS_TICS, trace, width: wideWidth || 320 }));
        console.log(`recorded ${label}: ${trace.length} hashes, W=${wideWidth || 320}`);
        continue;
    }

    const golden = JSON.parse(readFileSync(goldenPath));
    if (trace.length < golden.trace.length) {
        console.log(`FAIL ${label}: only ${trace.length} tics collected, need ${golden.trace.length}`);
        failures++;
        continue;
    }

    let diverged = -1;
    for (let i = 0; i < golden.trace.length; i++) {
        if (golden.trace[i] !== trace[i]) { diverged = i; break; }
    }

    if (diverged >= 0) {
        console.log(`FAIL ${label}: DESYNC at tic ${diverged} of ${golden.trace.length}` +
            (label.includes('wide')
                ? ' — check r_things.c:530 cull constant (tz<<2 expected)'
                : ''));
        failures++;
    } else {
        console.log(`PASS ${label}: ${golden.trace.length} hashes pixel-identical, W=${golden.width}`);
    }
}

if (failures) {
    console.log(`${failures} sprite-witness check(s) FAILED`);
    process.exit(1);
}
console.log('PASS — sprite-edge witness goldens verified (r_things.c:530 cull pin)');
