#!/usr/bin/env node
// The RAM floor: what each build needs in RAM, per ISA, with play included.
//
// For every target (a build on an ISA):
//   x86      tools/freestanding's fs-doom builds: default, zc (zero copy), lean,
//            leanzc, and full, the full memory diet (LEAN=1 ZERO_COPY=1
//            LEAN_LEVELS=1) (play-set.mjs X86_BUILDS)
//   armv6m   tools/cortexm on mps2-an385 (Cortex-M0+ code), the same five
//   armv8m   (ZC, LEAN, LEAN_LEVELS), on mps2-an505 (Cortex-M33 code)
// it adds up
//   statics  .data and .bss of the engine (engine/core) and the port (the
//            platform layer, its screens, its sound: tools/freestanding,
//            engine/web's synth, tools/cortexm's board code), and the C
//            library's; read from the binary's symbols (nm -S -l: every symbol's
//            size and the source line that defines it) and classified by that
//            file.  Excluded, by name: the measuring harness (i_main.c,
//            cm_main.c, perf.c, the --wrap hooks, the floor log, fs_audio.c's
//            trace and stage buffers, the timedemo's exit), and the zone arena,
//            which the next line replaces.  A symbol no rule classifies stops
//            the tool: a new array cannot join the floor, or leave it, unseen.
//   align    the link's padding: its .data/.bss sections less every symbol in
//            them
//   zone     the build's play-inclusive zone minimum (zone-min.mjs --play,
//            recorded in the golden), which this run re-verifies: the play set
//            must run identically to the build's own x86 references at 8 MiB
//            at that zone, on every ISA
//   stack    the peak, over the play set at that zone (fs-doom: below main's
//            frame, i_main.c paints it; cortexm: from the top of the stack
//            region, init and play, crt0.S paints it)
//   heap     the peak, the same way (fs-doom: the bytes the engine and port
//            requested, heap_wrap.c; cortexm: newlib's sbrk high-water, which
//            includes its allocator's overhead)
//
// The play set (play-set.mjs) is the 13 demos with a level exit and every map of
// the four IWADs (129 of them then saved and loaded back: the save is heap
// while it is written, zone while it is read), with the sound on in every run (it allocates in the zone:
// s_sound.c's channels, and in a copying build GENMIDI and each song; so a
// run without it lays the zone out differently, and near the minimum that
// decides whether a run fits).  On Cortex-M that is the zero-copy builds:
// a copying Cortex-M build reads its WAD through a window (wad_semi.c) that
// in-place sound effects cannot use, so it cannot play the game with its
// sound here, and its rows are statics only.  Under qemu the OPL synth costs
// more than the game, so a Cortex-M pass takes minutes, not seconds.
//
// Flash: what each target keeps in flash (code, const data, .data's image)
// and, measured on x86 over the play set (WD_DATA_DIFF, i_main.c), which RAM
// could follow it: .data that no run changed (it could be const), statics only
// init changed (they could be generated at build time, as TABLES_CONST does),
// and .bss no run touched.  Cortex-M targets borrow x86's verdicts symbol by
// symbol (the same source; marked derived).  A byte rewritten with its own
// value is invisible, so these are "never changed in N runs", not proofs.
//
// The verdict compares each target's floor with tools/golden/floor-ram.json:
// FAIL if it rose by more than the golden's tolerance (see there), or if a
// recorded zone minimum no longer runs the play set; a floor that fell is a
// NOTE asking for a re-record.  Every run first red-proofs the comparison: an
// x86 default build with MAXVISSPRITES raised (a real engine knob, +256
// vissprites) must read as a rise and FAIL.
//
// usage: node tools/floor/ram-floor.mjs [--isa x86|armv6m|armv8m|cortexm|all] [--jobs N]
//            [--keep DIR] [--statics]       (no runs: statics and flash only)
//            [--no-saveload]                without play-set.mjs's save and load
//                                           (a comparison, no verdict)
//            [--only S,S]                   only the play scenarios named so
//                                           (a look: no verdict, no record)
//            [--both-sides]                 also run the play set 4 KiB below
//                                           each zone minimum, where at least
//                                           one scenario must fail: the
//                                           recorded minimum measured on both
//                                           sides on every ISA (a measurement,
//                                           not the leg: it doubles the runs)
//        node tools/floor/ram-floor.mjs --record [--isa ...] [--zone default=K,zc=K,lean=K,leanzc=K,full=K]
//            measure and write the golden (zone minima from --zone, else kept)
// Copyright (C) 2026, GPL-2.0-or-later.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { root } from '../lib/util.mjs';
import * as P from './play-set.mjs';

