#!/usr/bin/env node
// tools/cortexm/audio-check.mjs — the sound on the Cortex-M boards: the exact
// OPL synth and the 8-channel mixer, sample for sample the x86 reference's,
// and what they cost per tic in each ISA's own instructions.
//
// usage: node tools/cortexm/audio-check.mjs [--demos a,b | --demos all]
//            [--isa armv6m,armv8m] [--no-red]
//
// For each ISA (both by default, side by side), the zero-copy build
// (run-floor.sh --zero-copy: a copying build reads its WAD through a window
// the mixer cannot read sound effects from in place), in a build directory of
// its own (<isa>-O1-zc-snd, the same code as the -zc legs'), runs the demos
// twice through the floor gate, mode A and mode B each:
//   off  without the sound (the game alone, as every other Cortex-M leg);
//   on   with it (run-floor.sh --audio: cm-doom -audio 1).
// Both must be correct (every tic's sim and render hash against the goldens),
// and then:
//   - every "on" log's AUDIO line (samples, underruns, music events, sound
//     starts, synthhash, mixhash, frames) equals tools/floor/audio-ref.json's,
//     the x86 fs-doom reference: the music the synth renders and the mix are
//     the same samples on ARM as on x86 (the sequencer's clock is a double:
//     both boards' builds are -mfloat-abi=soft, so it is libgcc's IEEE
//     soft-float there, SSE2 double on x86);
//   - every "off" log's AUDIO line is 0 (the sound really was off);
//   - the two timing runs ran the same tics to the same end.
// The figures: per ISA, the worst and mean graded tic with and without the
// sound, and the sound's own cost per graded tic, "on" minus "off" tic by tic
// (the synth, the mixer, their sum into the DAC buffer, and s_sound's 8
// channels in place of 3; the AUDIO line's hashes are the harness's and
// charged to no tic, cm_main.c's cm_audio_pause).
//
// Red-proofs, each must be caught or the check FAILs:
//   wrongref  the "on" logs against audio-ref.json with one digit of the
//             synthhash changed: the comparison must report it;
//   redsynth  a build with -DFS_AUDIO_REDPROOF_SYNTH (fs_audio.c: one music
//             sample in 4,096 one step off) run on doom-demo4 with the sound
//             (--correctness: mode A only, its own build directory): its
//             synthhash must differ from the reference and its mixhash not.
// --no-red skips the second (a measurement run).
//
// The leg (cortexm-audio) runs doom-demo4 only; --demos all is a measurement
// of the 13 (minutes, not seconds).  Exit 0 and a PASS line quoting the
// figures, or exit 1 and FAIL lines.
// Copyright (C) 2026, GPL-2.0-or-later.
import { readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLog, DEMOS } from '../floor/floor-gate.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CM = join(root, 'tools/cortexm');
const args = process.argv.slice(2);
const known = new Set(['--demos', '--isa', '--no-red']);
for (let i = 0; i < args.length; i++) {
    if (!known.has(args[i])) { console.log(`FAIL audio-check: unknown argument ${args[i]}`); process.exit(2); }
    if (args[i] !== '--no-red') i++;
}
const opt = k => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
const demosArg = opt('--demos') ?? 'doom-demo4';
const demos = demosArg === 'all' ? DEMOS : demosArg.split(',');
const isas = (opt('--isa') ?? 'armv6m,armv8m').split(',');
const RED = !args.includes('--no-red');
if (demos.some(d => !DEMOS.includes(d)) || isas.some(i => !['armv6m', 'armv8m'].includes(i))) {
    console.log(`FAIL audio-check: --demos takes demo names or all, --isa armv6m and/or armv8m`); process.exit(2);
}
const KEYS = ['samples', 'underruns', 'music_events', 'sfx_starts', 'synthhash', 'mixhash', 'frames'];
const REF = JSON.parse(readFileSync(join(root, 'tools/floor/audio-ref.json'), 'utf8'));
const fmt = v => Math.round(v).toLocaleString('en-US');
const fails = [];

