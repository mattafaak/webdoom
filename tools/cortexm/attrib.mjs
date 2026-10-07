#!/usr/bin/env node
// tools/cortexm/attrib.mjs — exact attribution of a Cortex-M floor run: every
// guest instruction of every tic, by function family and engine stage.
//
// usage: node tools/cortexm/attrib.mjs armv6m|armv8m [--zero-copy] [--variant NAME]
//            [--drawers | --fixed | --fast] [--jobs N] [--no-run] [--json FILE]
//            [--demos a,b] [--red-proof]
//
// It runs the 13 demos (mode B, the timing run) of a build run-floor.sh has
// already built and run, under qemu with tools/cortexm/qemu_attrib.c loaded:
// a TCG plugin that adds 1 to the executing function's counter on every
// instruction and splits the counts at the engine's own stage brackets
// (web_perf_now in d_main.c and r_main.c) and at the harness's tic boundaries
// (cm_ticks in cm_main.c).  Nothing is sampled and nothing in the guest
// changes: the plugin reads no register and writes nothing.
//
// Three checks make the numbers evidence, and any failure is a FAIL:
//   1. the attributed run is the measured run: its floor log has the same
//      tics and the same final state as the leg's (out/<isa>-O1<suffix>), every
//      tic's count within two timer steps.  Not one: the engine's own brackets
//      add timer readings as doubles (soft-float, 695 to 864 instructions a
//      tic, measured), so a run whose boot leaves the timer at another phase
//      runs a few instructions more or fewer in a tic, and the two quantised
//      counts can then differ by two steps (docs/retro.md: "to within a few
//      instructions");
//   2. per tic, the plugin's total equals the guest timer's count to within
//      one timer step (CM_INSN_PER_TICK: 40 on the an385, 50 on the an505);
//   3. per tic and stage, the plugin's stage total equals the stats file's
//      bracket to within one timer step; and no instruction in a tic falls
//      outside the ELF's mapped code.
//
// --red-proof drops the BSP stage's closing event from the map, so the
// instructions from there to the planes bracket (NetUpdate) land in the BSP
// stage: check 3 must FAIL on every rendered tic, and then this prints PASS
// and exits 0; anything else is a FAIL (the check could not see it).
//
// The report: the worst graded tic and the mean graded tic, by family
// (each drawer, the libgcc helpers, the rest of each stage) and stage, as
// instructions and shares.  The drawers' calls are also split by screen half
// (x < 160 or >= 160; a span that crosses 160 is "cross"), for the dual-core
// model (tools/cortexm/dualcore.mjs reads --json).
// Copyright (C) 2026, GPL-2.0-or-later.
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLog, DEMOS } from '../floor/floor-gate.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CM = join(root, 'tools/cortexm');
export const STAGES = ['other', 'sim', 'frame', 'bsp', 'planes', 'masked'];
const fails = [];
const fmt = v => Math.round(v).toLocaleString('en-US');

