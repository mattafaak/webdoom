#!/usr/bin/env node
// The texture tables as const data (TEXTURES_CONST and COMPOSITES_CONST,
// engine/core/r_data.c) on the floor's lean zero-copy build: the build
// tools/freestanding/Makefile makes as
//   make LEAN=1 ZERO_COPY=1 OBJDIR=obj-leanzc OUT=fs-doom-leanzc
// which keeps each IWAD's texture definitions, column lumps and offsets, width
// masks, heights, composite sizes, composites and sprite offsets in const data
// made at build time by the engine's own R_InitData (fs-texgen), and checks
// them against the WAD at boot.
//
//   1. the 13 demos through the floor gate (tools/floor/run-x86.sh: sim and
//      render hashes every tic, audio), and every one of the 26 runs must say
//      on stderr that it used its own WAD's const textures, composites and
//      sprites, checked: a run that quietly fell back to the zone tables
//      would pass the gate and prove nothing;
//   2. the smallest zone is still MIN_KB: it passes and MIN_KB - 4 fails
//      (tools/floor/zone-min.mjs --check);
// then three red-proofs, each a wrong table that must be caught:
//   corrupt    one wrong value of each kind the boot check compares, one per
//              WAD (tools/floor/gen-texture-tables.c, WD_TEXGEN_CORRUPT):
//                doom      AASTINKY's first patch one row low (texture 0: no
//                          texture freed yet when it is refused)
//                doom2     SKY1's column 100 offset one too high (texture
//                          229: 229 textures freed, built again)
//                tnt       a byte of BIGDOOR1's composite
//                plutonia  sprite lump 0's offset one pixel more
//              Each WAD's runs must name what was refused and use the rest,
//              all 26 must still be correct (on vanilla's tables where
//              refused), and step 1's check must fail exactly the refused;
//   unchecked  doom2's SKY1 alone with the boot check compiled out
//              (TEXTURES_CONST_UNCHECKED): the floor gate must fail, naming a
//              doom2 demo and the tic its render hash first differs;
//   holes      doom.wad with BIGDOOR1 taller than its patches reach, so its
//              composite has rows no patch writes: the build must refuse to
//              make tables that hold bytes the engine never wrote.
//
// usage: node tools/floor/textures-const-test.mjs [--keep DIR] [--no-redproof]
// Copyright (C) 2026, GPL-2.0-or-later.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, rmSync, writeSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { root } from '../lib/util.mjs';

// The smallest zone that runs all 13 demos correctly with rendering and audio,
// measured with zone-min.mjs (4 KiB steps): 544 KiB passes, 540 fails
// (tnt-demo2: a 64,000 B screen LEAN_SCREENS borrows).  Without the const
// tables (TEXTURES_CONST=0 COMPOSITES_CONST=0) it is 920 KiB, and 916 fails.
const MIN_KB = 544;
const args = process.argv.slice(2);
const KEEP = args.includes('--keep') ? args[args.indexOf('--keep') + 1] : null;
const REDPROOF = !args.includes('--no-redproof');
const FS = join(root, 'tools/freestanding');
const WADS = join(root, 'wads/lib');
const fail = msg => { console.log(`FAIL textures-const: ${msg}`); process.exit(1); };
const tmp = KEEP ?? mkdtempSync(join(tmpdir(), 'webdoom-texconst-'));
mkdirSync(tmp, { recursive: true });
if (!KEEP) process.on('exit', () => rmSync(tmp, { recursive: true, force: true }));
for (const w of ['doom.wad', 'doom2.wad', 'tnt.wad', 'plutonia.wad'])
    if (!existsSync(join(WADS, w))) fail(`wads/lib/${w} absent (tools/fetch-wads.sh)`);

