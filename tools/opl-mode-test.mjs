#!/usr/bin/env node
// OPL2/OPL3 mode toggle test (task 17.1).
//
// Three gates:
//  1. web_set_opl_mode export exists     (Red until implementation)
//  2. OPL2 mode output byte-identical to tools/golden/opl2-ref.f32
//  3. OPL3 mode produces audible output  (RMS >= 50% of OPL2 RMS)
//
// Two separate doom instances are created so that both gates sample from
// song position 0 (immediately after callMain) — no sequencer-reset export
// is needed, and the comparison is apples-to-apples.
//
// ── How to re-capture tools/golden/opl2-ref.f32 ─────────────────────────
// The reference MUST be captured from a build that predates any 17.1
// changes — a self-rebuild comparison would silently encode regressions.
//
//   git stash is NOT sufficient — Makefile artefacts survive a stash.
//
//   1. In the main checkout (not this worktree), switch to the commit
//      immediately before the 17.1 branch point:
//        git checkout 652d212   # harness/worker start base
//   2. Build: source tools/emsdk-env.sh && make -C engine
//   3. Capture 2 seconds of OPL2 audio from song position 0:
//        node -e "
//          (async () => {
//            const m = await import('./build/doom.js');
//            const doom = await m.default({ print:()=>{} });
//            const wad = (await import('fs')).readFileSync('wads/lib/doom.wad');
//            const p = doom._malloc(wad.length);
//            doom.HEAPU8.set(wad, p);
//            doom.ccall('web_register_file','',['string','number','number'],
//              ['doomu.wad',p,wad.length]);
//            doom.callMain([]);
//            doom._web_music_init(44100);
//            const NFRAMES = 44100*2;
//            const SZ = 4*2*NFRAMES;
//            const buf = doom._malloc(SZ);
//            doom._web_music_render(buf, NFRAMES);
//            const out = Buffer.from(doom.HEAPU8.buffer, buf, SZ);
//            (await import('fs')).writeFileSync('tools/golden/opl2-ref.f32', out);
//            console.log('captured', SZ, 'bytes');
//          })();
//        "
//   4. git checkout - to restore your working branch.
// ─────────────────────────────────────────────────────────────────────────
//
// Usage: node tools/opl-mode-test.mjs [wad]
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const wad  = process.argv[2] ?? 'doom.wad';

const createDoom = (await import(join(root, 'build/doom.js'))).default;
const engineName = wad === 'doom.wad' ? 'doomu.wad' : wad;
const wadBytes   = readFileSync(join(root, 'wads/lib', wad));

// Helper: create and boot a fresh doom instance at song position 0.
// Each call gives an isolated wasm module with its own linear memory,
// so both OPL2 and OPL3 gates sample from the same song position.
async function bootInstance (oplMode) {
    let fatal = null;
    const d = await createDoom({
        print:        () => {},
        printErr:     t  => process.stderr.write(`  ! ${t}\n`),
        onDoomError:  msg => { fatal = msg; },
    });
    const p = d._malloc(wadBytes.length);
    d.HEAPU8.set(wadBytes, p);
    d.ccall('web_register_file', null, ['string', 'number', 'number'],
            [engineName, p, wadBytes.length]);
    d.callMain([]);
    if (fatal) throw new Error(`FAIL init (opl_mode=${oplMode}): ${fatal}`);

    if (typeof d._web_set_opl_mode !== 'function')
        throw new Error('FAIL: _web_set_opl_mode not exported');

    // Apply mode BEFORE init so mus_init runs with the correct NEW bit.
    d._web_set_opl_mode(oplMode);
    d._web_music_init(44100);   // OPL chip reset from song position 0
    return { d, p };
}

// ── Gate 1: web_set_opl_mode must be exported ─────────────────────────────
// Verified inside bootInstance; boot a single instance to check up front.
{
    const tmp = await createDoom({ print:()=>{}, printErr:()=>{}, onDoomError:()=>{} });
    if (typeof tmp._web_set_opl_mode !== 'function') {
        console.error('FAIL: _web_set_opl_mode not exported (implementation missing)');
        process.exit(1);
    }
    console.log('gate 1 PASS: _web_set_opl_mode exported');
}

const NFRAMES = 44100 * 2;            // 2 seconds at song position 0
const SZ      = 4 * 2 * NFRAMES;      // bytes: f32 × 2ch × frames

// ── Gate 2: OPL2 mode byte-identical to pre-change reference ─────────────
// Instance 1 boots in OPL2 mode; renders 2 seconds from song position 0.
const refPath = join(root, 'tools/golden/opl2-ref.f32');
if (!existsSync(refPath)) {
    console.error('FAIL: reference file missing — see capture instructions at top of this file');
    process.exit(1);
}
const refBuf = readFileSync(refPath);

const { d: doom2, p: p2 } = await bootInstance(0);
const scratch2 = doom2._malloc(SZ);
doom2._web_music_render(scratch2, NFRAMES);
const opl2Buf = Buffer.from(doom2.HEAPU8.buffer, scratch2, SZ);

if (!opl2Buf.equals(refBuf)) {
    let diffIdx = -1;
    for (let i = 0; i < SZ; i++) {
        if (opl2Buf[i] !== refBuf[i]) { diffIdx = i; break; }
    }
    console.error(`FAIL: OPL2 output differs from reference at byte ${diffIdx}`);
    process.exit(1);
}

const opl2f32 = new Float32Array(doom2.HEAPU8.buffer, scratch2, NFRAMES * 2);
const opl2rms = Math.sqrt(opl2f32.reduce((s, v) => s + v * v, 0) / opl2f32.length);
doom2._free(scratch2); doom2._free(p2);
console.log(`gate 2 PASS: OPL2 byte-identical (${SZ} bytes), rms=${opl2rms.toFixed(5)}`);

// ── Gate 3: OPL3 mode has audible output ─────────────────────────────────
// Instance 2 boots in OPL3 mode; renders 2 seconds from song position 0.
// Using a separate instance (not web_music_restart) avoids adding a test-
// only export to the wasm and guarantees both gates sample the same passage.
const { d: doom3, p: p3 } = await bootInstance(1);
const scratch3 = doom3._malloc(SZ);
doom3._web_music_render(scratch3, NFRAMES);
const opl3f32 = new Float32Array(doom3.HEAPU8.buffer, scratch3, NFRAMES * 2);
const opl3rms = Math.sqrt(opl3f32.reduce((s, v) => s + v * v, 0) / opl3f32.length);
doom3._free(scratch3); doom3._free(p3);
console.log(`gate 3: opl2_rms=${opl2rms.toFixed(5)}, opl3_rms=${opl3rms.toFixed(5)}`);

// Threshold: OPL3 at song position 0 must produce at least 50% of OPL2 RMS.
// Both instances render the same passage, so a 50% floor is meaningful:
// any large divergence indicates a broken OPL3 render path.
// Hard lower-bound of 0.0001 guards against a zero-rms OPL2 reference
// silently greening the gate.
const threshold = Math.max(opl2rms * 0.5, 0.0001);
if (opl3rms < threshold) {
    console.error(`FAIL: OPL3 rms=${opl3rms.toFixed(5)} below threshold=${threshold.toFixed(5)} (50% of opl2_rms or 0.0001)`);
    process.exit(1);
}
console.log(`gate 3 PASS: OPL3 audible, rms=${opl3rms.toFixed(5)} >= threshold=${threshold.toFixed(5)}`);

console.log('PASS: OPL2/OPL3 mode toggle verified');
