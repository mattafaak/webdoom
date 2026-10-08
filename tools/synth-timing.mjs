// tools/synth-timing.mjs — wall-clock cost of the OPL music synth, per call,
// as docs/perf.md "Why the synth runs in the AudioWorklet" reports it.
//
// It times build/synth.wasm, the module the AudioWorklet runs; it links the
// same mus_opl.o and opl3.o objects as doom.wasm (engine/Makefile), whose
// main-thread path insecure origins still use.  The method is 53b1448's: one
// song, a call renders 100 ms of audio (4,800 frames at 48 kHz), 10 calls are
// discarded and the next 300 timed, and the figures are the per-call p50 and
// p99 and the synth's share of wall time.  Wall-clock: run it on a quiet host,
// and compare runs only on the same host.
//
// usage: node tools/synth-timing.mjs [--wad doom.wad] [--song D_INTRO]
//            [--rate 48000] [--frames 4800] [--warm 10] [--calls 300]
//            [--mode 0|1] [--module build/synth.wasm] [--json]
// --mode 0 is OPL2 (what the game plays by default), 1 OPL3.
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { hostname } from 'node:os';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const args = process.argv.slice(2);
const KNOWN = ['--wad', '--song', '--rate', '--frames', '--warm', '--calls', '--mode', '--module', '--json'];
for (const a of args)
    if (a.startsWith('--') && !KNOWN.includes(a)) { console.log(`FAIL synth-timing: unknown flag ${a}`); process.exit(2); }
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const WAD = opt('--wad', join(root, 'wads/lib/doom.wad'));
const SONG = opt('--song', 'D_INTRO');
const RATE = +opt('--rate', 48000), FRAMES = +opt('--frames', 4800);
const WARM = +opt('--warm', 10), CALLS = +opt('--calls', 300), MODE = +opt('--mode', 0);
const MODULE = opt('--module', join(root, 'build/synth.wasm'));
const BOOT_VOLUME = 67; // S_Init's I_SetMusicVolume(8) -> 8 * 127 / 15, as synth-native-test.mjs

function lump(wad, name) {
    const dv = new DataView(wad.buffer, wad.byteOffset, wad.length);
    const n = dv.getInt32(4, true), dir = dv.getInt32(8, true);
    for (let i = 0; i < n; i++) {
        const e = dir + 16 * i;
        const nm = wad.subarray(e + 8, e + 16).toString('latin1').replace(/\0.*$/, '');
        if (nm.toUpperCase() === name.toUpperCase()) {
            const pos = dv.getInt32(e, true), len = dv.getInt32(e + 4, true);
            return wad.subarray(pos, pos + len);
        }
    }
    console.log(`FAIL synth-timing: no lump ${name} in ${WAD}`);
    process.exit(1);
}

const wad = readFileSync(WAD);
const { instance } = await WebAssembly.instantiate(readFileSync(MODULE), {});
const x = instance.exports;
x._initialize();
const put = b => { const p = x.malloc(b.length); new Uint8Array(x.memory.buffer).set(b, p); return p; };
const gm = lump(wad, 'GENMIDI'), sg = lump(wad, SONG);
x.synth_boot(RATE, put(gm), gm.length, put(sg), sg.length, 1, 0, BOOT_VOLUME, MODE);
if (!x.web_music_debug(0)) { console.log(`FAIL synth-timing: synth.wasm refused ${SONG}`); process.exit(1); }
const buf = x.malloc(8 * FRAMES);

const ms = [];
let nonzero = 0;
for (let c = 0; c < WARM + CALLS; c++) {
    const t0 = performance.now();
    x.web_music_render(buf, FRAMES);
    const t1 = performance.now();
    if (c >= WARM) ms.push(t1 - t0);
    if (c === WARM + CALLS - 1) {
        const f = new Float32Array(x.memory.buffer, buf, 2 * FRAMES);
        for (const v of f) if (v !== 0) nonzero++;
    }
}
// a render of silence would time nothing worth reporting
if (nonzero === 0) { console.log('FAIL synth-timing: the last call rendered only silence'); process.exit(1); }

const s = [...ms].sort((a, b) => a - b);
const q = p => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
const callMs = (FRAMES / RATE) * 1000;
const mean = ms.reduce((a, b) => a + b, 0) / ms.length;
const r = {
    host: hostname(), node: process.version, module: MODULE.split('/').pop(), song: SONG,
    mode: MODE ? 'OPL3' : 'OPL2', rate: RATE, frames: FRAMES, warm: WARM, calls: CALLS,
    p50_ms: +q(0.5).toFixed(3), p99_ms: +q(0.99).toFixed(3), mean_ms: +mean.toFixed(3),
    share: +(mean / callMs).toFixed(4), ms_per_s: +(mean * 1000 / callMs).toFixed(1),
};
if (args.includes('--json')) console.log(JSON.stringify(r));
else console.log(`synth-timing ${r.host}: ${r.module} ${r.song} ${r.mode} ${RATE} Hz, ` +
                 `${CALLS} calls of ${FRAMES} frames (${callMs.toFixed(0)} ms of audio) after ${WARM} discarded: ` +
                 `p50 ${r.p50_ms} ms, p99 ${r.p99_ms} ms, mean ${r.mean_ms} ms = ${(r.share * 100).toFixed(1)}% ` +
                 `of wall time (${r.ms_per_s} ms of synth per second)`);
