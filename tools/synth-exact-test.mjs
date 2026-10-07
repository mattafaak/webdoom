#!/usr/bin/env node
// The shipped OPL synth is the reference synth, sample for sample: every music
// lump in the four IWADs, both modes, and random register streams, each
// rendered by engine/web/opl3.c (with the floor's exact savings) and by the
// reference core side by side, every frame of both channels compared.
//
// The reference is tools/floor/opl3-ref/opl3.c and opl3.h: Nuked OPL3 1.8 as
// engine/web/opl3.c was at 4eba931, before the savings, byte for byte (this
// test pins their sha256).  tools/freestanding/synth-exact links the two cores
// together and drives both with the same calls (synth-exact.c says how);
// opl3.c's header, "WEBDOOM: EXACT SAVINGS", argues why each saving is exact
// for ANY register stream, and this is the evidence:
//   1. songs: every lump of the four IWADs whose data is a MUS score (every
//      D_ lump, and nothing else is one; a name listed twice must be the same
//      bytes twice, and is rendered once), OPL2 and OPL3 mode, at 49,716 Hz
//      (the chip's own rate, the floor's: the resampler bypass is live) and at
//      44,100 Hz (a browser's: the resampler runs), driven by mus_opl.c through
//      synth.wasm's own entry points (synth_boot, web_music_render), each for
//      its whole score (its delays summed at 140 Hz) plus 5 s into its loop;
//   2. fuzz: random register streams, both banks and every address, rhythm
//      mode switched on after long stretches off, bank-1 writes arriving in
//      OPL2 mode after long stretches without, 4-op, NEW flipped, resets at
//      random rates, buffered and direct writes and generation;
//   3. itself: a frame flipped on purpose is found where it was flipped, and
//      four inexact variants of opl3.c must each fail, named and located:
//      slot 3 (channel 0's carrier) skipped, which every song plays; and three
//      that the songs cannot see, because mus_opl.c writes no 0x1xx register in
//      OPL2 mode and never turns rhythm mode on, so the fuzz must: the bank-1
//      skip keyed to NEW instead of to the writes; the noise LFSR stepped only
//      for the slots computed, as phase 1a's saving A did (skipping bank 1
//      skipped 18 of its 36 steps a sample); and the LFSR held while rhythm
//      mode is off (phase 1a's saving D).
// Besides the samples, the noise LFSR's state is compared after every frame,
// so a divergence that cannot be heard yet is still a failure.
//
// usage: node tools/synth-exact-test.mjs [--jobs N] [--seeds N]
// Copyright (C) 2026, GPL-2.0-or-later.
import { readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, availableParallelism } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const { check, summary, fatal } = await import('./lib/report.mjs');
const FS = join(root, 'tools/freestanding');
const OPL3 = join(root, 'engine/web/opl3.c');
const REF = {
    'tools/floor/opl3-ref/opl3.c': 'c989713afb17c3f72f0b770c178405f721883741abd9e7f4cf6ea847309c1d94',
    'tools/floor/opl3-ref/opl3.h': '460e11c78f59f6e8cfd8416639669fb19716fd51a6d6b59d048ed4fd4053e3af',
};
// the IWADs: how many MUS lumps each holds, and how many distinct scores (The
// Ultimate DOOM's directory lists 13 of its 32 twice, byte-identical copies)
const IWADS = { 'doom.wad': [45, 32], 'doom2.wad': [35, 35], 'tnt.wad': [35, 35], 'plutonia.wad': [35, 35] };
const RATES = [49716, 44100];
const MODES = [0, 1];
const TAIL_S = 5;          // rendered past the score's end, through the loop
const FUZZ_FRAMES = 2000000;

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? +args[i + 1] : d; };
for (let i = 0; i < args.length; i++)
    if (['--jobs', '--seeds'].includes(args[i]) && +args[i + 1] > 0) i++;
    else fatal(`unknown or incomplete argument ${args[i]}`);
const JOBS = opt('--jobs', Math.max(2, availableParallelism() - 2));
const SEEDS = opt('--seeds', 48);

// ── the reference is the one committed ──────────────────────────────────────
for (const [f, want] of Object.entries(REF)) {
    const got = createHash('sha256').update(readFileSync(join(root, f))).digest('hex');
    check(`${f} is the pinned reference (sha256 ${want.slice(0, 12)}...)`, got === want, `sha256 ${got}`);
}

