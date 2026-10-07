#!/usr/bin/env node
// The native OPL synth is the web's synth: tools/freestanding/synth-bench
// (engine/web/mus_opl.c, opl3.c and synth_main.c compiled unchanged for x86)
// renders byte for byte what build/synth.wasm renders, on the music the 13 IWAD
// demos actually play, and both match the floor's committed references.
//
// Why it matters: every bare-metal port of the floor plan is graded on the
// same samples (the AUDIO line's synthhash, tools/floor/floor_log.h), and a
// port can only be checked against a reference it can reproduce off the web.
// The first native build did NOT reproduce it: gcc -m32's x87 code moves one
// event group of D_STLKS2 by a frame (synth-bench.c, "THE CLOCK IS IEEE
// DOUBLE"), so the synth's objects are built for IEEE double, and this gate is
// what says that stays true.
//
// What it checks, for each demo's song (the lump fs-doom registers for it):
//   1. samples: synth-bench -O1 and -O2 == synth.wasm through synth_boot +
//      web_music_render, in OPL2 and OPL3 mode, at 49,716 Hz (the synth's own
//      rate, the floor's), 44,100 and 48,000 Hz, for the demo's whole length;
//   2. references, at 49,716 Hz in both modes: the register stream (L1:
//      writes and their hash) and the samples (L2) match
//      tools/floor/synth-ref.json, and rendering one frame per call gives the
//      same samples as fs-doom's per-tic blocks;
//   3. itself: a corrupted sample and a corrupted register write must each be
//      caught and located (the frame named), so a comparison that silently
//      compared nothing cannot pass.
// A difference is reported with the first differing frame, both builds' values
// and the time into the song.
//
// usage: node tools/synth-native-test.mjs [--write-ref] [--jobs N]
//   --write-ref  rewrite tools/floor/synth-ref.json from this run (refused
//                unless every native render matched synth.wasm)
// Copyright (C) 2026, GPL-2.0-or-later.
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, availableParallelism } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEMO_SONGS, demoTics } from './floor/demo-songs.mjs';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SELF = fileURLToPath(import.meta.url);
const RATES = [49716, 44100, 48000];
const REF_RATE = 49716;
const MODES = [0, 1];
const BUILDS = ['O1', 'O2'];
const BENCH = b => join(root, 'tools/freestanding', `synth-bench-${b}`);
const SYNTH_WASM = join(root, 'build/synth.wasm');
const REF_FILE = join(root, 'tools/floor/synth-ref.json');
const BOOT_VOLUME = 67; // S_Init's I_SetMusicVolume(8) -> 8 * 127 / 15

// ── WAD lumps, as synth-bench reads them ─────────────────────────────────────
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
    throw new Error(`no lump ${name}`);
}

// ── the wasm side: one render, run as a child of this file ──────────────────
// synth.wasm brought up exactly as the AudioWorklet does (synth_boot), then
// rendered in fs-doom's per-tic blocks; FNV-1a 32 over the samples as
// little-endian int16 (f32 * 16384 is exact), as synth-bench hashes them.
async function wasmRender([wadPath, song, mode, rate, frames, raw]) {
    const wad = readFileSync(wadPath);
    const { instance } = await WebAssembly.instantiate(readFileSync(SYNTH_WASM), {});
    const x = instance.exports;
    x._initialize();
    const put = b => { const p = x.malloc(b.length); new Uint8Array(x.memory.buffer).set(b, p); return p; };
    const gm = lump(wad, 'GENMIDI'), sg = lump(wad, song);
    x.synth_boot(+rate, put(gm), gm.length, put(sg), sg.length, 1, 0, BOOT_VOLUME, +mode);
    if (!x.web_music_debug(0)) throw new Error(`synth.wasm refused ${song}`);
    const N = +frames, R = +rate, sc = x.malloc(8 * (Math.ceil(R / 35) + 1));
    const parts = [];
    let h = 0x811c9dc5, done = 0, carry = 0;
    while (done < N) {
        let n = Math.floor((carry + R) / 35);
        carry = (carry + R) % 35;
        if (n > N - done) n = N - done;
        x.web_music_render(sc, n);
        const f = new Float32Array(x.memory.buffer, sc, 2 * n);
        const i16 = raw ? new Int16Array(2 * n) : null;
        for (let k = 0; k < 2 * n; k++) {
            const s = Math.round(f[k] * 16384);
            if (i16) i16[k] = s;
            h = Math.imul(h ^ (s & 0xff), 0x01000193) >>> 0;
            h = Math.imul(h ^ ((s >> 8) & 0xff), 0x01000193) >>> 0;
        }
        if (i16) parts.push(Buffer.from(i16.buffer));
        done += n;
    }
    if (raw) writeFileSync(raw, Buffer.concat(parts));
    console.log(`WASM l2=${h.toString(16).padStart(8, '0')} events=${x.web_music_debug(1)} frames=${N}`);
}

