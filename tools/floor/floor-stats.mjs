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
//       Writes OUT_DIR/xprof-tics.txt: the worst tics, as run-n64.sh --xprof
//       takes them.
//
//   node tools/floor/floor-stats.mjs --xprof OUT_DIR
//       Profile runs (<demo>.X.cal, .X.xprof, .X.log): checks the profiler's
//       calibration against COUNT and prints each profiled tic's stages with
//       cycles, cache misses and RDRAM traffic.  Exit 1 if the calibration
//       disagrees or the profiler was absent.
//
// Copyright (C) 2026, GPL-2.0-or-later.
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseLog } from './floor-gate.mjs';

const args = process.argv.slice(2);
let top = 10, against = null, xprof = false, dir = null;
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--top') top = +args[++i];
    else if (args[i] === '--against') against = args[++i];
    else if (args[i] === '--xprof') xprof = true;
    else if (args[i].startsWith('--')) { console.error(`floor-stats: unknown flag ${args[i]}`); process.exit(2); }
    else dir = args[i];
}
if (!dir) { console.error('usage: floor-stats.mjs [--top N] [--against DIR] [--xprof] OUT_DIR'); process.exit(2); }

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

if (xprof) {
    process.exit(xprofReport(dir));
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

// the tics to profile: the global worst, and each demo's worst
const pick = new Map();
for (const x of allSorted.slice(0, 8)) { if (!pick.has(x.name)) pick.set(x.name, new Set()); pick.get(x.name).add(x.i); }
for (const [name] of byName) {
    const w = allSorted.find(x => x.name === name);
    if (!pick.has(name)) pick.set(name, new Set());
    pick.get(name).add(w.i);
}
writeFileSync(join(dir, 'xprof-tics.txt'), [...pick].map(([n, s]) => `${n} ${[...s].sort((a, b) => a - b).join(',')}`).join('\n') + '\n');

const over = worst.elapsed > budget;
console.log(`\n  CPU-only PREDICTED ${over ? 'FAIL' : 'PASS'} (not the gate's verdict: audio is not running): worst graded tic ` +
    `${fmt(worst.elapsed)} of ${fmt(budget)} ${h.unit} = ${ms(worst.elapsed)} of ${ms(budget)} ms ` +
    `(${(worst.elapsed / budget).toFixed(2)}x the budget), ${worst.name} tic ${worst.i}; ` +
    `mean ${fmt(meanAll)} (${(meanAll / budget).toFixed(2)}x); ${overAll} of ${all.length} graded tics over (${pct(overAll, all.length)}), over ${byName.size} demos`);
process.exit(0);

// ── --xprof ─────────────────────────────────────────────────────────────────
function kv(line) { return Object.fromEntries(line.split(' ').filter(t => t.includes('=')).map(t => t.split('='))); }
function xprofReport(d) {
    // Calibration: XPROF cpuCycles (93.75 MHz) against 2 x COUNT over the same
    // loop.  Measured |cycles - 2*count| is 1 under the recompiler and 2 under
    // ForceInterpreter; TOL allows for a few instructions between the two
    // reads.  A skew of 1,000 loop iterations (3,000 cycles) must fail.
    const TOL = 64;
    let bad = 0, nCal = 0;
    const cals = readdirSync(d).filter(f => f.endsWith('.X.cal')).sort();
    if (!cals.length) { console.log(`FAIL xprof: no calibration (.X.cal) in ${d}`); return 1; }
    for (const f of cals) {
        for (const l of readFileSync(join(d, f), 'utf8').split('\n').filter(Boolean)) {
            const v = kv(l);
            if (l.startsWith('N64_XPROF_DETECT')) {
                if (v.xprof !== '1') { console.log(`FAIL xprof: ${f}: the profiler is absent (XDETECT mask_hi=${v.mask_hi}; ares needs Developer/HomebrewMode=true)`); bad++; }
                continue;
            }
            nCal++;
            const c = +v.cycles, n2 = 2 * +v.count, diff = c - n2;
            const ok = Math.abs(diff) <= TOL;
            if (!ok) bad++;
            console.log(`  ${ok ? 'PASS' : 'FAIL'} calibration ${f.split('.')[0]}: ${fmt(+v.iters)} iterations (+${v.skew} outside the profiler): XPROF ${fmt(c)} cycles, 2 x COUNT ${fmt(n2)}, difference ${diff} (tolerance ${TOL}); ${fmt(+v.insns)} instructions`);
        }
    }
    if (!nCal) { console.log('FAIL xprof: no calibration loop ran'); return 1; }
    // The copy benchmark: 64,000 WAD bytes by the word path and by PI DMA.
    for (const f of readdirSync(d).filter(f => f.endsWith('.X.copy')).sort().slice(0, 1))
        for (const l of readFileSync(join(d, f), 'utf8').split('\n').filter(Boolean)) {
            const v = kv(l), b = +v.bytes;
            console.log(`  copy ${fmt(b)} B from the WAD, source offset ${v.src_offset}: word path ${fmt(+v.words_count)} count ` +
                `(${(+v.words_count / b).toFixed(2)}/B)` + (v.dma === '1' ? `, PI DMA ${fmt(+v.dma_count)} count (${(+v.dma_count / b).toFixed(2)}/B)` : ''));
        }
    for (const f of readdirSync(d).filter(f => f.endsWith('.X.xprof')).sort()) {
        const name = f.split('.')[0];
        const lines = readFileSync(join(d, f), 'utf8').split('\n');
        const head = lines.find(l => l.startsWith('N64_XPROF_BEGIN'));
        if (!head || !lines.some(l => l.startsWith('N64_XPROF_END'))) { console.log(`FAIL xprof: ${f} is truncated`); bad++; continue; }
        const tics = new Map();
        let cur = null;
        for (const l of lines) {
            let m;
            if ((m = /^XT (\d+) (.*)$/.exec(l))) { cur = { tic: +m[1], ...kv(m[2]), slots: {} }; tics.set(cur.tic, cur); }
            else if ((m = /^([PA]) (-?\d+) (\S+) (.*)$/.exec(l))) {
                const v = kv(m[4]);
                const o = m[1] === 'A' ? (tics.get(-1) ?? (tics.set(-1, { tic: -1, slots: {} }), tics.get(-1))) : tics.get(+m[2]);
                o.slots[m[3]] = v;
            }
        }
        for (const [tic, t] of tics) {
            const W = t.slots.whole;
            if (!W) continue;
            const whole = +W.cycles;
            const title = tic < 0 ? `${name}: every tic of the demo (aggregate)` : `${name} tic ${tic}: COUNT ${fmt(+t.elapsed)} (2x = ${fmt(2 * t.elapsed)} cycles), XPROF ${fmt(whole)} cycles, calls ${W.calls}`;
            console.log(`\n  ${title}`);
            console.log(`    ${'slot'.padEnd(12)} ${'cycles'.padStart(13)} ${'share'.padStart(6)} ${'D-miss'.padStart(10)} ${'D-wb'.padStart(9)} ${'I-miss'.padStart(8)} ${'miss cyc'.padStart(7)} ${'RDRAM B'.padStart(12)} ${'calls'.padStart(8)} ${'px/cols'.padStart(9)} ${'cyc/px'.padStart(7)}`);
            const order = ['whole', 'sim', 'frame', 'bsp', 'bsp.wall', 'bsp.col', 'planes', 'planes.span', 'planes.col', 'masked', 'masked.seg', 'masked.col', 'masked.fuzz', 'bsp.fuzz', 'other.draw'];
            for (const s of order) {
                const v = t.slots[s];
                if (!v || (+v.cycles === 0 && s !== 'whole')) continue;
                const cyc = +v.cycles;
                // ares's charges: a D-cache fill or writeback 40 cycles, an
                // I-cache fill 48 (n64/cpu/dcache.cpp, cpu.hpp)
                const missCyc = 40 * (+v.dcache_misses + +v.dcache_wb) + 48 * +v.icache_misses;
                const rd = ['icache_rd', 'icache_wr', 'dcache_rd', 'dcache_wr', 'uncached_rd', 'uncached_wr', 'spdma_rd', 'spdma_wr', 'pidma_rd', 'pidma_wr', 'vidma_rd', 'dpdraw_rd', 'dpdraw_wr'].reduce((a, k) => a + +(v[k] ?? 0), 0);
                const px = +v.prim_px;
                console.log(`    ${s.padEnd(12)} ${fmt(cyc).padStart(13)} ${pct(cyc, whole).padStart(6)} ${fmt(+v.dcache_misses).padStart(10)} ${fmt(+v.dcache_wb).padStart(9)} ${fmt(+v.icache_misses).padStart(8)} ${pct(missCyc, cyc).padStart(7)} ${fmt(rd).padStart(12)} ${(+v.prim_calls ? fmt(+v.prim_calls) : '').padStart(8)} ${(px ? fmt(px) : '').padStart(9)} ${(px ? (cyc / px).toFixed(1) : '').padStart(7)}`);
            }
            const sumStages = ['sim', 'frame', 'bsp', 'planes', 'masked'].reduce((a, s) => a + +(t.slots[s]?.cycles ?? 0), 0);
            console.log(`    ${'other'.padEnd(12)} ${fmt(whole - sumStages).padStart(13)} ${pct(whole - sumStages, whole).padStart(6)}   (whole minus the five stages)`);
            const icyc = +W.icache_hits + +W.icache_misses;
            console.log(`    I-cache hits + misses ${fmt(icyc)} (instructions fetched, under ForceInterpreter only); RSP ${fmt(+W.rsp_cycles - +W.rsp_halted)} active of ${fmt(+W.rsp_cycles)} cycles`);
        }
    }
    if (bad) { console.log(`FAIL xprof: ${bad} problem(s)`); return 1; }
    console.log(`\nPASS xprof: ${nCal} calibration loop(s) agree with COUNT within ${TOL} cycles`);
    return 0;
}
