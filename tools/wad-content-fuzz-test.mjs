#!/usr/bin/env node
// tools/wad-content-fuzz-test.mjs — hostile LUMP CONTENT (task 23.2).
//
// wad-import.js validates a WAD's DIRECTORY well (lump count cap, negative and
// EOF checks on every field).  Nothing validated what is INSIDE a lump, and a
// PWAD's lump overrides the IWAD's, so a WAD the player imports (16.6a) can
// hand the engine any bytes it likes under a well-known name.
//
// Two defects were reproduced here before being fixed:
//   * GENMIDI: load_bank() never consulted the lump length.  An 8-byte lump
//     (just the "#OPL_II#" magic) made it memcpy 6300 bytes -- a 6292-byte
//     overread into adjacent zone memory, then used as OPL instrument data.
//   * the MUS sequencer: one `ev >= ev_end` check per event group admitted the
//     first byte while the cases consumed up to two more, and the trailing
//     delay VLQ had no bound at all -- it walked the heap until it met a byte
//     with bit 7 clear, and its unbounded left-shift could make `delay`
//     negative, which never leaves the `while (tick_accum <= 0)` render pump.
//
// EVERY CASE RUNS IN A CHILD PROCESS WITH A TIMEOUT, because one failure mode
// under test is a hang: a case that wedges must be a FAILURE, not a wedged gate.
//
// WHAT EACH CASE IS WORTH, honestly.  Red-proofed against the unguarded engine
// on 2026-09-11:
//   * the three short-GENMIDI cases DETECT the defect -- unguarded they report
//     `bankLoaded: expected 0, got 1`, i.e. an 8-byte lump accepted as a
//     6308-byte bank.  genmidi-full-garbage is the other direction: a
//     full-length bank must still be ACCEPTED, so the guard cannot degenerate
//     into "reject everything".
//   * the two hostile MUS cases pass with OR without the bounds fix, and are
//     therefore REGRESSION GUARDS AGAINST A HANG OR CRASH, not detectors.  The
//     defect they cover is an out-of-bounds READ, which in wasm neither traps
//     nor faults, and the runaway VLQ happened not to drive `delay` negative.
//     The bounds fix itself was verified by reading the code and by the OPL2
//     byte-identity gate (valid input renders identically); this file only
//     proves the hostile payloads do not wedge the sequencer.
//   * mus-empty-score exists to stop those two being VACUOUS: an empty score
//     can run no events, so `events=0` proves the PWAD override is really
//     reached.  Without it the two cases above could be exercising the IWAD's
//     own title music and asserting nothing.
//
// The first version of this file asserted only "the engine survived", and
// red-proofing showed all seven cases passing against the unguarded engine --
// a check that could not fail.
//
// usage: node tools/wad-content-fuzz-test.mjs [--build-dir DIR]
// Copyright (C) 2026, GPL-2.0-or-later.
import { readFileSync, existsSync, writeFileSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bdIdx = process.argv.indexOf('--build-dir');
const buildDir = bdIdx >= 0 ? process.argv[bdIdx + 1] : 'build';
const CASE_MS = 90_000;

// ── PWAD construction ────────────────────────────────────────────────────────
function pwad(lumps) {                     // lumps: [[name, Buffer], ...]
    const body = Buffer.concat(lumps.map(([, b]) => b));
    const dirOfs = 12 + body.length;
    const out = Buffer.alloc(dirOfs + 16 * lumps.length);
    out.write('PWAD', 0, 'ascii');
    out.writeInt32LE(lumps.length, 4);
    out.writeInt32LE(dirOfs, 8);
    body.copy(out, 12);
    let at = 12, e = dirOfs;
    for (const [name, b] of lumps) {
        out.writeInt32LE(at, e);
        out.writeInt32LE(b.length, e + 4);
        out.write(name.slice(0, 8), e + 8, 'ascii');
        at += b.length; e += 16;
    }
    return out;
}
const OPL = Buffer.from('#OPL_II#', 'ascii');

// `expect` is the BEHAVIOUR asserted, not "it did not crash".  An out-of-bounds
// READ in wasm neither traps nor crashes, so a survival-only assertion is a
// check that cannot fail -- which is exactly what the first version of this
// file was, proven by red-proofing it against the unguarded engine and watching
// all seven cases pass.  bankLoaded is web_music_debug(3): load_bank() sets it
// only when it ACCEPTS a GENMIDI lump, so "was a 8-byte lump accepted as a
// 6308-byte bank?" is directly observable.
const TITLE_MUS = 'D_INTRO';   // what doom.wad plays at the title screen
const CASES = {
    'genmidi-magic-only':   { wad: () => pwad([['GENMIDI', OPL]]),                       expect: { bankLoaded: 0 } },
    'genmidi-empty':        { wad: () => pwad([['GENMIDI', Buffer.alloc(0)]]),            expect: { bankLoaded: 0 } },
    'genmidi-one-short':    { wad: () => pwad([['GENMIDI', Buffer.concat([OPL, Buffer.alloc(175 * 36 - 1, 0x5a)])]]),
                              expect: { bankLoaded: 0 } },
    // A full-length bank is legitimate however silly its contents: this one
    // must be ACCEPTED, so the guard cannot be "reject everything".
    'genmidi-full-garbage': { wad: () => pwad([['GENMIDI', Buffer.concat([OPL, Buffer.alloc(175 * 36, 0xa5)])]]),
                              expect: { bankLoaded: 1 } },
    // Proves the override is actually reached: an empty score can run no
    // events, so dbg_events must be 0 where the real title song gives > 0.
    // Without this the two hostile MUS cases below would be vacuous.
    'mus-empty-score':      { wad: () => pwad([[TITLE_MUS, musLump(Buffer.alloc(0))]]),   expect: { events: 0 } },
    // An event group whose first byte is in range but whose payload is not.
    'mus-truncated-event':  { wad: () => pwad([[TITLE_MUS, musLump(Buffer.from([0x10]))]]) },
    // A trailing delay VLQ of all-continuation bytes: the unbounded decoder
    // walked the heap here, and its unbounded shift could make delay negative.
    'mus-runaway-vlq':      { wad: () => pwad([[TITLE_MUS, musLump(Buffer.from([0x90, 0x40, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]))]]) },
};

function musLump(score) {
    const h = Buffer.alloc(16);
    h.write('MUS\x1a', 0, 'ascii');
    h.writeUInt16LE(score.length, 4);   // score length
    h.writeUInt16LE(16, 6);             // score start
    h.writeUInt16LE(1, 8);              // primary channels
    h.writeUInt16LE(0, 10);             // secondary
    h.writeUInt16LE(0, 12);             // instrument count
    return Buffer.concat([h, score]);
}

// ── child: run one case ──────────────────────────────────────────────────────
const caseIdx = process.argv.indexOf('--case');
if (caseIdx >= 0) {
    const name = process.argv[caseIdx + 1];
    const dir = mkdtempSync(join(tmpdir(), 'wadfuzz-'));
    const file = join(dir, 'fuzz.wad');
    writeFileSync(file, CASES[name].wad());

    const createDoom = (await import(join(root, buildDir, 'doom.js'))).default;
    const doom = await createDoom({ noInitialRun: true, print() {}, printErr() {} });
    for (const [n, bytes] of [['doom.wad', readFileSync(join(root, 'wads/lib/doom.wad'))],
                              ['fuzz.wad', readFileSync(file)]]) {
        const p = doom._malloc(bytes.length);
        doom.HEAPU8.set(bytes, p);
        doom.ccall('web_register_file', 'null', ['string', 'number', 'number'], [n, p, bytes.length]);
    }
    doom.callMain(['-iwad', 'doom.wad', '-file', 'fuzz.wad', '-nodraw']);
    doom._web_music_init(44100);
    // Render a second of music: this is what walks the score.
    const frames = 4096;
    const buf = doom._malloc(frames * 2 * 4);
    for (let i = 0; i < 11; i++) doom._web_music_render(buf, frames);
    // And advance the sim, so a wedged pump shows up as a hang here too.
    for (let i = 0; i < 60; i++) doom._web_frame();
    console.log(`CHILD-OK bankLoaded=${doom._web_music_debug(3)} events=${doom._web_music_debug(1)}`);
    process.exit(0);
}

// ── parent ───────────────────────────────────────────────────────────────────
if (!existsSync(join(root, buildDir, 'doom.js'))) {
    console.log(`FAIL wad-content-fuzz: ${buildDir}/doom.js absent - verified nothing`); process.exit(1);
}
if (!existsSync(join(root, 'wads/lib/doom.wad'))) {
    console.log('FAIL wad-content-fuzz: doom.wad not fetched - verified nothing'); process.exit(1);
}

let passes = 0, failures = 0;
for (const name of Object.keys(CASES)) {
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--build-dir', buildDir, '--case', name],
                        { timeout: CASE_MS, encoding: 'utf8' });
    const hung = r.error && r.error.code === 'ETIMEDOUT';
    const line = (r.stdout || '').split('\n').find(l => l.startsWith('CHILD-OK')) ?? '';
    const survived = !hung && r.status === 0 && line !== '';
    if (!survived) {
        const why = hung ? `HUNG (no exit within ${CASE_MS / 1000}s)`
                         : `exit ${r.status}${r.signal ? ` signal ${r.signal}` : ''}: ${(r.stderr || '').trim().split('\n').pop()?.slice(0, 90) ?? ''}`;
        console.log(`  FAIL ${name} - ${why}`);
        failures++;
        continue;
    }
    const got = Object.fromEntries([...line.matchAll(/(\w+)=(-?\d+)/g)].map(m => [m[1], Number(m[2])]));
    const want = CASES[name].expect ?? {};
    const bad = Object.entries(want).filter(([k, v]) => got[k] !== v);
    if (bad.length) {
        console.log(`  FAIL ${name} - ${bad.map(([k, v]) => `${k}: expected ${v}, got ${got[k]}`).join('; ')}`);
        failures++;
    } else {
        const shown = Object.keys(want).length ? ` (${Object.keys(want).map(k => `${k}=${got[k]}`).join(' ')})` : '';
        console.log(`  ok   ${name} - survived${shown}`);
        passes++;
    }
}