const GOLDEN = join(root, 'tools/golden/floor-ram.json');
const args = process.argv.slice(2);
const opt = k => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
const ISA = opt('--isa') ?? 'all';
const RECORD = args.includes('--record');
const STATICS = args.includes('--statics');
const JOBS = Number(opt('--jobs')) || 16;
const KEEP = opt('--keep');
const BOTH = args.includes('--both-sides');
const fail = m => { console.log(`FAIL ram-floor: ${m}`); process.exit(1); };
if (!['x86', 'armv6m', 'armv8m', 'cortexm', 'all'].includes(ISA)) fail(`--isa x86|armv6m|armv8m|cortexm|all, not '${ISA}'`);
if (RECORD && STATICS) fail('--record needs the runs (not --statics)');

const golden = existsSync(GOLDEN) ? JSON.parse(readFileSync(GOLDEN, 'utf8')) : null;
const zoneKb = { ...(golden?.zone_kb ?? {}) };
for (const kv of (opt('--zone') ?? '').split(',').filter(Boolean)) {
    const [b, k] = kv.split('=');
    if (!P.X86_BUILDS[b] || !(Number(k) > 0)) fail(`--zone ${kv}: build=KiB`);
    zoneKb[b] = Number(k);
}
const BUILDS = Object.keys(P.X86_BUILDS);
for (const b of BUILDS) if (!(zoneKb[b] > 0) && !STATICS) fail(`no zone minimum for ${b} (the golden's zone_kb, or --zone ${b}=KiB)`);

const isZc = build => ['zc', 'leanzc', 'full'].includes(build);
const TARGETS = [];
for (const isa of ['x86', 'armv6m', 'armv8m'])
    for (const build of BUILDS)
        if (ISA === 'all' || ISA === isa || (ISA === 'cortexm' && isa !== 'x86'))
            TARGETS.push({ id: `${isa}/${build}`, isa, build, run: isa === 'x86' || isZc(build) });
const dir = KEEP ?? mkdtempSync(join(tmpdir(), 'webdoom-ramfloor-'));
if (!KEEP) process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

// ── the builds ───────────────────────────────────────────────────────────────
// tools/cortexm builds in build directories of their own (rf-*), so this never
// shares objects with run-floor.sh's legs running beside it
// A lean Cortex-M build carries one IWAD's const texture tables (the four
// IWADs' do not fit the boards' CODE: tools/cortexm/Makefile TEXTURES_WADS),
// so a lean target is four ELFs, one per IWAD, each scenario run on its own
// WAD's; their RAM statics must be the same, and flash is reported for the
// largest.  The others are one ELF: { wad: elf } with '*' for every WAD.
function buildCm(isa, build) {
    const zc = isZc(build) ? 1 : 0, lean = build.startsWith('lean') || build === 'full' ? 1 : 0, lv = build === 'full' ? 1 : 0;
    const out = {};
    for (const w of lean ? P.IWADS.map(i => i.file) : ['*']) {
        const tw = w === '*' ? '' : w.replace('.wad', '');
        const B = join(root, 'tools/cortexm/build', `rf-${isa}-O1${lean ? `-lean-${tw}` : ''}${lv ? '-lv' : ''}${zc ? '-zc' : ''}`);
        const r = spawnSync('make', ['-s', '-C', join(root, 'tools/cortexm'), '-j8', `ISA=${isa}`, `ZC=${zc}`, `LEAN=${lean}`,
                                     `LEAN_LEVELS=${lv}`, ...(lean ? [`TEXTURES_WADS=${w}`] : []), `B=${B}`], { encoding: 'utf8' });
        if (r.status !== 0) fail(`make -C tools/cortexm ISA=${isa} ZC=${zc} LEAN=${lean} LEAN_LEVELS=${lv} ${lean ? `TEXTURES_WADS=${w}` : ''}:\n${((r.stdout ?? '') + (r.stderr ?? '')).trim().split('\n').slice(-8).join('\n')}`);
        out[w] = join(B, 'cm-doom.elf');
    }
    return out;
}
for (const t of TARGETS) {
    try {
        if (t.isa === 'x86') t.bin = P.buildX86(t.build);
        else { t.bins = buildCm(t.isa, t.build); t.bin = t.bins['*'] ?? t.bins['doom2.wad']; }
    }
    catch (e) { fail(e.message); }
}

