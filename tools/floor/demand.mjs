#!/usr/bin/env node
// The demand vector: what one tic of webdoom asks of a CPU, measured on the
// host in x86 instructions (fs-doom, perf_event_open, pinned to a P-core).
//
// Five configurations, all 13 demos each, one row per tic (-tictrace):
//   o1-v10   -O1, screenblocks 10: the graded configuration
//   o2-v10   -O2, screenblocks 10
//   o1-v11   -O1, screenblocks 11 (the full 320x200 view; not graded)
//   fixed    -O1 with fixed_count.h: FixedMul / FixedDiv calls per tic
//            (its instruction counts include the counting, so not demand)
//   o1-v10-audio  o1-v10 with music and sound effects running every tic
// A tic is graded unless a level load, intermission or finale started in it.
//
//   node tools/floor/demand.mjs            measure, write tools/golden/floor-demand.json
//   node tools/floor/demand.mjs --check    measure, compare with the golden:
//                                          each demo's worst graded tic must be the
//                                          same tic, and its count and the mean
//                                          within 1%
//   node tools/floor/demand.mjs --check --against-view 11
//                                          compare the view-11 run with the view-10
//                                          golden (the red-proof: it must fail)
// Copyright (C) 2026, GPL-2.0-or-later.
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, symlinkSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FS = join(root, 'tools/freestanding');
const GOLDEN = join(root, 'tools/golden/floor-demand.json');
const MATRIX = [
    ['doom.wad', 'doomu.wad', 'demo1', 'doom-demo1'], ['doom.wad', 'doomu.wad', 'demo2', 'doom-demo2'],
    ['doom.wad', 'doomu.wad', 'demo3', 'doom-demo3'], ['doom.wad', 'doomu.wad', 'demo4', 'doom-demo4'],
    ['doom2.wad', 'doom2.wad', 'demo1', 'doom2-demo1'], ['doom2.wad', 'doom2.wad', 'demo2', 'doom2-demo2'],
    ['doom2.wad', 'doom2.wad', 'demo3', 'doom2-demo3'],
    ['tnt.wad', 'tnt.wad', 'demo1', 'tnt-demo1'], ['tnt.wad', 'tnt.wad', 'demo2', 'tnt-demo2'],
    ['tnt.wad', 'tnt.wad', 'demo3', 'tnt-demo3'],
    ['plutonia.wad', 'plutonia.wad', 'demo1', 'plutonia-demo1'], ['plutonia.wad', 'plutonia.wad', 'demo2', 'plutonia-demo2'],
    ['plutonia.wad', 'plutonia.wad', 'demo3', 'plutonia-demo3'],
];
// The game's demand is measured with audio off (WD_AUDIO=0); o1-v10-audio is
// the same with the OPL2 synth and the 8-channel mixer running inside every
// tic, which is what the floor gate grades.
const CONFIGS = [
    { id: 'o1-v10', bin: 'fs-doom', env: { WD_AUDIO: '0' } },
    { id: 'o2-v10', bin: 'fs-doom-o2', env: { WD_AUDIO: '0' } },
    { id: 'o1-v11', bin: 'fs-doom', env: { WD_AUDIO: '0', WD_VIEW: '11' } },
    { id: 'fixed', bin: 'fs-doom-fixed', env: { WD_AUDIO: '0' } },
    { id: 'o1-v10-audio', bin: 'fs-doom', env: {} },
];

const args = process.argv.slice(2);
const CHECK = args.includes('--check');
const againstView = args.includes('--against-view') ? args[args.indexOf('--against-view') + 1] : null;

// P-cores: the instruction counter does not count on an E-core
const expand = s => s.trim().split(',').flatMap(r => { const [a, b = a] = r.split('-').map(Number); return Array.from({ length: b - a + 1 }, (_, k) => a + k); });
const CPUS = existsSync('/sys/devices/cpu_core/cpus') ? expand(readFileSync('/sys/devices/cpu_core/cpus', 'utf8'))
           : Array.from({ length: Number(execFileSync('nproc').toString()) }, (_, k) => k);

