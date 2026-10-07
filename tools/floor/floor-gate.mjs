#!/usr/bin/env node
// The floor gate: does a target run webdoom uncrippled at full speed?
//
// Reads FLOOR logs (tools/floor/floor_log.h) from one target and build:
//   mode A  correctness: every tic's sim and render hash against the goldens;
//   mode B  timing, twice: every tic's elapsed time in the target's own units.
// and says, for the 13 IWAD demos:
//   PASS / FAIL          source=hardware: the worst graded tic of both timing
//                        runs fits unit_hz/35 (35 Hz), with audio running and
//                        no underruns;
//   PREDICTED PASS/FAIL  source=emulator: the same arithmetic, which is not a
//                        verdict (spec.md: timings come from real hardware);
//   DEMAND               source=host, or unit_hz=0 from any source (a count of
//                        work, e.g. instructions under qemu -icount, not a
//                        time): the worst graded tic in its own units.  One
//                        timing run suffices and audio is noted, not required:
//                        both are conditions of a verdict, and this is none.
// A tic is graded unless a level load, intermission or finale started in it
// (flag L).  Any correctness failure is a FAIL whatever the source.
//
// --correctness grades mode A alone and gives no floor verdict at all:
//   CORRECT              every tic's sim and render hash matches on every demo;
//                        timing and audio are not graded, so it can never read
//                        PASS or PREDICTED.  It is what a leg that holds a port
//                        to the goldens runs (n64-floor), not a floor result.
//
// usage: node tools/floor/floor-gate.mjs [--require hardware | --correctness]
//                                        [--demos a,b] [--golden-dir DIR] LOG...
// Exit 0 on PASS, PREDICTED, DEMAND and CORRECT; 1 on any FAIL; 2 on usage.
// Copyright (C) 2026, GPL-2.0-or-later.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEMOS = [
    'doom-demo1', 'doom-demo2', 'doom-demo3', 'doom-demo4',
    'doom2-demo1', 'doom2-demo2', 'doom2-demo3',
    'tnt-demo1', 'tnt-demo2', 'tnt-demo3',
    'plutonia-demo1', 'plutonia-demo2', 'plutonia-demo3',
];
const HEADER_KEYS = ['target', 'source', 'unit', 'unit_hz', 'build', 'view', 'detail', 'zone', 'precache', 'mode'];
const SAME_KEYS = HEADER_KEYS.filter(k => k !== 'mode');
const GRADED_VIEW = '10';