// ── the bucket map: every .text input section of the link map ───────────────
// A port's drawer replaces an engine drawer through --wrap: its section is
// .text.__wrap_<engine name>, and it is charged to the engine drawer's family;
// the engine's own function, which the port hands the cases it does not take,
// is the same family's ":engine" bucket, reported apart.
export const DRAWERS = ['R_DrawColumn', 'R_DrawSpan', 'R_DrawFuzzColumn', 'R_DrawTranslatedColumn', 'R_DrawColumnLow', 'R_DrawSpanLow'];
function bucketName(section, obj, wrapped) {
    const fn = section.startsWith('.text.') ? section.slice(6) : '';
    const plain = fn.replace(/^__wrap_/, '');
    if (DRAWERS.includes(plain)) return `draw:${plain}${plain === fn && wrapped.has(plain) ? ':engine' : ''}`;
    if (fn === 'cm_udiv30') return 'port:cm_udiv30';
    let m;
    if ((m = /libgcc\.a\((.*)\.o\)$/.exec(obj))) return `libgcc:${fn || m[1]}`;
    if ((m = /lib(c|m|nosys)\.a\((?:lib\w?_a)-(.*)\.o\)$/.exec(obj))) return `lib${m[1]}:${m[2]}`;
    if ((m = /\/(core|fs|cm|floor|web)\/([^/]+)\.o$/.exec(obj))) return `${m[1]}:${m[2]}`;
    if ((m = /\/([^/]+)\.o$/.exec(obj))) return `port:${m[1]}`;
    return `other:${basename(obj)}`;
}
export function readMap(mapFile) {
    const text = readFileSync(mapFile, 'utf8');
    const start = text.indexOf('\nLinker script and memory map');
    if (start < 0) throw new Error(`${mapFile}: no memory map`);
    const lines = text.slice(start).split('\n');
    const secs = [];
    let inText = false, pend = null;
    for (const l of lines) {
        if (/^\.text\s/.test(l)) { inText = true; continue; }
        if (/^\.[A-Za-z]/.test(l)) { if (inText) break; continue; }
        if (!inText) continue;
        let m;
        if ((m = /^ (\.text\S*)\s+0x([0-9a-f]+)\s+0x([0-9a-f]+)\s+(\S.*)$/.exec(l))) { secs.push({ sec: m[1], lo: parseInt(m[2], 16), size: parseInt(m[3], 16), obj: m[4] }); pend = null; }
        else if ((m = /^ (\.text\S*)$/.exec(l))) pend = m[1];
        else if (pend && (m = /^\s+0x([0-9a-f]+)\s+0x([0-9a-f]+)\s+(\S.*)$/.exec(l))) { secs.push({ sec: pend, lo: parseInt(m[1], 16), size: parseInt(m[2], 16), obj: m[3] }); pend = null; }
        else pend = null;
    }
    return secs.filter(s => s.size > 0);
}

// ── the events: return addresses of the bracketing calls ─────────────────────
function callSites(elf) {
    const out = execFileSync('arm-none-eabi-objdump', ['-d', '-l', '--no-show-raw-insn', elf], { encoding: 'utf8', maxBuffer: 1 << 30 });
    const sites = [];
    let loc = null;
    for (const l of out.split('\n')) {
        let m;
        if ((m = /^(\/\S+):(\d+)(?: \(discriminator \d+\))?$/.exec(l))) loc = { file: m[1], line: +m[2] };
        else if ((m = /^\s*([0-9a-f]+):\s+bl\s+[0-9a-f]+ <(web_perf_now|cm_ticks)>/.exec(l)))
            sites.push({ addr: parseInt(m[1], 16) + 4, callee: m[2], ...loc });
    }
    return sites;
}
const srcCache = new Map();
function srcLine(file, line) {
    if (!srcCache.has(file)) srcCache.set(file, readFileSync(file, 'utf8').split('\n'));
    return srcCache.get(file)[line - 1] ?? '';
}
function stageAfter(file, line) {
    const L = srcCache.get(file);
    for (let i = line - 1; i < Math.min(L.length, line + 40); i++) {
        const m = /web_perf_(\w+)_us\s*\+=/.exec(L[i]);
        if (m) return m[1];
    }
    return null;
}
export function events(elf) {
    const ev = [];
    for (const s of callSites(elf)) {
        const f = basename(s.file), t = srcLine(s.file, s.line);
        if (s.callee === 'cm_ticks') {
            if (f !== 'cm_main.c') continue;
            if (/\bnow\s*=\s*cm_ticks/.test(t)) ev.push({ addr: s.addr, kind: 'E', stage: 0, at: `${f}:${s.line}` });
            else if (/\blast\s*=\s*cm_ticks/.test(t)) ev.push({ addr: s.addr, kind: 'B', stage: 0, at: `${f}:${s.line}` });
            // play_run's frame timer: play mode only, and attrib runs demos
            else if (/\bt[01]\s*=\s*cm_ticks/.test(t)) continue;
            else throw new Error(`unclassified cm_ticks call at ${f}:${s.line}: ${t.trim()}`);
            continue;
        }
        if (f === 'perf.c') continue;
        const st = stageAfter(s.file, s.line), si = STAGES.indexOf(st);
        let kind = null;
        if (/\b(t0|_ts)\s*=\s*web_perf_now/.test(t)) kind = 'S';
        else if (/\bt1\s*=\s*web_perf_now/.test(t) || /web_perf_\w+_us\s*\+=\s*web_perf_now/.test(t)) kind = 'X';
        if (!kind || si < 1) throw new Error(`unclassified web_perf_now call at ${f}:${s.line}: ${t.trim()}`);
        ev.push({ addr: s.addr, kind, stage: si, at: `${f}:${s.line} ${kind} ${st}` });
    }
    const need = { B: 1, E: 1, S: 5, X: 5 };
    for (const [k, n] of Object.entries(need))
        if (ev.filter(e => e.kind === k).length < n) throw new Error(`only ${ev.filter(e => e.kind === k).length} '${k}' events in ${elf} (want >= ${n})`);
    for (let s = 1; s < STAGES.length; s++)
        if (!ev.some(e => e.kind === 'S' && e.stage === s) || !ev.some(e => e.kind === 'X' && e.stage === s))
            throw new Error(`stage ${STAGES[s]} has no bracket in ${elf}`);
    return ev;
}

