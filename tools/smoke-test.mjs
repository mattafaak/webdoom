#!/usr/bin/env node
// Headless engine smoke test: boot the wasm with a real IWAD, run the
// title-demo loop for N frames, and prove the framebuffer is alive.
// This grows into the determinism CI (demo playback + gamestate checksums).
//
// callMain([]) runs the attract loop paced from the wall clock, the way a
// browser does; the demo goldens replay with -timedemo instead, so they do
// not cover this path.  Several IWADs run one after another in this process,
// each in its own engine instance, and an IWAD that fails does not stop the
// next one from being tried.
//
// usage: node tools/smoke-test.mjs [wad frames]...   (default: doom.wad 175)
import { createHash } from 'node:crypto';
import { bootEngine, loadWad } from './lib/engine.mjs';
import { check, summary } from './lib/report.mjs';

const args = process.argv.slice(2);
if (args.length % 2) {
    console.error('usage: node tools/smoke-test.mjs [wad frames]...');
    process.exit(2);
}
const runs = [];
for (let i = 0; i < args.length; i += 2) runs.push([args[i], Number(args[i + 1])]);
if (!runs.length) runs.push(['doom.wad', 175]);   // 5 seconds of demo

for (const [wad, frames] of runs)
    await smoke(wad, frames).catch(e => check(`${wad}: boots and runs ${frames} frames`, false, String(e?.message ?? e)));

summary(`engine smoke: ${runs.map(([w, n]) => `${w} ${n} frames`).join(', ')} — the attract loop runs, `
      + 'draws and plays music');

async function smoke(wad, frames) {
    // The engine detects Ultimate Doom by the doomu.wad filename.
    const engineName = wad === 'doom.wad' ? 'doomu.wad' : wad;

    let ierror = null;
    const doom = await bootEngine('build', [[engineName, loadWad(wad)]], {
        print: t => process.stdout.write(`  | ${t}\n`),
        printErr: t => process.stderr.write(`  ! ${t}\n`),
        onDoomError: msg => { ierror = msg; },
    });

    // one failed check stands for the IWAD's three when it cannot get as far
    const died = why => check(`${wad}: boots and runs ${frames} frames`, false, why);
    doom.callMain([]);
    if (ierror) return died(`I_Error during init: ${ierror}`);

    const fb = doom._web_framebuffer();
    if (!fb) return died('no framebuffer');

    const hashes = new Set();
    const start = performance.now();
    for (let i = 0; i < frames; i++) {
        // 35Hz tics from real time: pace frames like a 70fps display.
        const target = start + i * (1000 / 70);
        while (performance.now() < target) {}
        doom._web_frame();
        if (ierror) return died(`I_Error at frame ${i}: ${ierror}`);
        hashes.add(createHash('sha1')
            .update(doom.HEAPU8.subarray(fb, fb + 320 * 200)).digest('hex'));
    }

    const px = doom.HEAPU8.subarray(fb, fb + 320 * 200);
    // `nonzero` is a LIVENESS SIGNAL, not a measurement, and the check prints it
    // only so a reader can see the gate looked at something.  It wobbles by a
    // pixel or two between identical runs -- 63,463 / 63,463 / 63,464 over three
    // runs of `doom.wad 700` -- because the loop above is wall-clock paced, so
    // the last frame lands at a slightly different point in the attract loop
    // each time.  The assertion is the 10,000 threshold below, nowhere near that
    // noise.  Do not quote this number as a figure or pin it in a golden; the
    // per-tic framebuffer hashes in `render-goldens` are the deterministic
    // instrument.
    const nonzero = px.reduce((n, v) => n + (v !== 0), 0);
    console.log(`${wad}: frames rendered: ${frames}, distinct: ${hashes.size}, nonzero px: ${nonzero}/64000`);

    // music: the title screen starts mus_intro on boot; render 8 s of OPL
    // output and require audible signal.
    doom._web_music_init(44100);
    const nMusic = 44100 * 8;   // some tracks (Suspense) open nearly silent
    const scratch = doom._malloc(4 * 2 * nMusic);
    doom._web_music_render(scratch, nMusic);
    const f32 = new Float32Array(doom.HEAPU8.buffer, scratch, nMusic * 2);
    const rms = Math.sqrt(f32.reduce((s, v) => s + v * v, 0) / f32.length);
    const peak = f32.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    console.log(`${wad}: music: rms=${rms.toFixed(5)} peak=${peak.toFixed(4)}`);

    check(`${wad}: the attract loop runs (${hashes.size} distinct framebuffers, need 10)`, hashes.size >= 10,
          'framebuffer barely changes — demo not running');
    check(`${wad}: the framebuffer is drawn (${nonzero} non-black pixels, need 10000)`, nonzero >= 10000,
          'framebuffer mostly empty');
    check(`${wad}: OPL music is audible (rms ${rms.toFixed(5)}, need 0.0005)`, rms >= 0.0005, 'OPL music silent');
}
