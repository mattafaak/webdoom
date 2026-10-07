#!/usr/bin/env node
// The lean-levels leg: tools/freestanding's lean zero-copy build with
// LEAN_LEVELS (engine/core/r_defs.h: VERTEXES, SEGS and NODES read where they
// lie in the WAD, lines and sides narrowed exactly) against the same build
// without it.
//
//   1. The 13 demos at the build's zone minimum, through the floor gate (sim
//      and render hashes against the goldens, audio on): zone-min.mjs --check
//      LEVELS_ZONE_MIN_KB, which also requires 4 KiB less to fail.
//   2. The same 13 through the floor gate in the copying lean build with
//      LEAN_LEVELS (no ZERO_COPY): every array a PU_LEVEL copy, swapped.
//   3. Frame by frame (fs-doom -frames: render hash, sim hash, map, view) against
//      the reference build, on what the goldens never reach:
//        largest   the biggest map of each IWAD (E4M9, MAP14, MAP31, MAP28),
//                  played by a demo's input (a copy of the IWAD with the
//                  demo's map byte rewritten), at 8 MiB, and in the lean build
//                  also at LEVELS_PLAY_KB, the smallest zone all four play in
//                  (4 KiB less fails tnt MAP31; the reference fails there too)
//        glass     doom E1M5 with every 4th eligible one-sided line a glass
//                  window (two-sided, no back side: SEG_BACK's null sector),
//                  ended before frame 412, where a hitscan crosses one and
//                  vanilla's PTR_ShootTraverse reads its NULL backsector
//        save      doom2 MAP11 (demo 1): saved at tic 800, loaded at once, saved
//                  again at 835, played on to 1150; then each build loads the
//                  other's save.  Every save's world part (S lines: sectors,
//                  lines, sides, the part that holds no pointer) is compared
//                  byte for byte by hash, and what each load leads to frame by
//                  frame
//        misaligned  doom.wad with every lump at an odd offset (misalign-wad.mjs):
//                  the zero-copy build cannot read a lump in place there and
//                  copies each, demo 1
//   4. Red-proofs, each a wrong lean path that must fail where it is wrong
//      (WD_LEVELS_FAULT, tools/freestanding/i_main.c):
//        glass     SEG_BACK has no null sector: the glass scenario
//        save      a load leaves every side's texture offsets 0: the save
//                  scenario, in its frames and its second save's world part
//        twosided  no line is two-sided as loaded: plutonia MAP28
//
// usage: node tools/floor/lean-levels-test.mjs [--keep DIR] [--no-redproof]
// Copyright (C) 2026, GPL-2.0-or-later.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { root } from '../lib/util.mjs';

// Measured (4 KiB steps, tools/floor/zone-min.mjs and this file's largest
// scenario): the 13 demos need 744 KiB with LEAN_LEVELS (740 fails) and 920
// without (916 fails); the four largest maps 816 KiB (812 fails tnt MAP31),
// and without LEAN_LEVELS 748 (E4M9), 784 (MAP14), 1152 (MAP31), 1120 (MAP28).
const LEVELS_ZONE_MIN_KB = 744;
const LEVELS_PLAY_KB = 816;

const args = process.argv.slice(2);
const KEEP = args.includes('--keep') ? args[args.indexOf('--keep') + 1] : null;
const REDPROOF = !args.includes('--no-redproof');
const FS = join(root, 'tools/freestanding');
const LIB = join(root, 'wads/lib');
const fail = msg => { console.log(`FAIL lean-levels: ${msg}`); process.exit(1); };

