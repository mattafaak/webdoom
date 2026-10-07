#!/usr/bin/env node
// tools/cortexm/demand-table.mjs — the demand table: what one tic of webdoom
// costs, per ISA, from the floor logs the legs wrote.
//
//   x86       tools/floor/out-x86/*.B.log           (bash tools/floor/run-x86.sh)
//   ARMv6-M   tools/cortexm/out/armv6m<opt>/        (run-floor.sh armv6m [--opt])
//   ARMv8-M   tools/cortexm/out/armv8m<opt>/        (run-floor.sh armv8m [--opt])
//   helpers   tools/cortexm/out/<isa><opt>-count/   (run-floor.sh <isa> --count)
//
// Every number is read from a log, a stats file or an ELF; nothing is typed in.
// A graded tic is one the floor gate grades (no L flag); means are over graded
// tics, from the timing (mode B) run.  The stage split is the engine's own
// brackets (d_main.c, r_main.c): sim = G_Ticker, frame = view setup, bsp, planes,
// masked; other = the tic minus the five (status bar, HUD, NetUpdate, sound).
// x86's split comes from fs-doom -attrib (all tics, load tics included), so the
// ARM split is also given over all tics, beside the graded-tic one.
//
// usage: node tools/cortexm/demand-table.mjs [--opt -O1,-O2] [--x86-attrib]
//   --x86-attrib  (re)run fs-doom -attrib on the 13 demos, pinned to a P-core,
//                 into tools/cortexm/out/x86-attrib/ (13 runs, ~10 s)
// Copyright (C) 2026, GPL-2.0-or-later.
import { readFileSync, existsSync, mkdirSync, readdirSync, symlinkSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLog, DEMOS } from '../floor/floor-gate.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CM = join(root, 'tools/cortexm');
const args = process.argv.slice(2);
const opts = (args.includes('--opt') ? args[args.indexOf('--opt') + 1] : '-O1,-O2').split(',');
const fmt = v => Math.round(v).toLocaleString('en-US');
const fails = [];

// ── per-demo demand from mode-B logs ─────────────────────────────────────────
function demand(dir) {
    const per = {};
    let all = [], worst = null;
    for (const name of DEMOS) {
        const f = join(dir, `${name}.B.log`);
        if (!existsSync(f)) { fails.push(`no ${f}`); continue; }
        const { header, demos } = parseLog(readFileSync(f, 'utf8'), f);
        const d = demos[0];
        const g = d.rows.filter(r => !r.load);
        const w = g.reduce((a, r) => (r.elapsed > a.elapsed ? r : a), g[0]);
        per[name] = { mean: g.reduce((s, r) => s + r.elapsed, 0) / g.length, worst: w, n: g.length, header, rows: d.rows };
        all = all.concat(g.map(r => r.elapsed));
        if (!worst || w.elapsed > worst.elapsed) worst = { ...w, name };
    }
    return { per, worst, mean: all.reduce((a, b) => a + b, 0) / all.length, n: all.length };
}

// ── stats files: stages, helpers, stack ──────────────────────────────────────
function stats(dir, name) {
    const f = join(dir, `${name}.B.stats`);
    if (!existsSync(f)) return null;
    const lines = readFileSync(f, 'utf8').split('\n');
    const helpers = (lines.find(l => l.startsWith('HELPERS')) || 'HELPERS').split(' ').slice(1);
    const stack = Object.fromEntries((lines.find(l => l.startsWith('STACK')) || '').split(' ').slice(1).map(kv => kv.split('=')).map(([k, v]) => [k, +v]));
    const S = lines.filter(l => l.startsWith('S ')).map(l => l.split(' ').slice(1).map(Number));
    return { helpers, stack, S };
}
function stackPeaks(dir) {
    let init = { v: -1 }, demo = { v: -1 };
    for (const name of DEMOS)
        for (const m of ['A', 'B']) {
            const f = join(dir, `${name}.${m}.stats`);
            if (!existsSync(f)) continue;
            const l = readFileSync(f, 'utf8').split('\n').find(x => x.startsWith('STACK'));
            const kv = Object.fromEntries(l.split(' ').slice(1).map(x => x.split('=')));
            if (+kv.init > init.v) init = { v: +kv.init, name };
            if (+kv.demo > demo.v) demo = { v: +kv.demo, name };
        }
    return { init, demo };
}

