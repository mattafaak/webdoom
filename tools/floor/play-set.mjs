// tools/floor/play-set.mjs — play beyond the 13 demos, for the floor's RAM
// measurements (zone-min.mjs --play, ram-floor.mjs).
//
// The 13 demos never change level and their wipes are cut short, so a zone
// that runs them can still be too small for a game.  The play set adds:
//
//   exits  each of the 13 demos with a level exit injected at a tic of its own
//          (fs-doom's -frames mode, WD_EXIT_AT): the melt wipe run to its end,
//          the intermission (and Doom II's text screen after MAP11), the next
//          level loaded into the zone the first one left, played to the demo's
//          end by the rest of its input;
//   maps   every map of the four IWADs (all 132, so "the largest" needs no
//          ranking to be right), each a scripted demo: the map at
//          ultra-violence (the most things), a full turn on the spot, then
//          SCRIPT_TICS of running, turning, strafing, firing, switching
//          weapons and pressing use (doors, lifts, switches; and when the
//          player has died, the level reloads), the opening wipe run to its end;
//          and then, on 129 of them (SAVELOAD_CRASHES has the other three),
//          the game is saved (SAVE_AT) and loaded back (LOAD_AT): the save is
//          heap while it is written (G_DoSaveGame) and zone while it is read
//          (M_ReadFile holds it, PU_STATIC, while the level loads around it),
//          and a loaded game is no longer a demo, so the run idles to END_AT.
//          Where the save lands splits the zone the level then loads into, so
//          in the copying builds the smallest zone that survives it is far
//          less regular (measured, the default build: 1,604 KiB, a
//          bisection's answer, passes, and so does 1,728; 1,724 and 1,760
//          fail; every step from 1,764 to 1,856 passes).  { saveload:
//          false } (zone-min.mjs, ram-floor.mjs --no-saveload) leaves it out.
//
// A scripted demo is written here (scriptedDemo) and handed to fs-doom with
// -lmp, which plays it as the IWAD's DEMO1 (i_main.c): the same lumps, the same
// directory and the same heap as a real demo.
//
// What "correct" means for a run with no golden: every frame's render and sim
// hash equal to the same scenario's at an 8 MiB zone, through the same binary,
// and the run ending at the demo's end.  A smaller zone can only make a run
// fail by changing what it computes or by Z_Malloc's I_Error; both show.
//
// Every record also carries the run's MEM line (stack and heap peaks) and an
// L line per level load: what the zone held with the level in it.
// Copyright (C) 2026, GPL-2.0-or-later.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { root } from '../lib/util.mjs';

export const WADS_DIR = join(root, 'wads/lib');

