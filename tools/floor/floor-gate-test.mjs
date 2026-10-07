#!/usr/bin/env node
// Red-proofs for tools/floor/floor-gate.mjs: each way a floor log can lie must
// FAIL, and say why.  The logs are synthetic, built from the committed goldens
// (so this runs with no build and no WADs): a hardware target whose every tic
// takes 1,000 units against a 2,000-unit budget, except each demo's tic 0, a
// 50,000-unit level load flagged L.
//
// The control comes first: that log must PASS, so every FAIL below is the
// mutation's, not a broken base.
//
// usage: node tools/floor/floor-gate-test.mjs
// Copyright (C) 2026, GPL-2.0-or-later.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLog, grade, DEMOS } from './floor-gate.mjs';
import { check, summary } from '../lib/report.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const hexes = name => {
    const t = JSON.parse(readFileSync(join(root, 'tools/golden', `${name}.json`), 'utf8')).trace;
    return typeof t === 'string' ? t.match(/.{8}/g) : t.map(v => (v >>> 0).toString(16).padStart(8, '0'));
};
const G = Object.fromEntries(DEMOS.map(n => [n, { sim: hexes(n), render: hexes(`${n}-render`) }]));

// One log: { mode, header overrides, per-demo tweak(rows, demo) }
function makeLog({ mode, source = 'hardware', unit_hz = 70000, view = 10, detail = 0, demos = DEMOS,
                   audio = {}, row = r => r }) {
    const out = [`FLOOR 1 target=synthetic source=${source} unit=count unit_hz=${unit_hz} build=test view=${view} detail=${detail} zone=4194304 precache=0 mode=${mode}`];
    for (const name of demos) {
        const g = G[name];
        out.push(`DEMO ${name} tics=${g.sim.length}`);
        for (let i = 0; i < g.sim.length; i++) {
            const r = row({ i, gametic: i + 1, elapsed: i === 0 ? 50000 : 1000, flags: i === 0 ? 'L' : '-',
                            sim: g.sim[i], render: g.render[i] }, name);
            out.push(`T ${r.i} ${r.gametic} ${r.elapsed} ${r.flags}${mode === 'A' ? ` ${r.sim} ${r.render}` : ''}`);
        }
        const a = { samples: 1000, underruns: 0, music_events: 5, sfx_starts: 9, synthhash: 'aaaaaaaa', mixhash: 'bbbbbbbb', frames: g.sim.length, ...audio };
        out.push(`AUDIO samples=${a.samples} underruns=${a.underruns} music_events=${a.music_events} sfx_starts=${a.sfx_starts} synthhash=${a.synthhash} mixhash=${a.mixhash} frames=${a.frames}`);
        out.push(`END ${name} final=${g.sim.at(-1)}:${g.render.at(-1)}`);
    }
    return out.join('\n') + '\n';
}

// Grade texts; return { ok, verdict, text } where text is every line joined.
function run(texts, opts = {}) {
    let logs;
    try { logs = texts.map((t, k) => ({ label: `log${k}`, log: parseLog(t, `log${k}`) })); }
    catch (e) { return { ok: false, verdict: 'FAIL', text: `FAIL ${e.message}` }; }
    const r = grade(logs, opts);
    return { ...r, text: r.lines.join('\n') };
}
const base = (o = {}) => [makeLog({ mode: 'A', ...o.a, ...o.all }), makeLog({ mode: 'B', ...o.b, ...o.all }), makeLog({ mode: 'B', ...o.b, ...o.all })];
const mustFail = (label, r, cause) =>
    check(`${label}: FAIL, naming the cause`, !r.ok && new RegExp(cause).test(r.text), r.text.split('\n').filter(l => /FAIL/.test(l)).slice(0, 2).join(' | ') || r.verdict);

// ── control ──────────────────────────────────────────────────────────────────
const ctl = run(base());
check('CONTROL: a well-formed hardware run of all 13 demos PASSES', ctl.ok && ctl.verdict === 'PASS', ctl.text.split('\n').at(-1));
check('CONTROL: its verdict names the worst graded tic and the budget', /worst graded tic 1,000 of 2,000 count/.test(ctl.text), ctl.text.split('\n').at(-1));

