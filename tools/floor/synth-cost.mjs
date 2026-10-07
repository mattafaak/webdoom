#!/usr/bin/env node
// What the OPL music synth costs on x86, per song the 13 demos play: user-space
// instructions per second of audio and per tic (1/35 s), for -O1 (fs-doom's
// level) and -O2, OPL2 and OPL3 mode, at 49,716 Hz (the synth's own rate, the
// floor's), 44,100 and 48,000 Hz.  Each render covers the demo's whole length
// in fs-doom's per-tic blocks, and the worst block is the worst tic's music.
//
// Counted by tools/freestanding/synth-bench --count (perf_event_open, as
// fs-doom counts), every run pinned to a P-core: on a hybrid CPU the E-cores'
// counter reads 0, and synth-bench refuses such a run.  The samples are the
// ones tools/synth-native-test.mjs proves identical to build/synth.wasm.
//
// usage: node tools/floor/synth-cost.mjs [--rates 49716,44100,48000]
//                                        [--builds O1,O2] [--modes 0,1] [--json FILE]
// Copyright (C) 2026, GPL-2.0-or-later.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEMO_SONGS, demoTics as tics } from './demo-songs.mjs';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const RATES = arg('--rates', '49716,44100,48000').split(',').map(Number);
const BUILDS = arg('--builds', 'O1,O2').split(',');
const MODES = arg('--modes', '0,1').split(',').map(Number);
const JSON_OUT = arg('--json', null);

const mk = spawnSync('make', ['-C', join(root, 'tools/freestanding'), 'synth-bench'], { encoding: 'utf8' });
if (mk.status !== 0) { console.log(`FAIL synth-cost: make synth-bench failed\n${mk.stderr}`); process.exit(1); }

// P-cores: the cpu_core PMU's CPUs on a hybrid part, else every CPU
const expand = s => s.trim().split(',').flatMap(r => { const [a, b = a] = r.split('-').map(Number);
                                                       return Array.from({ length: b - a + 1 }, (_, i) => a + i); });
const CPUS = existsSync('/sys/devices/cpu_core/cpus') ? expand(readFileSync('/sys/devices/cpu_core/cpus', 'utf8'))
                                                      : Array.from({ length: (await import('node:os')).cpus().length }, (_, i) => i);

const jobs = [];
for (const [d, wad, song] of DEMO_SONGS)
    for (const b of BUILDS) for (const mode of MODES) for (const rate of RATES)
        jobs.push({ d, wad, song, b, mode, rate });
const free = [...CPUS];
let next = 0, failed = 0;
await Promise.all(CPUS.map(() => (async () => {
    while (next < jobs.length) {
        const j = jobs[next++], cpu = free.shift();
        const out = await new Promise(res => {
            const p = spawn('taskset', ['-c', String(cpu), join(root, 'tools/freestanding', `synth-bench-${j.b}`),
                                        '--wad', join(root, 'wads/lib', j.wad), '--song', j.song, '--mode', String(j.mode),
                                        '--rate', String(j.rate), '--tics', String(tics(j.d)), '--count']);
            let o = '', e = '';
            p.stdout.on('data', x => { o += x; }); p.stderr.on('data', x => { e += x; });
            p.on('close', code => res({ code, o, e }));
        });
        free.push(cpu);
        const f = k => +(new RegExp(`\\b${k}=(\\S+)`).exec(out.o) || [])[1];
        if (out.code || !(f('instr') > 0)) { failed++; console.log(`FAIL ${j.d} ${j.b} mode ${j.mode} ${j.rate}: ${out.e.trim()}`); continue; }
        Object.assign(j, { instr: f('instr'), per_s: f('per_s'), per_tic: f('per_tic'), worst: f('worst_block'), frames: f('frames') });
    }
})()));
if (failed) { console.log(`FAIL synth-cost: ${failed} run(s) failed`); process.exit(1); }

const M = n => (n / 1e6).toFixed(2);
const pick = (d, b, mode, rate) => jobs.find(j => j.d === d && j.b === b && j.mode === mode && j.rate === rate);
for (const rate of RATES) {
    console.log(`\n${rate} Hz — million instructions per second of audio / per tic (mean, worst tic)`);
    const cols = BUILDS.flatMap(b => MODES.map(m => `${m ? 'OPL3' : 'OPL2'} ${b}`));
    console.log(`  ${'demo (song)'.padEnd(26)} ${cols.map(c => c.padStart(22)).join('')}`);
    for (const [d, , song] of DEMO_SONGS)
        console.log(`  ${`${d} (${song})`.padEnd(26)} ${BUILDS.flatMap(b => MODES.map(m => {
            const j = pick(d, b, m, rate);
            return `${M(j.per_s)} / ${M(j.per_tic)}, ${M(j.worst)}`.padStart(22);
        })).join('')}`);
    const all = BUILDS.flatMap(b => MODES.map(m => {
        const js = jobs.filter(j => j.b === b && j.mode === m && j.rate === rate);
        const instr = js.reduce((s, j) => s + j.instr, 0), secs = js.reduce((s, j) => s + j.frames / rate, 0);
        return `${M(instr / secs)} / ${M(instr / secs / 35)}, ${M(Math.max(...js.map(j => j.worst)))}`.padStart(22);
    }));
    console.log(`  ${'all 13 (weighted)'.padEnd(26)} ${all.join('')}`);
}
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(jobs, null, 1) + '\n');
console.log(`\nsynth-cost: ${jobs.length} pinned runs on ${CPUS.length} P-core CPU(s)`);
