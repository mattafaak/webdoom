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
// The same synthetic logs then drive tools/floor/floor-stats.mjs, the evidence
// tools/floor/run-n64.sh prints beside the verdict (after its timing runs, and
// alone for --timing-once and --xprof), which no leg ran before: two timing
// runs (B1, B2) with their stage tables, and the profiler's calibration
// (.X.cal).
//
// usage: node tools/floor/floor-gate-test.mjs
// Copyright (C) 2026, GPL-2.0-or-later.
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
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

// ── --correctness: mode A alone, never a floor verdict ───────────────────────
{
    const A = o => makeLog({ mode: 'A', source: 'emulator', ...o });
    const ok = run([A()], { correctness: true });
    check('CONTROL --correctness: a correct mode A run of all 13 demos reads CORRECT',
          ok.ok && ok.verdict === 'CORRECT' && /on all 13 demos \(44,580 tics\)/.test(ok.text), ok.text);
    check('--correctness never reads PASS or PREDICTED', !/PASS|PREDICTED/.test(ok.text), ok.text);
    const full = run([A()]);
    check('the same mode A log without --correctness still FAILs (no timing runs)',
          !full.ok && /0 timing \(mode B\) run\(s\), 2 needed/.test(full.text), full.verdict);
    mustFail('--correctness: a sim hash corrupted at tic 77',
             run([A({ row: (r, n) => (n === 'plutonia-demo3' && r.i === 77 ? { ...r, sim: '0badf00d' } : r) })], { correctness: true }),
             'plutonia-demo3: sim hash differs from the golden at tic 77');
    const frozen = {};
    mustFail('--correctness: a -nodraw run (render hash frozen)',
             run([A({ row: (r, n) => ({ ...r, render: (frozen[n] ??= r.render) }) })], { correctness: true }),
             'render hash differs from the golden at tic \\d+');
    mustFail('--correctness: a missing demo', run([A({ demos: DEMOS.slice(0, -1) })], { correctness: true }), 'plutonia-demo3: no correctness');
    mustFail('--correctness: a mode B log offered', run([A(), makeLog({ mode: 'B', source: 'emulator' })], { correctness: true }),
             '--correctness grades mode A logs only');
}

