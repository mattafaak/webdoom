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
// usage: node tools/floor/zone-min.mjs [--cortexm ISA [--zero-copy]] [--build B] [--play] [lo_kb hi_kb]
//        node tools/floor/zone-min.mjs [--build B] --play [--no-saveload] --scan <lo_kb> <hi_kb>
//            every 4 KiB step from hi down to the first that fails (no lower
//            than lo): the lowest size from which every step to hi passes
//        node tools/floor/zone-min.mjs [--cortexm ISA [--zero-copy]] [--build B] [--play] --check <min_kb>
//            the gate form: <min_kb> must pass and <min_kb> - 4 must fail
//            (two probes, both sides of the recorded boundary)
//
// --build default|zc|lean|leanzc builds that host build (tools/freestanding,
// its own objects: play-set.mjs X86_BUILDS) and probes it, as FS_DOOM would.
//
// The play set includes a game saved and loaded back on 129 of its maps
// (play-set.mjs); --no-saveload leaves that out, for comparison.
//
// --play: the play-inclusive minimum.  A probe must also run the play set
// (tools/floor/play-set.mjs): each of the 13 demos with a level exit injected
// (the wipe run to its end, the intermission, the next level), and a scripted
// demo on every map of the four IWADs, saved and loaded back at its end, each
// run's every frame identical (render and sim hash) to the same scenario's at
// an 8 MiB zone.  The references run
// first, and each must still reach what its scenario is for (play-set.mjs
// coverage()), or the gate fails: a scenario that stopped testing must not
// pass.  The play set runs first in a probe; the 13 demos run only if it
// passed (a probe needs both).
//
// After a bisection, five more probes above the minimum (+4, +8, +16, +32 and
// +64 KiB) must all pass: the zone's allocator is first-fit over a rover, so
// whether a run fits is not monotone in the zone's size (measured, the default
// build: 1,604 and 1,728 KiB pass, 1,724 and 1,760 fail; every step from 1,764
// to 1,856 passes), and a minimum is only a floor if the sizes above it pass
// too.  --scan lo hi probes every 4 KiB step from hi
// down to the first that fails (the play set alone; the 13 demos at the
// answer) and reports the lowest size from which every step to hi passes:
// the floor a bisection can only approximate.
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
import * as P from './play-set.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const STEP = 4;
const argv = process.argv.slice(2);
let CORTEXM = null, ZC = false, PLAY = false, BUILD = null, SAVELOAD = true;
for (;;) {
    if (argv[0] === '--cortexm') { CORTEXM = argv[1]; argv.splice(0, 2); }
    else if (argv[0] === '--zero-copy') { ZC = true; argv.shift(); }
    else if (argv[0] === '--play') { PLAY = true; argv.shift(); }
    else if (argv[0] === '--build') { BUILD = argv[1]; argv.splice(0, 2); }
    else if (argv[0] === '--no-saveload') { SAVELOAD = false; argv.shift(); }
    else break;
}
if (BUILD && CORTEXM) { console.log('zone-min: --build names a host build; --cortexm builds its own'); process.exit(2); }
if (BUILD) {
    try { process.env.FS_DOOM = P.buildX86(BUILD); }
    catch (e) { console.log(`FAIL zone-min: ${e.message}`); process.exit(1); }
}
if (!SAVELOAD && !PLAY) { console.log('zone-min: --no-saveload narrows --play'); process.exit(2); }
if (PLAY && CORTEXM) { console.log('zone-min: --play is host-only (fs-doom\'s -frames mode)'); process.exit(2); }
if (CORTEXM !== null && !['armv6m', 'armv8m'].includes(CORTEXM)) { console.log('usage: zone-min.mjs --cortexm armv6m|armv8m ...'); process.exit(2); }
if (ZC && !CORTEXM) { console.log('zone-min: --zero-copy is for --cortexm; on the host, FS_DOOM=tools/freestanding/fs-doom-zc'); process.exit(2); }
const CHECK = argv[0] === '--check' ? Number(argv[1]) : null;
const SCAN = argv[0] === '--scan' ? [Number(argv[1]), Number(argv[2])] : null;
if (SCAN && (!PLAY || !(SCAN[0] > STEP) || !(SCAN[1] > SCAN[0]) || SCAN.some(k => k % STEP)))
    { console.log('usage: zone-min.mjs --play --scan <lo_kb> <hi_kb> (multiples of 4)'); process.exit(2); }