const STAGES = ['sim', 'frame', 'bsp', 'planes', 'masked'];
function stageSplit(dir, dm) {
    // over graded tics, over all tics, and at the worst graded tic
    const tot = { g: Array(6).fill(0), a: Array(6).fill(0), ng: 0, na: 0 };
    let atWorst = null;
    for (const name of DEMOS) {
        const st = stats(dir, name), p = dm.per[name];
        if (!st || !p) continue;
        p.rows.forEach((r, i) => {
            const s = st.S[i].slice(1, 6), other = r.elapsed - s.reduce((a, b) => a + b, 0);
            const v = [...s, other];
            v.forEach((x, k) => { tot.a[k] += x; if (!r.load) tot.g[k] += x; });
            tot.na++; if (!r.load) tot.ng++;
            if (name === dm.worst.name && i === dm.worst.i) atWorst = v;
        });
    }
    return { g: tot.g.map(x => x / tot.ng), a: tot.a.map(x => x / tot.na), atWorst };
}

function helperCounts(dir, dm) {
    const out = {};
    let atWorst = null;
    for (const name of DEMOS) {
        const st = stats(dir, name);
        if (!st) { fails.push(`no helper stats ${dir}/${name}.B.stats`); continue; }
        const log = parseLog(readFileSync(join(dir, `${name}.B.log`), 'utf8')).demos[0];
        st.helpers.forEach((h, j) => {
            const o = (out[h] ??= { sum: 0, max: 0, n: 0, maxAt: '' });
            log.rows.forEach((r, i) => {
                if (r.load) return;
                const v = st.S[i][6 + j];
                o.sum += v; o.n++;
                if (v > o.max) { o.max = v; o.maxAt = `${name} tic ${i}`; }
            });
        });
        if (dm && name === dm.worst.name) atWorst = Object.fromEntries(st.helpers.map((h, j) => [h, st.S[dm.worst.i][6 + j]]));
    }
    return { out, atWorst };
}

function sizes(elf) {
    const A = execFileSync('arm-none-eabi-size', ['-A', elf], { encoding: 'utf8' });
    const sec = Object.fromEntries(A.split('\n').map(l => l.trim().split(/\s+/)).filter(x => x.length === 3 && x[0].startsWith('.')).map(x => [x[0], +x[1]]));
    const nm = execFileSync('arm-none-eabi-nm', ['-S', elf], { encoding: 'utf8' });
    const sym = n => { const m = new RegExp(`^\\S+ (\\S+) \\S ${n}$`, 'm').exec(nm); return m ? parseInt(m[1], 16) : 0; };
    return { text: sec['.text'], data: sec['.data'], bss: sec['.bss'], zone: sec['.zone'],
             screens: sym('fs_screenbufs') + sym('fs_screenbuf'), big: sec['.big'], heap: sec['.heap'], stack: sec['.stack'] };
}

// ── x86 attrib (fs-doom -attrib), optional ───────────────────────────────────
const X86A = join(CM, 'out/x86-attrib');
if (args.includes('--x86-attrib')) {
    const fsd = join(root, 'tools/freestanding/fs-doom');
    rmSync(X86A, { recursive: true, force: true });
    mkdirSync(X86A, { recursive: true });
    const cpus = existsSync('/sys/devices/cpu_core/cpus') ? readFileSync('/sys/devices/cpu_core/cpus', 'utf8').trim().split(/[,-]/)[0] : '0';
    const W = { doom: ['doom.wad', 'doomu.wad'], doom2: ['doom2.wad', 'doom2.wad'], tnt: ['tnt.wad', 'tnt.wad'], plutonia: ['plutonia.wad', 'plutonia.wad'] };
    for (const name of DEMOS) {
        const [iwad, demo] = name.split('-'), [src, as] = W[iwad];
        mkdirSync(join(X86A, name), { recursive: true });
        symlinkSync(join(root, 'wads/lib', src), join(X86A, name, as));
        execFileSync('taskset', ['-c', cpus, fsd, join(X86A, name, as), '-timedemo', demo, '-attrib', join(X86A, `${name}.json`)],
                     { env: { ...process.env, WD_CYCLES: '1' }, stdio: ['ignore', 'ignore', 'ignore'] });
    }
}
function x86Split() {
    if (!existsSync(X86A)) return null;
    let tot = Array(6).fill(0), n = 0;
    for (const name of DEMOS) {
        const f = join(X86A, `${name}.json`);
        if (!existsSync(f)) return null;
        const j = JSON.parse(readFileSync(f, 'utf8'));
        const v = [...STAGES.map(s => j.stages[s].mean), j.stages.other.mean];
        v.forEach((x, k) => (tot[k] += x * j.tics));
        n += j.tics;
    }
    return tot.map(x => x / n);
}