function symbols(elf) {
    const nm = execFileSync('arm-none-eabi-nm', [elf], { encoding: 'utf8', maxBuffer: 1 << 28 });
    const s = new Map();
    for (const l of nm.split('\n')) { const m = /^([0-9a-f]+) \S (\S+)$/.exec(l); if (m) s.set(m[2], parseInt(m[1], 16)); }
    return s;
}

export function writeMapFile(build, file, redProof = false) {
    const elf = join(build, 'cm-doom.elf');
    const secs = readMap(join(build, 'cm-doom.map'));
    const wrapped = new Set(secs.map(s => s.sec).filter(x => x.startsWith('.text.__wrap_')).map(x => x.slice(13)));
    const names = ['unmapped'], idx = new Map([['unmapped', 0]]);
    const R = [];
    for (const s of secs) {
        const n = bucketName(s.sec, s.obj, wrapped);
        if (!idx.has(n)) { idx.set(n, names.length); names.push(n); }
        R.push(`R ${s.lo.toString(16)} ${(s.lo + s.size).toString(16)} ${idx.get(n)}`);
    }
    let ev = events(elf);
    if (redProof) ev = ev.filter(e => !(e.kind === 'X' && e.stage === STAGES.indexOf('bsp')));
    const sym = symbols(elf);
    const D = [];
    for (const d of ['R_DrawColumn', 'R_DrawFuzzColumn', 'R_DrawTranslatedColumn', 'R_DrawSpan']) {
        const b = idx.get(`draw:${d}`);
        if (b === undefined) continue;
        const entry = sym.get(`__wrap_${d}`) ?? sym.get(d);
        const span = d === 'R_DrawSpan';
        const g = span ? [sym.get('ds_x1'), sym.get('ds_x2')] : [sym.get('dc_x')];
        if (entry === undefined || g.some(a => a === undefined)) throw new Error(`no symbols for ${d}`);
        D.push(`D ${(entry & ~1).toString(16)} ${b} ${span ? 'span' : 'col'} ${g.map(a => a.toString(16)).join(' ')} 160`);
    }
    // calls counted at a function's entry: the two libgcc 32-bit divides (every
    // divide, through __aeabi_uidivmod or __aeabi_idivmod too, enters one of
    // them once: the RP2040's hardware divider would serve each)
    const C = COUNTED.map((n, i) => (sym.has(n) ? `C ${(sym.get(n) & ~1).toString(16)} ${i}` : null)).filter(Boolean);
    writeFileSync(file, [`N ${names.length}`, ...names.map((n, i) => `B ${i} ${n}`), ...R,
                         ...ev.map(e => `V ${e.addr.toString(16)} ${e.kind} ${e.stage}`), ...D, ...C].join('\n') + '\n');
    return { names, events: ev, drawers: D.length };
}

