#!/usr/bin/env node
// The wipe probe: what a melt wipe costs in the lean build, measured, not
// graded.  The floor's demand (floor-x86, floor-demand) cuts every wipe short
// and grades game tics only, so a wipe's own price is reported here.
//
// fs-doom-lean (tools/freestanding LEAN=1: LEAN_SCREENS, the wipe's two screens
// borrowed from the zone) runs the 13 demo-exit scenarios of
// tools/floor/play-set.mjs in -frames mode: every wipe run to its end on the
// wipe clock (one melt step per frame, one tic of melt each, as at 35 Hz),
// WD_CYCLES=1 (x86 instructions per frame, perf_event_open, each run pinned
// to a P-core: on an E-core the counter reads 0).  Each scenario has at least three wipes: the
// demo's opening one, level to intermission, and intermission (or Doom II's
// text screen) to the next level; a death's level reload adds one more.
//
// A wipe, in the record (i_main.c): its first frame draws the new screen,
// captures both screens (V_HoldScreen x2), turns them column-major and takes
// the first melt step (<wipe> 1, <wiping> 0); every later frame is one melt
// step (<wiping> 1), and the last one releases the screens (<wipe> 0).
// Reported per wipe, from the instructions inside the wipe's own functions
// (frames_wrap.c, so a level load in the same frame is not the wipe's): its
// first frame, its melt steps, the whole wipe; and the zone its two screen
// captures took (the W line: non-purgeable bytes after the end screen, less
// before the start screen).
//
// The verdict is REPORT, never PASS: a wipe is not graded.  It FAILs only if it
// measured nothing (no wipe, or a zero count: the counter on an E-core).  On a
// hybrid CPU that second check is red-proofed every run: one scenario pinned
// to an E-core must count zero and be caught.
//
// usage: node tools/floor/wipe-probe.mjs [--keep DIR] [--build lean|leanzc|default|zc]
// Copyright (C) 2026, GPL-2.0-or-later.
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as P from './play-set.mjs';

const args = process.argv.slice(2);
const opt = k => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
const BUILD = opt('--build') ?? 'lean';
const KEEP = opt('--keep');
const fail = m => { console.log(`FAIL wipe-probe: ${m}`); process.exit(1); };

let bin;
try { bin = P.buildX86(BUILD); } catch (e) { fail(e.message); }
const dir = KEEP ?? mkdtempSync(join(tmpdir(), 'webdoom-wipeprobe-'));
if (!KEEP) process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

// P-cores, one per job (as run-x86.sh)
const expand = r => r.split(',').flatMap(x => { const [a, b = a] = x.split('-').map(Number); return Array.from({ length: b - a + 1 }, (_, i) => a + i); });
const CPUS = existsSync('/sys/devices/cpu_core/cpus') ? expand(readFileSync('/sys/devices/cpu_core/cpus', 'utf8').trim()) : null;

const SC = P.scenarios(dir, { maps: [] }).filter(s => s.kind === 'exit');
const free = CPUS ? [...CPUS] : null;
const runs = await P.pool(SC.map(s => async () => {
    const cpu = free ? free.shift() : null;
    const r = await P.run(bin, s, P.REF_KB, dir, { WD_CYCLES: '1' }, cpu);
    if (free) free.push(cpu);
    return r;
}), CPUS ? CPUS.length : 8);

// the red-proof: on an E-core the counter reads 0, and the zero check must see it
let redproof = 'no E-cores here: not red-proofed';
if (existsSync('/sys/devices/cpu_atom/cpus')) {
    const e = expand(readFileSync('/sys/devices/cpu_atom/cpus', 'utf8').trim())[0];
    const r = await P.run(bin, SC[0], P.REF_KB, dir, { WD_CYCLES: '1' }, e);
    const counted = r.frames.filter(f => f.instr).length;
    if (!r.ok || counted) fail(`red-proof: ${SC[0].id} on E-core ${e} counted ${counted} of ${r.frames.length} frames: the zero check is not what catches an uncounted run`);
    redproof = `${SC[0].id} on E-core ${e} counted 0 of ${r.frames.length} frames, as the zero check expects`;
}

