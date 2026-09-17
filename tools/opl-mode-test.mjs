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

// ── Gates 4-6: build/synth.wasm is the SAME synth (ledger NC6) ───────────
//
// The worklet-side synth is a second wasm built from the same mus_opl.o and
// opl3.o the engine links (engine/Makefile $(SYNTH)), with engine/web/
// synth_main.c supplying the four W_* symbols load_bank() needs.  These gates
// prove the two produce the same samples.
//
// AND THEY PLAY REAL MUSIC, which gates 2 and 3 above do not.  Those render
// straight after callMain -- and the engine registers the title song on the
// FIRST web_frame(), not during D_DoomMain, so at that point the sequencer is
// stopped: `web_music_debug` reads playing=0, events=0, noteons=0.  What
// opl2-ref.f32 pins is the OPL core's reset/init/render path (90,203 non-zero
// samples at max amplitude 0.0005 -- real, deterministic, and quiet), not the
// MUS sequencer, not GENMIDI instruments, not note handling.  Worth keeping as
// the chip-level anchor; worth knowing it is not more than that.  One frame is
// enough to start D_INTRO, so these gates take it.
const SYNTH_WASM = join(root, 'build/synth.wasm');
if (!existsSync(SYNTH_WASM)) {
    console.error('FAIL: build/synth.wasm missing — run: source tools/emsdk-env.sh && make -C engine');
    process.exit(1);
}

// The engine, one frame in, with the title song playing.
async function engineWithMusic (oplMode) {
    const { d, p } = await bootInstance(oplMode);   // boot + set mode + music_init
    d._web_set_singletics(1);
    d._web_wipe_skip();
    d._web_frame();                                 // D_INTRO is registered here
    const stp = d._malloc(7 * 4);
    d._web_music_state(stp);
    const st = Array.from(new Int32Array(d.HEAP32.buffer, stp, 7));
    if (!st[0] || !st[2]) {
        console.error(`FAIL: no music state after one frame (genmidi=${st[0]} song=${st[2]}) — nothing would be compared`);
        process.exit(1);
    }
    const genmidi = Buffer.from(d.HEAPU8.slice(st[0], st[0] + st[1]));
    const song    = Buffer.from(d.HEAPU8.slice(st[2], st[2] + st[3]));
    d._web_music_init(44100);                       // the arm-time re-init
    const sc = d._malloc(SZ);
    d._web_music_render(sc, NFRAMES);
    const out = Buffer.from(d.HEAPU8.buffer, sc, SZ);
    const copy = Buffer.from(out);                  // before the instance dies
    const noteons = d._web_music_debug(2);
    d._free(sc); d._free(p);
    return { buf: copy, genmidi, song, looping: st[4], paused: st[5], vol: st[6], noteons };
}

// The standalone module, brought to the same state through synth_boot.
async function standalone (oplMode, ref) {
    const { instance } = await WebAssembly.instantiate(readFileSync(SYNTH_WASM), {});
    const x = instance.exports;
    x._initialize();
    const put = buf => { const ptr = x.malloc(buf.length); if (!ptr) throw new Error('synth.wasm malloc failed');
                         new Uint8Array(x.memory.buffer).set(buf, ptr); return ptr; };
    x.synth_boot(44100, put(ref.genmidi), ref.genmidi.length,
                 put(ref.song), ref.song.length, ref.looping, ref.paused, ref.vol, oplMode);
    const sc = x.malloc(SZ);
    x.web_music_render(sc, NFRAMES);
    return { buf: Buffer.from(new Uint8Array(x.memory.buffer, sc, SZ)), noteons: x.web_music_debug(2) };
}

// Gate 4: the module asks the host for nothing.  A new import would mean the
// worklet must supply it, and the worklet has no host to supply it from -- so
// this fails here rather than as silence in a browser.
{
    const imports = WebAssembly.Module.imports(new WebAssembly.Module(readFileSync(SYNTH_WASM)));
    if (imports.length) {
        console.error(`FAIL: build/synth.wasm imports ${imports.length} symbol(s): ` +
                      imports.map(i => `${i.module}.${i.name}`).join(', '));
        process.exit(1);
    }
    console.log(`gate 4 PASS: synth.wasm is self-contained (0 imports, ${readFileSync(SYNTH_WASM).length} bytes)`);
}

// Gates 5 and 6: byte-identical on real music, both modes.
for (const [mode, name] of [[0, 'OPL2'], [1, 'OPL3']]) {
    const eng = await engineWithMusic(mode);
    const syn = await standalone(mode, eng);
    if (!eng.noteons || !syn.noteons) {
        console.error(`FAIL: ${name} rendered ${eng.noteons}/${syn.noteons} note-ons — the sequencer never ran, ` +
                      'so byte-equality here would compare two silences');
        process.exit(1);
    }
    if (!eng.buf.equals(syn.buf)) {
        let i = 0; while (i < SZ && eng.buf[i] === syn.buf[i]) i++;
        console.error(`FAIL: ${name} standalone synth differs from the engine at byte ${i} of ${SZ}`);
        process.exit(1);
    }
    console.log(`gate ${mode === 0 ? 5 : 6} PASS: ${name} synth.wasm byte-identical to the engine over ` +
                `${NFRAMES} frames of ${eng.song.length}-byte D_INTRO (${eng.noteons} note-ons, vol ${eng.vol})`);
}

console.log('PASS: OPL2/OPL3 mode toggle verified; synth.wasm identical on real music');