// ── families: what the report adds up ────────────────────────────────────────
export function family(name) {
    if (name.startsWith('draw:')) return name.slice(5).replace(/:engine$/, '');
    if (name === 'unmapped') return 'unmapped';
    if (name === 'port:cm_udiv30') return 'udiv30';
    const [k, v] = name.split(':');
    if (k === 'libgcc') {
        if (/muldi3|aeabi_lmul/.test(v)) return 'lmul';
        // the 64-bit divide and the helpers libgcc's __divdi3 calls (clz, shifts)
        if (/ldivmod|divdi3|udivdi3|udivmoddi4|dvmd|gnu_ldivmod|gnu_uldivmod|aeabi_uldivmod|bpabi|clz[sd]i2|ashldi3|lshrdi3|ashrdi3/.test(v)) return 'ldiv';
        if (/udivsi3|divsi3|aeabi_uidiv|aeabi_idiv/.test(v)) return 'div32';
        return 'softfloat';
    }
    if (k === 'libc' || k === 'libm' || k === 'libnosys') return 'libc';
    if (k === 'core') {
        if (/^r_/.test(v)) return `render:${v}`;
        if (/^(p_|g_game|info|tables|m_random|d_items|doomstat|m_fixed|m_bbox)/.test(v)) return 'game';
        if (/^(st_|hu_|v_video|wi_|am_map|f_|m_menu|m_misc|m_cheat|m_swap|m_argv)/.test(v)) return 'screens';
        if (/^(s_sound|sounds)/.test(v)) return 'sound';
        if (/^(z_zone|w_wad)/.test(v)) return 'zone-wad';
        return `core:${v}`;
    }
    if (k === 'web') return 'sound';
    if (k === 'fs' && /audio|sfx|mus|sound/.test(v)) return 'sound';
    return 'platform';
}
export const HELPERS = ['lmul', 'ldiv', 'udiv30', 'div32', 'softfloat', 'libc'];
export const COUNTED = ['__aeabi_uidiv', '__aeabi_idiv', '__aeabi_lmul', '__aeabi_ldivmod', 'cm_udiv30'];
export const COLS = ['R_DrawColumn', 'R_DrawFuzzColumn', 'R_DrawTranslatedColumn', 'R_DrawColumnLow'];
export const SPANS = ['R_DrawSpan', 'R_DrawSpanLow'];

// ── parse a plugin output into per-tic [stage][family] ───────────────────────
export function parseAttr(file, names) {
    const fam = names.map(family);
    const back = names.map(n => (n.endsWith(':engine') ? fam[names.indexOf(n)] : null));
    const tics = [];
    let cur = null, z = null;
    for (const l of readFileSync(file, 'utf8').split('\n')) {
        if (!l) continue;
        if (l[0] === 'T') { cur = { st: STAGES.map(() => ({})), half: {}, back: {}, calls: {} }; tics.push(cur); continue; }
        if (l[0] === 'Z') { const p = l.split(' '); z = { tics: +p[1], total: +p[2], unmapped: +p[3] }; continue; }
        const p = l.split(' ');
        if (l[0] === 'C') { const c = (cur.calls[COUNTED[+p[1]]] ??= {}); c[STAGES[+p[2]]] = (c[STAGES[+p[2]]] ?? 0) + +p[3]; continue; }
        if (l[0] === 'H') {
            // per drawer family and stage: [left, right, cross] instructions and calls
            const f = fam[+p[1]], h = ((cur.half[f] ??= {})[STAGES[+p[2]]] ??= { insn: [0, 0, 0], calls: [0, 0, 0] });
            h.insn[+p[3]] += +p[4];
            h.calls[+p[3]] += +p[5];
            continue;
        }
        const s = cur.st[+p[0]], f = fam[+p[1]];
        s[f] = (s[f] ?? 0) + +p[2];
        if (back[+p[1]]) cur.back[f] = (cur.back[f] ?? 0) + +p[2];
    }
    return { tics, z };
}
export const sum = o => Object.values(o).reduce((a, b) => a + b, 0);

