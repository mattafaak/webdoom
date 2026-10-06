#!/usr/bin/env node
// tools/fuzz/crafted-maps.mjs — engine limits that only a purpose-built map
// reaches, each entered through the real loader and a real demo.
//
// Every case is a PWAD made by tools/lib/mapkit.mjs (one subsector, no node
// builder) holding MAP01 and a DEMO lump for doom2.wad, played with
// -playdemo in the wasm engine, and judged on an outcome the defect changes:
//
//   intercepts-128   126 candles stand between the player and a closed door
//                    whose face opens when shot (GR, special 46).  With the
//                    shooter itself that makes the face intercept 128 of the
//                    pistol's trace.  The array holds 128; the old guard
//                    clamped at 127 and the face was never traversed, so the
//                    door stayed shut and the player, walking north, stopped
//                    at it.
//   intercepts-129   the control: one candle more, so the face is the 129th
//                    and is dropped -- the door must stay shut, which proves
//                    the case above sits exactly on the boundary.
//
// The cases below also run in tools/native-sanitize/nat-doom (ASan/UBSan,
// -timedemo), and pass only with no sanitizer report there:
//
//   brain-no-targets a boss shooter (89) wakes in a room with no boss target
//                    (87).  A_BrainSpit took `% numbraintargets` of 0: a
//                    divide-by-zero trap in wasm, SIGFPE natively.  It must
//                    end in A_BrainSpit's I_Error, as in Chocolate Doom.
//   dm-no-start      a two-player deathmatch demo on a map whose four
//                    deathmatch starts share one spot and that has no start
//                    for player 2.  Player 2's 20 tries all collide with
//                    player 1, and the fallback spawned him at the zeroed
//                    playerstarts[1] -- type 0, so playeringame[-1] and
//                    players[-1].  It must end in P_SpawnPlayer's I_Error.
//
// And these render, natively under ASan/UBSan and in wasm, and pass only with
// no sanitizer report and no trap:
//
//   masked-openings  thirty two-sided lines with a masked midtexture span the
//                    view one behind another, so the openings run out part
//                    way through one of them: its masked columns are
//                    allocated, its sprite clips are not.  R_RenderMaskedSegRange
//                    then clipped against a NULL array (UBSan: load of a null
//                    pointer in R_DrawMaskedColumn).
//   solidsegs-full   75 thin pillars in a row, each its own solid range on
//                    screen, fill the 64-entry solid clip list; the far wall
//                    then merges them all, and the crunch copies the entry at
//                    newend -- solidsegs[64], one past the array (ASan:
//                    global-buffer-overflow in R_ClipSolidWallSegment).
//
// usage: node tools/fuzz/crafted-maps.mjs [--build-dir DIR]
// Copyright (C) 2026, GPL-2.0-or-later.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pwad, buildMap, demoLump } from '../lib/mapkit.mjs';
import { bootEngine, loadWad } from '../lib/engine.mjs';
import { root, buildDirArg } from '../lib/util.mjs';
import { check, summary, fatal } from '../lib/report.mjs';

const BUILD = buildDirArg();
const NAT_DOOM = join(root, 'tools/native-sanitize/nat-doom');
if (!existsSync(NAT_DOOM)) fatal('needs tools/native-sanitize/nat-doom (make -C tools/native-sanitize): the sanitizer is half of every native case');
const STARTAN = { mid: 'STARTAN3' };
const ROOM = { floor: 0, ceil: 256, floorpic: 'FLOOR4_8', ceilpic: 'CEIL3_5', light: 192 };
const idle = n => Array.from({ length: n }, () => [{}]);

// A map from a list of sectors and a line-drawing callback.
function map(sectors, draw, things) {
    const vertices = [], sides = [], lines = [];
    const v = (x, y) => {
        const i = vertices.findIndex(([a, b]) => a === x && b === y);
        return i >= 0 ? i : vertices.push([x, y]) - 1;
    };
    const side = (sector, tex = {}) => sides.push({ sector, ...tex }) - 1;
    // a wall from (x1,y1) to (x2,y2), its front on the right
    const wall = (x1, y1, x2, y2, sector, extra = {}) =>
        lines.push({ v1: v(x1, y1), v2: v(x2, y2), front: side(sector, STARTAN), flags: 1, ...extra });
    const twoSided = (x1, y1, x2, y2, front, back, frontTex = {}, backTex = {}, extra = {}) =>
        lines.push({ v1: v(x1, y1), v2: v(x2, y2), front: side(front, frontTex), back: side(back, backTex), flags: 4, ...extra });
    draw({ wall, twoSided });
    return buildMap({ vertices, sectors, sides, lines, things });
}