const LEANZC = ['LEAN=1', 'ZERO_COPY=1', 'TEXTURES_CONST=1', 'COMPOSITES_CONST=1'];
const SKY1 = 'ofs:doom2:SKY1:100';
const CORRUPT = `TEXGEN_CORRUPT=def:doom:AASTINKY,${SKY1},comp:tnt:BIGDOOR1:0,sprite:plutonia:0`;
function make(id, knobs) {
    const out = knobs.find(a => a.startsWith('OUT=')).slice(4);
    const r = spawnSync('make', ['-C', FS, '-j8', ...knobs, out], { encoding: 'utf8' });
    return { ok: r.status === 0, bin: join(FS, out), log: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}
function built(id, knobs) {
    const b = make(id, knobs);
    if (!b.ok) fail(`make ${knobs.join(' ')} failed:\n${b.log.trim().split('\n').slice(-8).join('\n')}`);
    return b.bin;
}
// run-x86.sh: its exit, its output, and each run's stderr by run name
function floorRun(bin, label) {
    const out = join(tmp, label);
    const r = spawnSync('bash', [join(root, 'tools/floor/run-x86.sh'), out],
                        { env: { ...process.env, FS_DOOM: bin }, encoding: 'utf8' });
    const errs = existsSync(out) ? readdirSync(out).filter(f => f.endsWith('.err')).sort() : [];
    return { ok: r.status === 0, text: r.stdout ?? '', errs: errs.map(f => ({ run: f.replace(/\.err$/, ''), text: readFileSync(join(out, f), 'utf8') })) };
}
// the runs that did not use their own WAD's const tables, checked
const wadOf = run => `${run.split('-')[0]}.wad`;
function notConst(errs) {
    return errs.filter(({ run, text }) => {
        const w = wadOf(run).replace('.', '\\.');
        return !new RegExp(`^R_InitTextures: const tables from ${w}: \\d+ textures, \\d+ columns, \\d+ composites const, checked against this WAD$`, 'm').test(text)
            || !new RegExp(`^R_InitSpriteLumps: const tables from ${w}: \\d+ sprite lumps, checked against this WAD$`, 'm').test(text);
    });
}

// ── 1. the 13 demos on the const tables ──────────────────────────────────────
const bin = built('leanzc', [...LEANZC, 'OBJDIR=obj-leanzc', 'OUT=fs-doom-leanzc']);
const good = floorRun(bin, 'x86');
const verdict = good.text.trim().split('\n').at(-1);
if (!good.ok) fail(`the floor gate failed on fs-doom-leanzc:\n${good.text.trim().split('\n').slice(-6).join('\n')}`);
if (good.errs.length !== 26) fail(`${good.errs.length} runs' stderr found, 26 expected`);
const off = notConst(good.errs);
if (off.length) fail(`${off.length} of 26 runs did not use their WAD's own const tables, checked: ${off.map(e => e.run).join(', ')}\n` +
                     (off[0].text.match(/^R_Init(Textures|SpriteLumps): .*$/gm) ?? []).join('\n'));
console.log(`textures-const: 13 demos, 26 runs: ${verdict}`);
console.log('textures-const: all 26 runs used their own WAD\'s const textures, composites and sprites, checked at boot');

// ── 2. the zone minimum ──────────────────────────────────────────────────────
const zm = spawnSync('node', [join(root, 'tools/floor/zone-min.mjs'), '--check', String(MIN_KB)],
                     { env: { ...process.env, FS_DOOM: bin }, encoding: 'utf8' });
const zmLast = (zm.stdout ?? '').trim().split('\n').at(-1);
if (zm.status !== 0) fail(`zone minimum: ${zmLast}`);
console.log(`textures-const: ${zmLast}`);

// ── 3. the red-proofs ────────────────────────────────────────────────────────
if (REDPROOF) {
    // corrupt: each refused where it is, and only there
    const cbin = built('corrupt', [...LEANZC, CORRUPT, 'OBJDIR=obj-leanzc-rp-corrupt', 'OUT=fs-doom-leanzc-rp-corrupt']);
    const c = floorRun(cbin, 'rp-corrupt');
    if (!c.ok) fail(`red-proof corrupt: the runs were not all correct:\n${c.text.trim().split('\n').slice(-6).join('\n')}`);
    const T = 'R_InitTextures: ', S = 'R_InitSpriteLumps: ';
    const EXPECT = {
        doom: [`${T}the const tables from doom.wad differ at texture 0 (AASTINKY: patches): built in the zone`,
               `${S}const tables from doom.wad: 764 sprite lumps, checked against this WAD`],
        doom2: [`${T}the const tables from doom2.wad differ at texture 229 (SKY1: column offsets): built in the zone`,
                `${S}const tables from doom2.wad: 1381 sprite lumps, checked against this WAD`],
        tnt: [`${T}const tables from tnt.wad: 562 textures, 64736 columns, 205 composites built in the zone, checked against this WAD`,
              `${T}the const composites from tnt.wad differ at texture 13 (BIGDOOR1): built in the zone`,
              `${S}const tables from tnt.wad: 1381 sprite lumps, checked against this WAD`],
        // another IWAD's sprite tables can be this one's exactly, and may be used
        plutonia: [`${T}const tables from plutonia.wad: 505 textures, 51840 columns, 154 composites const, checked against this WAD`,
                   /^R_InitSpriteLumps: (no const tables for this WAD's 1381 sprite lumps: built in the zone|const tables from (doom2|tnt)\.wad: 1381 sprite lumps, checked against this WAD)$/m],
    };
    const wrong = c.errs.filter(({ run, text }) => !EXPECT[run.split('-')[0]].every(e =>
        typeof e === 'string' ? text.split('\n').includes(e) : e.test(text)));
    if (wrong.length) fail(`red-proof corrupt: ${wrong.length} of 26 runs did not refuse what was wrong, or refused more: ${wrong.map(e => e.run).join(', ')}\n` +
                           (wrong[0].text.match(/^R_Init(Textures|SpriteLumps): .*$/gm) ?? []).join('\n'));
    const refused = notConst(c.errs).length;
    if (refused !== 26) fail(`red-proof corrupt: step 1's check passed ${26 - refused} runs that used a refused table`);
    const plutoSprites = c.errs.find(e => e.run.startsWith('plutonia-')).text.match(/^R_InitSpriteLumps: (.*)$/m)[1];
    console.log('textures-const: red-proof corrupt: 4 wrong values, 4 refused at boot in every run of their WAD, the rest used, all 26 runs correct:');
    console.log('    doom texture 0 (AASTINKY: patches), vanilla\'s textures; doom2 texture 229 (SKY1: column offsets), built again after 229 were freed;');
    console.log(`    tnt's composites (BIGDOOR1), its tables const; plutonia's sprites (${plutoSprites})`);

    // unchecked: SKY1's wrong offset, used, must fail the gate at a named tic
    const ubin = built('unchecked', [...LEANZC, `TEXGEN_CORRUPT=${SKY1}`, 'EXTRA_CFLAGS=-DTEXTURES_CONST_UNCHECKED',
                                     'OBJDIR=obj-leanzc-rp-unchecked', 'OUT=fs-doom-leanzc-rp-unchecked']);
    const u = floorRun(ubin, 'rp-unchecked');
    const at = u.text.match(/^FAIL (doom2-demo\d): render hash differs from the golden at tic (\d+)/m);
    if (u.ok || !at) fail(`red-proof unchecked: the floor gate did not fail on a wrong column offset in use (${u.text.trim().split('\n').at(-1)})`);
    if (!/UNCHECKED/.test(u.errs.find(e => e.run.startsWith('doom2-')).text)) fail('red-proof unchecked: the build did not say it skipped the boot check');
    console.log(`textures-const: red-proof unchecked: with the boot check compiled out, SKY1's wrong offset is used and fails the gate: ${at[0]}`);

    // holes: a composite row no patch writes must stop the build
    const hdir = join(tmp, 'holes');
    mkdirSync(hdir, { recursive: true });
    copyFileSync(join(WADS, 'doom.wad'), join(hdir, 'doom.wad'));
    const tall = setTextureHeight(join(hdir, 'doom.wad'), 'BIGDOOR1', 255);
    const h = make('holes', [...LEANZC, `TEXTURES_WAD_DIR=${hdir}`, 'TEXTURES_WADS=doom.wad',
                             'OBJDIR=obj-leanzc-rp-holes', 'OUT=fs-doom-leanzc-rp-holes']);
    const why = h.log.match(/^TEXTURES_CONST: doom\.wad's tables hold bytes the engine never wrote.*$/m);
    if (h.ok || !why) fail(`red-proof holes: BIGDOOR1 ${tall} -> 255 rows tall, and the build ${h.ok ? 'succeeded' : 'failed for another reason'}:\n${h.log.trim().split('\n').slice(-4).join('\n')}`);
    console.log(`textures-const: red-proof holes: BIGDOOR1 made 255 rows tall (from ${tall}), its composite rows past the patches unwritten: the build refused (${why[0].slice(0, 90)}...)`);
}

console.log(`PASS textures-const: 13/13 demos correct on the const tables in all 26 runs; zone minimum ${MIN_KB} KiB (${MIN_KB - 4} fails)` +
            (REDPROOF ? '; wrong tables caught: 4 of 4 kinds at boot, 1 used one by the floor gate at a named tic, unwritten bytes at build time' : '; red-proofs skipped'));

// TEXTURE1's entry for `name`: its height (int16 at entry + 14) set to h, in place
function setTextureHeight(path, name, h) {
    const fd = openSync(path, 'r+');
    const rd = (pos, n) => { const b = Buffer.alloc(n); readSync(fd, b, 0, n, pos); return b; };
    const head = rd(0, 12), numlumps = head.readInt32LE(4), dir = rd(head.readInt32LE(8), numlumps * 16);
    let t1 = null;
    for (let i = 0; i < numlumps; i++)
        if (dir.toString('latin1', i * 16 + 8, i * 16 + 16).replace(/\0.*$/, '') === 'TEXTURE1') t1 = { pos: dir.readInt32LE(i * 16), size: dir.readInt32LE(i * 16 + 4) };
    if (!t1) fail(`${path}: no TEXTURE1`);
    const lump = rd(t1.pos, t1.size), n = lump.readInt32LE(0);
    for (let i = 0; i < n; i++) {
        const off = lump.readInt32LE(4 + 4 * i);
        if (lump.toString('latin1', off, off + 8).replace(/\0.*$/, '') !== name) continue;
        const old = lump.readInt16LE(off + 14), b = Buffer.alloc(2);
        b.writeInt16LE(h);
        writeSync(fd, b, 0, 2, t1.pos + off + 14);
        closeSync(fd);
        return old;
    }
    fail(`${path}: no ${name} in TEXTURE1`);
}