// ── run ──────────────────────────────────────────────────────────────────────
const W = { doom: ['doom.wad', 'doomu.wad'], doom2: ['doom2.wad', 'doom2.wad'], tnt: ['tnt.wad', 'tnt.wad'], plutonia: ['plutonia.wad', 'plutonia.wad'] };
function runAll(jobs, mk) {
    return new Promise((res, rej) => {
        let next = 0, live = 0, done = 0;
        const n = mk.length, codes = [];
        const go = () => {
            while (live < jobs && next < n) {
                const i = next++, { cmd, args, label } = mk[i];
                live++;
                const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
                let err = '';
                p.stderr.on('data', d => (err += d));
                p.on('close', c => { codes[i] = { c, label, err }; live--; done++; if (done === n) res(codes); else go(); });
                p.on('error', rej);
            }
        };
        go();
    });
}

async function main() {
    const args = process.argv.slice(2);
    const isa = args[0];
    if (!['armv6m', 'armv8m'].includes(isa)) { console.log('FAIL attrib: first argument must be armv6m or armv8m'); process.exit(2); }
    const known = new Set(['--zero-copy', '--variant', '--jobs', '--no-run', '--json', '--demos', '--red-proof', '--fixed', '--drawers', '--fast']);
    for (const a of args.slice(1)) if (a.startsWith('--') && !known.has(a)) { console.log(`FAIL attrib: unknown flag ${a}`); process.exit(2); }
    const opt = k => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
    const zc = args.includes('--zero-copy'), variant = opt('--variant');
    const jobs = +(opt('--jobs') ?? 24);
    const demos = opt('--demos') ? opt('--demos').split(',') : DEMOS;
    // run-floor.sh's port suffix
    const dr = args.includes('--drawers') || args.includes('--fast'), fx = args.includes('--fixed') || args.includes('--fast');
    const psuf = dr && fx ? '-fast' : dr ? '-dr' : fx ? '-fx' : '';
    const suf = `${zc ? '-zc' : ''}${psuf}${variant ? `-${variant}` : ''}`;
    const red = args.includes('--red-proof');
    const build = join(CM, `build/${isa}-O1${suf}`), ref = join(CM, `out/${isa}-O1${suf}`), out = join(CM, `out/${isa}-O1${suf}-attrib${red ? '-red' : ''}`);
    for (const p of [join(build, 'cm-doom.elf'), join(build, 'cm-doom.map'), ref])
        if (!existsSync(p)) { console.log(`FAIL attrib: ${p} absent (run: bash tools/cortexm/run-floor.sh ${isa}${zc ? ' --zero-copy' : ''}${psuf ? ` --${{ '-fast': 'fast', '-dr': 'drawers', '-fx': 'fixed' }[psuf]}` : ''}${variant ? ` --variant ${variant} ...` : ''})`); process.exit(1); }

    // the plugin, built for the host
    const so = join(CM, 'build/host/qemu_attrib.so'), src = join(CM, 'qemu_attrib.c');
    if (!existsSync(so) || statSync(so).mtimeMs < statSync(src).mtimeMs) {
        mkdirSync(dirname(so), { recursive: true });
        const glib = execFileSync('pkg-config', ['--cflags', 'glib-2.0'], { encoding: 'utf8' }).trim().split(/\s+/);
        execFileSync('gcc', ['-O2', '-shared', '-fPIC', '-Wall', '-Werror', ...glib, '-o', so, src], { stdio: 'inherit' });
    }
    const mapFile = join(out, 'buckets.map');
    if (!args.includes('--no-run')) { rmSync(out, { recursive: true, force: true }); mkdirSync(out, { recursive: true }); }
    const { names, events: ev, drawers } = writeMapFile(build, mapFile, red);
    console.log(`attrib: ${names.length} buckets, ${ev.length} events (${ev.map(e => e.at).join('; ')}), ${drawers} drawers x-split at 160`);

    const board = isa === 'armv6m' ? 'mps2-an385' : 'mps2-an505';
    const wads = join(root, 'wads/lib');
    if (!args.includes('--no-run')) {
        const t0 = Date.now();
        const runs = demos.map(name => {
            const [iwad, demo] = name.split('-'), [wad, as] = W[iwad];
            const buildId = parseLog(readFileSync(join(ref, `${name}.B.log`), 'utf8')).header.build;
            const a = ['cm-doom', '-wad', join(wads, wad), '-as', as, '-timedemo', demo, '-floor', join(out, `${name}.B.log`), '-mode', 'B',
                       '-name', name, '-build', buildId, '-stats', join(out, `${name}.B.stats`)];
            return { label: name, cmd: 'timeout', args: ['3600', 'qemu-system-arm', '-M', board, '-icount', 'shift=0', '-display', 'none', '-monitor', 'none',
                     '-serial', `file:${join(out, `${name}.B.uart`)}`, '-semihosting-config', `enable=on,target=native,${a.map(x => `arg=${x}`).join(',')}`,
                     '-plugin', `${so},map=${mapFile},out=${join(out, `${name}.attr`)}`, '-kernel', join(build, 'cm-doom.elf')] };
        });
        const codes = await runAll(jobs, runs);
        const bad = codes.filter(c => c.c !== 0);
        if (bad.length) { for (const b of bad) console.log(`FAIL attrib: ${b.label} exited ${b.c} ${b.err.trim().split('\n').pop() ?? ''}`); process.exit(1); }
        console.log(`attrib: ${runs.length} runs in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    }

    // ── checks and the per-tic table ─────────────────────────────────────────
    const perDemo = {};
    let maxTic = 0, maxStage = 0, nTic = 0, nStage = 0, refSame = 0, refTics = 0, refMax = 0, unm = 0;
    let k = 0;
    for (const name of demos) {
        const A = parseAttr(join(out, `${name}.attr`), names);
        const log = parseLog(readFileSync(join(out, `${name}.B.log`), 'utf8')).demos[0];
        const rlog = parseLog(readFileSync(join(ref, `${name}.B.log`), 'utf8')).demos[0];
        const stats = readFileSync(join(out, `${name}.B.stats`), 'utf8').split('\n');
        k = +/insn_per_tick=(\d+)/.exec(stats[0])[1];
        const S = stats.filter(l => l.startsWith('S ')).map(l => l.split(' ').slice(1).map(Number));
        if (A.tics.length !== log.rows.length) fails.push(`${name}: the plugin saw ${A.tics.length} tics, the floor log has ${log.rows.length}`);
        if (log.rows.length !== rlog.rows.length || log.final.sim !== rlog.final.sim || log.final.render !== rlog.final.render)
            fails.push(`${name}: the attributed run is not the leg's run (tics ${log.rows.length}/${rlog.rows.length}, final ${log.final.sim}:${log.final.render} vs ${rlog.final.sim}:${rlog.final.render})`);
        const n = Math.min(A.tics.length, log.rows.length);
        for (let i = 0; i < n; i++) {
            const t = A.tics[i], tot = t.st.reduce((a, s) => a + sum(s), 0);
            unm += t.st.reduce((a, s) => a + (s.unmapped ?? 0), 0);
            const d = Math.abs(tot - log.rows[i].elapsed);
            maxTic = Math.max(maxTic, d); nTic++;
            if (d > k) fails.push(`${name} tic ${i}: plugin ${tot}, timer ${log.rows[i].elapsed} (more than one step, ${k})`);
            for (let s = 1; s < STAGES.length; s++) {
                const ds = Math.abs(sum(t.st[s]) - S[i][s]); // S: i sim frame bsp planes masked
                maxStage = Math.max(maxStage, ds); nStage++;
                if (ds > k) fails.push(`${name} tic ${i} ${STAGES[s]}: plugin ${sum(t.st[s])}, bracket ${S[i][s]}`);
            }
            if (i < rlog.rows.length) { refTics++; const r = Math.abs(log.rows[i].elapsed - rlog.rows[i].elapsed); refMax = Math.max(refMax, r); if (!r) refSame++; }
        }
        perDemo[name] = { tics: A.tics, load: log.rows.map(r => r.load), elapsed: log.rows.map(r => r.elapsed) };
    }
    if (red) {
        const bspFails = fails.filter(f => / bsp: plugin \d+, bracket \d+$/.test(f)).length;
        const rendered = Object.values(perDemo).reduce((a, p) => a + p.tics.filter(t => sum(t.st[STAGES.indexOf('planes')]) > 0).length, 0);
        if (bspFails === rendered && rendered > 0) {
            console.log(`PASS attrib red-proof: with the BSP stage's closing event dropped, the stage check failed on ${bspFails} of ${rendered} rendered tics, as required`);
            process.exit(0);
        }
        console.log(`FAIL attrib red-proof: the stage check failed on ${bspFails} of ${rendered} rendered tics (all must fail)`);
        process.exit(1);
    }
    if (fails.length > 20) fails.splice(20, fails.length - 20, `... ${fails.length - 20} more`);
    if (refMax > 2 * k) fails.push(`the attributed run differs from the leg's by up to ${refMax} instructions in a tic (more than two steps)`);
    if (unm) fails.push(`${unm} instructions in tics ran outside the mapped code`);

    // ── the report ───────────────────────────────────────────────────────────
    let worst = null, nG = 0;
    const meanAcc = STAGES.map(() => ({}));
    for (const name of demos) {
        const p = perDemo[name];
        p.tics.forEach((t, i) => {
            if (p.load[i]) return;
            nG++;
            t.st.forEach((s, si) => { for (const [f, v] of Object.entries(s)) meanAcc[si][f] = (meanAcc[si][f] ?? 0) + v; });
            const tot = t.st.reduce((a, s) => a + sum(s), 0);
            if (!worst || tot > worst.tot) worst = { tot, name, i, t };
        });
    }
    const mean = { st: meanAcc.map(s => Object.fromEntries(Object.entries(s).map(([f, v]) => [f, v / nG]))), half: {} };
    const totOf = t => t.st.reduce((a, s) => a + sum(s), 0);
    const rowsOf = t => {
        const g = (s, f) => t.st[STAGES.indexOf(s)][f] ?? 0;
        const gs = s => sum(t.st[STAGES.indexOf(s)]);
        const hs = s => HELPERS.reduce((a, h) => a + g(s, h), 0);
        const ds = s => [...COLS, ...SPANS].reduce((a, h) => a + g(s, h), 0);
        const allH = h => STAGES.reduce((a, s) => a + g(s, h), 0);
        return [
            ['sim: G_Ticker, own code', gs('sim') - hs('sim') - ds('sim')],
            ['frame setup', gs('frame') - hs('frame') - ds('frame')],
            ['BSP/seg code (bsp stage minus drawers, helpers)', gs('bsp') - hs('bsp') - ds('bsp')],
            ['R_DrawColumn, walls (bsp stage)', g('bsp', 'R_DrawColumn')],
            ['R_DrawPlanes minus drawers, helpers', gs('planes') - hs('planes') - ds('planes')],
            ['R_DrawSpan', g('planes', 'R_DrawSpan')],
            ['R_DrawColumn, sky (planes stage)', g('planes', 'R_DrawColumn')],
            ['R_DrawMasked minus drawers, helpers', gs('masked') - hs('masked') - ds('masked')],
            ['R_DrawColumn, sprites + masked mid (masked)', g('masked', 'R_DrawColumn')],
            ['R_DrawFuzzColumn', allH('R_DrawFuzzColumn')],
            ['R_DrawTranslatedColumn', allH('R_DrawTranslatedColumn')],
            ['__aeabi_lmul (FixedMul), all stages', allH('lmul')],
            ['64-bit divide (FixedDiv: ldivmod, divdi3, clz, shifts)', allH('ldiv')],
            ["FixedDiv's divide, the port's (cm_udiv30)", allH('udiv30')],
            ['32-bit divide (uidiv, idiv), all stages', allH('div32')],
            ['soft-float, all stages', allH('softfloat')],
            ['memcpy/memset (libc), all stages', allH('libc')],
            ['other (outside the brackets) minus helpers', gs('other') - hs('other') - ds('other')],
        ];
    };
    const P = s => console.log(s);
    P(`ATTRIBUTION ${isa}-O1${suf} — exact instructions per tic (qemu TCG plugin, every instruction counted)`);
    P(`  checks: ${nTic} tics, plugin total vs guest timer within ${maxTic} (step ${k}); ${nStage} stage brackets within ${maxStage}; ` +
      `${refSame} of ${refTics} tics identical to the leg's run (max diff ${refMax}); unmapped instructions in tics: ${unm}`);
    const W2 = 52;
    P(`\n  ${'family'.padEnd(W2)} ${'mean graded'.padStart(12)} ${'share'.padStart(6)}   ${`worst: ${worst.name} tic ${worst.i}`.padStart(34)} ${'share'.padStart(6)}`);
    const rm = rowsOf(mean), rw = rowsOf(worst.t), tm = totOf(mean), tw = totOf(worst.t);
    rm.forEach(([l, v], j) => P(`  ${l.padEnd(W2)} ${fmt(v).padStart(12)} ${(v / tm * 100).toFixed(1).padStart(5)}%   ${fmt(rw[j][1]).padStart(34)} ${(rw[j][1] / tw * 100).toFixed(1).padStart(5)}%`));
    const chk = rm.reduce((a, [, v]) => a + v, 0), chkw = rw.reduce((a, [, v]) => a + v, 0);
    P(`  ${'total'.padEnd(W2)} ${fmt(tm).padStart(12)} ${''.padStart(6)}   ${fmt(tw).padStart(34)}`);
    if (Math.abs(chk - tm) > 1 || chkw !== tw) fails.push(`the family rows do not add up to the tic (${chk} vs ${tm}, ${chkw} vs ${tw})`);
    P(`  (over ${nG} graded tics; stage totals: ` + STAGES.map(s => `${s} ${fmt(sum(mean.st[STAGES.indexOf(s)]))}/${fmt(sum(worst.t.st[STAGES.indexOf(s)]))}`).join(', ') + ' mean/worst)');
    P('\n  helpers by stage at the worst tic: ' + HELPERS.map(h => `${h} ` + STAGES.map(s => fmt(worst.t.st[STAGES.indexOf(s)][h] ?? 0)).join('/')).join('; ') + `  (${STAGES.join('/')})`);
    const hb = {};
    for (const name of demos) perDemo[name].tics.forEach((t, i) => { if (!perDemo[name].load[i]) for (const [f, v] of Object.entries(t.back)) hb[f] = (hb[f] ?? 0) + v; });
    if (Object.keys(hb).length)
        P('  of which the port handed back to the engine\'s drawers (mean / worst tic): ' +
          Object.entries(hb).map(([f, v]) => `${f} ${fmt(v / nG)} / ${fmt(worst.t.back[f] ?? 0)}`).join(', '));
    const fk = {};
    worst.t.st.forEach(s => { for (const [f, v] of Object.entries(s)) fk[f] = (fk[f] ?? 0) + v; });
    P('  every family at the worst tic: ' + Object.entries(fk).sort((a, b) => b[1] - a[1]).map(([f, v]) => `${f} ${fmt(v)}`).join(', '));

    if (opt('--json')) {
        const j = { isa, suffix: suf, k, worst: { name: worst.name, i: worst.i }, demos: {} };
        for (const name of demos) j.demos[name] = perDemo[name];
        writeFileSync(opt('--json'), JSON.stringify(j));
        P(`  per-tic data: ${opt('--json')}`);
    }
    if (fails.length) { for (const f of fails) P(`FAIL attrib: ${f}`); process.exit(1); }
    P(`PASS attrib: ${isa}-O1${suf}, ${demos.length} demos, ${nTic} tics attributed exactly (every tic within ${maxTic} of the guest timer)`);
}
if (import.meta.url === `file://${process.argv[1]}`) main().catch(e => { console.log(`FAIL attrib: ${e.stack}`); process.exit(1); });
