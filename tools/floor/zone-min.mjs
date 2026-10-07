#!/usr/bin/env node
// The smallest zone that still runs all 13 demos correctly with rendering on.
//
// Each probe is tools/floor/run-x86.sh with WD_ZONE_KB=<n>: all 13 demos, a
// correctness run (sim and render hashes against the goldens) and a timing run
// each, through the floor gate.  A probe passes when every run exits 0 and the
// gate is satisfied.  Bisected in 4 KiB steps between a size that must fail and
// one that must pass; the answer is reported only with both sides measured:
// the minimum passes and the minimum - 4 KiB fails.
//
// Then, at 1x, 1.5x and 2x the minimum, how much a smaller zone costs in WAD
// copies inside graded tics (cache misses: the M:<bytes> flag).
//
// usage: node tools/floor/zone-min.mjs [--cortexm ISA [--zero-copy]] [lo_kb hi_kb]
//        node tools/floor/zone-min.mjs [--cortexm ISA [--zero-copy]] --check <min_kb>
//            the gate form: <min_kb> must pass and <min_kb> - 4 must fail
//            (two probes, both sides of the recorded boundary)
//
// FS_DOOM=<binary> probes a side build on the host, as run-x86.sh does
// (tools/freestanding/fs-doom-zc: lumps read in place).  --cortexm ISA probes
// the Cortex-M build under qemu instead: tools/cortexm/run-floor.sh ISA
// --correctness --zone <n> (mode A, sim and render hashes, no timing run and
// no audio: that build has none), with --zero-copy passed on; its arena is the
// Makefile's ZONE_KB, so hi_kb must not exceed it.
// Copyright (C) 2026, GPL-2.0-or-later.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const STEP = 4;
const argv = process.argv.slice(2);
let CORTEXM = null, ZC = false;
for (;;) {
    if (argv[0] === '--cortexm') { CORTEXM = argv[1]; argv.splice(0, 2); }
    else if (argv[0] === '--zero-copy') { ZC = true; argv.shift(); }
    else break;
}
if (CORTEXM !== null && !['armv6m', 'armv8m'].includes(CORTEXM)) { console.log('usage: zone-min.mjs --cortexm armv6m|armv8m ...'); process.exit(2); }
if (ZC && !CORTEXM) { console.log('zone-min: --zero-copy is for --cortexm; on the host, FS_DOOM=tools/freestanding/fs-doom-zc'); process.exit(2); }
const CHECK = argv[0] === '--check' ? Number(argv[1]) : null;
const [lo0 = 256, hi0 = CORTEXM ? 2048 : 4096] = CHECK ? [] : argv.map(Number);
const WHAT = CORTEXM ? `${CORTEXM}${ZC ? ' zero-copy' : ''} under qemu` : (process.env.FS_DOOM ? process.env.FS_DOOM.split('/').at(-1) : 'fs-doom');
const tmp = mkdtempSync(join(tmpdir(), 'webdoom-zonemin-'));
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }));

const probes = new Map();
function probe(kb) {
    if (probes.has(kb)) return probes.get(kb);
    const out = join(tmp, `z${kb}`);
    const r = CORTEXM
        ? spawnSync('bash', [join(root, 'tools/cortexm/run-floor.sh'), CORTEXM, ...(ZC ? ['--zero-copy'] : []),
                             '--correctness', '--zone', String(kb), '--out', out], { encoding: 'utf8' })
        : spawnSync('bash', [join(root, 'tools/floor/run-x86.sh'), out],
                    { env: { ...process.env, WD_ZONE_KB: String(kb) }, encoding: 'utf8' });
    const last = (r.stdout ?? '').trim().split('\n').at(-1);
    const res = { kb, ok: r.status === 0, last, out };
    probes.set(kb, res);
    console.log(`  zone ${String(kb).padStart(5)} KiB: ${res.ok ? 'pass' : 'FAIL'} — ${last}`);
    return res;
}

if (CHECK) {
    if (!(CHECK > STEP)) { console.log('usage: zone-min.mjs --check <min_kb>'); process.exit(2); }
    const at = probe(CHECK), below = probe(CHECK - STEP);
    if (at.ok && !below.ok) {
        console.log(`PASS zone-min: ${CHECK} KiB runs all 13 demos correctly with rendering and ${CHECK - STEP} KiB does not — the recorded minimum holds (${WHAT})`);
        process.exit(0);
    }
    console.log(`FAIL zone-min: the recorded minimum moved: ${CHECK} KiB ${at.ok ? 'passes' : 'fails'}, ${CHECK - STEP} KiB ${below.ok ? 'passes' : 'fails'} (${WHAT}; re-measure: node tools/floor/zone-min.mjs)`);
    process.exit(1);
}
console.log(`zone-min: bisecting ${lo0}..${hi0} KiB in ${STEP} KiB steps (${WHAT})`);
if (probe(hi0).ok === false) { console.log(`FAIL zone-min: ${hi0} KiB does not pass, so it cannot bound the search`); process.exit(1); }
if (probe(lo0).ok === true) { console.log(`FAIL zone-min: ${lo0} KiB already passes; lower the bound`); process.exit(1); }
let lo = lo0, hi = hi0;                       // lo fails, hi passes
while (hi - lo > STEP) {
    const mid = lo + Math.floor((hi - lo) / 2 / STEP) * STEP || lo + STEP;
    if (probe(mid).ok) hi = mid; else lo = mid;
}
const min = hi;
const below = probe(min - STEP);
if (below.ok || !probe(min).ok) { console.log(`FAIL zone-min: the boundary did not hold (${min} and ${min - STEP} KiB)`); process.exit(1); }

// cache-miss cost in graded tics at 1x, 1.5x and 2x the minimum (mode B logs;
// a --correctness probe has only mode A's, which carry the same flags)
function misses(dir) {
    let tics = 0, bytes = 0, max = 0, maxAt = '';
    const mode = readdirSync(dir).some(f => f.endsWith('.B.log')) ? 'B' : 'A';
    for (const f of readdirSync(dir).filter(f => f.endsWith(`.${mode}.log`))) {
        for (const l of readFileSync(join(dir, f), 'utf8').split('\n')) {
            const m = /^T (\d+) \d+ \d+ (\S+)/.exec(l);
            if (!m || m[2].split(',').includes('L')) continue;
            const mb = m[2].split(',').find(x => x.startsWith('M:'));
            if (!mb) continue;
            const n = +mb.slice(2);
            tics++; bytes += n;
            if (n > max) { max = n; maxAt = `${f.replace(`.${mode}.log`, '')} tic ${m[1]}`; }
        }
    }
    return { tics, bytes, max, maxAt };
}
console.log('  graded tics that copied from the WAD (cache misses), all 13 demos:');
for (const k of [1, 1.5, 2]) {
    const kb = Math.round(min * k / STEP) * STEP;
    if (kb > hi0) { console.log(`    ${k}x = ${kb} KiB: above the ${hi0} KiB bound, not probed`); continue; }
    const p = probe(kb);
    if (!p.ok) { console.log(`FAIL zone-min: ${kb} KiB failed after ${min} KiB passed`); process.exit(1); }
    const m = misses(p.out);
    console.log(`    ${k}x = ${kb} KiB: ${m.tics} tics, ${m.bytes.toLocaleString('en-US')} B in all, worst ${m.max.toLocaleString('en-US')} B (${m.maxAt})`);
}
console.log(`PASS zone-min: the smallest zone that runs all 13 demos correctly with rendering is ${min} KiB (${min * 1024} B); ${min - STEP} KiB fails (${WHAT})`);
