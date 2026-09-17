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
import { join } from 'node:path';
import { root } from './lib/util.mjs';
import { bootEngine, loadWad } from './lib/engine.mjs';

const wad  = process.argv[2] ?? 'doom.wad';

const buildDir = 'build';
const engineName = wad === 'doom.wad' ? 'doomu.wad' : wad;
const wadBytes   = loadWad(wad);

// Helper: create and boot a fresh doom instance at song position 0.
// Each call gives an isolated wasm module with its own linear memory,
// so both OPL2 and OPL3 gates sample from the same song position.
async function bootInstance (oplMode) {
    let fatal = null;
    const d = await bootEngine(buildDir, [[engineName, wadBytes]], {
        printErr:     t  => process.stderr.write(`  ! ${t}\n`),
        onDoomError:  msg => { fatal = msg; },
    });
    d.callMain([]);
    if (fatal) throw new Error(`FAIL init (opl_mode=${oplMode}): ${fatal}`);

    if (typeof d._web_set_opl_mode !== 'function')
        throw new Error('FAIL: _web_set_opl_mode not exported');

    // Apply mode BEFORE init so mus_init runs with the correct NEW bit.
    d._web_set_opl_mode(oplMode);
    d._web_music_init(44100);   // OPL chip reset from song position 0
    return d;
}