// ── intercepts ───────────────────────────────────────────────────────────────
// A 1024-wide room cut at y=300..316 by a closed door sector tagged 1.  The
// player stands at y=64 facing north with the candles at y=100, all in the
// first blockmap row, and the door's south face is the first line in the
// third row, so the trace adds the shooter, the candles, then the face.
function doorShot(candles) {
    const sectors = [ROOM, { ...ROOM, ceil: 0, tag: 1 }];
    const lumps = map(sectors, ({ wall, twoSided }) => {
        twoSided(0, 300, 1024, 300, 0, 1, { top: 'STARTAN3' }, {}, { special: 46, tag: 1 });
        twoSided(1024, 316, 0, 316, 0, 1, { top: 'STARTAN3' });
        wall(0, 0, 0, 300, 0); wall(1024, 300, 1024, 0, 0); wall(1024, 0, 0, 0, 0);
        wall(0, 300, 0, 316, 1); wall(1024, 316, 1024, 300, 1);
        wall(0, 316, 0, 2048, 0); wall(0, 2048, 1024, 2048, 0); wall(1024, 2048, 1024, 316, 0);
    }, [...Array.from({ length: candles }, () => ({ x: 576, y: 100, type: 34 })),
        { x: 576, y: 64, angle: 90, type: 1 }]);
    // one pistol shot, time for the door to open, then walk north
    const tics = [...idle(20), [{ buttons: 1 }], ...idle(80),
                  ...Array.from({ length: 60 }, () => [{ forward: 25 }]), ...idle(10)];
    return { lumps, tics };
}

// ── a boss shooter with nothing to shoot at ──────────────────────────────────
function brainNoTargets() {
    const lumps = map([ROOM], ({ wall }) => {
        wall(0, 0, 0, 1024, 0); wall(0, 1024, 1024, 1024, 0); wall(1024, 1024, 1024, 0, 0); wall(1024, 0, 0, 0, 0);
    }, [{ x: 512, y: 900, angle: 270, type: 89 }, { x: 512, y: 128, angle: 90, type: 1 }]);
    // it looks every 10 tics, then waits 181 in S_BRAINEYESEE before spitting
    return { lumps, tics: idle(260) };
}

// ── a deathmatch spawn with nowhere to go ────────────────────────────────────
function dmNoStart() {
    const lumps = map([ROOM], ({ wall }) => {
        wall(0, 0, 0, 1024, 0); wall(0, 1024, 1024, 1024, 0); wall(1024, 1024, 1024, 0, 0); wall(1024, 0, 0, 0, 0);
    }, [...Array.from({ length: 4 }, () => ({ x: 256, y: 256, type: 11 })), { x: 768, y: 768, angle: 90, type: 1 }]);
    return { lumps, tics: Array.from({ length: 35 }, () => [{}, {}]), demo: { deathmatch: 1, players: 2 } };
}

// ── more masked walls than openings ──────────────────────────────────────────
function maskedOpenings() {
    const lumps = map([ROOM], ({ wall, twoSided }) => {
        // nearest first: one subsector draws in seg order
        for (let k = 1; k <= 30; k++)
            twoSided(-4096, 32 + 64 * k, 4096, 32 + 64 * k, 0, 0, { mid: 'MIDGRATE' }, { mid: 'MIDGRATE' });
        wall(-4096, 0, -4096, 4096, 0); wall(-4096, 4096, 4096, 4096, 0); wall(4096, 4096, 4096, 0, 0); wall(4096, 0, -4096, 0, 0);
    }, [{ x: 0, y: 16, angle: 90, type: 1 }]);
    return { lumps, tics: idle(10) };
}

// ── more solid ranges on screen than clip-list entries ───────────────────────
function solidsegsFull() {
    const lumps = map([ROOM], ({ wall }) => {
        // 8-unit pillars every 20 units, 736 units away: ~2 px each, ~2 px apart
        for (let k = 0; k < 75; k++) {
            const x = -740 + 20 * k, y = 800;
            wall(x, y, x + 8, y, 0); wall(x + 8, y, x + 8, y + 8, 0); wall(x + 8, y + 8, x, y + 8, 0); wall(x, y + 8, x, y, 0);
        }
        wall(-1024, 0, -1024, 2048, 0); wall(-1024, 2048, 1024, 2048, 0); wall(1024, 2048, 1024, 0, 0); wall(1024, 0, -1024, 0, 0);
    }, [{ x: 0, y: 64, angle: 90, type: 1 }]);
    return { lumps, tics: idle(10) };
}

const lmp = c => pwad([['MAP01', Buffer.alloc(0)], ...c.lumps, ['DEMO', demoLump({ tics: c.tics, ...c.demo })]]);