// ── the songs: every MUS lump ────────────────────────────────────────────────
function musLumps(wadName) {
    const wad = readFileSync(join(root, 'wads/lib', wadName));
    const dv = new DataView(wad.buffer, wad.byteOffset, wad.length);
    const n = dv.getInt32(4, true), dir = dv.getInt32(8, true), out = [], dnames = [];
    for (let i = 0; i < n; i++) {
        const e = dir + 16 * i, pos = dv.getInt32(e, true), len = dv.getInt32(e + 4, true);
        const name = wad.subarray(e + 8, e + 16).toString('latin1').replace(/\0.*$/s, '').toUpperCase();
        if (name.startsWith('D_')) dnames.push(name);
        const d = wad.subarray(pos, pos + len);
        if (len >= 16 && d.toString('latin1', 0, 4) === 'MUS\x1a')
            out.push({ wad: wadName, song: name, ticks: scoreTicks(d), sha: createHash('sha256').update(d).digest('hex') });
    }
    return { songs: out, dnames };
}

// the score's length in MUS ticks: its delays summed up to the end marker
function scoreTicks(m) {
    const len = m[4] | (m[5] << 8), start = m[6] | (m[7] << 8), end = Math.min(m.length, start + len);
    let p = start, ticks = 0;
    while (p < end) {
        const b = m[p++], type = (b >> 4) & 7;
        if (type === 6) break;
        if (type === 1) p += (m[p] & 0x80) ? 2 : 1;
        else if (type === 4) p += 2;
        else p += 1;
        if (b & 0x80) {
            let d = 0, c;
            do { c = m[p++]; d = d * 128 + (c & 0x7f); } while (c & 0x80 && p < end);
            ticks += d;
        }
    }
    return ticks;
}

for (const w of Object.keys(IWADS))
    if (!existsSync(join(root, 'wads/lib', w))) fatal(`wads/lib/${w} missing (tools/fetch-wads.sh)`);
const songs = [];
let lumpCount = 0;
for (const [w, [want, wantDistinct]] of Object.entries(IWADS)) {
    const { songs: s, dnames } = musLumps(w);
    const names = s.map(x => x.song), distinct = s.filter((x, i) => names.indexOf(x.song) === i);
    // synth-exact finds a lump by name, so a name listed twice must be one score
    const differ = s.filter(x => x.sha !== distinct.find(d => d.song === x.song).sha).map(x => x.song);
    const notMus = dnames.filter(d => !names.includes(d)), notD = names.filter(x => !x.startsWith('D_'));
    check(`${w}: ${s.length} MUS lumps, ${distinct.length} distinct scores (${want} and ${wantDistinct} expected); ` +
          `every D_ lump one of them; a name listed twice is the same bytes`,
          s.length === want && distinct.length === wantDistinct && !differ.length && !notMus.length && !notD.length,
          `same name, other bytes [${differ}], D_ lumps not MUS [${notMus}], MUS lumps not D_ [${notD}]`);
    songs.push(...distinct);
    lumpCount += s.length;
}

// ── build ────────────────────────────────────────────────────────────────────
const tmp = mkdtempSync(join(tmpdir(), 'synth-exact-'));
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }));
function build(opl3, tag) {
    const out = tag ? join(tmp, tag, 'synth-exact') : join(FS, 'synth-exact');
    const vars = tag ? [`SYNTH_EXACT_OPL3=${opl3}`, `SYNTH_EXACT_OBJ=${join(tmp, tag, 'obj')}`, `SYNTH_EXACT_OUT=${out}`] : [];
    const r = spawnSync('make', ['-C', FS, ...vars, tag ? out : 'synth-exact'], { encoding: 'utf8' });
    if (r.status !== 0) fatal(`make synth-exact${tag ? ` (${tag})` : ''} failed:\n${r.stdout}${r.stderr}`);
    return out;
}
const EXE = build(OPL3, null);

// the red-proof variants: opl3.c with one inexact change each
const src = readFileSync(OPL3, 'utf8');
function edit(s, from, to, count = 1) {
    const n = s.split(from).length - 1;
    if (n !== count) fatal(`engine/web/opl3.c no longer has the text the red-proof edits expect (${n} of ${count}): ${from.slice(0, 60)}`);
    return s.split(from).join(to);
}
const VARIANTS = {
    'slot3': { what: 'slot 3 (channel 0\'s carrier) skipped',
               src: edit(src, '    for (ii = 0; ii < 15; ii++)\n    {\n', '    for (ii = 0; ii < 15; ii++)\n    {\n        if (ii == 3)\n            continue;\n') },
    'new-keyed': { what: 'the bank-1 skip keyed to NEW instead of to the writes',
                   src: edit(src, 'chip->bank1_live ?', 'chip->newm ?', 3) },
    'noise-18': { what: 'the noise LFSR stepped only for the slots computed (phase 1a\'s A)',
                  src: edit(src, '    for (jj = 0; jj < 4; jj++)\n    {\n        noise = (noise >> 9)',
                            '    for (jj = 0; jj < (chip->bank1_live ? 4 : 2); jj++)\n    {\n        noise = (noise >> 9)') },
    'noise-held': { what: 'the noise LFSR held while rhythm mode is off (phase 1a\'s D)',
                    src: edit(src, '    for (jj = 0; jj < 4; jj++)\n    {\n        noise = (noise >> 9)',
                              '    for (jj = 0; jj < ((chip->rhy & 0x20) ? 4 : 0); jj++)\n    {\n        noise = (noise >> 9)') },
};
for (const [tag, v] of Object.entries(VARIANTS)) {
    mkdirSync(join(tmp, tag), { recursive: true });
    writeFileSync(join(tmp, tag, 'opl3.c'), v.src);
    v.exe = build(join(tmp, tag, 'opl3.c'), tag);
}