// ── the statics ──────────────────────────────────────────────────────────────
const HARNESS_FILES = new Set(['i_main.c', 'perf.c', 'floor_wrap.c', 'heap_wrap.c', 'frames_wrap.c', 'floor_log.c', 'cm_main.c']);
// harness state inside port files: fs_audio.c's WD_AUDIO_TRACE and
// WD_AUDIO_STAGES buffers and the AUDIO line's counters, files.c's write hash
// (the -frames record's) and its kept savegames (a port's file system, not
// its RAM), i_system.c's timedemo exit and wipe clock
const HARNESS_SYMS = {
    'fs_audio.c': ['trace', 'ntrace', 'trace_lost', 'trace_path', 'stages', 'st_mus', 'st_sfx', 'st_sum', 'st_live', 'nstage',
                   'samples', 'blocks', 'sfx_starts', 'synthhash', 'mixhash', 'sfxhash'],
    'files.c': ['fs_write_count', 'fs_write_hash', 'fs_kept', 'fs_keep_alloc', 'fs_keep_release'],
    'i_system.c': ['fs_timedemo_active', 'fs_timedemo_gametics', 'fs_demo_jmp', 'fs_wipe_clock'],
};
const AUDIO_FILES = new Set(['fs_audio.c', 'sfx_mix.c', 'fs_mus.c', 'i_sound.c']);
const PLATFORM_FILES = new Set(['i_system.c', 'i_video.c', 'd_net.c', 'files.c',
                                'board.c', 'fault.c', 'semihost.c', 'syscalls.c', 'wad_semi.c']);
function classify(name, file) {
    const f = file ? resolve(file) : '';
    const base = basename(f);
    const rel = f ? relative(root, f) : '';
    if (name === 'fs_arena') return 'zone-arena';
    if (!f || f.includes('/newlib/') || f.includes('/glibc/')) return 'libc';
    if (rel.startsWith('engine/core/')) return 'engine';
    if (rel.startsWith('engine/web/')) return 'audio';
    if (HARNESS_FILES.has(base) || HARNESS_SYMS[base]?.includes(name.replace(/\.\d+$/, ''))) return 'harness';
    if (name === 'fs_screenbufs' || name === 'fs_screenbuf') return 'screens';
    if (AUDIO_FILES.has(base)) return 'audio';
    if (PLATFORM_FILES.has(base) && (rel.startsWith('tools/freestanding/') || rel.startsWith('tools/cortexm/'))) return 'platform';
    return null;
}
const RAM_PARTS = ['engine', 'screens', 'audio', 'platform', 'libc'];

