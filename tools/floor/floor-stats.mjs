#!/usr/bin/env node
// floor-stats: what a directory of FLOOR logs says, beyond the gate's verdict.
// Evidence for a reader, never a verdict: the floor verdict is floor-gate.mjs.
//
//   node tools/floor/floor-stats.mjs [--top N] [--against DIR] OUT_DIR
//       Mode B logs (<demo>.B1.log, .B2.log) and their stage tables
//       (<demo>.B1.stages, written by tools/floor/run-n64.sh): per demo, the
//       graded tics' mean, p99 and worst; whether the two timing runs agree;
//       the N worst graded tics with the engine's stage split; the cost of
//       the tics that copied WAD bytes (M:<bytes>); and the CPU-only
//       PREDICTED line: the worst graded tic against unit_hz/35 with audio
//       left out, which the gate itself never prints while audio is missing.
//       --against DIR compares every tic with the same tic in DIR (same demos,
//       another build), e.g. PI DMA against the word-by-word copy.
//
// Copyright (C) 2026, GPL-2.0-or-later.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseLog } from './floor-gate.mjs';

const args = process.argv.slice(2);
let top = 10, against = null, dir = null;
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--top') top = +args[++i];
    else if (args[i] === '--against') against = args[++i];
    else if (args[i].startsWith('--')) { console.error(`floor-stats: unknown flag ${args[i]}`); process.exit(2); }
    else dir = args[i];
}
if (!dir) { console.error('usage: floor-stats.mjs [--top N] [--against DIR] OUT_DIR'); process.exit(2); }

const fmt = v => Math.round(v).toLocaleString('en-US');
const pct = (a, b) => b ? `${(100 * a / b).toFixed(1)}%` : '-';
const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
const STAGES = ['sim', 'frame', 'bsp', 'planes', 'masked'];

// <demo>.<run>.log -> { name, run, log, stages: [[sim..masked] per tic] | null }
function readRuns(d, re) {
    const out = [];
    for (const f of readdirSync(d).filter(f => re.test(f)).sort()) {
        const [name, run] = f.replace(/\.log$/, '').split('.');
        const log = parseLog(readFileSync(join(d, f), 'utf8'), f);
        const sf = join(d, f.replace(/\.log$/, '.stages'));
        let stages = null;
        if (existsSync(sf)) {
            stages = [];
            for (const l of readFileSync(sf, 'utf8').split('\n')) {
                const m = /^S (\d+) (\d+) (\d+) (\d+) (\d+) (\d+)$/.exec(l);
                if (m) stages[+m[1]] = m.slice(2).map(Number);
            }
        }
        out.push({ name, run, log, demo: log.demos[0], stages });
    }
    return out;
}

const runs = readRuns(dir, /\.B\d\.log$/);
if (!runs.length) { console.log(`floor-stats: no mode B logs in ${dir}`); process.exit(1); }
const h = runs[0].log.header;
const budget = Math.floor(Number(h.unit_hz) / 35);
const ms = v => (1000 * v / Number(h.unit_hz)).toFixed(2);
console.log(`floor-stats: ${runs.length} timing run(s), target=${h.target} source=${h.source} unit=${h.unit} build=${h.build} zone=${h.zone}; budget ${fmt(budget)} ${h.unit} per tic (35 Hz, ${ms(budget)} ms)`);
console.log('  not a verdict: evidence beside floor-gate.mjs');

// two runs of one demo: do they agree tic for tic?
const byName = new Map();
for (const r of runs) { if (!byName.has(r.name)) byName.set(r.name, []); byName.get(r.name).push(r); }
const all = [];
console.log(`\n  ${'demo'.padEnd(15)} ${'graded'.padStart(6)} ${'mean'.padStart(10)} ${'p99'.padStart(10)} ${'worst'.padStart(10)}  worst tic  ${'over budget'.padStart(13)}  runs`);
for (const [name, rs] of byName) {
    const r = rs[0], rows = r.demo.rows;
    const g = rows.filter(x => !x.load);
    const el = g.map(x => x.elapsed).sort((a, b) => a - b);
    const mean = el.reduce((a, b) => a + b, 0) / el.length;
    const w = g.reduce((a, b) => (b.elapsed > a.elapsed ? b : a));
    const over = g.filter(x => x.elapsed > budget).length;
    let agree = `${rs.length} run(s)`;
    if (rs.length > 1) {
        const diffs = rs.slice(1).map(o => o.demo.rows.reduce((n, x, i) => n + (x.elapsed !== rows[i]?.elapsed ? 1 : 0), 0));
        agree = diffs.every(d => d === 0) ? `${rs.length} runs identical` : `${rs.length} runs, ${Math.max(...diffs)} tics differ`;
    }
    console.log(`  ${name.padEnd(15)} ${String(g.length).padStart(6)} ${fmt(mean).padStart(10)} ${fmt(quantile(el, 0.99)).padStart(10)} ${fmt(w.elapsed).padStart(10)}  ${String(w.i).padStart(9)}  ${(over + ' ' + pct(over, g.length)).padStart(13)}  ${agree}`);
    for (const x of g) all.push({ ...x, name, st: r.stages ? r.stages[x.i] : null });
}

const allSorted = [...all].sort((a, b) => b.elapsed - a.elapsed);
const worst = allSorted[0];
const meanAll = all.reduce((a, b) => a + b.elapsed, 0) / all.length;
const overAll = all.filter(x => x.elapsed > budget).length;