// ── the runs ─────────────────────────────────────────────────────────────────
function run(exe, argv) {
    return new Promise(resolve => {
        const p = spawn(exe, argv, { cwd: root });
        let out = '', err = '';
        p.stdout.on('data', b => { out += b; });
        p.stderr.on('data', b => { err += b; });
        p.on('close', code => {
            const line = out.split('\n').find(l => l.startsWith('EXACT ')) || '';
            const f = Object.fromEntries(line.split(' ').slice(1).map(kv => kv.split('=')));
            resolve({ code, err: err.trim(), line, f });
        });
    });
}
const framesOf = (s, rate) => Math.ceil(s.ticks * rate / 140) + TAIL_S * rate;
const songArgv = (s, mode, rate, extra = []) =>
    ['--wad', join(root, 'wads/lib', s.wad), '--song', s.song, '--mode', String(mode), '--rate', String(rate),
     '--frames', String(framesOf(s, rate)), ...extra];
const jobs = [];
for (const s of songs)
    for (const mode of MODES)
        for (const rate of RATES)
            jobs.push({ kind: 'song', s, mode, rate, frames: framesOf(s, rate), argv: songArgv(s, mode, rate) });
for (let seed = 1; seed <= SEEDS; seed++)
    jobs.push({ kind: 'fuzz', seed, frames: FUZZ_FRAMES, argv: ['--fuzz', String(seed), '--frames', String(FUZZ_FRAMES)] });
// the self-checks and red-proofs run in the same pool: the shortest song
// and the first fuzz seeds
const short = songs.filter(s => s.ticks > 140 * 30).sort((a, b) => a.ticks - b.ticks)[0];
const FLIP = 100003;
const red = [
    { kind: 'flip', exe: EXE, s: short, mode: 0, rate: 49716, frames: framesOf(short, 49716),
      argv: songArgv(short, 0, 49716, ['--flip', String(FLIP)]) },
    { kind: 'red', tag: 'slot3', s: short, mode: 0, rate: 49716, frames: framesOf(short, 49716), argv: songArgv(short, 0, 49716) },
    ...['new-keyed', 'noise-18', 'noise-held'].flatMap(tag => [1, 2, 3, 4].map(seed =>
        ({ kind: 'red', tag, seed, frames: FUZZ_FRAMES, argv: ['--fuzz', String(seed), '--frames', String(FUZZ_FRAMES)] }))),
];
for (const j of jobs) j.exe = EXE;
for (const j of red) j.exe ??= VARIANTS[j.tag].exe;
const all = [...jobs, ...red].sort((a, b) => b.frames - a.frames); // longest first
const totalFrames = jobs.reduce((a, j) => a + j.frames, 0);
console.log(`synth-exact: ${jobs.length} renders (${songs.length} songs x ${MODES.length} modes x ${RATES.length} rates, ` +
            `${SEEDS} fuzz seeds) + ${red.length} self-checks, ${JOBS} at a time; ${(totalFrames / 1e9).toFixed(2)} G frames`);
const t0 = Date.now();
{
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(JOBS, all.length) }, async () => {
        while (next < all.length) { const j = all[next++]; j.r = await run(j.exe, j.argv); }
    }));
}

// ── grading ──────────────────────────────────────────────────────────────────
const label = j => j.kind === 'fuzz' || j.seed ? `fuzz seed ${j.seed}` :
                   `${j.s.wad} ${j.s.song} ${j.mode ? 'OPL3' : 'OPL2'} ${j.rate} Hz`;
const where = (j, r) => `first differs at frame ${r.f.first_diff}` +
    (j.rate ? ` (${(r.f.first_diff / j.rate).toFixed(3)} s)` : '') + `, ${r.f.ch}: shipped ${r.f.opt}, reference ${r.f.ref}`;