const tmp = mkdtempSync(join(tmpdir(), 'webdoom-demand-'));
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }));
for (const [src, as, , name] of MATRIX) {
    if (!existsSync(join(root, 'wads/lib', src))) { console.log(`FAIL demand: wads/lib/${src} absent`); process.exit(1); }
    mkdirSync(join(tmp, name));
    symlinkSync(join(root, 'wads/lib', src), join(tmp, name, as));
}

function runOne(cfg, [, as, demo, name], cpu) {
    const out = join(tmp, `${cfg.id}.${name}.tsv`);
    return new Promise((res, rej) => {
        const p = spawn('taskset', ['-c', String(cpu), join(FS, cfg.bin), join(tmp, name, as), '-timedemo', demo, '-tictrace', out],
                        { env: { ...process.env, WD_CYCLES: '1', WD_FLOOR_MODE: 'B', ...cfg.env }, stdio: ['ignore', 'ignore', 'pipe'] });
        let err = '';
        p.stderr.on('data', d => { err += d; });
        p.on('exit', code => code === 0 ? res(out) : rej(new Error(`${cfg.id} ${name}: exit ${code}: ${err.trim().split('\n').at(-1)}`)));
    });
}

async function runAll(configs) {
    const jobs = configs.flatMap(cfg => MATRIX.map(m => ({ cfg, m })));
    const results = new Map();
    let next = 0;
    await Promise.all(CPUS.map(async cpu => {
        while (next < jobs.length) {
            const { cfg, m } = jobs[next++];
            results.set(`${cfg.id}/${m[3]}`, await runOne(cfg, m, cpu));
        }
    }));
    return results;
}

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p / 100))];
const STAGES = ['sim', 'frame', 'bsp', 'planes', 'masked', 'other'];

function summarise(file, name) {
    const [head, ...rows] = readFileSync(file, 'utf8').trim().split('\n');
    const cols = head.split('\t');
    const t = rows.map(r => Object.fromEntries(r.split('\t').map((v, k) => [cols[k], Number(v)])));
    const golden = JSON.parse(readFileSync(join(root, 'tools/golden', `${name}.json`), 'utf8'));
    const want = typeof golden.trace === 'string' ? golden.trace.length / 8 : golden.trace.length;
    if (t.length !== want) throw new Error(`${name}: ${t.length} tics, the golden has ${want}`);
    const graded = t.filter(r => !r.load);
    const zero = graded.find(r => r.whole === 0);
    if (zero) throw new Error(`${name}: tic ${zero.i} read 0 instructions (not on a P-core?)`);
    const sorted = graded.map(r => r.whole).sort((a, b) => a - b);
    const worst = graded.reduce((w, r) => (r.whole > w.whole ? r : w));
    const loads = t.filter(r => r.load);
    const stage = Object.fromEntries(STAGES.map(s => {
        const v = graded.map(r => r[s]).sort((a, b) => a - b);
        return [s, { mean: Math.round(v.reduce((a, b) => a + b, 0) / v.length), p99: pct(v, 99), max: v.at(-1) }];
    }));
    const peak = k => Math.max(...t.map(r => r[k]));
    return {
        tics: t.length, graded: graded.length,
        mean: Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length), p50: pct(sorted, 50), p99: pct(sorted, 99),
        worst: { tic: worst.i, whole: worst.whole, ...Object.fromEntries(STAGES.map(s => [s, worst[s]])), mbytes: worst.mbytes },
        stage,
        load_tics: loads.map(r => ({ tic: r.i, whole: r.whole, mbytes: r.mbytes })),
        miss_tics: graded.filter(r => r.mbytes > 0).length,
        miss_bytes_max: Math.max(0, ...graded.map(r => r.mbytes)),
        peaks: { visplanes: peak('visplanes'), drawsegs: peak('drawsegs'), vissprites: peak('vissprites'), openings: peak('openings') },
        fixed: {
            fixedmul_mean: Math.round(graded.reduce((a, r) => a + r.fixedmul, 0) / graded.length), fixedmul_max: Math.max(...graded.map(r => r.fixedmul)),
            fixeddiv_mean: Math.round(graded.reduce((a, r) => a + r.fixeddiv, 0) / graded.length), fixeddiv_max: Math.max(...graded.map(r => r.fixeddiv)),
            fixeddiv_clamped_max: Math.max(...graded.map(r => r.fixeddiv_clamped)),
            at_worst: { fixedmul: worst.fixedmul, fixeddiv: worst.fixeddiv },
        },
    };
}