// the stage split of the graded tics, and of the worst ones
if (all[0].st) {
    const sum = STAGES.map((_, k) => all.reduce((a, x) => a + x.st[k], 0));
    const other = all.reduce((a, x) => a + x.elapsed - x.st.reduce((p, q) => p + q, 0), 0);
    const tot = all.reduce((a, x) => a + x.elapsed, 0);
    console.log(`\n  stage share over all ${all.length} graded tics: ` +
        STAGES.map((s, k) => `${s} ${pct(sum[k], tot)}`).join(', ') + `, other ${pct(other, tot)}`);
    console.log(`  mean per graded tic: ` + STAGES.map((s, k) => `${s} ${fmt(sum[k] / all.length)}`).join(', ') + `, other ${fmt(other / all.length)} ${h.unit}`);
}
console.log(`\n  the ${top} worst graded tics (${h.unit}; stages from the engine's own brackets):`);
console.log(`    ${'demo'.padEnd(15)} ${'tic'.padStart(5)} ${'elapsed'.padStart(10)} ${'x budget'.padStart(8)} ` + STAGES.map(s => s.padStart(9)).join(' ') + ` ${'other'.padStart(8)}  WAD bytes`);
for (const x of allSorted.slice(0, top)) {
    const st = x.st ? x.st.map(v => fmt(v).padStart(9)).join(' ') + ' ' + fmt(x.elapsed - x.st.reduce((a, b) => a + b, 0)).padStart(8) : '(no stage table)';
    console.log(`    ${x.name.padEnd(15)} ${String(x.i).padStart(5)} ${fmt(x.elapsed).padStart(10)} ${(x.elapsed / budget).toFixed(2).padStart(8)} ${st}  ${x.mbytes || '-'}`);
}

// tics that copied bytes out of the WAD (zone cache misses)
const miss = all.filter(x => x.mbytes > 0), hit = all.filter(x => !x.mbytes);
if (miss.length) {
    const mm = miss.reduce((a, b) => a + b.elapsed, 0) / miss.length, mh = hit.reduce((a, b) => a + b.elapsed, 0) / hit.length;
    const mb = miss.reduce((a, b) => a + b.mbytes, 0) / miss.length;
    const big = miss.reduce((a, b) => (b.mbytes > a.mbytes ? b : a));
    console.log(`\n  WAD copies in graded tics: ${miss.length} of ${all.length} tics (${pct(miss.length, all.length)}), mean ${fmt(mb)} B; ` +
        `mean tic ${fmt(mm)} ${h.unit} with a copy, ${fmt(mh)} without; the largest: ${big.name} tic ${big.i}, ${fmt(big.mbytes)} B, ${fmt(big.elapsed)} ${h.unit}`);
}

// --against: the same tics in another build
if (against) {
    const other = readRuns(against, /\.B1\.log$/);
    const om = new Map(other.map(o => [o.name, o.demo.rows]));
    let n = 0, bytes = 0, delta = 0, nohit = 0, dh = 0, worstOther = 0, worstOtherAt = null;
    for (const x of all) {
        const o = om.get(x.name)?.[x.i];
        if (!o) continue;
        if (o.elapsed > worstOther) { worstOther = o.elapsed; worstOtherAt = `${x.name} tic ${x.i}`; }
        if (x.mbytes > 0) { n++; bytes += x.mbytes; delta += o.elapsed - x.elapsed; }
        else { nohit++; dh += o.elapsed - x.elapsed; }
    }
    // load tics too: they are where the big copies are
    let ln = 0, lbytes = 0, ldelta = 0;
    for (const r of runs.filter(r => r.run === 'B1'))
        for (const x of r.demo.rows.filter(x => x.load)) {
            const o = om.get(r.name)?.[x.i];
            if (o) { ln++; lbytes += x.mbytes; ldelta += o.elapsed - x.elapsed; }
        }
    console.log(`\n  against ${against} (${other[0]?.log.header.build}):`);
    console.log(`    graded tics with a WAD copy: ${n}, ${fmt(bytes)} B; that build took ${fmt(delta)} ${h.unit} more over them, ${(delta / Math.max(bytes, 1)).toFixed(2)} ${h.unit}/byte`);
    console.log(`    graded tics with no copy: ${nohit}, that build took ${fmt(dh)} ${h.unit} more in all (${(dh / Math.max(nohit, 1)).toFixed(1)} per tic)`);
    console.log(`    load tics: ${ln}, ${fmt(lbytes)} B; that build took ${fmt(ldelta)} ${h.unit} more, ${(ldelta / Math.max(lbytes, 1)).toFixed(2)} ${h.unit}/byte`);
    console.log(`    its worst graded tic: ${fmt(worstOther)} ${h.unit} (${worstOtherAt})`);
}

const over = worst.elapsed > budget;
console.log(`\n  CPU-only PREDICTED ${over ? 'FAIL' : 'PASS'} (not the gate's verdict: audio is not running): worst graded tic ` +
    `${fmt(worst.elapsed)} of ${fmt(budget)} ${h.unit} = ${ms(worst.elapsed)} of ${ms(budget)} ms ` +
    `(${(worst.elapsed / budget).toFixed(2)}x the budget), ${worst.name} tic ${worst.i}; ` +
    `mean ${fmt(meanAll)} (${(meanAll / budget).toFixed(2)}x); ${overAll} of ${all.length} graded tics over (${pct(overAll, all.length)}), over ${byName.size} demos`);