// ── the report ───────────────────────────────────────────────────────────────
const rows = [];
const x86 = demand(join(root, 'tools/floor/out-x86'));
rows.push({ label: 'x86 (fs-doom, gcc -m32 -O1, host)', dm: x86, split: x86Split() ? { a: x86Split() } : null });
for (const isa of ['armv6m', 'armv8m'])
    for (const o of opts) {
        const dir = join(CM, `out/${isa}${o}`);
        if (!existsSync(dir)) { fails.push(`no ${dir} (run: bash tools/cortexm/run-floor.sh ${isa} --opt ${o})`); continue; }
        const dm = demand(dir);
        rows.push({ label: `${isa === 'armv6m' ? 'ARMv6-M (cortex-m0plus code on mps2-an385)' : 'ARMv8-M (cortex-m33 on mps2-an505)'} ${o}`,
                    isa, o, dm, split: stageSplit(dir, dm), stack: stackPeaks(dir), size: sizes(join(CM, `build/${isa}${o}/cm-doom.elf`)),
                    helpers: existsSync(join(CM, `out/${isa}${o}-count`)) ? helperCounts(join(CM, `out/${isa}${o}-count`), dm) : null,
                    header: dm.per[DEMOS[0]]?.header });
    }

const P = s => console.log(s);
P('DEMAND TABLE — instructions per tic, mode-B (timing) runs, graded tics only unless stated');
P(`(x86: perf_event_open user-mode instructions; ARM: qemu -icount shift=0 timer steps x insn/step)\n`);
P(['demo', ...rows.map(r => r.label.split(' (')[0] + (r.o ? ' ' + r.o : ''))].map((s, k) => (k ? s.padStart(22) : s.padEnd(15))).join(''));
for (const name of DEMOS)
    P([name, ...rows.map(r => { const p = r.dm.per[name]; return p ? `${fmt(p.mean)} / ${fmt(p.worst.elapsed)}` : '-'; })].map((s, k) => (k ? s.padStart(22) : s.padEnd(15))).join(''));
P('  (each cell: mean / worst graded tic)');
for (const r of rows) {
    P(`\n== ${r.label}${r.header ? `  [target=${r.header.target} build=${r.header.build}]` : ''}`);
    P(`  graded tics ${r.dm.n}; mean ${fmt(r.dm.mean)}; worst ${fmt(r.dm.worst.elapsed)} at ${r.dm.worst.name} tic ${r.dm.worst.i}${r.dm.worst.mbytes ? ` (M:${r.dm.worst.mbytes} B copied from the WAD in that tic)` : ''}`);
    if (r.split) {
        const lab = [...STAGES, 'other'];
        if (r.split.g) P(`  stage mean, graded tics: ${lab.map((s, k) => `${s} ${fmt(r.split.g[k])}`).join(', ')}`);
        if (r.split.a) P(`  stage mean, all tics:    ${lab.map((s, k) => `${s} ${fmt(r.split.a[k])}`).join(', ')}`);
        if (r.split.atWorst) P(`  stages at the worst tic: ${lab.map((s, k) => `${s} ${fmt(r.split.atWorst[k])}`).join(', ')}`);
    } else P('  stage split: none (run with --x86-attrib)');
    if (r.size) {
        const s = r.size;
        P(`  size (B): text ${fmt(s.text)} (code + rodata, newlib and libgcc included), data ${fmt(s.data)}, bss ${fmt(s.bss)}; ` +
          `zone ${fmt(s.zone)}, screens ${fmt(s.screens)} (in PSRAM .big ${fmt(s.big)} with the harness's per-tic arrays), heap ${fmt(s.heap)}, stack region ${fmt(s.stack)}`);
    }
    if (r.stack) P(`  peak stack (painted): D_DoomMain ${fmt(r.stack.init.v)} B (deepest: ${r.stack.init.name}), demo loop ${fmt(r.stack.demo.v)} B (deepest: ${r.stack.demo.name})`);
    if (r.helpers) {
        const h = Object.entries(r.helpers.out).filter(([, o]) => o.sum > 0);
        P(`  libgcc helper calls per graded tic (counting build; mean / max at):`);
        for (const [name, o] of h) P(`    ${name.padEnd(18)} ${(o.sum / o.n).toFixed(2).padStart(10)} / ${fmt(o.max).padStart(7)}  (${o.maxAt})${r.helpers.atWorst ? `   at the worst tic: ${fmt(r.helpers.atWorst[name])}` : ''}`);
        const z = Object.entries(r.helpers.out).filter(([, o]) => o.sum === 0).map(([n]) => n);
        if (z.length) P(`    linked but never called in a graded tic: ${z.join(' ')}`);
    }
}
if (fails.length) { for (const f of fails) P(`FAIL demand-table: ${f}`); process.exit(1); }
P(`\nPASS demand-table: ${rows.length} builds over ${DEMOS.length} demos`);
