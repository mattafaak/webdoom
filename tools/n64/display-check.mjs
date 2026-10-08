#!/usr/bin/env node
// display-check: is the N64's 32-bit framebuffer the exact colour of each
// frame?  (tools/n64 N64_DISPLAY, through tools/floor/run-n64.sh --display.)
//
//   node tools/n64/display-check.mjs [--demos a,b] [--build-dir build] OUT_DIR
//
// The N64 side: each mode A display ROM leaves OUT_DIR/<demo>.A.fb32, the VI
// registers as read back (N64_DISPLAY_VI) and, for every tic, FNV-1a over the
// framebuffer's 76,800 32-bit words (0xRRGGBBAA, row-major, 320x240, read out
// of RDRAM: what the VI scans out).
//
// The host side: the browser build (build/doom.js) replays the same demo the
// way tools/demo-test.mjs --render does, and at every tic converts ITS OWN
// screens[0] through ITS OWN palette (web_palette(): engine/web/i_video.c's
// gammatable[usegamma][PLAYPAL] per channel, the bytes client/js/video.js
// shows) into the same 320x240 layout: rows 20..219 the frame, the 20 rows
// above and below opaque black 0x000000ff.  Nothing of the N64 conversion is
// shared: another compiler, another palette path, the WAD read by another
// loader.  The host's 8-bit frames are held to the render goldens first, so
// both sides convert the frames the goldens recorded.
//
// PASS needs, per demo: the VI in 32-bit mode with AA/resampling, gamma and
// gamma dither off, its origin on the framebuffer; one hash per golden tic;
// the host's frames equal to the render goldens; and every tic's hash equal.
// Over the run, at least one compared tic must show a palette other than the
// demo's usual one (a damage or pickup flash): a check that never saw one
// could not see a palette defect.
//
// Copyright (C) 2026, GPL-2.0-or-later.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { root } from '../lib/util.mjs';
import { readGolden } from '../lib/golden.mjs';
import { check, summary, fatal } from '../lib/report.mjs';

const args = process.argv.slice(2);
let demosArg = null, buildDir = 'build', dir = null;
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--demos') demosArg = args[++i];
    else if (args[i] === '--build-dir') buildDir = args[++i];
    else if (args[i].startsWith('--')) fatal(`display-check: unknown flag ${args[i]}`);
    else if (dir === null) dir = args[i];
    else fatal(`display-check: one OUT_DIR, got '${dir}' and '${args[i]}'`);
}
if (!dir) fatal('usage: display-check.mjs [--demos a,b] [--build-dir build] OUT_DIR');

// <demo tag> -> [wad file, engine name, demo]; doom.wad is Ultimate DOOM and is
// presented as doomu.wad, as everywhere else in this repo.
const MATRIX = {};
for (const [wad, name, demos] of [
    ['doom.wad', 'doomu.wad', ['demo1', 'demo2', 'demo3', 'demo4']],
    ['doom2.wad', 'doom2.wad', ['demo1', 'demo2', 'demo3']],
    ['tnt.wad', 'tnt.wad', ['demo1', 'demo2', 'demo3']],
    ['plutonia.wad', 'plutonia.wad', ['demo1', 'demo2', 'demo3']],
]) for (const d of demos) MATRIX[`${wad.replace('.wad', '')}-${d}`] = [wad, name, d];

const tags = demosArg ? demosArg.split(',').filter(Boolean)
    : readdirSync(dir).filter(f => f.endsWith('.A.fb32')).map(f => f.replace('.A.fb32', '')).sort();
if (!tags.length) fatal(`display-check: no <demo>.A.fb32 in ${dir} (run tools/floor/run-n64.sh --correctness --display 1)`);
for (const t of tags) if (!MATRIX[t]) fatal(`display-check: unknown demo '${t}'`);

const doomJs = join(root, buildDir, 'doom.js');
if (!existsSync(doomJs)) fatal(`display-check: ${buildDir}/doom.js absent (source tools/emsdk-env.sh && make -C engine)`);
const createDoom = (await import(doomJs)).default;