// The host builds the floor measures (tools/freestanding/Makefile), each from
// objects of its own: make arguments and the binary.  default and zc are the
// suite's fs-doom and fs-doom-zc (`make` builds both); the others have object
// directories no other leg builds in (lean-screens, textures-const,
// lean-levels and floor-lean build obj-lean, obj-leanzc, obj-full).  full is
// the full memory diet: every RAM lever of LEAN=1 (vanilla limits, the lookup
// and texture tables and composites const, LEAN_SCREENS), lumps read in place
// and the level read in place and narrowed (LEAN_LEVELS).
export const X86_BUILDS = {
    default: { make: ['OUT=fs-doom'], out: 'fs-doom', objdir: 'obj' },
    zc: { make: ['ZERO_COPY=1', 'OBJDIR=obj-zc', 'OUT=fs-doom-zc'], out: 'fs-doom-zc', objdir: 'obj-zc' },
    lean: { make: ['LEAN=1', 'OBJDIR=obj-lean-floor', 'OUT=fs-doom-lean-floor'], out: 'fs-doom-lean-floor', objdir: 'obj-lean-floor' },
    leanzc: { make: ['LEAN=1', 'ZERO_COPY=1', 'OBJDIR=obj-leanzc-floor', 'OUT=fs-doom-leanzc-floor'], out: 'fs-doom-leanzc-floor', objdir: 'obj-leanzc-floor' },
    full: { make: ['LEAN=1', 'ZERO_COPY=1', 'LEAN_LEVELS=1', 'OBJDIR=obj-full-floor', 'OUT=fs-doom-full-floor'], out: 'fs-doom-full-floor', objdir: 'obj-full-floor' },
};
// make one; returns the binary's path, or throws with the build's last lines.
// Under run-tests.sh --jobs several legs may ask for the same build at once:
// make runs under an flock of its own per object directory, so one compiles
// and the others then find it up to date.
export function buildX86(name) {
    const b = X86_BUILDS[name];
    if (!b) throw new Error(`no host build '${name}' (${Object.keys(X86_BUILDS).join(', ')})`);
    const dir = join(root, 'tools/freestanding');
    const r = spawnSync('flock', [join(dir, `.${b.objdir}.lock`), 'make', '-s', '-C', dir, '-j8', ...b.make, b.out],
                        { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`make ${b.make.join(' ')} failed:\n${(r.stderr ?? '').trim().split('\n').slice(-8).join('\n')}`);
    return join(dir, b.out);
}
export const REF_KB = 8192; // the reference zone: fs-doom's whole arena

// The four IWADs, presented as run-x86.sh presents them (doom.wad as doomu.wad:
// The Ultimate Doom's fourth episode).
export const IWADS = [
    { file: 'doom.wad', as: 'doomu.wad', maps: [1, 2, 3, 4].flatMap(e => [1, 2, 3, 4, 5, 6, 7, 8, 9].map(m => [e, m])) },
    { file: 'doom2.wad', as: 'doom2.wad', maps: Array.from({ length: 32 }, (_, i) => [1, i + 1]) },
    { file: 'tnt.wad', as: 'tnt.wad', maps: Array.from({ length: 32 }, (_, i) => [1, i + 1]) },
    { file: 'plutonia.wad', as: 'plutonia.wad', maps: Array.from({ length: 32 }, (_, i) => [1, i + 1]) },
];
export const mapName = (iwad, e, m) => iwad.file === 'doom.wad' ? `E${e}M${m}` : `MAP${String(m).padStart(2, '0')}`;

// The 13 demos and where each exits its level: about a third of the way in,
// so the level has been played and the demo has two thirds left for the
// intermission and the next level.  coverage() checks each one still reaches
// what it is for.
export const EXITS = [
    { id: 'doom-demo1', wad: 'doom.wad', as: 'doomu.wad', demo: 'demo1', at: 600 },   // E1M5 -> E1M6
    { id: 'doom-demo2', wad: 'doom.wad', as: 'doomu.wad', demo: 'demo2', at: 800 },   // E2M2 -> E2M3
    { id: 'doom-demo3', wad: 'doom.wad', as: 'doomu.wad', demo: 'demo3', at: 1300 },  // E3M5 -> E3M6
    { id: 'doom-demo4', wad: 'doom.wad', as: 'doomu.wad', demo: 'demo4', at: 280 },   // E4M2 -> E4M3
    { id: 'doom2-demo1', wad: 'doom2.wad', as: 'doom2.wad', demo: 'demo1', at: 400 }, // MAP11 -> text -> MAP12
    { id: 'doom2-demo2', wad: 'doom2.wad', as: 'doom2.wad', demo: 'demo2', at: 700 }, // MAP05 -> MAP06
    { id: 'doom2-demo3', wad: 'doom2.wad', as: 'doom2.wad', demo: 'demo3', at: 1500 }, // MAP26 -> MAP27
    { id: 'tnt-demo1', wad: 'tnt.wad', as: 'tnt.wad', demo: 'demo1', at: 1500 },      // MAP01 -> MAP02
    { id: 'tnt-demo2', wad: 'tnt.wad', as: 'tnt.wad', demo: 'demo2', at: 1200 },      // MAP12 -> MAP13
    { id: 'tnt-demo3', wad: 'tnt.wad', as: 'tnt.wad', demo: 'demo3', at: 1150 },      // MAP13 -> MAP14
    { id: 'plutonia-demo1', wad: 'plutonia.wad', as: 'plutonia.wad', demo: 'demo1', at: 2500 }, // MAP17 -> MAP18
    { id: 'plutonia-demo2', wad: 'plutonia.wad', as: 'plutonia.wad', demo: 'demo2', at: 1150 }, // MAP10 -> MAP11
    { id: 'plutonia-demo3', wad: 'plutonia.wad', as: 'plutonia.wad', demo: 'demo3', at: 1900 }, // MAP12 -> MAP13
];

export const SCRIPT_TICS = 2100; // 60 s of play per map
export const SCRIPT_SKILL = 3;   // sk_hard: ultra-violence, as the IWAD demos
// the save, the load and the end, in gametics (i_main.c's WD_SAVE_AT,
// WD_LOAD_AT, WD_END_AT; cm_main.c's -save-at, -load-at, -end-at)
export const SAVE_AT = 1900, LOAD_AT = 2000, END_AT = 2350;
// Three maps play their script without the save and load, because loading
// that save crashes the engine at any zone size, vanilla's way: a monster
// saved mid-attack comes back with no target (P_UnArchiveThinkers clears
// mobj->target) and its next action dereferences it.  Measured at 8 MiB:
//   doom2 MAP07, plutonia MAP32  a mancubus: A_FatAttack2/3 -> P_SpawnMissile
//                                with dest NULL (p_mobj.c:947), SIGSEGV
//   doom2 MAP30                  a boss cube: A_SpawnFly reads its NULL
//                                target (p_enemy.c:1964), SIGSEGV
// (engine/core's to fix; the floor only needs the RAM the other 129 show)
export const SAVELOAD_CRASHES = ['doom2.wad:MAP07', 'doom2.wad:MAP30', 'plutonia.wad:MAP32'];

// A demo (v1.9 format, version 109 as the IWADs' own) on map (e, m): a full
// turn on the spot, then segments of scripted movement, firing most tics,
// pressing use every sixth tic (a press needs a release between), and asking
// for the next weapon every five seconds.  The sequence is a function of the
// map alone (xorshift32 seeded by its name), so every run of a scenario plays
// the same input.
export function scriptedDemo(name, e, m, tics = SCRIPT_TICS, skill = SCRIPT_SKILL) {
    let x = 2166136261;
    for (const c of name) x = Math.imul(x ^ c.charCodeAt(0), 16777619) >>> 0;
    const rnd = n => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x % n; };
    const b = Buffer.alloc(13 + tics * 4 + 1);
    b.set([109, skill, e, m, 0, 0, 0, 0, 0, 1, 0, 0, 0]);
    let fm = 0, sm = 0, turn = 0, left = 0, weapon = 1;
    for (let t = 0; t < tics; t++) {
        if (t < 64) { fm = 0; sm = 0; turn = 4; }            // 64 x 1024 = a full turn
        else if (left-- <= 0) {
            left = 15 + rnd(50);
            const k = rnd(6);
            fm = k === 5 ? -50 : k === 4 ? 0 : 50;            // run, or turn in place, or back off
            sm = k === 3 ? (rnd(2) ? 40 : -40) : 0;
            turn = k === 4 ? (rnd(2) ? 1 : -1) * (3 + rnd(4)) : rnd(5) - 2;
        }
        let buttons = rnd(10) ? 1 : 0;                        // BT_ATTACK, 90% of tics
        if (t % 6 === 0) buttons |= 2;                        // BT_USE
        if (t % 175 === 100) { weapon = weapon % 6 + 1; buttons = 4 | (weapon << 3); } // BT_CHANGE
        const o = 13 + t * 4;
        b.writeInt8(fm, o);
        b.writeInt8(sm, o + 1);
        b.writeUInt8(turn & 0xff, o + 2);                     // angleturn's high byte
        b.writeUInt8(buttons, o + 3);
    }
    b[13 + tics * 4] = 0x80;                                  // DEMOMARKER
    return b;
}