// Play a case natively under ASan/UBSan; returns { ierror } (the I_Error
// text), { sanitizer } (the report's first line), { crash } or { ran: true }.
function playNative(c, { draw = false } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'webdoom-crafted-'));
    try {
        symlinkSync(join(root, 'wads/lib/doom2.wad'), join(dir, 'doom2.wad'));
        writeFileSync(join(dir, 'crafted.wad'), lmp(c));
        const r = spawnSync(NAT_DOOM, ['-waddir', dir, '-file', 'crafted.wad', '-timedemo', 'DEMO', ...(draw ? [] : ['-nodraw'])],
                            { encoding: 'utf8', timeout: 120_000,
                              env: { ...process.env, ASAN_OPTIONS: 'halt_on_error=1:abort_on_error=0', UBSAN_OPTIONS: 'halt_on_error=1' } });
        const err = r.stderr ?? '';
        const san = /(AddressSanitizer[^\n]*|runtime error:[^\n]*|ERROR: [^\n]*)/.exec(err);
        if (san) return { sanitizer: san[1].trim() };
        const ie = /I_Error: ([^\n]*)/.exec(err);
        if (ie) return { ierror: ie[1].trim() };
        if (r.status === 0) return { ran: true };
        return { crash: `exit ${r.status}${r.signal ? ` ${r.signal}` : ''}` };
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

// Play a case; returns { y } (player 0's y in map units) and, drawn, the
// last { frame }, or { error }.
async function play(c, { draw = false } = {}) {
    const { tics } = c;
    const bytes = lmp(c);
    let err = null;
    const doom = await bootEngine(BUILD, [['doom2.wad', loadWad('doom2.wad')], ['crafted.wad', bytes]],
                                  { onDoomError: m => { err = m; } });
    try {
        doom.callMain(['-file', 'crafted.wad', '-playdemo', 'DEMO', ...(draw ? [] : ['-nodraw'])]);
        doom._web_set_singletics(1);
        if (!draw) doom._web_set_nodraw(1);
        for (let i = 0; i < tics.length - 2 && !err; i++) { doom._web_wipe_skip(); doom._web_frame(); }
    } catch (e) {
        if (!err) return { error: `trapped: ${String(e.message ?? e).split('\n')[0]}` };
    }
    if (err) return { error: `I_Error: ${err}`, ierror: err };
    const p = doom._malloc(24);    // web_demo_state writes six ints
    doom._web_demo_state(p);
    const fb = doom._web_framebuffer();
    return { y: doom.HEAP32[p / 4 + 2] / 65536, frame: draw ? Buffer.from(doom.HEAPU8.subarray(fb, fb + 320 * 200)) : null };
}

// VACUITY-EXEMPT R3: play() is the one bootEngine call site, and every case
// below runs in an engine of its own, so no case can disarm the next.
const DOOR = 316;   // the door's north face
let r = await play(doorShot(126));
check(`intercepts-128: the shot crosses the door face as intercept 128 and opens it (player walked to y=${r.y?.toFixed(0)})`,
      r.y > DOOR, r.error ?? 'the door stayed shut');
r = await play(doorShot(127));
check(`intercepts-129: as intercept 129 it is dropped and the door stays shut (player stopped at y=${r.y?.toFixed(0)})`,
      r.y !== undefined && r.y < 300, r.error ?? 'the door opened');

// Both engines must stop with `expected`'s I_Error, and nat-doom must report
// nothing else.
async function refuses(name, c, expected) {
    const w = await play(c);
    check(`${name}: wasm stops with ${expected} (${w.ierror ?? w.error ?? 'it ran on'})`,
          new RegExp(`^${expected}`).test(w.ierror ?? ''), w.error ?? 'no error');
    const n = playNative(c);
    check(`${name}: nat-doom stops with ${expected}, no sanitizer report (${Object.values(n)[0]})`,
          new RegExp(`^${expected}`).test(n.ierror ?? ''), n.sanitizer ?? n.crash ?? n.ierror ?? 'it ran on');
}
// Both engines must draw every frame: nat-doom with no sanitizer report,
// wasm without trapping.
async function renders(name, c) {
    const w = await play(c, { draw: true });
    check(`${name}: wasm draws ${c.tics.length - 2} frames`, !w.error, w.error);
    const n = playNative(c, { draw: true });
    check(`${name}: nat-doom draws the demo with no sanitizer report`, n.ran, n.sanitizer ?? n.crash ?? n.ierror);
}
const RENDERED = [
    ['masked-openings', maskedOpenings],
    ['solidsegs-full', solidsegsFull],
];
for (const [name, build] of RENDERED) await renders(name, build());

const REFUSED = [
    ['brain-no-targets', brainNoTargets, 'A_BrainSpit'],
    ['dm-no-start', dmNoStart, 'P_SpawnPlayer'],
];
for (const [name, build, expected] of REFUSED) await refuses(name, build(), expected);

summary(`crafted maps reach their limits through the real loader and a demo (${2 + RENDERED.length + REFUSED.length} cases)`);