// ── the N64 side ────────────────────────────────────────────────────────────
function readN64(tag) {
    const f = join(dir, `${tag}.A.fb32`);
    if (!existsSync(f)) return { error: `${f} absent` };
    let vi = null, n = -1, end = false;
    const hashes = [];
    for (const l of readFileSync(f, 'utf8').split('\n')) {
        if (l.startsWith('N64_DISPLAY_VI ')) {
            vi = Object.fromEntries(l.split(' ').slice(1).map(kv => kv.split('=')));
            continue;
        }
        let m = /^N64_FB32_BEGIN (\S+) (\d+)$/.exec(l);
        if (m) { n = +m[2]; continue; }
        if (/^N64_FB32_END /.test(l)) { end = true; continue; }
        m = /^H (\d+)((?: [0-9a-f]{8})+)$/.exec(l);
        if (m) m[2].trim().split(' ').forEach((h, k) => { hashes[+m[1] + k] = parseInt(h, 16) >>> 0; });
    }
    return { vi, n, end, hashes };
}

// ── the host side ───────────────────────────────────────────────────────────
// The goldens' render hash (tools/demo-test.mjs fnv1aRender).
function fnv1aRender(heap, fb, palVer) {
    let h = 0x811c9dc5;
    for (let y = 0; y < 200; y++)
        for (let x = 0; x < 320; x++)
            h = Math.imul(h ^ heap[fb + x * 200 + y], 0x01000193);
    for (let s = 0; s < 32; s += 8) h = Math.imul(h ^ ((palVer >>> s) & 0xff), 0x01000193);
    return h >>> 0;
}
// The 320x240 frame the N64 shows, from the host's own frame and palette.
const BLACK = 0x000000ff;
function fb32Hash(heap, fb, pal) {
    const lut = new Uint32Array(256);
    for (let i = 0; i < 256; i++)
        lut[i] = ((pal[3 * i] << 24) | (pal[3 * i + 1] << 16) | (pal[3 * i + 2] << 8) | 0xff) >>> 0;
    let h = 0x811c9dc5;
    for (let y = 0; y < 240; y++) {
        const row = y - 20;
        for (let x = 0; x < 320; x++) {
            const w = row >= 0 && row < 200 ? lut[heap[fb + x * 200 + row]] : BLACK;
            h = Math.imul(h ^ w, 0x01000193);
        }
    }
    return h >>> 0;
}
async function host(tag) {
    const [wad, engineName, demo] = MATRIX[tag];
    const path = join(root, 'wads/lib', wad);
    if (!existsSync(path)) return { error: `wads/lib/${wad} absent` };
    const wadBytes = readFileSync(path);
    let done = null;
    const doom = await createDoom({
        print: () => {},
        printErr: t => { const m = /timed (\d+) gametics/.exec(t); if (m) done = +m[1]; },
        onDoomError: msg => { if (!/timed \d+ gametics/.test(msg)) done = `error: ${msg}`; },
    });
    const p = doom._malloc(wadBytes.length);
    doom.HEAPU8.set(wadBytes, p);
    doom.ccall('web_register_file', null, ['string', 'number', 'number'], [engineName, p, wadBytes.length]);
    const render = [], fb32 = [], palKey = [];
    try {
        doom.callMain(['-timedemo', demo]);   // no -nodraw: the renderer runs
        doom._web_set_smooth(0);
        const fb = doom._web_framebuffer(), palPtr = doom._web_palette();
        let last = -1;
        for (let i = 0; i < 200000 && done === null; i++) {
            doom._web_wipe_skip();
            doom._web_frame();
            const tic = doom._web_gametic();
            if (tic === last) continue;
            last = tic;
            const heap = doom.HEAPU8, pal = heap.subarray(palPtr, palPtr + 768);
            render.push(fnv1aRender(heap, fb, doom._web_palette_version()));
            fb32.push(fb32Hash(heap, fb, pal));
            palKey.push(Buffer.from(pal).toString('base64'));
        }
    } catch (e) {
        if (done === null) done = `threw: ${String(e).slice(0, 80)}`;
    }
    if (typeof done !== 'number') return { error: `the host replay did not finish: ${done ?? 'never finished'}` };
    return { tics: done, render, fb32, palKey };
}