const ran = j => !j.r.code && j.r.line && +j.r.f.frames === j.frames;
let identical = 0, secs = 0;
const tally = { opl2: 0, opl2skip: 0, opl3: 0, opl3skip: 0, fuzz: 0, skipped: 0, rhythm: 0, loud: 0, wakes: 0, rhythmOn: 0, resets: 0 };
for (const j of all.filter(j => j.kind === 'song' || j.kind === 'fuzz')) {
    const r = j.r;
    if (!ran(j)) { check(`${label(j)}: rendered ${j.frames} frames`, false, r.err || r.line || `exit ${r.code}`); continue; }
    if (+r.f.differ !== 0) { check(`${label(j)}: identical to the reference`, false, `${r.f.differ} frames differ; ${where(j, r)}`); continue; }
    if (+r.f.noise_diff !== -1) { check(`${label(j)}: noise LFSR == the reference's`, false, `differs from frame ${r.f.noise_diff}`); continue; }
    identical++;
    if (j.kind === 'song') {
        secs += j.frames / j.rate;
        const m = j.mode ? 'opl3' : 'opl2';
        tally[m] += +r.f.frames;
        tally[`${m}skip`] += +r.f.skipped;
    } else {
        tally.fuzz += +r.f.frames;
        for (const [k, f] of [['skipped', 'skipped'], ['rhythm', 'rhythm'], ['loud', 'loud'], ['wakes', 'wakes_opl2'],
                              ['rhythmOn', 'rhythm_on'], ['resets', 'resets']]) tally[k] += +r.f[f];
    }
}
const G = n => (n / 1e9).toFixed(3);
check(`songs and fuzz: ${identical} of ${jobs.length} renders identical to the reference, every frame of both channels ` +
      `and the noise LFSR (${lumpCount} MUS lumps, ${songs.length} distinct scores, x OPL2/OPL3 x ${RATES.join('/')} Hz, score + ${TAIL_S} s: ` +
      `${(secs / 3600).toFixed(2)} h of audio; ${SEEDS} fuzz seeds x ${FUZZ_FRAMES} frames)`, identical === jobs.length);
// what the runs covered: graded on quantities that only rise
check(`OPL2: bank 1 skipped on all ${G(tally.opl2)} G song frames (mus_opl.c writes no 0x1xx register in OPL2 mode)`,
      tally.opl2 > 0 && tally.opl2skip === tally.opl2, `${tally.opl2skip} of ${tally.opl2}`);
check(`OPL3: bank 1 skipped on ${G(tally.opl3skip)} of ${G(tally.opl3)} G song frames (until a song keys voice 9)`,
      tally.opl3 > 0 && tally.opl3skip > 0 && tally.opl3skip < tally.opl3, `${tally.opl3skip} of ${tally.opl3}`);
check(`fuzz covered the savings' edges: ${tally.wakes} bank-1 wakes in OPL2 mode, rhythm mode on ${tally.rhythmOn} times ` +
      `after 1 s or more off (${G(tally.rhythm)} G rhythm frames), ${G(tally.skipped)} G frames with bank 1 skipped, ` +
      `${tally.resets} resets, ${G(tally.loud)} of ${G(tally.fuzz)} G frames louder than +-64`,
      tally.wakes >= SEEDS && tally.rhythmOn >= SEEDS && tally.skipped > 0 && tally.rhythm > 0 && tally.resets > SEEDS &&
      tally.loud > tally.fuzz / 2);

// the self-checks
const flip = red[0];
check(`self-check: a frame flipped at ${FLIP} (${short.wad} ${short.song} OPL2) is found there`,
      ran(flip) && +flip.r.f.first_diff === FLIP && flip.r.f.ch === 'L' && +flip.r.f.differ === 1, flip.r.line || flip.r.err);
const s3 = red[1];
check(`red-proof: ${VARIANTS.slot3.what} fails, named and located (${label(s3)}: ${ran(s3) ? where(s3, s3.r) : 'did not run'})`,
      ran(s3) && +s3.r.f.differ > 0 && +s3.r.f.first_diff >= 0, s3.r.line || s3.r.err);
for (const tag of ['new-keyed', 'noise-18', 'noise-held']) {
    const rs = red.filter(j => j.tag === tag), caught = rs.filter(j => ran(j) && +j.r.f.differ > 0);
    const first = caught[0];
    check(`red-proof: ${VARIANTS[tag].what} fails the fuzz on its samples, ${caught.length} of ${rs.length} seeds` +
          (first ? ` (${label(first)}: ${where(first, first.r)})` : ''), caught.length === rs.length,
          rs.map(j => j.r.line || j.r.err).join('; '));
}

console.log(`  (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
summary(`synth exact: ${identical}/${jobs.length} renders identical to the reference (${songs.length} music scores x ` +
        `OPL2/OPL3 x ${RATES.join('/')} Hz, whole score + ${TAIL_S} s; ${SEEDS} fuzz seeds), 4 inexact variants caught`,
        { min: 10 });
