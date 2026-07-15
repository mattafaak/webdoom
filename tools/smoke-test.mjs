#!/usr/bin/env node
// Headless engine smoke test: boot the wasm with a real IWAD, run the
// title-demo loop for N frames, and prove the framebuffer is alive.
// This grows into the determinism CI (demo playback + gamestate checksums).
// usage: node tools/smoke-test.mjs [wad] [frames]
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const wad = process.argv[2] ?? 'doom.wad';
const frames = Number(process.argv[3] ?? 175);   // 5 seconds of demo

const createDoom = (await import(join(root, 'build/doom.js'))).default;

// The engine detects Ultimate Doom by the doomu.wad filename.
const engineName = wad === 'doom.wad' ? 'doomu.wad' : wad;
const wadBytes = readFileSync(join(root, 'wads/lib', wad));

const reg = (doom, name, bytes) => {
    const p = doom._malloc(bytes.length);
    doom.HEAPU8.set(bytes, p);
    doom.ccall('web_register_file', null, ['string', 'number', 'number'], [name, p, bytes.length]);
};

let fatal = null;
const doom = await createDoom({
    print: t => process.stdout.write(`  | ${t}\n`),
    printErr: t => process.stderr.write(`  ! ${t}\n`),
    onDoomError: msg => { fatal = msg; },
});
reg(doom, engineName, wadBytes);

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
console.log('PASS');