// ── server side: the same WAD bytes through server/ui-assets.js ─────────────
// Not the engine, but the same class and the same input: the operator's own
// wads/lib.  A corrupt WAD should cost its own box art, not the server process.
console.log('');
const badDir = mkdtempSync(join(tmpdir(), 'wadfuzz-srv-'));
const { uiAssets } = await import(join(root, 'server/ui-assets.js'));
const SERVER_CASES = [
    ['truncated-header',  Buffer.from('IWAD')],
    ['absurd-numlumps',   (() => { const b = Buffer.alloc(64); b.write('IWAD', 0, 'ascii');
                                   b.writeInt32LE(0x7FFFFFFF, 4); b.writeInt32LE(12, 8); return b; })()],
    ['negative-numlumps', (() => { const b = Buffer.alloc(64); b.write('IWAD', 0, 'ascii');
                                   b.writeInt32LE(-5, 4); b.writeInt32LE(12, 8); return b; })()],
    ['dirofs-past-eof',   (() => { const b = Buffer.alloc(64); b.write('IWAD', 0, 'ascii');
                                   b.writeInt32LE(2, 4); b.writeInt32LE(0x40000000, 8); return b; })()],
    ['empty-file',        Buffer.alloc(0)],
];
for (const [name, bytes] of SERVER_CASES) {
    writeFileSync(join(badDir, 'doom.wad'), bytes);
    const t0 = Date.now();
    let verdict;
    try {
        // uiAssets memoises into a module-level `cached`, so each case needs a
        // fresh module instance or only the first one is actually exercised.
        const { uiAssets: fresh } = await import(join(root, 'server/ui-assets.js') + `?c=${name}`);
        const r = fresh(badDir, { wads: [] });
        const ms = Date.now() - t0;
        // null is the right answer (serve.js turns it into a 404).  Returning
        // assets from a corrupt WAD would be wrong too.
        verdict = r === null ? { good: true, why: `declined in ${ms}ms` }
                             : { good: false, why: 'returned assets from a corrupt WAD' };
    } catch (e) {
        // A throw here propagates out of the /api/ui-assets request handler,
        // which is an uncaught exception in a Node request listener: the
        // process exits.  That is the defect, not an acceptable outcome.
        verdict = { good: false, why: `threw ${e.constructor.name} (this kills the server): ${e.message.slice(0, 60)}` };
    }
    console.log(`  ${verdict.good ? 'ok  ' : 'FAIL'} ui-assets ${name} - ${verdict.why}`);
    verdict.good ? passes++ : failures++;
}