if (process.argv[2] === '--wasm-render') {
    await wasmRender(process.argv.slice(3));
    process.exit(0);
}

// ── the gate ──────────────────────────────────────────────────────────────────
const { check, summary, fatal } = await import('./lib/report.mjs');
const args = process.argv.slice(2);
const WRITE_REF = args.includes('--write-ref');
const ji = args.indexOf('--jobs');
const JOBS = ji >= 0 ? +args[ji + 1] : Math.max(2, availableParallelism() - 2);
for (const a of args)
    if (a.startsWith('--') && !['--write-ref', '--jobs'].includes(a)) fatal(`unknown flag ${a}`);

// synth-bench is gcc-only and quick to build; build it here so the leg cannot
// grade a stale binary
{
    const r = spawnSync('make', ['-C', join(root, 'tools/freestanding'), 'synth-bench'], { encoding: 'utf8' });
    if (r.status !== 0) fatal(`make synth-bench failed:\n${r.stdout}${r.stderr}`);
}
if (!existsSync(SYNTH_WASM)) fatal('build/synth.wasm missing — run: source tools/emsdk-env.sh && make -C engine');
for (const [, wad] of DEMO_SONGS)
    if (!existsSync(join(root, 'wads/lib', wad))) fatal(`wads/lib/${wad} missing (tools/fetch-wads.sh)`);

const tics = Object.fromEntries(DEMO_SONGS.map(([d]) => [d, demoTics(d)]));
const framesOf = (d, rate) => Math.floor(tics[d] * rate / 35);

// a small process pool
function run(cmd, argv) {
    return new Promise(resolve => {
        const p = spawn(cmd, argv, { cwd: root });
        let out = '', err = '';
        p.stdout.on('data', b => { out += b; });
        p.stderr.on('data', b => { err += b; });
        p.on('close', code => resolve({ code, out, err }));
    });
}
async function pool(tasks) {
    const results = new Array(tasks.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(JOBS, tasks.length) }, async () => {
        while (next < tasks.length) { const i = next++; results[i] = await tasks[i](); }
    }));
    return results;
}
const field = (line, k) => (new RegExp(`\\b${k}=(\\S+)`).exec(line) || [])[1];
const native = (b, d, wad, song, mode, rate, extra = []) => () =>
    run(BENCH(b), ['--wad', join(root, 'wads/lib', wad), '--song', song, '--mode', String(mode),
                   '--rate', String(rate), '--tics', String(tics[d]), ...extra]);
const wasm = (d, wad, song, mode, rate, raw) => () =>
    run(process.execPath, [SELF, '--wasm-render', join(root, 'wads/lib', wad), song, String(mode),
                           String(rate), String(framesOf(d, rate)), ...(raw ? [raw] : [])]);

const tmp = mkdtempSync(join(tmpdir(), 'synth-native-'));
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }));