const configs = CHECK ? CONFIGS.filter(c => c.id === (againstView ? `o1-v${againstView}` : 'o1-v10')) : CONFIGS;
let files;
try { files = await runAll(configs); }
catch (e) { console.log(`FAIL demand: ${e.message}`); process.exit(1); }
const vec = { schema: 'floor-demand.v1', unit: 'x86 instructions (gcc -m32, user space)', host: 'alder i9-12900K, P-core', configs: {} };
for (const cfg of configs) {
    const demos = {};
    for (const [, , , name] of MATRIX) {
        try { demos[name] = summarise(files.get(`${cfg.id}/${name}`), name); }
        catch (e) { console.log(`FAIL demand: ${cfg.id} ${e.message}`); process.exit(1); }
    }
    const worstDemo = Object.entries(demos).reduce((w, [n, d]) => (!w || d.worst.whole > w[1].worst.whole ? [n, d] : w), null);
    vec.configs[cfg.id] = { worst: { demo: worstDemo[0], tic: worstDemo[1].worst.tic, whole: worstDemo[1].worst.whole }, demos };
}
// the fixed build's own instruction counts include its counting: keep only its counts
if (vec.configs.fixed) for (const d of Object.values(vec.configs.fixed.demos)) { delete d.stage; delete d.p50; delete d.p99; }

if (!CHECK) {
    writeFileSync(GOLDEN, JSON.stringify(vec, null, 1) + '\n');
    const w = vec.configs['o1-v10'].worst;
    console.log(`PASS demand: wrote ${GOLDEN.replace(root + '/', '')}: ${CONFIGS.length} configurations x ${MATRIX.length} demos; worst graded tic ${w.whole.toLocaleString('en-US')} instructions (${w.demo} tic ${w.tic})`);
    process.exit(0);
}

// --check: the same tic must be the worst, within 1%
const gold = JSON.parse(readFileSync(GOLDEN, 'utf8')).configs['o1-v10'];
const now = Object.values(vec.configs)[0];
let bad = 0;
for (const [name, g] of Object.entries(gold.demos)) {
    const n = now.demos[name];
    const off = (a, b) => Math.abs(a - b) / b;
    if (n.worst.tic !== g.worst.tic) { console.log(`FAIL ${name}: worst graded tic is ${n.worst.tic}, the golden's is ${g.worst.tic}`); bad++; continue; }
    if (off(n.worst.whole, g.worst.whole) > 0.01) { console.log(`FAIL ${name}: worst tic ${n.worst.whole} vs golden ${g.worst.whole} (> 1%)`); bad++; }
    if (off(n.mean, g.mean) > 0.01) { console.log(`FAIL ${name}: mean ${n.mean} vs golden ${g.mean} (> 1%)`); bad++; }
}
const n = Object.keys(gold.demos).length;
if (bad) { console.log(`FAIL demand: ${bad} difference(s) from the golden over ${n} demos`); process.exit(1); }
console.log(`PASS demand: ${n} demos match the golden — same worst graded tic in each, counts within 1% (worst ${now.worst.whole.toLocaleString('en-US')} instructions, ${now.worst.demo} tic ${now.worst.tic})`);