function statics(t) {
    const nm = t.isa === 'x86' ? 'nm' : 'arm-none-eabi-nm', size = t.isa === 'x86' ? 'size' : 'arm-none-eabi-size';
    const r = spawnSync(nm, ['-S', '-l', '--defined-only', '--format=sysv', t.bin], { encoding: 'utf8', maxBuffer: 1 << 28 });
    if (r.status !== 0) fail(`${nm} ${t.bin}: ${r.stderr}`);
    const secs = Object.fromEntries(spawnSync(size, ['-A', t.bin], { encoding: 'utf8' }).stdout.split('\n')
        .map(l => l.trim().split(/\s+/)).filter(a => a.length === 3 && /^\d+$/.test(a[1])).map(a => [a[0], { size: +a[1], addr: +a[2] }]));
    const syms = [], unknown = [];
    // sysv: name |value|class|type|size|line|section<TAB>file:line.  RAM is
    // what lies in .data, .bss and cortexm's .zone and .big (x86's
    // .data.rel.ro, the const texture tables' pointer arrays, is const: a
    // static link resolves it, and on a board it is flash like .rodata)
    const RAMSEC = new Set(['.data', '.bss', '.zone', '.big']);
    for (const l of r.stdout.split('\n')) {
        const f = l.split('|');
        if (f.length < 7) continue;
        const [secName, where = ''] = f[6].split('\t');
        const sec = secName.trim();
        const s = { addr: parseInt(f[1], 16), size: parseInt(f[4], 16), type: f[2].trim(), name: f[0].trim(),
                    file: where.replace(/:\d+$/, ''), sec };
        if (!(s.size > 0) || f[3].trim() !== 'OBJECT' && f[3].trim() !== 'FUNC') continue;
        s.data = sec === '.data', s.bss = RAMSEC.has(sec) && !s.data, s.code = f[3].trim() === 'FUNC', s.ro = !RAMSEC.has(sec) && !s.code;
        s.cls = classify(s.name, s.file);
        s.key = `${s.name}@${s.file ? relative(root, resolve(s.file)) : ''}`;
        if (s.data || s.bss) {
            if (!s.cls) unknown.push(`${s.name} (${s.size} B, ${s.file || 'no file'})`);
            syms.push(s);
        } else syms.push(s);
    }
    if (unknown.length) fail(`${t.id}: ${unknown.length} static(s) no rule classifies: ${unknown.slice(0, 8).join(', ')}`);
    const ram = Object.fromEntries(RAM_PARTS.map(k => [k, 0]));
    let harness = 0, arena = 0, symTotal = 0, flashCode = 0, flashConst = 0, dataImage = 0;
    for (const s of syms) {
        if (s.data || s.bss) {
            symTotal += s.size;
            if (s.cls === 'harness') harness += s.size;
            else if (s.cls === 'zone-arena') arena += s.size;
            else ram[s.cls] += s.size;
            if (s.data && s.cls !== 'harness') dataImage += s.size;
        } else {
            if (s.file && HARNESS_FILES.has(basename(s.file))) continue;
            if (s.code) flashCode += s.size; else flashConst += s.size;
        }
    }
    // nm cannot split code from const data (cortexm puts .rodata inside its
    // .text output section, sections.ld; strings have no symbols): the link
    // map can, per input section
    ({ flashCode, flashConst } = mapFlash(t.isa === 'x86' ? `${t.bin}.map` : t.bin.replace(/\.elf$/, '.map')));
    // the sections the symbols live in (cortexm adds .zone and .big, sections.ld)
    const dataSecs = ['.data', '.bss', '.zone', '.big'].filter(k => secs[k]);
    const secTotal = dataSecs.reduce((a, k) => a + secs[k].size, 0);
    const align = secTotal - symTotal;
    if (align < 0) fail(`${t.id}: the data sections (${secTotal} B) hold less than their symbols (${symTotal} B)`);
    const engineData = syms.filter(s => s.data && s.cls === 'engine').reduce((a, s) => a + s.size, 0);
    return { syms, ram, harness, arena, align, secs, flashCode, flashConst, dataImage, engineData,
             staticSum: RAM_PARTS.reduce((a, k) => a + ram[k], 0) + align };
}

// code and const data kept by a GNU ld link, from its map: every .text*,
// .rodata* and .data.rel.ro* input section after "Linker script and memory
// map" (the discarded ones are listed before it), harness objects excluded
function mapFlash(path) {
    if (!existsSync(path)) fail(`${path}: no link map`);
    const L = readFileSync(path, 'utf8').split('\n');
    let i = L.findIndex(l => l.startsWith('Linker script and memory map'));
    if (i < 0) fail(`${path}: not a GNU ld map`);
    const out = { flashCode: 0, flashConst: 0 };
    for (; i < L.length; i++) {
        const m = /^ (\.text\S*|\.rodata\S*|\.data\.rel\.ro\S*)(?:\s+0x([0-9a-f]+)\s+0x([0-9a-f]+)\s+(\S+))?\s*$/.exec(L[i]);
        if (!m) continue;
        let [, sec, , size, obj] = m;
        if (!size) {
            const n = /^\s+0x([0-9a-f]+)\s+0x([0-9a-f]+)\s+(\S+)/.exec(L[i + 1] ?? '');
            if (!n) continue;
            [, , size, obj] = n;
            i++;
        }
        if (HARNESS_FILES.has(basename(obj).replace(/\.o$/, '.c'))) continue;
        out[sec.startsWith('.text') ? 'flashCode' : 'flashConst'] += parseInt(size, 16);
    }
    return out;
}