// ── floor-stats.mjs: the evidence beside the verdict ─────────────────────────
// Output directories laid out as run-n64.sh leaves them (<demo>.B1.log,
// <demo>.B2.log, <demo>.B1.stages; <demo>.X.cal, <demo>.X.xprof), floor-stats
// run on each as a child, its exit code and its lines read back.  Two demos;
// doom-demo1's tic 10 is the worst graded tic, 1,500 units, and copied 4,096
// WAD bytes (M:4096); every tic's stage table reads sim 100, frame 200, bsp
// 300, planes 100, masked 100.
{
    const STATS = join(root, 'tools/floor/floor-stats.mjs');
    const tmp = mkdtempSync(join(tmpdir(), 'floor-stats-test-'));
    process.on('exit', () => rmSync(tmp, { recursive: true, force: true }));
    let nd = 0;
    const dirOf = files => {
        const d = join(tmp, `d${nd++}`);
        mkdirSync(d);
        for (const [f, text] of Object.entries(files)) writeFileSync(join(d, f), text);
        return d;
    };
    const stats = (...argv) => {
        const r = spawnSync(process.execPath, [STATS, ...argv], { encoding: 'utf8' });
        return { code: r.status, text: `${r.stdout ?? ''}${r.stderr ?? ''}` };
    };
    const lastLine = t => t.trim().split('\n').at(-1);
    const TWO = DEMOS.slice(0, 2);
    const [D1, D2] = TWO;
    const stages = name => [`N64_STAGES_BEGIN ${name} ${G[name].sim.length} sim frame bsp planes masked`,
        ...G[name].sim.map((_, i) => `S ${i} 100 200 300 100 100`), `N64_STAGES_END ${name}`].join('\n') + '\n';
    const base = (r, n) => (n === D1 && r.i === 10 ? { ...r, elapsed: 1500, flags: 'M:4096' } : r);
    const and = f => (r, n) => f(base(r, n), n);
    // one log per demo per run, as run-n64.sh extracts them
    const timing = ({ b1 = base, b2 = base, withStages = true } = {}) => {
        const files = {};
        for (const n of TWO) {
            files[`${n}.B1.log`] = makeLog({ mode: 'B', demos: [n], row: b1 });
            files[`${n}.B2.log`] = makeLog({ mode: 'B', demos: [n], row: b2 });
            if (withStages) files[`${n}.B1.stages`] = stages(n);
        }
        return files;
    };
    const graded = TWO.reduce((a, n) => a + G[n].sim.length - 1, 0);

    // the control: two identical timing runs, every tic under budget
    const dir = dirOf(timing());
    const c = stats(dir);
    check('floor-stats CONTROL: two identical timing runs read "2 runs identical" for each demo, exit 0',
          c.code === 0 && TWO.every(n => new RegExp(`^  ${n} .* 2 runs identical$`, 'm').test(c.text)), c.text.slice(0, 400));
    check('floor-stats CONTROL: the CPU-only PREDICTED PASS names the worst graded tic and the budget',
          new RegExp(`CPU-only PREDICTED PASS .*worst graded tic 1,500 of 2,000 count .*${D1} tic 10;.* 0 of ${graded} graded tics over`).test(c.text),
          lastLine(c.text));
    const share = (100 * 100 * graded / (1000 * graded + 500)).toFixed(1);
    check(`floor-stats CONTROL: the stage share is the tables' (sim ${share}% of ${graded} graded tics)`,
          new RegExp(`stage share over all ${graded} graded tics: sim ${share.replace('.', '\\.')}%`).test(c.text),
          c.text.split('\n').find(l => /stage share/.test(l)) ?? 'no stage share line');
    check('floor-stats CONTROL: the one tic that copied WAD bytes is counted and named',
          new RegExp(`WAD copies in graded tics: 1 of ${graded} tics .* the largest: ${D1} tic 10, 4,096 B, 1,500 count`).test(c.text),
          c.text.split('\n').find(l => /WAD copies/.test(l)) ?? 'no WAD copies line');
    const tics = existsSync(join(dir, 'xprof-tics.txt')) ? readFileSync(join(dir, 'xprof-tics.txt'), 'utf8') : '';
    check('floor-stats CONTROL: xprof-tics.txt names the worst tic for run-n64.sh --xprof',
          new RegExp(`^${D1} (\\d+,)*10$`, 'm').test(tics) && new RegExp(`^${D2} \\d`, 'm').test(tics), JSON.stringify(tics));

    // the two timing runs disagree on three of doom-demo2's tics
    const d2 = stats(dirOf(timing({ b2: and((r, n) => (n === D2 && r.i >= 5 && r.i <= 7 ? { ...r, elapsed: 1001 } : r)) })));
    check('floor-stats: timing runs that differ on 3 tics say so, for that demo only',
          new RegExp(`^  ${D2} .* 2 runs, 3 tics differ$`, 'm').test(d2.text) && new RegExp(`^  ${D1} .* 2 runs identical$`, 'm').test(d2.text),
          d2.text.split('\n').filter(l => /runs/.test(l)).join(' | '));

    // a graded tic over the budget: PREDICTED FAIL, and still exit 0 (evidence, not a verdict)
    const over = and((r, n) => (n === D2 && r.i === 20 ? { ...r, elapsed: 2500 } : r));
    const o = stats(dirOf(timing({ b1: over, b2: over })));
    check('floor-stats: a graded tic over budget reads PREDICTED FAIL, naming it, and exits 0 (not a verdict)',
          o.code === 0 && new RegExp(`CPU-only PREDICTED FAIL .*worst graded tic 2,500 of 2,000 count .*\\(1\\.25x the budget\\), ${D2} tic 20;.* 1 of ${graded} graded tics over`).test(o.text),
          `exit ${o.code}: ${lastLine(o.text)}`);

    // --against: the same tics in another build, where the WAD copy costs 2 count a byte
    const dear = and((r, n) => (n === D1 && r.i === 10 ? { ...r, elapsed: 1500 + 2 * 4096 } : r));
    const other = dirOf(timing({ b1: dear, b2: dear, withStages: false }));
    const ag = stats('--against', other, dir);
    check('floor-stats --against: the other build\'s extra cost over the copying tics, per byte',
          ag.code === 0 && /graded tics with a WAD copy: 1, 4,096 B; that build took 8,192 count more over them, 2\.00 count\/byte/.test(ag.text) &&
          new RegExp(`graded tics with no copy: ${graded - 1}, that build took 0 count more in all`).test(ag.text),
          ag.text.split('\n').filter(l => /graded tics with/.test(l)).join(' | ') || lastLine(ag.text));

    const none = stats(dirOf({}));
    check('floor-stats: a directory with no timing runs exits 1, saying so',
          none.code === 1 && /no mode B logs/.test(none.text), `exit ${none.code}: ${lastLine(none.text)}`);

    // --xprof: the profiler's calibration against COUNT.  The loop is three
    // instructions an iteration; a run that agrees is within a cycle or two
    // of 2 x COUNT, and a skew of 1,000 iterations outside the profiler is
    // 3,000 cycles that COUNT saw and XPROF did not.
    const DETECT = x => `N64_XPROF_DETECT mask_hi=00000300 xprof=${x}`;
    const CAL = (iters, skew, cycles, count) =>
        `N64_XPROF_CAL iters=${iters} skew=${skew} count=${count} cycles=${cycles} insns=${3 * iters} icache_hits=0 icache_misses=0 dcache_misses=0`;
    const goodCal = [DETECT(1), CAL(10000, 0, 30001, 15000), CAL(100000, 0, 300002, 150000), CAL(1000000, 0, 3000001, 1500000)];
    const slot = (k, tic, s, cycles) => `${k} ${tic} ${s} calls=1 prim_calls=0 prim_px=0 cycles=${cycles} cycles_exc=0 ` +
        'icache_hits=900 icache_misses=10 icache_wb=0 dcache_hits=500 dcache_misses=20 dcache_wb=5 rsp_cycles=100 rsp_halted=40 ' +
        'icache_rd=320 icache_wr=0 dcache_rd=640 dcache_wr=80 uncached_rd=0 uncached_wr=0 spdma_rd=0 spdma_wr=0 ' +
        'pidma_rd=0 pidma_wr=0 vidma_rd=0 dpdraw_rd=0 dpdraw_wr=0';
    const profile = [`N64_XPROF_BEGIN ${D1} ok=1 profiled=1`, 'XT 10 elapsed=1500 flags=0 mbytes=4096',
                     slot('P', 10, 'whole', 3000), slot('P', 10, 'sim', 1000), slot('P', 10, 'bsp', 1200), `N64_XPROF_END ${D1}`];
    const xp = stats('--xprof', dirOf({ [`${D1}.X.cal`]: goodCal.join('\n') + '\n', [`${D1}.X.xprof`]: profile.join('\n') + '\n' }));
    check('floor-stats --xprof CONTROL: 3 calibration loops agree with COUNT, the profiled tic is printed, exit 0',
          xp.code === 0 && /PASS xprof: 3 calibration loop\(s\) agree with COUNT within 64 cycles/.test(xp.text) &&
          new RegExp(`${D1} tic 10: COUNT 1,500 \\(2x = 3,000 cycles\\), XPROF 3,000 cycles`).test(xp.text) &&
          /^ {4}other +800 +26\.7%/m.test(xp.text),
          `exit ${xp.code}: ${xp.text.split('\n').filter(l => /xprof|tic 10|other/.test(l)).join(' | ')}`);
    const skewed = stats('--xprof', dirOf({ [`${D1}.X.cal`]: [...goodCal.slice(0, 3), CAL(1000000, 1000, 3000001, 1501500)].join('\n') + '\n' }));
    check('floor-stats --xprof: a calibration skewed by 1,000 iterations (3,000 cycles) FAILs, exit 1',
          skewed.code === 1 && /FAIL calibration .*\+1000 outside the profiler.*difference -2999/.test(skewed.text) && /FAIL xprof: 1 problem\(s\)/.test(skewed.text),
          `exit ${skewed.code}: ${skewed.text.split('\n').filter(l => /FAIL|PASS/.test(l)).join(' | ')}`);
    const absent = stats('--xprof', dirOf({ [`${D1}.X.cal`]: [DETECT(0), ...goodCal.slice(1)].join('\n') + '\n' }));
    check('floor-stats --xprof: the profiler absent (xprof=0) FAILs, exit 1',
          absent.code === 1 && /the profiler is absent/.test(absent.text), `exit ${absent.code}: ${lastLine(absent.text)}`);
    const nocal = stats('--xprof', dirOf({ [`${D1}.X.xprof`]: profile.join('\n') + '\n' }));
    check('floor-stats --xprof: no calibration file FAILs, exit 1',
          nocal.code === 1 && /FAIL xprof: no calibration \(\.X\.cal\)/.test(nocal.text), `exit ${nocal.code}: ${lastLine(nocal.text)}`);
    const cut = stats('--xprof', dirOf({ [`${D1}.X.cal`]: goodCal.join('\n') + '\n', [`${D1}.X.xprof`]: profile.slice(0, -1).join('\n') + '\n' }));
    check('floor-stats --xprof: a profile with no END line FAILs as truncated, exit 1',
          cut.code === 1 && new RegExp(`FAIL xprof: ${D1}\\.X\\.xprof is truncated`).test(cut.text), `exit ${cut.code}: ${lastLine(cut.text)}`);
}

summary('the floor gate passes a well-formed run and fails each way a log can lie, naming the cause; floor-stats reads the timing runs, the stage tables and the profiler calibration',
        { min: 45 });