// Parse one log's text into { header, demos: [{ name, tics, rows, audio, final }] }
// or throw with the reason.
export function parseLog(text, label = 'log') {
    const lines = text.split('\n').filter(l => l.length);
    if (!lines.length) throw new Error(`${label}: empty`);
    const head = /^FLOOR 1 (.*)$/.exec(lines[0]);
    if (!head) throw new Error(`${label}: first line is not a FLOOR 1 header`);
    const header = Object.fromEntries(head[1].split(' ').map(kv => kv.split('=')));
    for (const k of HEADER_KEYS)
        if (header[k] === undefined) throw new Error(`${label}: header has no ${k}`);
    if (!['hardware', 'emulator', 'host'].includes(header.source))
        throw new Error(`${label}: unknown source=${header.source}`);
    if (!['A', 'B'].includes(header.mode)) throw new Error(`${label}: unknown mode=${header.mode}`);
    const demos = [];
    let cur = null;
    for (let n = 1; n < lines.length; n++) {
        const l = lines[n];
        let m;
        if ((m = /^DEMO (\S+) tics=(\d+)$/.exec(l))) {
            if (cur) throw new Error(`${label}: ${cur.name} has no END line (truncated)`);
            cur = { name: m[1], tics: +m[2], rows: [], audio: null, final: null };
        } else if ((m = /^T (\d+) (\d+) (\d+) (\S+)(?: ([0-9a-f]{8}) ([0-9a-f]{8}))?$/.exec(l))) {
            if (!cur) throw new Error(`${label}: a T line outside a DEMO block`);
            const i = +m[1];
            if (i !== cur.rows.length) throw new Error(`${label}: ${cur.name} tic ${i} out of order (expected ${cur.rows.length})`);
            const flags = m[4] === '-' ? [] : m[4].split(',');
            const miss = flags.find(f => f.startsWith('M:'));
            cur.rows.push({ i, gametic: +m[2], elapsed: Number(m[3]), load: flags.includes('L'),
                            mbytes: miss ? +miss.slice(2) : 0, sim: m[5] ?? null, render: m[6] ?? null });
        } else if ((m = /^AUDIO (.*)$/.exec(l))) {
            if (!cur) throw new Error(`${label}: an AUDIO line outside a DEMO block`);
            cur.audio = Object.fromEntries(m[1].split(' ').map(kv => kv.split('=')));
        } else if ((m = /^END (\S+) final=([0-9a-f]{8}):([0-9a-f]{8})$/.exec(l))) {
            if (!cur || cur.name !== m[1]) throw new Error(`${label}: END ${m[1]} without its DEMO`);
            cur.final = { sim: m[2], render: m[3] };
            demos.push(cur);
            cur = null;
        } else {
            throw new Error(`${label}: unreadable line ${n + 1}: ${l.slice(0, 60)}`);
        }
    }
    if (cur) throw new Error(`${label}: ${cur.name} has no END line (truncated)`);
    for (const d of demos) {
        if (d.rows.length !== d.tics) throw new Error(`${label}: ${d.name} has ${d.rows.length} of ${d.tics} tics (truncated)`);
        if (!d.audio) throw new Error(`${label}: ${d.name} has no AUDIO line`);
    }
    return { header, demos };
}

const goldenCache = new Map();
function golden(dir, name, kind) {
    const file = join(dir, `${name}${kind === 'render' ? '-render' : ''}.json`);
    if (!goldenCache.has(file)) {
        if (!existsSync(file)) throw new Error(`no golden ${file}`);
        const t = JSON.parse(readFileSync(file, 'utf8')).trace;
        goldenCache.set(file, typeof t === 'string' ? t.match(/.{8}/g) : t.map(v => (v >>> 0).toString(16).padStart(8, '0')));
    }
    return goldenCache.get(file);
}