// The thumb route decodes a TITLEPIC on the server with the client decoder's
// bounds: a column offset past the lump, a post that runs past it, absurd
// dimensions.  It must answer null (no art) or bytes, and answer quickly.
const { titleThumb } = await import(join(root, 'server/ui-assets.js'));
const hostilePatch = kind => {
    const b = Buffer.alloc(64);
    if (kind === 'offsets-past-eof') { b.writeUInt16LE(4, 0); b.writeUInt16LE(4, 2); for (let x = 0; x < 4; x++) b.writeUInt32LE(0x7fffff00, 8 + 4 * x); }
    if (kind === 'post-runs-past-eof') { b.writeUInt16LE(1, 0); b.writeUInt16LE(4, 2); b.writeUInt32LE(12, 8); b[12] = 0; b[13] = 250; }
    if (kind === 'absurd-dimensions') { b.writeUInt16LE(0xffff, 0); b.writeUInt16LE(0xffff, 2); }
    if (kind === 'row-past-height') { b.writeUInt16LE(1, 0); b.writeUInt16LE(2, 2); b.writeUInt32LE(12, 8); b[12] = 200; b[13] = 8; b[24] = 0xff; }
    return kind === 'empty' ? Buffer.alloc(0) : b;
};
const THUMB_CASES = ['offsets-past-eof', 'post-runs-past-eof', 'absurd-dimensions', 'row-past-height', 'empty'];
for (const kind of THUMB_CASES) {
    const wadPath = join(badDir, `t-${kind}.wad`);
    writeFileSync(wadPath, pwad([['PLAYPAL', Buffer.alloc(768, 7)], ['TITLEPIC', hostilePatch(kind)]]));
    const t0 = Date.now();
    let verdict;
    try {
        const r = titleThumb(badDir, { wads: [{ file: `t-${kind}.wad` }] }, `t-${kind}.wad`);
        const ms = Date.now() - t0;
        verdict = (r === null || (Buffer.isBuffer(r) && r.length === 768 + 80 * 60)) && ms < 2000
            ? { good: true, why: `${r === null ? 'declined' : 'thumb built'} in ${ms}ms` }
            : { good: false, why: `returned ${r?.length ?? r} in ${ms}ms` };
    } catch (e) {
        verdict = { good: false, why: `threw ${e.constructor.name}: ${e.message.slice(0, 60)}` };
    }
    console.log(`  ${verdict.good ? 'ok  ' : 'FAIL'} thumb ${kind} - ${verdict.why}`);
    verdict.good ? passes++ : failures++;
}