// The scenario list: { id, kind, wad, as, demo, env, lmp? }.  `maps` filters
// the map sweep (a list of 'tnt.wad:MAP31'-style names; null = all 132).
export function scenarios(dir, { exits = true, maps = null, tics = SCRIPT_TICS, saveload = true } = {}) {
    const out = [];
    if (exits)
        for (const s of EXITS)
            out.push({ id: `exit-${s.id}`, kind: 'exit', wad: s.wad, as: s.as, demo: s.demo,
                       env: { WD_EXIT_AT: String(s.at) } });
    for (const iwad of IWADS)
        for (const [e, m] of iwad.maps) {
            const name = mapName(iwad, e, m);
            if (maps && !maps.includes(`${iwad.file}:${name}`)) continue;
            const id = `map-${iwad.file.replace('.wad', '')}-${name}`;
            const lmp = join(dir, `${id}.lmp`);
            if (!existsSync(lmp)) writeFileSync(lmp, scriptedDemo(`${iwad.file}:${name}`, e, m, tics));
            const sl = saveload && !SAVELOAD_CRASHES.includes(`${iwad.file}:${name}`);
            out.push({ id, kind: 'map', wad: iwad.file, as: iwad.as, demo: 'demo1', lmp, map: name, saveload: sl,
                       env: sl ? { WD_SAVE_AT: `${SAVE_AT}:0`, WD_LOAD_AT: `${LOAD_AT}:0`, WD_END_AT: String(END_AT) } : {} });
        }
    return out;
}