for (const t of TARGETS) {
    t.st = statics(t);
    // a lean Cortex-M target's other ELFs: the same RAM, their own flash
    for (const [w, elf] of Object.entries(t.bins ?? {})) {
        if (elf === t.bin) continue;
        const o = statics({ ...t, bin: elf });
        const a = JSON.stringify([o.ram, o.align, o.dataImage]), b = JSON.stringify([t.st.ram, t.st.align, t.st.dataImage]);
        if (a !== b) fail(`${t.id}: the ${w} build's RAM statics differ from the doom2.wad build's (${a} vs ${b})`);
        if (o.flashCode + o.flashConst > t.st.flashCode + t.st.flashConst)
            Object.assign(t.st, { flashCode: o.flashCode, flashConst: o.flashConst, flashWad: w });
    }
    if (t.bins && !t.bins['*']) t.st.flashWad ??= 'doom2.wad';
}

// ── the red-proof: a real rise must fail ─────────────────────────────────────
// The first default-build target of this run (x86/default, or armv6m/default
// for --isa cortexm), rebuilt with 256 more vissprites (MAXVISSPRITES, a real
// engine knob) in objects of its own, statics only, against that target's
// golden floor: the comparison below must call it a rise past the tolerance.
let redproof = 'skipped (no golden for the target)';
const tol = golden?.tolerance_bytes ?? 1024;
const rpT = TARGETS.find(t => t.build === 'default');
if (rpT && golden?.targets?.[rpT.id]) {
    let bin;
    if (rpT.isa === 'x86') {
        const fd = join(root, 'tools/freestanding');
        const r = spawnSync('make', ['-s', '-C', fd, '-j8', 'OBJDIR=obj-rp-ramfloor', 'OUT=fs-doom-rp-ramfloor',
                                     'EXTRA_CFLAGS=-DMAXVISSPRITES=1280', 'fs-doom-rp-ramfloor'], { encoding: 'utf8' });
        if (r.status !== 0) fail(`red-proof build: ${r.stderr.trim().split('\n').slice(-4).join(' | ')}`);
        bin = join(fd, 'fs-doom-rp-ramfloor');
    } else {
        const B = join(root, 'tools/cortexm/build', `rf-rp-${rpT.isa}-O1`);
        const r = spawnSync('make', ['-s', '-C', join(root, 'tools/cortexm'), '-j8', `ISA=${rpT.isa}`, 'ZC=0', 'LEAN=0', `B=${B}`,
                                     'EXTRA_CFLAGS=-DMAXVISSPRITES=1280'], { encoding: 'utf8' });
        if (r.status !== 0) fail(`red-proof build: ${r.stderr.trim().split('\n').slice(-4).join(' | ')}`);
        bin = join(B, 'cm-doom.elf');
    }
    const rp = statics({ id: `${rpT.id}+256 vissprites`, isa: rpT.isa, bin });
    const g = golden.targets[rpT.id];
    const rise = rp.staticSum - (g.sum - (g.zone ?? 0) - (g.stack ?? 0) - (g.heap ?? 0));
    if (!(rise > tol)) fail(`red-proof: 256 more vissprites on ${rpT.id} (+${rp.staticSum - rpT.st.staticSum} B of statics) read as a rise of ${rise} B, within the ${tol} B tolerance: this gate cannot see a real rise`);
    redproof = `256 more vissprites on ${rpT.id} read as +${rise.toLocaleString('en-US')} B, a FAIL`;
}

// ── the runs: the play set at each build's zone minimum ─────────────────────
const fmt = n => Math.round(n).toLocaleString('en-US');
// --only S[,S]: the play scenarios whose id contains one of these (a quick
// look; a run with it records nothing and passes nothing)
const ONLY = opt('--only')?.split(',');
if (ONLY && RECORD) fail('--only measures part of the play set: it cannot --record');
// --no-saveload: the play set without its save and load (a comparison: the
// golden is the whole set's)
const SAVELOAD = !args.includes('--no-saveload');
if (!SAVELOAD && RECORD) fail('--no-saveload is a comparison beside the golden, not one to --record');
const SCEN = P.scenarios(dir, { saveload: SAVELOAD }).filter(s => !ONLY || ONLY.some(o => s.id.includes(o)));
// The references: each build's own x86 binary at 8 MiB, which every target of
// that build is held to on every ISA.  Builds do not share them: the lean
// builds' vanilla limit of 128 vissprites drops sprites the others draw (the
// default build's records differ from the lean one's on doom2 MAP19).
const REFS = new Map();
async function refsFor(build) {
    if (REFS.has(build)) return REFS.get(build);
    const refBin = P.buildX86(build);
    const rs = await P.pool(SCEN.map(s => () => P.run(refBin, s, P.REF_KB, dir)), JOBS);
    const bad = SCEN.map((s, i) => [s, P.coverage(rs[i], s)]).filter(([, w]) => w);
    if (bad.length) fail(`${build}: play scenario ${bad[0][0].id}: ${bad[0][1]} (${bad.length} such)`);
    const m = new Map(SCEN.map((s, i) => [s.id, rs[i]]));
    REFS.set(build, m);
    console.log(`ram-floor: references: ${SCEN.length} play scenarios on x86 ${build} at ${P.REF_KB} KiB, ${fmt(rs.reduce((a, r) => a + r.frames.length, 0))} frames`);
    return m;
}