// The first differing frame between a native and a wasm render of one config,
// from raw dumps of both.
async function locate(b, d, wad, song, mode, rate, nativeExtra = []) {
    const nr = join(tmp, `${d}.${mode}.${rate}.${b}.nat`), wr = join(tmp, `${d}.${mode}.${rate}.wasm`);
    const [n, w] = await Promise.all([native(b, d, wad, song, mode, rate, ['--raw', nr, ...nativeExtra])(),
                                      wasm(d, wad, song, mode, rate, wr)()]);
    if (n.code || w.code) return `could not re-render to locate it (${n.err || w.err})`;
    const A = readFileSync(nr), B = readFileSync(wr);
    if (A.length !== B.length) return `lengths differ: native ${A.length} B, wasm ${B.length} B`;
    for (let i = 0; i < A.length; i += 2)
        if (A.readInt16LE(i) !== B.readInt16LE(i)) {
            const f = i >> 2, ch = (i >> 1) & 1 ? 'R' : 'L';
            return { frame: f, ch, text: `first differs at frame ${f} (${(f / rate).toFixed(4)} s), ${ch}: ` +
                     `native ${A.readInt16LE(i)}, wasm ${B.readInt16LE(i)}` };
        }
    return 'the raw dumps are identical (the hashes disagree: a hashing defect)';
}

const t0 = Date.now();
// 1. samples, every config
const configs = [];
for (const [d, wad, song] of DEMO_SONGS)
    for (const mode of MODES)
        for (const rate of RATES) configs.push({ d, wad, song, mode, rate });
const tasks = [];
for (const c of configs) {
    c.wasmIdx = tasks.push(wasm(c.d, c.wad, c.song, c.mode, c.rate)) - 1;
    c.natIdx = BUILDS.map(b => tasks.push(native(b, c.d, c.wad, c.song, c.mode, c.rate)) - 1);
}
// 2. references: one frame per call, with the register stream
const refRuns = [];
for (const [d, wad, song] of DEMO_SONGS)
    for (const mode of MODES) {
        const r = { d, wad, song, mode };
        r.idx = tasks.push(native('O1', d, wad, song, mode, REF_RATE, ['--regs'])) - 1;
        refRuns.push(r);
    }
console.log(`synth-native: ${tasks.length} renders, ${JOBS} at a time ` +
            `(${DEMO_SONGS.length} songs x ${MODES.length} modes x ${RATES.length} rates; wasm, ${BUILDS.join(', ')}; ` +
            `${refRuns.length} register-stream runs)`);
const res = await pool(tasks);

let nativeOk = 0, renders = 0, allMatch = true, audioS = 0;
for (const c of configs) {
    const w = res[c.wasmIdx];
    const wl2 = field(w.out, 'l2');
    const label = `${c.d} ${c.song} ${c.mode ? 'OPL3' : 'OPL2'} ${c.rate} Hz`;
    if (w.code || !wl2) { check(`${label}: synth.wasm rendered`, false, w.err.trim().split('\n').pop()); allMatch = false; continue; }
    if (c.rate === REF_RATE && c.mode === 0) audioS += framesOf(c.d, c.rate) / c.rate;
    for (const [k, b] of BUILDS.entries()) {
        const n = res[c.natIdx[k]];
        renders++;
        const nl2 = field(n.out, 'l2');
        if (n.code || !nl2) { check(`${label}: synth-bench-${b} rendered`, false, n.err.trim()); allMatch = false; continue; }
        if (+field(n.out, 'frames') !== framesOf(c.d, c.rate) || +field(n.out, 'events') <= 0) {
            check(`${label} ${b}: rendered the demo's ${framesOf(c.d, c.rate)} frames with music events`, false,
                  `frames=${field(n.out, 'frames')} events=${field(n.out, 'events')}`);
            allMatch = false; continue;
        }
        if (nl2 === wl2) { nativeOk++; continue; }
        allMatch = false;
        const where = await locate(b, c.d, c.wad, c.song, c.mode, c.rate);
        check(`${label}: synth-bench-${b} == synth.wasm`, false, `l2 ${nl2} vs ${wl2}; ${where.text ?? where}`);
    }
}
check(`samples: ${nativeOk} of ${renders} native renders byte-identical to synth.wasm ` +
      `(${configs.length} configs, ${audioS.toFixed(0)} s of audio each)`, nativeOk === renders && renders === configs.length * BUILDS.length);

