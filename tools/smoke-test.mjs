#!/usr/bin/env node
// Headless engine smoke test: boot the wasm with a real IWAD, run the
// title-demo loop for N frames, and prove the framebuffer is alive.
// This grows into the determinism CI (demo playback + gamestate checksums).
// usage: node tools/smoke-test.mjs [wad] [frames]
import { createHash } from 'node:crypto';
import { bootEngine, loadWad } from './lib/engine.mjs';

const wad = process.argv[2] ?? 'doom.wad';
const frames = Number(process.argv[3] ?? 175);   // 5 seconds of demo

// The engine detects Ultimate Doom by the doomu.wad filename.
const engineName = wad === 'doom.wad' ? 'doomu.wad' : wad;

let fatal = null;
const doom = await bootEngine('build', [[engineName, loadWad(wad)]], {
    print: t => process.stdout.write(`  | ${t}\n`),
    printErr: t => process.stderr.write(`  ! ${t}\n`),
    onDoomError: msg => { fatal = msg; },
});

doom.callMain([]);
if (fatal) { console.error(`FAIL: I_Error during init: ${fatal}`); process.exit(1); }

const fb = doom._web_framebuffer();
if (!fb) { console.error('FAIL: no framebuffer'); process.exit(1); }

const hashes = new Set();
const start = performance.now();
for (let i = 0; i < frames; i++) {
    // 35Hz tics from real time: pace frames like a 70fps display.
    const target = start + i * (1000 / 70);
    while (performance.now() < target) {}
    doom._web_frame();
    if (fatal) { console.error(`FAIL: I_Error at frame ${i}: ${fatal}`); process.exit(1); }
    hashes.add(createHash('sha1')
        .update(doom.HEAPU8.subarray(fb, fb + 320 * 200)).digest('hex'));
}

const px = doom.HEAPU8.subarray(fb, fb + 320 * 200);
// `nonzero` is a LIVENESS SIGNAL, not a measurement, and the headline prints it
// only so a reader can see the gate looked at something.  It wobbles by a pixel
// or two between identical runs -- 63,463 / 63,463 / 63,464 over three runs of
// `doom.wad 700` -- because the loop below is wall-clock paced, so the last
// frame lands at a slightly different point in the attract loop each time.  The
// assertion is the threshold at :56 and is nowhere near that noise.  Do not
// quote this number as a figure or pin it in a golden; the per-tic framebuffer
// hashes in `render-goldens` are the deterministic instrument.
const nonzero = px.reduce((n, v) => n + (v !== 0), 0);
console.log(`frames rendered: ${frames}, distinct: ${hashes.size}, nonzero px: ${nonzero}/64000`);

// music: the title screen starts mus_intro on boot; render 2s of OPL
// output and require audible signal.
doom._web_music_init(44100);
const nMusic = 44100 * 8;   // some tracks (Suspense) open nearly silent
const scratch = doom._malloc(4 * 2 * nMusic);
doom._web_music_render(scratch, nMusic);
const f32 = new Float32Array(doom.HEAPU8.buffer, scratch, nMusic * 2);
const rms = Math.sqrt(f32.reduce((s, v) => s + v * v, 0) / f32.length);
const peak = f32.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
console.log(`music: rms=${rms.toFixed(5)} peak=${peak.toFixed(4)}`);

if (hashes.size < 10) { console.error('FAIL: framebuffer barely changes — demo not running'); process.exit(1); }
if (nonzero < 10000)  { console.error('FAIL: framebuffer mostly empty'); process.exit(1); }
if (rms < 0.0005)      { console.error('FAIL: OPL music silent'); process.exit(1); }
// Bare `PASS` was this leg's whole headline in the summary table.  Say what was
// observed: the three numbers the three assertions above are made of.
console.log(`PASS — engine smoke: ${hashes.size} distinct framebuffers, ${nonzero} non-black pixels, ` +
            `OPL rms ${rms.toFixed(5)} (3 assertions)`);