// the changed ranges of a WD_DATA_DIFF file, merged across runs
function readDiff(path, acc) {
    for (const l of readFileSync(path, 'utf8').split('\n')) {
        const [k, a, b] = l.split(' ');
        if (k === 'I' || k === 'P') acc[k].push([parseInt(a, 16), parseInt(b, 16)]);
    }
}
function overlaps(ranges, lo, hi) { // ranges sorted by start, merged
    let a = 0, b = ranges.length;
    while (a < b) { const m = (a + b) >> 1; if (ranges[m][1] <= lo) a = m + 1; else b = m; }
    return a < ranges.length && ranges[a][0] < hi;
}
const merge = rs => { rs.sort((x, y) => x[0] - y[0]); const o = []; for (const r of rs) { if (o.length && r[0] <= o.at(-1)[1]) o.at(-1)[1] = Math.max(o.at(-1)[1], r[1]); else o.push([...r]); } return o; };

// one pass of the play set on a target at kb KiB: the runs and what differed
async function pass(t, kb, diffs) {
    const refs = await refsFor(t.build);
    const runs = await P.pool(SCEN.map(s => async () => {
        if (t.isa === 'x86') {
            if (!diffs) return P.run(t.bin, s, kb, dir);
            const dd = join(dir, `${t.id.replace('/', '-')}.${s.id}.diff`);
            const r = await P.run(t.bin, s, kb, dir, { WD_DATA_DIFF: dd });
            if (existsSync(dd)) { readDiff(dd, diffs); rmSync(dd); } else r.nodiff = true;
            return r;
        }
        return P.runCm(t.bins['*'] ?? t.bins[s.wad], t.isa, s, kb, dir, { audio: true });
    }), JOBS);
    const differ = [];
    for (let i = 0; i < SCEN.length; i++) {
        const d = P.firstDiff(refs.get(SCEN[i].id), runs[i]);
        if (d) differ.push(`${SCEN[i].id} at frame ${d.frame}: ${d.what}`);
        else if (!runs[i].mem) differ.push(`${SCEN[i].id}: no MEM line`);
        else if (runs[i].nodiff) differ.push(`${SCEN[i].id}: no WD_DATA_DIFF file`);
        rmSync(join(dir, `${SCEN[i].id}${t.isa === 'x86' ? '' : `.${t.isa}`}.z${kb}.frames`), { force: true });
        rmSync(join(dir, `${SCEN[i].id}.${t.isa}.z${kb}.uart`), { force: true });
    }
    return { runs, differ };
}

for (const t of TARGETS) {
    if (STATICS) break;
    if (!t.run) continue;
    const kb = zoneKb[t.build];
    const t0 = Date.now();
    const diffs = { I: [], P: [] };
    const { runs, differ } = await pass(t, kb, t.isa === 'x86' ? diffs : null);
    if (differ.length) fail(`${t.id} at its recorded zone minimum ${kb} KiB: ${differ.length} of ${SCEN.length} play scenarios differ from 8 MiB (${differ.slice(0, 3).join('; ')}): the zone minimum rose, or the build broke`);
    const top = k => runs.reduce((a, r, i) => (r.mem[k] > a.v ? { v: r.mem[k], at: SCEN[i].id } : a), { v: 0, at: '' });
    t.stack = top('stack_peak');
    t.heap = top('heap_peak');
    t.zone = kb * 1024;
    t.secs = (Date.now() - t0) / 1000;
    if (t.isa === 'x86') { t.diffI = merge(diffs.I); t.diffP = merge(diffs.P); }
    console.log(`  ${t.id}: ${SCEN.length} scenarios identical to 8 MiB at ${kb} KiB; stack ${fmt(t.stack.v)} B (${t.stack.at}), heap ${fmt(t.heap.v)} B (${t.heap.at}); ${t.secs.toFixed(0)} s`);
    if (BOTH) {
        const below = await pass(t, kb - 4, null);
        if (!below.differ.length) fail(`${t.id}: the play set also runs at ${kb - 4} KiB: the recorded minimum ${kb} KiB is not the boundary on this ISA`);
        t.below = below.differ;
        console.log(`  ${t.id}: at ${kb - 4} KiB ${below.differ.length} of ${SCEN.length} scenarios differ (first ${below.differ[0]}): both sides hold`);
    }
}