// ── the builds: one OBJDIR each, so no object is shared between configurations
const BUILDS = {
    ref: ['LEAN=1', 'ZERO_COPY=1', 'OBJDIR=obj-leanzc', 'OUT=fs-doom-leanzc'],
    lv: ['LEAN=1', 'ZERO_COPY=1', 'LEAN_LEVELS=1', 'OBJDIR=obj-leanzc-lv', 'OUT=fs-doom-leanzc-lv'],
    copy: ['LEAN=1', 'LEAN_LEVELS=1', 'OBJDIR=obj-lean-lv', 'OUT=fs-doom-lean-lv'],
};
const tmp = KEEP ?? mkdtempSync(join(tmpdir(), 'webdoom-leanlevels-'));
mkdirSync(tmp, { recursive: true });
if (!KEEP) process.on('exit', () => rmSync(tmp, { recursive: true, force: true }));
const BIN = {};
for (const [id, mk] of Object.entries(BUILDS)) {
    const out = mk.find(a => a.startsWith('OUT=')).slice(4);
    const r = spawnSync('make', ['-C', FS, '-j8', ...mk, out], { encoding: 'utf8' });
    writeFileSync(join(tmp, `build-${id}.log`), (r.stdout ?? '') + (r.stderr ?? ''));
    if (r.status !== 0) fail(`make ${mk.join(' ')} failed:\n${(r.stderr ?? '').trim().split('\n').slice(-8).join('\n')}`);
    BIN[id] = join(FS, out);
}

// ── the WADs: the IWADs under the names the engine knows them by, and the
// rewritten copies (written here, never into wads/)
for (const w of ['doom.wad', 'doom2.wad', 'tnt.wad', 'plutonia.wad'])
    if (!existsSync(join(LIB, w))) fail(`wads/lib/${w} absent (tools/fetch-wads.sh)`);
function wadDir(rel) { const d = join(tmp, rel); mkdirSync(d, { recursive: true }); return d; }
function lumpsOf(b) {
    const n = b.readInt32LE(4), dir = b.readInt32LE(8), out = [];
    for (let i = 0; i < n; i++) {
        const o = dir + 16 * i;
        out.push({ pos: b.readInt32LE(o), size: b.readInt32LE(o + 4), name: b.toString('latin1', o + 8, o + 16).replace(/\0.*$/, '') });
    }
    return out;
}
// a copy of an IWAD whose demo lump starts on another map
function demoOnMap(src, dir, as, demo, ep, map) {
    const b = readFileSync(join(LIB, src)), l = lumpsOf(b).find(x => x.name === demo.toUpperCase());
    if (!l || b[l.pos] !== 109) fail(`${src} ${demo}: not a v1.9 demo`);
    b[l.pos + 2] = ep;
    b[l.pos + 3] = map;
    writeFileSync(join(wadDir(dir), as), b);
}
// doom.wad whose E1M5 has every 4th eligible one-sided line a glass window:
// ML_TWOSIDED with no side 1, its sidedef's midtexture "-" (a solid wall's
// texture drawn masked reads past its columns, which depends on the heap).
// Eligible: no special on the line or its sector, no tag on the sector, a
// sidedef no other line uses (vanilla's getNextSector callers expect a
// two-sided line to have a side 1).
function glassWad(dir) {
    const b = readFileSync(join(LIB, 'doom.wad')), L = lumpsOf(b);
    const m = L.findIndex(x => x.name === 'E1M5'), lines = L[m + 2], sides = L[m + 3], secs = L[m + 8];
    const used = new Map();
    for (let i = 0; i < lines.size / 14; i++)
        for (const k of [10, 12]) { const s = b.readInt16LE(lines.pos + 14 * i + k); used.set(s, (used.get(s) ?? 0) + 1); }
    let eligible = 0, made = 0;
    for (let i = 0; i < lines.size / 14; i++) {
        const o = lines.pos + 14 * i, s0 = b.readInt16LE(o + 10);
        if (b.readInt16LE(o + 12) !== -1 || b.readInt16LE(o + 6) || b.readInt16LE(o + 8) || used.get(s0) !== 1) continue;
        const so = secs.pos + 26 * b.readInt16LE(sides.pos + 30 * s0 + 28);
        if (b.readInt16LE(so + 22) || b.readInt16LE(so + 24)) continue;
        if (eligible++ % 4) continue;
        b.writeInt16LE(b.readInt16LE(o + 4) | 4, o + 4);
        b.write('-\0\0\0\0\0\0\0', sides.pos + 30 * s0 + 20, 8, 'latin1');
        made++;
    }
    writeFileSync(join(wadDir(dir), 'doomu.wad'), b);
    return made;
}
demoOnMap('doom.wad', 'big-doom', 'doomu.wad', 'demo3', 4, 9);
demoOnMap('doom2.wad', 'big-doom2', 'doom2.wad', 'demo1', 1, 14);
demoOnMap('tnt.wad', 'big-tnt', 'tnt.wad', 'demo2', 1, 31);
demoOnMap('plutonia.wad', 'big-plutonia', 'plutonia.wad', 'demo1', 1, 28);
const glassLines = glassWad('glass');
symlinkSync(join(LIB, 'doom2.wad'), join(wadDir('save'), 'doom2.wad'));
{
    const r = spawnSync('node', [join(root, 'tools/floor/misalign-wad.mjs'), join(LIB, 'doom.wad'), join(wadDir('odd'), 'doomu.wad')], { encoding: 'utf8' });
    if (r.status !== 0) fail(`misalign-wad.mjs: ${(r.stdout ?? '').trim()}`);
}