const med = a => { const b = [...a].sort((x, y) => x - y); return b.length ? b[b.length >> 1] : 0; };
const max = a => a.reduce((m, x) => Math.max(m, x), 0);
const fmt = n => Math.round(n).toLocaleString('en-US');
const wipes = [], game = [];
for (const r of runs) {
    if (!r.ok) fail(`${r.id} did not run to its end (${r.err || r.signal || `exit ${r.code}`})`);
    const ws = new Map(r.wipes.map(w => [w.frame, w]));
    const f = r.frames;
    for (let i = 0; i < f.length; i++) {
        const x = f[i];
        if (x.gs === 0 && !x.wipe && !x.wiping) game.push(x.instr);
        if (!(x.wipe && !x.wiping)) continue;
        // the wipe: this first frame, then every frame that began in it
        let j = i + 1;
        while (j < f.length && f[j].wiping) j++;
        const all = f.slice(i, j);
        const w = ws.get(x.n);
        if (!w) fail(`${r.id}: a wipe began at frame ${x.n} with no W line (frames_wrap.c not linked?)`);
        wipes.push({
            id: r.id, at: x.gametic, frames: all.length, ended: !f[j - 1].wipe,
            first: x.wipeInstr, firstFrame: x.instr,
            steps: all.slice(1).map(y => y.wipeInstr), stepFrames: all.slice(1).map(y => y.instr),
            own: all.reduce((a, y) => a + y.wipeInstr, 0), held: w.after - w.before,
        });
        i = j - 1;
    }
}
if (!wipes.length) fail('no wipe was recorded: the probe measured nothing');
if (wipes.some(w => !w.first || w.steps.some(n => !n)) || !max(game))
    fail('a wipe or a frame counted 0 instructions: the counter did not run (a P-core is needed)');
const unended = wipes.filter(w => !w.ended);
const steps = wipes.flatMap(w => w.steps), stepFrames = wipes.flatMap(w => w.stepFrames);
const worst = wipes.reduce((a, w) => (w.own > a.own ? w : a));
const helds = wipes.map(w => w.held);
console.log(`wipe-probe: fs-doom ${BUILD} (${bin.split('/').at(-1)}), ${runs.length} scenarios, ${wipes.length} wipes ` +
            `(${unended.length} still running at a demo's end), ${fmt(runs.reduce((a, r) => a + r.frames.length, 0))} frames`);
console.log(`  the wipe's own instructions (inside wipe_StartScreen, wipe_EndScreen and wipe_ScreenWipe, frames_wrap.c):`);
console.log(`    a melt step (one frame, one tic of melt): median ${fmt(med(steps))}, max ${fmt(max(steps))} over ${steps.length} steps; ` +
            `the whole frame around it: median ${fmt(med(stepFrames))}, max ${fmt(max(stepFrames))}`);
console.log(`    the first frame's share (both screens captured, made column-major, the first step): median ${fmt(med(wipes.map(w => w.first)))}, ` +
            `max ${fmt(max(wipes.map(w => w.first)))}; that whole frame (it also draws the new screen, often after a level load): ` +
            `median ${fmt(med(wipes.map(w => w.firstFrame)))}, max ${fmt(max(wipes.map(w => w.firstFrame)))}`);
console.log(`    a whole wipe: median ${fmt(med(wipes.map(w => w.own)))}, max ${fmt(worst.own)} (${worst.id} at gametic ${worst.at}); ` +
            `${med(wipes.map(w => w.frames))} frames median, ${Math.min(...wipes.map(w => w.frames))}-${max(wipes.map(w => w.frames))}`);
console.log(`  for scale, a game frame (level, no wipe): median ${fmt(med(game))}, max ${fmt(max(game))} x86 instructions over ${game.length} frames`);
console.log(`  zone the two screen captures took (non-purgeable bytes after the end screen less before the start screen): ` +
            `median ${fmt(med(helds))} B, min ${fmt(Math.min(...helds))} B, max ${fmt(max(helds))} B`);
console.log(`REPORT wipe-probe: a melt step is ${fmt(med(steps))} x86 instructions (max ${fmt(max(steps))}), a whole wipe ${fmt(med(wipes.map(w => w.own)))} ` +
            `(max ${fmt(worst.own)}) over ${med(wipes.map(w => w.frames))} frames, and it holds ${fmt(max(helds))} B of zone at most ` +
            `(${wipes.length} wipes measured in ${runs.length} scenarios, ${BUILD} build); red-proof: ${redproof}`);