// ── flash: what is there, and what RAM could follow it ───────────────────────
// x86's verdict per symbol, from the diffs; cortexm's from x86's same build
const verdict = {};
for (const t of TARGETS.filter(t => t.isa === 'x86' && t.diffI)) {
    const v = verdict[t.build] = new Map();
    for (const s of t.st.syms.filter(s => (s.data || s.bss) && RAM_PARTS.includes(s.cls))) {
        const i = overlaps(t.diffI, s.addr, s.addr + s.size), p = overlaps(t.diffP, s.addr, s.addr + s.size);
        v.set(s.key, p ? 'play' : i ? 'init' : 'never');
    }
}
for (const t of TARGETS) {
    const v = verdict[t.build];
    t.flash = { never_data: 0, never_bss: 0, init: 0, play: 0, unmatched: 0, derived: t.isa !== 'x86' };
    if (!v) { t.flash = null; continue; }
    for (const s of t.st.syms.filter(s => (s.data || s.bss) && RAM_PARTS.includes(s.cls))) {
        const k = v.get(s.key);
        if (!k) t.flash.unmatched += s.size;
        else if (k === 'never') t.flash[s.data ? 'never_data' : 'never_bss'] += s.size;
        else t.flash[k] += s.size;
    }
}

// ── the table ────────────────────────────────────────────────────────────────
console.log('');
console.log('RAM, bytes (statics: engine and port .data+.bss by source; zone: the play-inclusive minimum; stack, heap: play-set peaks)');
const H = ['target', 'engine', 'screens', 'audio', 'platform', 'libc', 'align', 'zone', 'stack', 'heap', 'FLOOR', 'excluded harness'];
const rows = [];
for (const t of TARGETS) {
    const r = t.st.ram;
    t.sum = t.st.staticSum + (t.zone ?? 0) + (t.stack?.v ?? 0) + (t.heap?.v ?? 0);
    rows.push([t.id, r.engine, r.screens, r.audio, r.platform, r.libc, t.st.align, t.zone ?? '-', t.stack?.v ?? '-', t.heap?.v ?? '-',
               STATICS ? '-' : t.run ? t.sum : `${fmt(t.sum)} (statics)`, t.st.harness]);
}
const w = H.map((h, i) => Math.max(h.length, ...rows.map(r => String(typeof r[i] === 'number' ? fmt(r[i]) : r[i]).length)));
const line = r => r.map((c, i) => String(typeof c === 'number' ? fmt(c) : c)[i ? 'padStart' : 'padEnd'](w[i])).join('  ');
console.log(line(H));
for (const r of rows) console.log(line(r));
console.log('');
console.log('Flash, bytes (code and const data as linked, harness code excluded; .data image: the initial values a board copies to RAM;');
console.log('a lean Cortex-M build holds one IWAD\'s texture tables: the largest of the four is shown, named),');
console.log('and the RAM statics by what the play set did to them (x86 measured with WD_DATA_DIFF; Cortex-M borrows x86\'s verdicts, derived):');
const F = ['target', 'code', 'const', '.data image', 'never-changed .data', 'init-only', 'never-touched .bss', 'changed in play', 'no x86 twin'];
const frows = TARGETS.map(t => [t.id + (t.st.flashWad ? ` (${t.st.flashWad.replace('.wad', '')})` : ''), t.st.flashCode, t.st.flashConst, t.st.dataImage,
                                 ...(t.flash ? [t.flash.never_data, t.flash.init, t.flash.never_bss, t.flash.play, t.flash.unmatched] : ['-', '-', '-', '-', '-'])]);