// run-floor.sh on the zero-copy build in a build directory of its own
// (--variant): under run-tests.sh --jobs this leg may overlap the -zc legs,
// and two makes in one directory race
function runFloor(isa, extra, out, list = demos) {
    return new Promise(res => {
        const a = [join(CM, 'run-floor.sh'), isa, '--zero-copy', '--demos', list.join(','), '--out', out, ...extra];
        // the build is make -s in one job by default: give it the cores
        const p = spawn('bash', a, { env: { ...process.env, MAKEFLAGS: process.env.MAKEFLAGS ?? '-j8' }, stdio: ['ignore', 'pipe', 'pipe'] });
        let log = '';
        p.stdout.on('data', d => (log += d));
        p.stderr.on('data', d => (log += d));
        p.on('close', code => res({ code, log }));
    });
}
const lineOf = a => KEYS.map(k => `${k}=${a[k]}`).join(' ');
const logOf = (dir, name, mode) => parseLog(readFileSync(join(dir, `${name}.${mode}.log`), 'utf8'), `${name}.${mode}.log`).demos[0];

// one ISA: off, on (one build directory, so one after the other), then the red
async function oneIsa(isa) {
    const base = join(CM, `out/audio-check-${isa}`), off = join(base, 'off'), on = join(base, 'on');
    const r = { isa, lines: [] };
    for (const [dir, extra] of [[off, ['--variant', 'snd']], [on, ['--variant', 'snd', '--audio']]]) {
        const { code, log } = await runFloor(isa, extra, dir);
        const verdict = log.split('\n').filter(l => /^(DEMAND|FAIL)/.test(l)).pop() ?? '';
        if (code !== 0 || !new RegExp(`^DEMAND floor: .*correct: sim and render hashes match on all ${demos.length}\\)`).test(verdict)) {
            fails.push(`${isa} ${extra.includes('--audio') ? 'with' : 'without'} the sound: run-floor.sh exited ${code}: ${verdict || log.trim().split('\n').pop()}`);
            return r;
        }
    }
    // the AUDIO lines
    let matched = 0;
    for (const name of demos)
        for (const m of ['A', 'B']) {
            const a = logOf(on, name, m).audio, z = logOf(off, name, m).audio;
            if (lineOf(a) === REF[name]) matched++;
            else fails.push(`${isa} ${name}.${m}: AUDIO ${lineOf(a)}, tools/floor/audio-ref.json says ${REF[name]}`);
            if (KEYS.some(k => !/^0+$/.test(z[k]))) fails.push(`${isa} ${name}.${m} without the sound: AUDIO ${lineOf(z)} (not 0)`);
        }
    r.matched = matched;
    // wrongref: the comparison must see one digit
    const wrong = Object.fromEntries(demos.map(n => [n, REF[n].replace(/synthhash=(.)/, (s, c) => `synthhash=${c === '0' ? '1' : '0'}`)]));
    const seen = demos.filter(n => lineOf(logOf(on, n, 'B').audio) !== wrong[n]).length;
    if (seen === demos.length) r.lines.push(`  red-proof wrongref ${isa}: a reference with one synthhash digit changed: ${seen} of ${demos.length} demos differ, as required`);
    else fails.push(`${isa}: red-proof wrongref: only ${seen} of ${demos.length} demos differ from a wrong reference`);
    // the figures, from the timing runs
    let n = 0, sOn = 0, sOff = 0, sD = 0, wOn = null, wOff = null, dMax = null, dMin = null;
    for (const name of demos) {
        const A = logOf(on, name, 'B'), Z = logOf(off, name, 'B');
        if (A.rows.length !== Z.rows.length || A.final.sim !== Z.final.sim || A.final.render !== Z.final.render) {
            fails.push(`${isa} ${name}: the timing runs differ (${A.rows.length} vs ${Z.rows.length} tics, ${A.final.sim}:${A.final.render} vs ${Z.final.sim}:${Z.final.render})`);
            continue;
        }
        A.rows.forEach((t, i) => {
            if (t.load || Z.rows[i].load) return;
            const z = Z.rows[i].elapsed, d = t.elapsed - z;
            n++; sOn += t.elapsed; sOff += z; sD += d;
            if (!wOn || t.elapsed > wOn.v) wOn = { v: t.elapsed, at: `${name} tic ${i}`, game: z };
            if (!wOff || z > wOff.v) wOff = { v: z, at: `${name} tic ${i}`, all: t.elapsed };
            if (!dMax || d > dMax.v) dMax = { v: d, at: `${name} tic ${i}` };
            if (!dMin || d < dMin.v) dMin = { v: d, at: `${name} tic ${i}` };
        });
    }
    if (!n) { fails.push(`${isa}: no graded tic to measure`); return r; }
    Object.assign(r, { n, meanOn: sOn / n, meanOff: sOff / n, meanD: sD / n, wOn, wOff, dMax, dMin });
    r.lines.unshift(
        `  ${isa}: AUDIO == tools/floor/audio-ref.json in ${matched} of ${demos.length * 2} logs (mode A and B of ${demos.join(', ')})`,
        `  ${isa}: game alone  mean ${fmt(r.meanOff)}, worst ${fmt(wOff.v)} (${wOff.at}; ${fmt(wOff.all)} with the sound)`,
        `  ${isa}: with sound  mean ${fmt(r.meanOn)}, worst ${fmt(wOn.v)} (${wOn.at}; the game alone ${fmt(wOn.game)})`,
        `  ${isa}: the sound   mean ${fmt(r.meanD)} a graded tic, max ${fmt(dMax.v)} (${dMax.at}), min ${fmt(dMin.v)} (${dMin.at}), over ${fmt(n)} graded tics`);
    // redsynth: a wrong synth on the board must read as one
    if (RED) {
        const red = join(base, 'redsynth');
        const { code, log } = await runFloor(isa, ['--audio', '--correctness', '--variant', 'redsynth', '--cflags', '-DFS_AUDIO_REDPROOF_SYNTH'],
                                             red, ['doom-demo4']);
        const f = join(red, 'doom-demo4.A.log');
        if (code !== 0 || !existsSync(f)) { fails.push(`${isa}: red-proof redsynth did not run (run-floor.sh exited ${code}: ${log.trim().split('\n').pop()})`); return r; }
        const a = logOf(red, 'doom-demo4', 'A').audio, ref = Object.fromEntries(REF['doom-demo4'].split(' ').map(kv => kv.split('=')));
        if (a.synthhash !== ref.synthhash && a.mixhash === ref.mixhash && a.samples === ref.samples)
            r.lines.push(`  red-proof redsynth ${isa}: one music sample in 4,096 one step off: synthhash ${a.synthhash}, the reference's ${ref.synthhash} (mixhash ${a.mixhash} equal): caught`);
        else fails.push(`${isa}: red-proof redsynth NOT CAUGHT: AUDIO ${lineOf(a)} against ${REF['doom-demo4']}`);
    }
    return r;
}

for (const n of demos) if (!REF[n]) fails.push(`tools/floor/audio-ref.json has no ${n}`);
if (fails.length) { for (const f of fails) console.log(`FAIL audio-check: ${f}`); process.exit(1); }
const t0 = Date.now();
const res = await Promise.all(isas.map(oneIsa));
for (const r of res) for (const l of r.lines) console.log(l);
if (fails.length) { for (const f of fails) console.log(`FAIL audio-check: ${f}`); process.exit(1); }
const reds = res.reduce((a, r) => a + r.lines.filter(l => /red-proof .*(as required|caught)$/.test(l)).length, 0);
console.log(`PASS audio-check: ${demos.length === 1 ? demos[0] : `${demos.length} demos`} with the sound on ${isas.join(' and ')}, AUDIO == audio-ref.json in every log; ` +
            res.map(r => `${r.isa} the sound ${fmt(r.meanD)} mean / ${fmt(r.dMax.v)} max a tic, worst tic ${fmt(r.wOn.v)} with it`).join('; ') +
            `; ${reds} red-proofs caught (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