// Grade a set of parsed logs.  Returns { verdict, lines, ok }.
export function grade(logs, { require = null, correctness = false, demos = DEMOS, goldenDir = join(root, 'tools/golden') } = {}) {
    const fails = [], notes = [];
    const fail = m => fails.push(`FAIL ${m}`);
    if (!logs.length) return { ok: false, verdict: 'FAIL', lines: ['FAIL no logs'] };

    const h0 = logs[0].log.header;
    for (const { log, label } of logs)
        for (const k of SAME_KEYS)
            if (log.header[k] !== h0[k]) fail(`${label}: ${k}=${log.header[k]} differs from ${logs[0].label} (${h0[k]}): one target and build per verdict`);
    if (h0.view !== GRADED_VIEW) fail(`view=${h0.view} is not graded: only screenblocks ${GRADED_VIEW} has render goldens (screenblocks 11 needs its own, decision D0)`);
    if (h0.detail !== '0') fail(`detail=${h0.detail}: low detail is not uncrippled`);

    // demo -> { A: demo, B: [demo, ...] }
    const by = new Map(demos.map(n => [n, { A: null, B: [] }]));
    for (const { log, label } of logs)
        for (const d of log.demos) {
            if (!by.has(d.name)) { fail(`${label}: ${d.name} is not one of the graded demos`); continue; }
            const slot = by.get(d.name);
            if (log.header.mode === 'A') {
                if (slot.A) fail(`${label}: a second correctness run of ${d.name}`);
                slot.A = { d, label };
            } else if (correctness) fail(`${label}: --correctness grades mode A logs only, and this is mode ${log.header.mode}`);
            else slot.B.push({ d, label });
        }

    // correctness: every tic of every demo against the goldens
    for (const [name, { A }] of by) {
        if (!A) { fail(`${name}: no correctness (mode A) run`); continue; }
        const { d, label } = A;
        let sim, ren;
        try { sim = golden(goldenDir, name, 'sim'); ren = golden(goldenDir, name, 'render'); }
        catch (e) { fail(`${name}: ${e.message}`); continue; }
        if (d.rows.length !== sim.length) { fail(`${name}: ${d.rows.length} tics, the golden has ${sim.length}`); continue; }
        const noHash = d.rows.findIndex(r => r.sim === null || r.render === null);
        if (noHash >= 0) { fail(`${name}: tic ${noHash} carries no hashes: a correctness run must hash every tic`); continue; }
        const badSim = d.rows.findIndex((r, i) => r.sim !== sim[i]);
        if (badSim >= 0) { fail(`${name}: sim hash differs from the golden at tic ${badSim} (${d.rows[badSim].sim} vs ${sim[badSim]})`); continue; }
        const badRen = d.rows.findIndex((r, i) => r.render !== ren[i]);
        if (badRen >= 0) fail(`${name}: render hash differs from the golden at tic ${badRen} (${d.rows[badRen].render} vs ${ren[badRen]}): a -nodraw run, another view or a render defect`);
    }

    const n = demos.length;
    if (correctness) {
        const tics = [...by.values()].reduce((t, { A }) => t + (A ? A.d.rows.length : 0), 0).toLocaleString('en-US');
        if (fails.length) return { ok: false, verdict: 'FAIL', lines: [...fails, `FAIL floor correctness: ${h0.target} — ${fails.length} problem(s) over ${n} demos`] };
        return { ok: true, verdict: 'CORRECT', lines: [`CORRECT floor: ${h0.target} — sim and render hashes match the goldens on all ${n} demos (${tics} tics); timing and audio not graded (--correctness)`] };
    }

    // timing: two runs of every demo, each ending where the correctness run ended
    // a time unit from a target is graded as timing; a demand log is not
    const timed = h0.source !== 'host' && Number(h0.unit_hz) > 0;
    const needRuns = timed ? 2 : 1;
    let worst = null, loadWorst = null, gradedTics = 0;
    for (const [name, { A, B }] of by) {
        if (B.length < needRuns) { fail(`${name}: ${B.length} timing (mode B) run(s), ${needRuns} needed`); continue; }
        for (const { d, label } of B) {
            if (A && d.rows.length !== A.d.rows.length) fail(`${label}: ${name} ran ${d.rows.length} tics, the correctness run ${A.d.rows.length}`);
            if (A && (d.final.sim !== A.d.final.sim || d.final.render !== A.d.final.render))
                fail(`${label}: ${name} ended in state ${d.final.sim}:${d.final.render}, the correctness run in ${A.d.final.sim}:${A.d.final.render}`);
            const zero = d.rows.find(r => r.elapsed === 0);
            if (zero) fail(`${label}: ${name} tic ${zero.i} took 0 ${h0.unit}: the counter was not counting (on a hybrid CPU, pin to a P-core)`);
            for (const r of d.rows) {
                if (r.load) { if (!loadWorst || r.elapsed > loadWorst.elapsed) loadWorst = { ...r, name }; continue; }
                gradedTics++;
                if (!worst || r.elapsed > worst.elapsed) worst = { ...r, name };
            }
            if (timed) {
                const a = d.audio, need = k => +a[k] > 0;
                if (+a.underruns > 0) fail(`${label}: ${name} audio underran ${a.underruns} time(s)`);
                if (!need('samples')) fail(`${label}: ${name} produced no audio samples`);
                if (!need('music_events')) fail(`${label}: ${name} played no music (music_events=0): uncrippled includes OPL2 music`);
                if (!need('sfx_starts')) fail(`${label}: ${name} started no sound effects`);
            }
        }
    }
    if (!timed && logs.some(({ log }) => log.demos.some(d => +d.audio.music_events === 0)))
        notes.push(`note: audio was not exercised in these ${h0.source} logs`);

    const at = w => w ? `${w.name} tic ${w.i}${w.mbytes ? `, ${w.mbytes} B from the WAD` : ''}` : 'none';
    const fmt = v => v === null ? '-' : v.toLocaleString('en-US');
    const lines = [...fails, ...notes];
    if (worst) lines.push(`  worst graded tic: ${fmt(worst.elapsed)} ${h0.unit} (${at(worst)}) over ${gradedTics} graded tics`);
    if (loadWorst) lines.push(`  worst load tic (not graded): ${fmt(loadWorst.elapsed)} ${h0.unit} (${at(loadWorst)})`);

    if (fails.length) return { ok: false, verdict: 'FAIL', lines: [...lines, `FAIL floor: ${h0.target} — ${fails.length} problem(s) over ${n} demos`] };
    if (require === 'hardware' && h0.source !== 'hardware')
        return { ok: false, verdict: 'FAIL', lines: [...lines, `FAIL floor: source=${h0.source} cannot PASS: only hardware timings are a verdict (spec.md)`] };

    const hz = Number(h0.unit_hz);
    if (h0.source === 'host' || !hz)
        return { ok: true, verdict: 'DEMAND', lines: [...lines, `DEMAND floor: ${h0.target} — worst graded tic ${fmt(worst?.elapsed ?? null)} ${h0.unit} over ${n} demos (correct: sim and render hashes match on all ${n})`] };
    const budget = Math.floor(hz / 35);
    const fits = worst.elapsed <= budget;
    const pct = ((budget - worst.elapsed) / budget * 100).toFixed(1);
    const what = `${h0.target} — worst graded tic ${fmt(worst.elapsed)} of ${fmt(budget)} ${h0.unit} (${at(worst)}), ${fits ? `${pct}% headroom` : `${(-pct).toFixed(1)}% over`}, over ${n} demos`;
    if (h0.source === 'emulator')
        return { ok: true, verdict: `PREDICTED ${fits ? 'PASS' : 'FAIL'}`, lines: [...lines, `PREDICTED ${fits ? 'PASS' : 'FAIL'} floor: ${what}`] };
    return { ok: fits, verdict: fits ? 'PASS' : 'FAIL', lines: [...lines, `${fits ? 'PASS' : 'FAIL'} floor: ${what}`] };
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const args = process.argv.slice(2);
    let require = null, correctness = false, demos = DEMOS, goldenDir;
    const files = [];
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--require') require = args[++i];
        else if (args[i] === '--correctness') correctness = true;
        else if (args[i] === '--demos') demos = args[++i].split(',');
        else if (args[i] === '--golden-dir') goldenDir = args[++i];
        else if (args[i].startsWith('--')) { console.error(`floor-gate: unknown flag ${args[i]}`); process.exit(2); }
        else files.push(args[i]);
    }
    if (require && require !== 'hardware') { console.error('floor-gate: --require takes "hardware"'); process.exit(2); }
    if (require && correctness) { console.error('floor-gate: --correctness gives no floor verdict, so it cannot --require one'); process.exit(2); }
    const logs = [];
    let bad = 0;
    for (const f of files) {
        try { logs.push({ label: f.split('/').pop(), log: parseLog(readFileSync(f, 'utf8'), f.split('/').pop()) }); }
        catch (e) { console.log(`FAIL ${e.message}`); bad++; }
    }
    if (bad) { console.log(`FAIL floor: ${bad} unreadable log(s)`); process.exit(1); }
    const r = grade(logs, { require, correctness, demos, ...(goldenDir ? { goldenDir } : {}) });
    for (const l of r.lines) console.log(l);
    process.exit(r.ok ? 0 : 1);
}