const fw = F.map((h, i) => Math.max(h.length, ...frows.map(r => String(typeof r[i] === 'number' ? fmt(r[i]) : r[i]).length)));
const fline = r => r.map((c, i) => String(typeof c === 'number' ? fmt(c) : c)[i ? 'padStart' : 'padEnd'](fw[i])).join('  ');
console.log(fline(F));
for (const r of frows) console.log(fline(r));

// the biggest RAM statics of the smallest target, by name, with x86's verdict
const small = TARGETS.find(t => t.id === 'armv8m/full') ?? TARGETS.at(-1);
const big = small.st.syms.filter(s => (s.data || s.bss) && RAM_PARTS.includes(s.cls)).sort((a, b) => b.size - a.size).slice(0, 14);
console.log(`\nThe largest RAM statics of ${small.id}: ` + big.map(s => `${s.name} ${fmt(s.size)} (${s.cls}${verdict[small.build] ? `, ${verdict[small.build].get(s.key) ?? 'no twin'}` : ''})`).join('; '));

if (STATICS) { console.log('\nram-floor: --statics: no runs, no verdict'); process.exit(0); }

// ── the verdict ─────────────────────────────────────────────────────────────
const PARTS = ['engine', 'screens', 'audio', 'platform', 'libc', 'align', 'zone', 'stack', 'heap'];
const record = t => ({ ...Object.fromEntries(RAM_PARTS.map(k => [k, t.st.ram[k]])), align: t.st.align,
                       zone: t.run ? t.zone : null, stack: t.run ? t.stack.v : null, heap: t.run ? t.heap.v : null,
                       sum: t.sum, ...(t.run ? {} : { statics_only: 'a copying Cortex-M build cannot play the game with its sound here' }) });
if (RECORD) {
    const out = {
        doc: golden?.doc ?? [],
        tolerance_bytes: tol,
        tolerance_why: golden?.tolerance_why ?? '',
        zone_kb: zoneKb,
        targets: { ...(golden?.targets ?? {}), ...Object.fromEntries(TARGETS.map(t => [t.id, record(t)])) },
    };
    writeFileSync(GOLDEN, JSON.stringify(out, null, 1) + '\n');
    console.log(`\nram-floor: recorded ${TARGETS.length} target(s) in ${relative(root, GOLDEN)}`);
    process.exit(0);
}
if (ONLY || !SAVELOAD) { console.log(`\nram-floor: ${ONLY ? `--only ${ONLY.join(',')}: ${SCEN.length} of the play set` : '--no-saveload'}, no verdict`); process.exit(0); }
if (!golden) fail(`no golden (${relative(root, GOLDEN)}); measure and write it with --record`);
const rose = [], fell = [], missing = [];
for (const t of TARGETS) {
    const g = golden.targets?.[t.id];
    if (!g) { missing.push(t.id); continue; }
    const d = t.sum - g.sum;
    const parts = PARTS.filter(k => record(t)[k] !== g[k]).map(k => `${k} ${record(t)[k] - g[k] > 0 ? '+' : ''}${fmt(record(t)[k] - g[k])}`);
    if (d > tol) rose.push(`${t.id} +${fmt(d)} B (${parts.join(', ')})`);
    else if (d < -tol) fell.push(`${t.id} ${fmt(d)} B (${parts.join(', ')})`);
    t.delta = d;
}
if (missing.length) fail(`${missing.join(', ')}: not in the golden (--record)`);
if (rose.length) fail(`the RAM floor rose by more than ${fmt(tol)} B: ${rose.join('; ')}`);
for (const f of fell) console.log(`NOTE ram-floor: the floor fell: ${f}; the golden is stale: re-record (node tools/floor/ram-floor.mjs --record)`);
const most = TARGETS.reduce((a, t) => (Math.abs(t.delta) > Math.abs(a.delta) ? t : a));
const ran = TARGETS.filter(t => t.run);
console.log(`PASS ram-floor: ${TARGETS.length} targets (${[...new Set(TARGETS.map(t => t.isa))].join(', ')} x ${BUILDS.length} builds; ` +
            `${ran.length} run, ${TARGETS.length - ran.length} statics only), each floor within ${fmt(tol)} B of the golden ` +
            `(largest move ${most.id} ${most.delta >= 0 ? '+' : ''}${fmt(most.delta)} B); ${SCEN.length} play scenarios identical to 8 MiB ` +
            `at each run target's zone minimum (${ran.map(t => `${t.id} ${zoneKb[t.build]}`).join(', ')} KiB); red-proof: ${redproof}`);