// ── compare ─────────────────────────────────────────────────────────────────
let comparedTics = 0, flashTics = 0;
const vi32 = 3, viAaOff = 3;
for (const tag of tags) {
    const n64 = readN64(tag);
    if (n64.error) { check(`${tag}: N64 framebuffer hashes`, false, n64.error); continue; }
    const v = n64.vi;
    const ctrl = v ? parseInt(v.ctrl, 16) : NaN;
    check(`${tag}: VI read back: 32 bpp, AA and resampling off, gamma and gamma dither off, divot and dedither off`,
        v && (ctrl & 3) === vi32 && ((ctrl >> 8) & 3) === viAaOff && (ctrl & 0x1c) === 0 && (ctrl & 0x10000) === 0,
        v ? `ctrl=${v.ctrl}` : 'no N64_DISPLAY_VI line');
    check(`${tag}: VI origin is the framebuffer, width 320, x scale 0x200, y scale 0x400 (320x240)`,
        v && v.origin === v.fb && v.fb !== '00000000' && v.width === '320' && v.xscale === '00000200' && v.yscale === '00000400',
        v ? `origin=${v.origin} fb=${v.fb} width=${v.width} xscale=${v.xscale} yscale=${v.yscale}` : 'no N64_DISPLAY_VI line');
    check(`${tag}: the conversion ran: variant ${v?.variant}, fault ${v?.fault}, ${v?.frames} frames, ${v?.lut_builds} LUT builds`,
        v && +v.frames >= n64.n && +v.lut_builds >= 1, v ? '' : 'no N64_DISPLAY_VI line');

    const golden = readGolden(join(root, 'tools/golden', `${tag}-render.json`));
    const g = golden.trace;
    check(`${tag}: N64 printed one framebuffer hash per tic (${n64.n} of ${golden.tics})`,
        n64.end && n64.n === golden.tics && n64.hashes.length === n64.n && !n64.hashes.includes(undefined),
        `${n64.end ? '' : 'no N64_FB32_END; '}${n64.hashes.filter(h => h !== undefined).length} hashes parsed`);

    const t0 = Date.now();
    const h = await host(tag);
    if (h.error) { check(`${tag}: host replay`, false, h.error); continue; }
    const rdiff = h.render.findIndex((x, i) => x !== g[i] >>> 0);
    check(`${tag}: the host's frames are the render goldens' (${h.render.length} tics)`,
        h.tics === golden.tics && h.render.length === g.length && rdiff < 0,
        rdiff >= 0 ? `first difference at tic ${rdiff}` : `host ${h.render.length} tics, golden ${g.length}`);

    // palettes: the demo's usual one, and the others (damage, pickup, radiation)
    const freq = new Map();
    for (const k of h.palKey) freq.set(k, (freq.get(k) || 0) + 1);
    const base = [...freq].sort((a, b) => b[1] - a[1])[0][0];
    const flashes = h.palKey.filter(k => k !== base).length;

    let first = -1, bad = 0;
    for (let i = 0; i < h.fb32.length; i++)
        if (n64.hashes[i] !== h.fb32[i]) { bad++; if (first < 0) first = i; }
    const ok = bad === 0 && h.fb32.length === n64.n;
    comparedTics += h.fb32.length; flashTics += flashes;
    check(`${tag}: N64 framebuffer == host conversion on every tic: ${h.fb32.length} tics, ` +
          `${flashes} under ${freq.size - 1} palette(s) other than the usual one (host ${((Date.now() - t0) / 1000).toFixed(1)} s)`,
        ok, first >= 0
            ? `framebuffer differs from the host conversion at tic ${first} (N64 ${n64.hashes[first]?.toString(16).padStart(8, '0')}, ` +
              `host ${h.fb32[first].toString(16).padStart(8, '0')}${h.palKey[first] !== base ? ', a palette-change tic' : ''}), ${bad} tics differ`
            : `host ${h.fb32.length} tics, N64 ${n64.n}`);
}
check(`at least one compared tic shows a palette other than the usual one (${flashTics} of ${comparedTics})`, flashTics > 0,
    'no damage or pickup flash was compared: a palette defect would pass');
summary(`N64 32-bit framebuffer equals the host conversion on every tic: ${comparedTics} tics on ${tags.length} demo(s), ` +
        `${flashTics} of them under a damage/pickup palette`, { min: 1 + 6 * tags.length });