const [lo0 = 256, hi0 = CORTEXM ? 2048 : 4096] = CHECK || SCAN ? [] : argv.map(Number);
const WHAT = (CORTEXM ? `${CORTEXM}${ZC ? ' zero-copy' : ''} under qemu` : (process.env.FS_DOOM ? process.env.FS_DOOM.split('/').at(-1) : 'fs-doom')) +
             (PLAY ? `, play-inclusive${SAVELOAD ? '' : ', without the save and load'}` : '');
const tmp = mkdtempSync(join(tmpdir(), 'webdoom-zonemin-'));
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }));

// ── the play set (--play): references at 8 MiB, then each probe against them
const FS = process.env.FS_DOOM ?? join(root, 'tools/freestanding/fs-doom');
const JOBS = Number(process.env.WD_PLAY_JOBS) || 16;
let SCEN = [], REF = null;
if (PLAY) {
    SCEN = P.scenarios(tmp, { saveload: SAVELOAD });
    const refs = await P.pool(SCEN.map(sc => () => P.run(FS, sc, P.REF_KB, tmp)), JOBS);
    const bad = SCEN.map((sc, i) => [sc, P.coverage(refs[i], sc)]).filter(([, why]) => why);
    for (const [sc, why] of bad) console.log(`FAIL zone-min: play scenario ${sc.id}: ${why}`);
    if (bad.length) process.exit(1);
    REF = new Map(SCEN.map((sc, i) => [sc.id, refs[i]]));
    const n = k => SCEN.filter(sc => sc.kind === k).length;
    const frames = refs.reduce((a, r) => a + r.frames.length, 0);
    console.log(`zone-min: play set: ${n('exit')} demo exits and ${n('map')} maps, ${frames.toLocaleString('en-US')} frames at ${P.REF_KB} KiB, every scenario reaching what it tests`);
}
async function playProbe(kb) {
    const rs = await P.pool(SCEN.map(sc => () => P.run(FS, sc, kb, tmp)), JOBS);
    const fails = [];
    for (let i = 0; i < SCEN.length; i++) {
        const d = P.firstDiff(REF.get(SCEN[i].id), rs[i]);
        if (d) fails.push(`${SCEN[i].id} at frame ${d.frame} (gametic ${d.gametic}): ${d.what}`);
        rmSync(join(tmp, `${SCEN[i].id}.z${kb}.frames`), { force: true });
    }
    return fails;
}

const probes = new Map();
async function probe(kb) {
    if (probes.has(kb)) return probes.get(kb);
    const out = join(tmp, `z${kb}`);
    if (PLAY) {
        const fails = await playProbe(kb);
        if (fails.length) {
            const res = { kb, ok: false, last: `play: ${fails.length} of ${SCEN.length} scenarios differ from 8 MiB; first ${fails[0]}`, out, fails };
            probes.set(kb, res);
            console.log(`  zone ${String(kb).padStart(5)} KiB: FAIL — ${res.last}`);
            return res;
        }
    }
    const r = CORTEXM
        // its own build directory (--variant zonemin): every probe rebuilds at
        // its zone size, and the armv6m-zc / armv8m-zc legs build the same
        // ISA beside it under --jobs; sharing one directory, each relinked
        // the other's objects mid-run
        ? spawnSync('bash', [join(root, 'tools/cortexm/run-floor.sh'), CORTEXM, ...(ZC ? ['--zero-copy'] : []),
                             '--variant', 'zonemin', '--correctness', '--zone', String(kb), '--out', out], { encoding: 'utf8' })
        : spawnSync('bash', [join(root, 'tools/floor/run-x86.sh'), out],
                    { env: { ...process.env, WD_ZONE_KB: String(kb) }, encoding: 'utf8' });
    const last = (PLAY ? `play: ${SCEN.length} scenarios identical to 8 MiB; ` : '') + (r.stdout ?? '').trim().split('\n').at(-1);
    const res = { kb, ok: r.status === 0, last, out };
    probes.set(kb, res);
    console.log(`  zone ${String(kb).padStart(5)} KiB: ${res.ok ? 'pass' : 'FAIL'} — ${last}`);
    return res;
}
const WHAT_RUNS = PLAY ? `all 13 demos and the play set (13 demo exits, ${SCEN.filter(sc => sc.kind === 'map').length} maps, ` +
                         `${SCEN.filter(sc => sc.saveload).length} of them saved and loaded)` : 'all 13 demos';