// One run of a scenario at `kb` KiB of zone: the parsed -frames record.
// `cpu` pins it (taskset), for a run that counts instructions.
export function run(bin, s, kb, dir, extraEnv = {}, cpu = null) {
    const wdir = join(dir, 'wads');
    mkdirSync(wdir, { recursive: true });
    const w = join(wdir, s.as);
    if (!existsSync(w)) symlinkSync(join(WADS_DIR, s.wad), w);
    const out = join(dir, `${s.id}.z${kb}.frames`);
    const args = [w, '-timedemo', s.demo, '-frames', out, ...(s.lmp ? ['-lmp', s.lmp] : [])];
    return new Promise(res => {
        const cmd = cpu === null ? [resolve(bin), args] : ['taskset', ['-c', String(cpu), resolve(bin), ...args]];
        const p = spawn(cmd[0], cmd[1], {
            cwd: dir, stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, WD_WIPES: '1', WD_ZONE_KB: String(kb), ...s.env, ...extraEnv },
        });
        let so = '', se = '';
        p.stdout.on('data', d => { so += d; });
        p.stderr.on('data', d => { se += d; });
        p.on('exit', (code, signal) => res(parse(out, s, kb, code, signal, so + se)));
    });
}

// The same run on a Cortex-M build under qemu (tools/cortexm/cm_main.c's play
// mode): `elf` built for `isa`, the zone handed `kb` KiB of its arena, the
// sound on when `audio` (a copying build reads sound effects in place, which
// its WAD window cannot serve: there the sound must stay off).
export const BOARDS = { armv6m: 'mps2-an385', armv8m: 'mps2-an505' };
export function runCm(elf, isa, s, kb, dir, { audio = true } = {}) {
    const out = join(dir, `${s.id}.${isa}.z${kb}.frames`);
    const wad = join(WADS_DIR, s.wad);
    const a = ['cm-doom', '-wad', wad, '-as', s.as, '-timedemo', s.demo, '-frames', out, '-zone', String(kb),
               ...(s.env.WD_EXIT_AT ? ['-exit-at', s.env.WD_EXIT_AT] : []), ...(s.lmp ? ['-lmp', s.lmp] : []),
               ...(s.saveload ? ['-save-at', String(SAVE_AT), '-load-at', String(LOAD_AT), '-end-at', String(END_AT)] : []),
               ...(audio ? ['-audio', '1'] : [])];
    for (const x of a) if (/[, ]/.test(x)) throw new Error(`play-set: qemu's semihosting cannot pass '${x}' (comma or space)`);
    const uart = join(dir, `${s.id}.${isa}.z${kb}.uart`);
    return new Promise(res => {
        const p = spawn('qemu-system-arm', ['-M', BOARDS[isa], '-icount', 'shift=0', '-display', 'none', '-monitor', 'none',
                                            '-serial', `file:${uart}`, '-semihosting-config',
                                            ['enable=on', 'target=native', ...a.map(x => `arg=${x}`)].join(','),
                                            '-kernel', resolve(elf)], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
        let se = '';
        p.stdout.on('data', d => { se += d; });
        p.stderr.on('data', d => { se += d; });
        p.on('exit', (code, signal) => {
            const u = existsSync(uart) ? readFileSync(uart, 'latin1') : '';
            res(parse(out, s, kb, code, signal, u + se));
        });
    });
}

export function parse(path, s, kb, code, signal, text) {
    const t = existsSync(path) ? readFileSync(path, 'utf8') : '';
    const frames = [], levels = [], zone = [], wipes = [], saves = [];
    let head = null, end = null, mem = null;
    for (const l of t.split('\n')) {
        const f = l.split(' ');
        if (f[0] === 'F') frames.push({ n: +f[1], gametic: +f[2], gs: +f[3], wipe: +f[4], render: f[5], sim: f[6],
                                        ep: +(f[13] ?? 0), map: +(f[14] ?? 0),
                                        instr: +(f[15] ?? 0), wiping: +(f[16] ?? 0), wipeInstr: +(f[17] ?? 0) });
        else if (f[0] === 'W') wipes.push({ frame: +f[1], ...kv(f.slice(2)) });
        else if (f[0] === 'L') levels.push({ frame: +f[1], ep: +f[2], map: +f[3], ...kv(f.slice(4)) });
        else if (f[0] === 'Z') zone.push({ frame: +f[1], ...kv(f.slice(2)) });
        else if (f[0] === 'S') saves.push({ frame: +f[1], gametic: +f[2], slot: +f[3], bytes: +f[4] });
        else if (f[0] === 'MEM') mem = kv(f.slice(1));
        else if (f[0] === 'FRAMES') head = l;
        else if (f[0] === 'END') end = l;
    }
    const err = text.match(/(I_Error: |FAULT |FAIL cm)[^\n]*/)?.[0] ?? '';
    return { id: s.id, kind: s.kind, kb, frames, levels, zone, wipes, saves, mem, head, end, code, signal, err,
             ok: code === 0 && !!end && !err };
}
const kv = a => Object.fromEntries(a.filter(x => x.includes('=')).map(x => { const [k, v] = x.split('='); return [k, +v]; }));

// The first frame at which a run differs from its reference, or null.
export function firstDiff(ref, got) {
    const n = Math.min(ref.frames.length, got.frames.length);
    for (let i = 0; i < n; i++) {
        const a = ref.frames[i], b = got.frames[i];
        for (const k of ['n', 'gametic', 'gs', 'wipe', 'render', 'sim'])
            if (a[k] !== b[k]) return { frame: i, what: k, gametic: a.gametic };
    }
    if (ref.frames.length !== got.frames.length || !got.ok)
        return { frame: n, what: got.ok ? 'length' : `end (${got.err || got.signal || `exit ${got.code}`})`, gametic: ref.frames[n]?.gametic };
    return null;
}

// What a reference run must contain for its scenario to be testing what it
// says: an exit reaches its intermission (and the next level after it); a map
// loads that map and plays it to the script's end.  Returns a reason, or null.
export function coverage(ref, s) {
    if (!ref.ok) return `the 8 MiB reference did not run to its end (${ref.err || ref.signal || `exit ${ref.code}`})`;
    const f = ref.frames;
    if (s.kind === 'exit') {
        const inter = f.findIndex(x => x.gs === 1);
        if (inter < 0) return 'no intermission frame: the exit never happened';
        const after = f.slice(inter).filter(x => x.gs === 0).length;
        if (after < 200) return `${after} level frames after the intermission (200 expected): the next level was barely played`;
        if (ref.levels.length < 2) return `${ref.levels.length} level load(s) (2 expected)`;
        return null;
    }
    if (!ref.levels.length) return 'no level load';
    const wipes = f.filter((x, i) => x.wipe && !(f[i - 1]?.wipe)).length;
    if (!wipes) return 'no wipe ran';
    if (!s.saveload) return null;
    const save = ref.saves.find(x => x.slot === 0);
    if (!save) return 'no save (no S line)';
    if (!ref.levels.some(l => l.frame > save.frame)) return 'the load loaded no level after the save';
    if (f.at(-1).gametic < END_AT) return `the run ended at gametic ${f.at(-1).gametic}, before ${END_AT}`;
    return null;
}

// The zone's contents after each level load, from a record: the largest
// level (PU_LEVEL + PU_LEVSPEC) this scenario loaded.
export const levelPeak = r => r.levels.reduce((a, l) => l.level > a.level ? l : a, { level: 0 });

// Run jobs with at most `n` at a time.
export async function pool(jobs, n) {
    const out = new Array(jobs.length);
    let next = 0;
    async function worker() { while (next < jobs.length) { const i = next++; out[i] = await jobs[i](); } }
    await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, worker));
    return out;
}