// ── the scenarios ────────────────────────────────────────────────────────────
const SAVE = { WD_SAVE_AT: '800:0,835:2', WD_LOAD_AT: '800:0', WD_END_AT: '1150' };
const LARGEST = [
    { id: 'largest-e4m9', dir: 'big-doom', wad: 'doomu.wad', demo: 'demo3', map: [4, 9] },
    { id: 'largest-map14', dir: 'big-doom2', wad: 'doom2.wad', demo: 'demo1', map: [1, 14] },
    { id: 'largest-map31', dir: 'big-tnt', wad: 'tnt.wad', demo: 'demo2', map: [1, 31] },
    { id: 'largest-map28', dir: 'big-plutonia', wad: 'plutonia.wad', demo: 'demo1', map: [1, 28] },
];
const SCEN = {
    ...Object.fromEntries(LARGEST.map(s => [s.id, { ...s, env: {} }])),
    glass: { dir: 'glass', wad: 'doomu.wad', demo: 'demo1', map: [1, 5], env: { WD_END_AT: '400' } },
    save: { dir: 'save', wad: 'doom2.wad', demo: 'demo1', map: [1, 11], env: SAVE },
    misaligned: { dir: 'odd', wad: 'doomu.wad', demo: 'demo1', map: [1, 5], env: {} },
};

// One run: its frame and save records, how it ended, the I_Error if any.
function run(bin, s, extraEnv, label) {
    const out = join(tmp, `${label}.frames`);
    return new Promise(res => {
        const p = spawn(bin, [join(tmp, s.dir, s.wad), '-timedemo', s.demo, '-frames', out], {
            cwd: tmp, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, ...s.env, ...extraEnv },
        });
        let stdout = '';   // fs-doom's I_Error writes to stdout (the byte-out)
        p.stdout.on('data', d => { stdout += d; });
        p.on('exit', (code, signal) => {
            const frames = [], saves = [];
            let head = null, end = null;
            for (const l of (existsSync(out) ? readFileSync(out, 'utf8') : '').split('\n')) {
                const f = l.split(' ');
                if (f[0] === 'F') frames.push({
                    n: +f[1], gametic: +f[2], gs: +f[3], wipe: +f[4], render: f[5], sim: f[6], held: +f[7],
                    sw: +f[8], vh: +f[9], detail: +f[10], ep: +f[13], map: +f[14],
                });
                else if (f[0] === 'S') saves.push({ n: +f[1], gametic: +f[2], slot: +f[3], bytes: +f[4], hash: f[5] });
                else if (f[0] === 'FRAMES') head = l;
                else if (f[0] === 'END') end = l;
            }
            res({ label, frames, saves, head, end, code, signal, err: stdout.match(/I_Error: [^\n]*/)?.[0] ?? '' });
        });
    });
}
// The first frame at which two records disagree, or null.  A run that ended
// early disagrees at the frame it never recorded.  (A frame's write count and
// hash are not compared: a save's bytes hold heap pointers, which move with
// any layout.  Its world part is compared through the S lines.)
const KEYS = ['n', 'gametic', 'gs', 'wipe', 'render', 'sim', 'held', 'sw', 'vh', 'detail', 'ep', 'map'];
function firstDiff(a, b) {
    const n = Math.min(a.frames.length, b.frames.length);
    for (let i = 0; i < n; i++)
        for (const k of KEYS)
            if (a.frames[i][k] !== b.frames[i][k]) return { frame: i, what: k, ref: a.frames[i], got: b.frames[i] };
    if (a.frames.length !== b.frames.length || !a.end || !b.end) return { frame: n, what: 'end', ref: a.frames[n], got: b.frames[n] };
    return null;
}
const sameSaves = (a, b) => a.saves.length === b.saves.length
    && a.saves.every((s, i) => ['gametic', 'slot', 'bytes', 'hash'].every(k => s[k] === b.saves[i][k]));