// ── hostile .doomrc: the OTHER bytes the player supplies ─────────────────────
//
// Everything above is lump content.  The config is the sibling case and had no
// cover at all: M_LoadDefaults (engine/core/m_misc.c) parses .doomrc and does
// `*defaults[i].location = parm` with NO range check on any entry, and .doomrc
// does not come from a file on the user's disk here -- it round-trips through
// IndexedDB and reaches the engine as Module.fileMap (files.c's js_file_len
// bridge), which browser-options already treats as hostile input.
//
// `usegamma` indexes gammatable[5][256] in engine/web/i_video.c on every
// palette update.  `usegamma 99` read about 24 KB past it until round 13
// clamped it at the index site.  spec.md tenet 4: no input from the network,
// the WAD, or the user may corrupt memory.
//
// The CONTROL is the load-bearing part.  A clamp that made every gamma
// identical would pass a "99 looks like 0" assertion trivially, so a LEGAL
// gamma must still change the palette or this case proves nothing.
const CONFIG_CASES = ['gamma-clamped', 'gamma-control'];
{
    const createDoom = (await import(join(root, buildDir, 'doom.js'))).default;
    const wadBytes = readFileSync(join(root, 'wads/lib/doom.wad'));
    const paletteFor = async rc => {
        const d = await createDoom({ noInitialRun: true, print() {}, printErr() {},
            fileMap: new Map([['.doomrc', new Uint8Array(Buffer.from(rc, 'ascii'))]]) });
        const wp = d._malloc(wadBytes.length);
        d.HEAPU8.set(wadBytes, wp);
        d.ccall('web_register_file', 'null', ['string', 'number', 'number'],
                ['doomu.wad', wp, wadBytes.length]);
        d.callMain(['-iwad', 'doomu.wad', '-warp', '1', '1', '-skill', '1', '-nodraw']);
        d._web_set_singletics(1);
        for (let i = 0; i < 12; i++) d._web_frame();
        const p = d._web_palette();
        return Buffer.from(d.HEAPU8.subarray(p, p + 768));
    };
    const g0 = await paletteFor('usegamma 0\n');
    const g99 = await paletteFor('usegamma 99\n');
    const g2 = await paletteFor('usegamma 2\n');
    const live = g0.some(b => b !== 0);

    const a = live && g0.equals(g99);
    console.log(`  ${a ? 'ok  ' : 'FAIL'} config usegamma 99 is clamped - `
        + `${live ? (a ? 'palette identical to gamma 0' : 'palette DIFFERS from gamma 0 (out-of-range read)')
                 : 'palette never populated, this case checked nothing'}`);
    a ? passes++ : failures++;

    const c = live && !g0.equals(g2);
    console.log(`  ${c ? 'ok  ' : 'FAIL'} config CONTROL: a legal gamma still changes the palette - `
        + `${c ? 'gamma 2 differs from gamma 0' : 'gamma 2 == gamma 0, so the case above sees nothing'}`);
    c ? passes++ : failures++;
}

const EXPECTED = Object.keys(CASES).length + SERVER_CASES.length + THUMB_CASES.length + CONFIG_CASES.length;
console.log(`\n  ${passes} passed, ${failures} failed`);
if (failures) { console.log(`FAIL wad-content-fuzz-test: ${failures} case(s)`); process.exit(1); }
if (passes !== EXPECTED) { console.log(`FAIL wad-content-fuzz-test: ran ${passes} of ${EXPECTED} cases`); process.exit(1); }
console.log(`PASS - wad-content-fuzz-test: ${passes} hostile payloads (lumps, server-side, thumbs, and a hostile .doomrc), engine survived all`);