if (CHECK) {
    if (!(CHECK > STEP)) { console.log('usage: zone-min.mjs --check <min_kb>'); process.exit(2); }
    const at = await probe(CHECK), below = await probe(CHECK - STEP);
    if (at.ok && !below.ok) {
        console.log(`PASS zone-min: ${CHECK} KiB runs ${WHAT_RUNS} correctly with rendering and ${CHECK - STEP} KiB does not — the recorded minimum holds (${WHAT})`);
        process.exit(0);
    }
    console.log(`FAIL zone-min: the recorded minimum moved: ${CHECK} KiB ${at.ok ? 'passes' : 'fails'}, ${CHECK - STEP} KiB ${below.ok ? 'passes' : 'fails'} (${WHAT}; re-measure: node tools/floor/zone-min.mjs${BUILD ? ` --build ${BUILD}` : ''}${PLAY ? ' --play --scan <lo> <hi>' : ''})`);
    process.exit(1);
}
if (SCAN) {
    // every 4 KiB step from hi down, the play set alone, until a step fails:
    // the floor is the last step that passed, the lowest size from which every
    // step up to hi passes (the 13 demos are run there too)
    const [lo, hi] = SCAN;
    console.log(`zone-min: scanning down from ${hi} KiB in ${STEP} KiB steps to the first that fails, the play set at each (${WHAT})`);
    let floor = null, failed = null;
    for (let kb = hi; kb >= lo; kb -= STEP) {
        const fails = await playProbe(kb);
        console.log(`  zone ${String(kb).padStart(5)} KiB: ${fails.length ? `FAIL — ${fails.length} of ${SCEN.length}: ${fails.slice(0, 2).join('; ')}` : 'pass'}`);
        if (fails.length) { failed = kb; break; }
        floor = kb;
    }
    if (floor === null) { console.log(`FAIL zone-min: ${hi} KiB fails the play set: raise the scan's top`); process.exit(1); }
    if (failed === null) { console.log(`FAIL zone-min: every step down to ${lo} KiB passes: lower the scan's bottom`); process.exit(1); }
    const full = await probe(floor);
    if (!full.ok) { console.log(`FAIL zone-min: ${floor} KiB passes the play set but not the 13 demos: ${full.last}`); process.exit(1); }
    console.log(`PASS zone-min: the smallest zone from which every ${STEP} KiB step to ${hi} KiB runs the play set, and which runs all 13 demos, is ${floor} KiB; ${failed} KiB fails (${WHAT})`);
    process.exit(0);
}
console.log(`zone-min: bisecting ${lo0}..${hi0} KiB in ${STEP} KiB steps (${WHAT})`);
if ((await probe(hi0)).ok === false) { console.log(`FAIL zone-min: ${hi0} KiB does not pass, so it cannot bound the search`); process.exit(1); }
if ((await probe(lo0)).ok === true) { console.log(`FAIL zone-min: ${lo0} KiB already passes; lower the bound`); process.exit(1); }
let lo = lo0, hi = hi0;                       // lo fails, hi passes
while (hi - lo > STEP) {
    const mid = lo + Math.floor((hi - lo) / 2 / STEP) * STEP || lo + STEP;
    if ((await probe(mid)).ok) hi = mid; else lo = mid;
}
const min = hi;
const below = await probe(min - STEP);
if (below.ok || !(await probe(min)).ok) { console.log(`FAIL zone-min: the boundary did not hold (${min} and ${min - STEP} KiB)`); process.exit(1); }
// the sizes just above the minimum must pass too, or it is not a floor
const above = [];
for (const d of [4, 8, 16, 32, 64]) {
    if (min + d > hi0) continue;
    if (!(await probe(min + d)).ok) { console.log(`FAIL zone-min: ${min} KiB passes but ${min + d} KiB fails: the boundary is not monotone here, so ${min} KiB is not a floor`); process.exit(1); }
    above.push(min + d);
}
console.log(`  above the minimum: ${above.join(', ')} KiB all pass`);

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
    const p = await probe(kb);
    if (!p.ok) { console.log(`FAIL zone-min: ${kb} KiB failed after ${min} KiB passed`); process.exit(1); }
    const m = misses(p.out);
    console.log(`    ${k}x = ${kb} KiB: ${m.tics} tics, ${m.bytes.toLocaleString('en-US')} B in all, worst ${m.max.toLocaleString('en-US')} B (${m.maxAt})`);
}
if (PLAY) {
    const f = below.fails ?? [];
    console.log(`  at ${min - STEP} KiB: ${f.length ? `${f.length} play scenario(s) fail: ${f.slice(0, 6).join('; ')}` : 'the play set passes; the 13 demos fail'}`);
}
console.log(`PASS zone-min: the smallest zone that runs ${WHAT_RUNS} correctly with rendering is ${min} KiB (${min * 1024} B); ${min - STEP} KiB fails (${WHAT})`);