// ── the red-proofs ───────────────────────────────────────────────────────────
mustFail('an empty log', run(['']), 'empty');
{
    const [a, b1, b2] = base();
    const cut = a.split('\n').slice(0, -3).join('\n');            // the last demo loses its tail
    mustFail('a truncated log', run([cut, b1, b2]), 'truncated');
}
mustFail('a missing demo', run(base({ a: { demos: DEMOS.slice(1) } })), 'doom-demo1: no correctness');
mustFail('a sim hash corrupted at tic 123',
         run(base({ a: { row: (r, n) => (n === 'tnt-demo2' && r.i === 123 ? { ...r, sim: 'deadbeef' } : r) } })),
         'tnt-demo2: sim hash differs from the golden at tic 123');
{
    const frozen = {};                                            // a -nodraw run: the screen never changes
    const r = run(base({ a: { row: (r, n) => ({ ...r, render: (frozen[n] ??= r.render) }) } }));
    mustFail('a log written with -nodraw (render hash frozen)', r, 'render hash differs from the golden at tic \\d+');
}
mustFail('the load-tic rule turned off (L flags stripped)',
         run(base({ b: { row: r => ({ ...r, flags: '-' }) } })), 'FAIL floor: synthetic — worst graded tic 50,000 of 2,000 count \\(doom-demo1 tic 0\\)');
mustFail('a budget of 1 unit per tic', run(base({ all: { unit_hz: 35 } })), 'worst graded tic 1,000 of 1 count');
mustFail('an audio underrun', run(base({ b: { audio: { underruns: 1 } } })), 'audio underran 1 time');
mustFail('no music played (music_events=0)', run(base({ b: { audio: { music_events: 0 } } })), 'played no music');
mustFail('no sound effects started', run(base({ b: { audio: { sfx_starts: 0 } } })), 'started no sound effects');
mustFail('a view=11 run offered as graded', run(base({ all: { view: 11 } })), 'view=11 is not graded');
mustFail('a low-detail run offered as uncrippled', run(base({ all: { detail: 1 } })), 'low detail is not uncrippled');
{
    const r = run(base({ all: { source: 'emulator' } }));
    check('an emulator log that fits: PREDICTED PASS, never PASS', r.ok && r.verdict === 'PREDICTED PASS', r.verdict);
    mustFail('an emulator log presented for a hardware verdict', run(base({ all: { source: 'emulator' } }), { require: 'hardware' }), 'source=emulator cannot PASS');
}
mustFail('one timing run, where two are needed', run(base().slice(0, 2)), '1 timing \\(mode B\\) run\\(s\\), 2 needed');
{
    // An emulator counting work (unit_hz=0: instructions under qemu -icount)
    // is a DEMAND, like the host: one timing run, no audio required.  Its
    // control first, then the same log made to lie each way.
    const quiet = { music_events: 0, sfx_starts: 0, samples: 0 };
    const demand = (o = {}) => [makeLog({ mode: 'A', source: 'emulator', unit_hz: 0, audio: quiet, ...o.a }),
                                makeLog({ mode: 'B', source: 'emulator', unit_hz: 0, audio: quiet, ...o.b })];
    const r = run(demand());
    check('CONTROL: an emulator demand log (unit_hz=0, one timing run, no audio): DEMAND', r.ok && r.verdict === 'DEMAND', r.text.split('\n').at(-1));
    mustFail('an emulator demand log with a sim hash corrupted at tic 7',
             run(demand({ a: { row: (r, n) => (n === 'plutonia-demo1' && r.i === 7 ? { ...r, sim: '00c0ffee' } : r) } })),
             'plutonia-demo1: sim hash differs from the golden at tic 7');
    mustFail('an emulator demand log with no timing run', run(demand().slice(0, 1)), '0 timing \\(mode B\\) run\\(s\\), 1 needed');
    mustFail('an emulator log in a time unit (unit_hz>0) with no music',
             run(base({ all: { source: 'emulator' }, b: { audio: { music_events: 0 } } })), 'played no music');
}
mustFail('a tic that took 0 units (a counter that did not count)',
         run(base({ b: { row: (r, n) => (n === 'doom2-demo3' && r.i === 40 ? { ...r, elapsed: 0 } : r) } })), 'doom2-demo3 tic 40 took 0 count');
{
    const [a, b1] = base();
    const b2 = makeLog({ mode: 'B' }).replace(/^END doom-demo2 final=\S+$/m, 'END doom-demo2 final=00000000:00000000');
    mustFail('a timing run that ended in another state', run([a, b1, b2]), 'doom-demo2 ended in state 00000000:00000000');
}
{
    const [a, b1, b2] = base();
    mustFail('logs from two builds in one verdict', run([a, b1, b2.replace('build=test', 'build=other')]), 'build=other differs');
}

summary('the floor gate passes a well-formed run and fails each way a log can lie, naming the cause', { min: 20 });