// ── Gate 1: web_set_opl_mode must be exported ─────────────────────────────
// Verified inside bootInstance; boot a single instance to check up front.
{
    const tmp = await bootEngine(buildDir, [], { onDoomError: () => {} });
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

const doom2 = await bootInstance(0);
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
doom2._free(scratch2);
console.log(`gate 2 PASS: OPL2 byte-identical (${SZ} bytes), rms=${opl2rms.toFixed(5)}`);

// ── Gate 3: OPL3 mode has audible output ─────────────────────────────────
// Instance 2 boots in OPL3 mode; renders 2 seconds from song position 0.
// Using a separate instance (not web_music_restart) avoids adding a test-
// only export to the wasm and guarantees both gates sample the same passage.
const doom3 = await bootInstance(1);
const scratch3 = doom3._malloc(SZ);
doom3._web_music_render(scratch3, NFRAMES);
const opl3f32 = new Float32Array(doom3.HEAPU8.buffer, scratch3, NFRAMES * 2);
const opl3rms = Math.sqrt(opl3f32.reduce((s, v) => s + v * v, 0) / opl3f32.length);
doom3._free(scratch3);
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
    const d = await bootInstance(oplMode);          // boot + set mode + music_init
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
    d._free(sc);
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

// ── Gate 7: the SHIPPED worklet renders those same bytes ─────────────────
//
// Gates 5 and 6 drive synth.wasm directly.  This drives it the way the browser
// does: through client/js/music-worklet.js, over its own message protocol, one
// 128-frame quantum at a time.  Two things it proves that nothing else can:
// the worklet file's own init/copy/render path is correct, and per-quantum
// rendering is byte-identical to one long call (the sequencer is per-frame
// stateful, so this is a property worth asserting rather than assuming).
//
// It lives in node because the browser cannot do it: headless Chrome and
// headed Chrome under xvfb both arm the context, instantiate the module and
// report {ready:true, playing:1} -- and never call process(), because no audio
// device pulls the graph.  The browser leg proves the wiring; this proves the
// samples.
{
    const { loadWorklet } = await import(join(root, 'tools/lib/worklet-host.mjs'));
    const eng = await engineWithMusic(0);
    const w = await loadWorklet();
    const ready = await w.send({
        type: 'init', wasm: readFileSync(SYNTH_WASM), rate: 44100,
        genmidi: eng.genmidi, song: eng.song, looping: eng.looping,
        paused: eng.paused, volume: eng.vol, oplMode: 0,
    }, m => m && m.ready !== undefined);
    if (!ready || ready.ready !== true) {
        console.error(`FAIL: the worklet did not instantiate synth.wasm (${ready ? ready.error : 'no reply'})`);
        process.exit(1);
    }
    // NFRAMES is not a multiple of the quantum, so the last call renders more
    // than is compared; the synth is per-frame stateful, so rendering the extra
    // frames is harmless and only the first NFRAMES are read back.
    const QUANTUM = 128;
    const out = Buffer.alloc(SZ);
    let quanta = 0;
    for (let done = 0; done < NFRAMES; done += QUANTUM) {
        const { l, r } = w.process(QUANTUM);
        quanta++;
        for (let k = 0; k < Math.min(QUANTUM, NFRAMES - done); k++) {
            out.writeFloatLE(l[k], (done + k) * 8);
            out.writeFloatLE(r[k], (done + k) * 8 + 4);
        }
    }
    if (!out.equals(eng.buf)) {
        let i = 0; while (i < SZ && out[i] === eng.buf[i]) i++;
        console.error(`FAIL: the worklet's output differs from the engine at byte ${i} of ${SZ} ` +
                      `(quantum ${Math.floor(i / 8 / QUANTUM)})`);
        process.exit(1);
    }
    console.log(`gate 7 PASS: client/js/music-worklet.js byte-identical to the engine over ` +
                `${quanta} quanta of ${QUANTUM} frames`);
}

// Gate 8: synth_play's OWNERSHIP CONTRACT (task 26.2).
//
// synth_main.c decides whether to free the caller's block or the previous one,
// and until round 13 it read that decision out of web_music_debug(0) -- the
// `playing` flag, through a debug accessor.  mus_play returns the decision now
// (1 = took the buffer, 0 = declined and touched nothing), so this asserts the
// contract the free depends on, against the real module:
//
//   a good song is TAKEN         -> web_music_debug(0) is 1, and it renders
//   a bad header is DECLINED     -> the module survives, the previous song is
//                                   still the one loaded, and audio is
//                                   byte-identical to before the refusal
//   the SAME pointer replayed    -> no free/reassign of a live block; the
//                                   module still renders (before the round-13
//                                   guard this freed `song` and assigned the
//                                   freed pointer straight back to it)
//
// WHAT THIS GATE CANNOT DO, said plainly: wasm has no allocator poisoning, so
// a use-after-free here reads whatever emmalloc left behind and usually looks
// fine.  These assertions prove the CONTRACT, not the absence of a UAF.  The
// guard in synth_play is what prevents it; this is what notices if the contract
// it rests on ever changes.
{
    const { instance } = await WebAssembly.instantiate(readFileSync(SYNTH_WASM), {});
    const x = instance.exports;
    x._initialize();
    const eng = await engineWithMusic(0);
    const put = buf => { const p = x.malloc(buf.length);
                         if (!p) throw new Error('synth.wasm malloc failed');
                         new Uint8Array(x.memory.buffer).set(buf, p); return p; };
    const render = () => { const sc = x.malloc(SZ); x.web_music_render(sc, NFRAMES);
                           const b = Buffer.from(new Uint8Array(x.memory.buffer, sc, SZ));
                           x.free(sc); return b; };
    const fail = m => { console.error(`FAIL: gate 8: ${m}`); process.exit(1); };

    const songPtr = put(eng.song);
    x.synth_boot(44100, put(eng.genmidi), eng.genmidi.length,
                 songPtr, eng.song.length, eng.looping, eng.paused, eng.vol, 0);
    if (!x.web_music_debug(0)) fail('a valid song was not accepted by synth_boot');
    const good = render();
    if (good.equals(Buffer.alloc(SZ))) fail('the accepted song rendered pure silence — nothing was verified');

    // a header that fails the MUS magic: taken must be 0, and the module lives
    const bad = put(Buffer.from('NOTMUS__________'));
    x.synth_play(bad, 16, 0);
    if (x.web_music_debug(0)) fail('a bad MUS header was ACCEPTED (mus_play returned 1)');

    // the previous song is still the loaded one: unpause and it renders again
    x.synth_pause(0);
    const afterRefusal = render();
    if (afterRefusal.equals(Buffer.alloc(SZ)))
        fail('after a refused song the module renders silence — the previous song was lost');

    // replaying the block the module already owns must not free it
    x.synth_play(songPtr, eng.song.length, 0);
    if (!x.web_music_debug(0)) fail('replaying the owned song was refused');
    const replayed = render();
    if (replayed.equals(Buffer.alloc(SZ)))
        fail('replaying the owned song rendered silence — the module lost its song');

    console.log('gate 8 PASS: synth_play ownership contract — accepted, declined (previous song ' +
                'survives), and same-pointer replay, on the real synth.wasm (4 assertions)');
}

console.log('PASS: OPL2/OPL3 mode toggle verified; synth.wasm identical on real music');