const ended = r => r.end ? 'ran to its end' : `died (${r.signal ?? `exit ${r.code}`}${r.err ? `: ${r.err}` : ''})`;
// doom.wad's maps are ExMy; in the commercial IWADs the episode is always 1
const mapName = (s, ep, map) => s.wad === 'doomu.wad' ? `E${ep}M${map}` : `MAP${String(map).padStart(2, '0')}`;
const where = (f, s) => f ? `gametic ${f.gametic}, ${mapName(s, f.ep, f.map)}` : 'past the end';

// ── the 13 demos (1, 2): the floor gate's own tools, as their legs run them ──
function gateRun(cmd, cmdArgs, env, label) {
    return new Promise(res => {
        const p = spawn(cmd, cmdArgs, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        p.stdout.on('data', d => { out += d; });
        p.stderr.on('data', d => { out += d; });
        p.on('exit', code => { writeFileSync(join(tmp, `${label}.log`), out); res({ code, last: out.trim().split('\n').at(-1) ?? '' }); });
    });
}
// the zone-min check first and alone: its probes take every P-core
const zmin = await gateRun('node', [join(root, 'tools/floor/zone-min.mjs'), '--check', String(LEVELS_ZONE_MIN_KB)],
                           { FS_DOOM: BIN.lv }, 'zone-min');
if (zmin.code !== 0 || !/^PASS zone-min: \d+ KiB runs all 13 demos correctly/.test(zmin.last))
    fail(`the 13 demos at the recorded zone minimum: ${zmin.last}`);
const copyGate = await gateRun('bash', [join(root, 'tools/floor/run-x86.sh'), join(tmp, 'copy-x86')], { FS_DOOM: BIN.copy }, 'copy-x86');
if (copyGate.code !== 0 || !/correct: sim and render hashes match on all 13/.test(copyGate.last))
    fail(`the copying LEAN_LEVELS build through the floor gate: ${copyGate.last}`);

// ── the frame records (3) ────────────────────────────────────────────────────
const jobs = [];
const PLAY = { WD_ZONE_KB: String(LEVELS_PLAY_KB) };
for (const [id, s] of Object.entries(SCEN)) {
    // the save scenario's runs write their first save out, for the cross-loads
    const out = b => id === 'save' ? { WD_SAVE_OUT: join(tmp, `save.${b}.dsg`) } : {};
    jobs.push(run(BIN.ref, s, out('ref'), `${id}.ref`));
    jobs.push(run(BIN.lv, s, out('lv'), `${id}.lv`));
    if (id !== 'misaligned') jobs.push(run(BIN.copy, s, out('copy'), `${id}.copy`));
}
for (const s of LARGEST) jobs.push(run(BIN.lv, SCEN[s.id], PLAY, `${s.id}.lv-play`));
jobs.push(run(BIN.lv, SCEN['largest-map31'], { WD_ZONE_KB: String(LEVELS_PLAY_KB - 4) }, 'largest-map31.lv-below'));
jobs.push(run(BIN.ref, SCEN['largest-map31'], PLAY, 'largest-map31.ref-play'));
if (REDPROOF) {
    jobs.push(run(BIN.lv, SCEN.glass, { WD_LEVELS_FAULT: 'glass' }, 'redproof.glass'));
    jobs.push(run(BIN.lv, SCEN.save, { WD_LEVELS_FAULT: 'save' }, 'redproof.save'));
    jobs.push(run(BIN.lv, SCEN['largest-map28'], { WD_LEVELS_FAULT: 'twosided' }, 'redproof.twosided'));
}
let R = Object.fromEntries((await Promise.all(jobs)).map(r => [r.label, r]));
// the cross-loads: each build loads the save the other wrote at tic 800
for (const [a, b] of [['ref', 'lv'], ['lv', 'ref']])
    if (!existsSync(join(tmp, `save.${b}.dsg`))) fail(`the save scenario's ${b} run wrote no savegame (${ended(R[`save.${b}`])})`);
const cross = await Promise.all([['ref', 'lv'], ['lv', 'ref']].map(([a, b]) =>
    run(BIN[a], SCEN.save, { WD_LOAD_AT: '800:1', WD_SAVE_IN: join(tmp, `save.${b}.dsg`) }, `save.${a}-loads-${b}`)));
R = { ...R, ...Object.fromEntries(cross.map(r => [r.label, r])) };

// ── the comparisons ──────────────────────────────────────────────────────────
const lines = [];
let total = 0;
function same(refLabel, label, s) {
    const ref = R[refLabel], r = R[label], d = firstDiff(ref, r);
    if (d) fail(`${label} differs from ${refLabel} at frame ${d.frame} (${where(d.ref, s)}): ${d.what} ` +
                `${d.ref?.[d.what]} vs ${d.got?.[d.what]}; it ${ended(r)}`);
    return r.frames.length;
}
for (const [id, s] of Object.entries(SCEN)) {
    const ref = R[`${id}.ref`];
    if (!ref.end || ref.code !== 0) fail(`${id}: the reference ${ended(ref)}`);
    const onMap = ref.frames.filter(f => f.gs === 0 && f.ep === s.map[0] && f.map === s.map[1]).length;
    const need = id === 'glass' ? 350 : id === 'save' ? 1000 : 800;
    if (onMap < need) fail(`${id}: the reference has ${onMap} level frames on ${mapName(s, ...s.map)} (at least ${need} expected): the scenario no longer plays what it tests`);
    if (!/lean_screens=1/.test(ref.head ?? '') || !/zone=8388608 /.test(ref.head ?? '')) fail(`${id}: the reference's header is ${ref.head}`);
    const builds = id === 'misaligned' ? ['lv'] : ['lv', 'copy'];
    for (const b of builds) total += same(`${id}.ref`, `${id}.${b}`, s);
    let note = `${ref.frames.length} frames, ${onMap} on ${mapName(s, ...s.map)}`;
    if (id.startsWith('largest')) {
        total += same(`${id}.ref`, `${id}.lv-play`, s);
        if (!R[`${id}.lv-play`].head.includes(`zone=${LEVELS_PLAY_KB * 1024} `)) fail(`${id}: the lean run at ${LEVELS_PLAY_KB} KiB had ${R[`${id}.lv-play`].head}`);
        note += `; the lean build also at ${LEVELS_PLAY_KB} KiB`;
    }
    if (id === 'glass') {
        if (glassLines < 50) fail(`glass: ${glassLines} glass windows made (at least 50 expected)`);
        note += `; ${glassLines} glass windows`;
    }
    if (id === 'save') {
        for (const b of ['ref', 'lv', 'copy', 'ref-loads-lv', 'lv-loads-ref']) {
            const r = R[`save.${b}`];
            if (r.saves.length !== 2 || r.saves[0].gametic !== 800 || r.saves[1].gametic !== 835 || !(r.saves[0].bytes > 1000))
                fail(`save ${b}: its saves are ${JSON.stringify(r.saves)}, not one at tic 800 and one at 835`);
            if (!sameSaves(ref, r)) fail(`save ${b}: a save's world part differs from the reference's: ${JSON.stringify(r.saves)} vs ${JSON.stringify(ref.saves)}`);
        }
        total += same('save.ref', 'save.ref-loads-lv', s) + same('save.ref', 'save.lv-loads-ref', s);
        const after = ref.frames.filter(f => f.n > 800).length;
        note += `; saved at 800 and 835 (world part ${ref.saves[0].bytes} B, the same in every build), loaded at 800, ` +
                `${after} frames after the load; each build loading the other's save lands on the same frames`;
    }
    if (id === 'misaligned') note += '; every lump at an odd offset, so the zero-copy build copies VERTEXES, SEGS and NODES';
    lines.push(`  ${id}: ${note}`);
}
// the lean build's play zone: 4 KiB less fails tnt MAP31, and the reference
// cannot play it there at all
{
    const below = R['largest-map31.lv-below'], refPlay = R['largest-map31.ref-play'];
    if (below.end && !firstDiff(R['largest-map31.ref'], below))
        fail(`largest-map31 runs in ${LEVELS_PLAY_KB - 4} KiB too: LEVELS_PLAY_KB is not the boundary (re-measure)`);
    if (refPlay.end && !firstDiff(R['largest-map31.ref'], refPlay))
        fail(`the reference build plays largest-map31 in ${LEVELS_PLAY_KB} KiB: LEAN_LEVELS saves nothing there (re-measure)`);
    lines.push(`  play zone: the four largest maps in ${LEVELS_PLAY_KB} KiB; ${LEVELS_PLAY_KB - 4} KiB fails MAP31 ` +
               `(${ended(below)}), and the reference fails it at ${LEVELS_PLAY_KB} (${ended(refPlay)})`);
}

// ── the red-proofs (4) ───────────────────────────────────────────────────────
let rp = '';
if (REDPROOF) {
    const proofs = [
        ['glass', 'glass', d => d.frame >= 1 && d.frame <= 5],
        ['save', 'save', d => d.frame > 800 && d.frame <= 810],
        ['twosided', 'largest-map28', d => d.frame >= 1 && d.frame <= 2],
    ];
    const caught = [];
    for (const [id, sid, expect] of proofs) {
        const r = R[`redproof.${id}`], d = firstDiff(R[`${sid}.ref`], r), s = SCEN[sid];
        if (!d) fail(`red-proof ${id}: a wrong lean path matched the reference on every frame: this gate cannot see it`);
        if (!expect(d)) fail(`red-proof ${id}: failed, but at frame ${d.frame} (${where(d.ref, s)}), not where its fault is`);
        caught.push(`${id} at frame ${d.frame} (${where(d.ref, s)}: ${d.what === 'end' ? ended(r) : d.what})`);
    }
    const s = R['redproof.save'].saves, g = R['save.ref'].saves;
    if (!(s.length === 2 && s[0].hash === g[0].hash && s[1].hash !== g[1].hash))
        fail(`red-proof save: the save after the faulty load has world part ${s[1]?.hash}, the reference's ${g[1]?.hash}: the S lines cannot see a lost restore`);
    caught.push('and its save at 835 differs in its world part');
    rp = `; red-proofs: ${caught.join('; ')}`;
}

console.log(`  13 demos: ${zmin.last.replace(/^PASS zone-min: /, '')}`);
console.log(`  13 demos, copying build: ${copyGate.last}`);
for (const l of lines) console.log(l);
console.log(`PASS lean-levels: 13 demos at ${LEVELS_ZONE_MIN_KB} KiB (and not at ${LEVELS_ZONE_MIN_KB - 4}) and in the copying build; ` +
            `${Object.keys(SCEN).length} scenarios, ${total} frames identical to the reference${rp}`);