// 2. the references
const ref = existsSync(REF_FILE) ? JSON.parse(readFileSync(REF_FILE, 'utf8')) : null;
if (!ref && !WRITE_REF) check('tools/floor/synth-ref.json exists', false, 'run with --write-ref to create it');
const newRef = { rate: REF_RATE, volume: BOOT_VOLUME, about: 'see tools/synth-native-test.mjs', demos: {} };
let refOk = 0;
for (const r of refRuns) {
    const n = res[r.idx];
    const key = `${r.d}.${r.mode ? 'opl3' : 'opl2'}`;
    const c = configs.find(c => c.d === r.d && c.mode === r.mode && c.rate === REF_RATE);
    const got = { song: r.song, wad: r.wad, tics: tics[r.d], frames: +field(n.out, 'frames'),
                  writes: +field(n.out, 'writes'), l1: field(n.out, 'l1'), l2: field(n.out, 'l2'),
                  events: +field(n.out, 'events') };
    newRef.demos[key] = got;
    if (n.code || !got.l1) { check(`${key}: register-stream run`, false, n.err.trim()); continue; }
    const tic = field(res[c.natIdx[0]].out, 'l2');
    if (got.l2 !== tic) { check(`${key}: one frame per call == per-tic blocks`, false, `${got.l2} vs ${tic}`); continue; }
    if (!ref || WRITE_REF) { refOk++; continue; }
    const want = ref.demos?.[key];
    if (!want) { check(`${key}: in synth-ref.json`, false); continue; }
    const bad = ['song', 'frames', 'writes', 'l1', 'l2', 'events'].filter(k => want[k] !== got[k]);
    if (bad.length) check(`${key} matches tools/floor/synth-ref.json`, false,
                          bad.map(k => `${k} ${got[k]} (reference ${want[k]})`).join(', '));
    else refOk++;
}
check(`references: ${refOk} of ${refRuns.length} register streams (L1) and sample hashes (L2) at ${REF_RATE} Hz match` +
      `${WRITE_REF ? ' (being written)' : ' tools/floor/synth-ref.json'}, block size 1 == per-tic blocks`, refOk === refRuns.length);

// 3. red-proofs: a corrupted sample and a corrupted register write are caught
// and located.  doom-demo4 is the shortest demo.
{
    const [d, wad, song] = DEMO_SONGS[3];
    const K = 123457;
    const w = await locate('O1', d, wad, song, 0, REF_RATE, ['--perturb-sample', String(K)]);
    check(`red-proof: a sample flipped at frame ${K} is caught there`, w.frame === K && w.ch === 'L', w.text ?? w);
    const J = 400;
    const n = await native('O1', d, wad, song, 0, REF_RATE, ['--perturb-reg', String(J)])();
    const want = ref?.demos?.[`${d}.opl2`];
    const pf = +field(n.out, 'perturbed_frame');
    const l1Caught = !!want && field(n.out, 'l1') !== want.l1;
    const loc = await locate('O1', d, wad, song, 0, REF_RATE, ['--perturb-reg', String(J)]);
    check(`red-proof: register write ${J} corrupted (issued at frame ${pf}) changes L1 and the samples from that frame on`,
          (WRITE_REF || l1Caught) && Number.isFinite(pf) && loc.frame >= pf,
          `l1 ${field(n.out, 'l1')} vs reference ${want?.l1}; ${loc.text ?? loc}`);
}

if (WRITE_REF) {
    if (!allMatch) fatal('--write-ref refused: not every native render matched synth.wasm');
    writeFileSync(REF_FILE, JSON.stringify(newRef, null, 1) + '\n');
    console.log(`wrote ${REF_FILE}`);
}
console.log(`  (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
summary(`native synth == synth.wasm: ${nativeOk}/${renders} renders byte-identical over ${DEMO_SONGS.length} demo songs x ` +
        `OPL2/OPL3 x ${RATES.join('/')} Hz x -O1/-O2; ${refOk}/${refRuns.length} L1+L2 references`, { min: 4 });
