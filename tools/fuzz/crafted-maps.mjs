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
//   stairs-glass     the player walks over a W1 "raise stairs 8" line (8)
//                    whose first step's first line is a glass line (two-sided,
//                    no side 1).  EV_BuildStairs took that line's NULL back
//                    sector as a candidate for the next step: its index, its
//                    floorpic (nat-doom: UBSan's member access within a null
//                    pointer).  wasm read 0 there, and the steps are on flat 0
//                    (doom2.wad's F1_START marker, never drawn: both run
//                    -nodraw), so it took NULL as the next step, put a floor
//                    thinker on it and never raised the real one.  The demo
//                    must run with no sanitizer report, and every wasm tic's
//                    state (web_demo_state) must equal the control's, the same
//                    map with a one-sided wall for the glass line.
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
//   sprite-no-rotation  a PWAD whose only sprite is TROOA1 (S_START TROOA1
//                    S_END replaces the IWAD's sprite list), and an imp seen
//                    from behind: rotation 5 of frame A has no patch, lump -1.
//                    R_ProjectSprite indexed spriteoffset[-1] and drew lump
//                    S_START (wasm: memory access out of bounds).  The frame
//                    must also equal the control's, an imp out of view: a
//                    rotation with no patch draws nothing.
//   weapon-no-frame  PISGA0 and PISGC0 but no frame B, and the pistol fires
//                    through S_PISTOL2 (frame B): the same -1 in
//                    R_DrawPSprite.  A regression guard only -- the old engine
//                    computed an off-screen x from the garbage and drew
//                    nothing, in both engines.
//   view-on-vertex   the player stands exactly on v1 of a wall it faces.
//                    R_PointToDist took FixedDiv(0, 0) -- MAXINT -- and
//                    indexed tantoangle[] with it (wasm: memory access out
//                    of bounds).  Real maps do this: Plutonia MAP15's
//                    deathmatch starts and an armor bonus on TNT MAP05.
//
// One limit is reached by a real map rather than a crafted one:
//
//   sigil-e5m6       SIGIL's E5M6 (sigil.wad on doom.wad) needs 134 visplanes
//                    in its opening view.  With vanilla's 128 the engine died
//                    on the first frame; R_CheckPlane also took the 129th with
//                    no bound and wrote past visplanes[] before R_DrawPlanes'
//                    RANGECHECK noticed.  It must draw in wasm and in nat-doom
//                    with no sanitizer report, and nat-doom-vp128 (the same
//                    engine with 128 visplanes) must stop at R_CheckPlane's
//                    I_Error with no sanitizer report: the bound, not an
//                    overrun.
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
const NAT_DOOM_VP128 = join(root, 'tools/native-sanitize/nat-doom-vp128');
if (!existsSync(NAT_DOOM) || !existsSync(NAT_DOOM_VP128))
    fatal('needs tools/native-sanitize/nat-doom and nat-doom-vp128 (make -C tools/native-sanitize): the sanitizer is half of every native case');
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
    // the glass hack: two-sided (ML_TWOSIDED), no side 1, its front on the right
    const glass = (x1, y1, x2, y2, sector) => lines.push({ v1: v(x1, y1), v2: v(x2, y2), front: side(sector), flags: 4 });
    draw({ wall, twoSided, glass });
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

// ── a staircase beside a glass line ──────────────────────────────────────────
// The room (sector 0, the player's: the first seg's) has the W1 stairs line
// across it at y=200, tag 1; the player starts at y=64 and walks north over
// it.  The steps are their own pair of sectors east of the room: 1, tagged,
// and 2, both on flat 0.  Sector 1's first line (P_GroupLines keeps linedef
// order) is the glass line, its front on sector 1; its second is the riser
// to sector 2, front on 1, back on 2.  With `glass` false a one-sided wall
// takes the glass line's place: the control.
function stairsGlass(glass = true) {
    const STEP = { floor: 0, ceil: 128, floorpic: 'F1_START', ceilpic: 'CEIL3_5', light: 192 };
    const lumps = map([ROOM, { ...STEP, tag: 1 }, STEP], ({ wall, twoSided, glass: pane }) => {
        wall(0, 0, 0, 1024, 0); wall(0, 1024, 1024, 1024, 0); wall(1024, 1024, 1024, 0, 0); wall(1024, 0, 0, 0, 0);
        twoSided(0, 200, 1024, 200, 0, 0, {}, {}, { special: 8, tag: 1 });
        if (glass) pane(2000, 0, 2000, 100, 1);
        else wall(2000, 0, 2000, 100, 1);
        twoSided(2100, 100, 2100, 0, 1, 2);
        wall(2000, 100, 2100, 100, 1); wall(2100, 0, 2000, 0, 1);
        wall(2100, 100, 2200, 100, 2); wall(2200, 100, 2200, 0, 2); wall(2200, 0, 2100, 0, 2);
    }, [{ x: 512, y: 64, angle: 90, type: 1 }]);
    // walk over the line, then wait while the steps rise (8 and 16 units at
    // a quarter unit a tic)
    return { lumps, tics: [...idle(5), ...Array.from({ length: 40 }, () => [{ forward: 25 }]), ...idle(100)] };
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

// ── the viewpoint on a wall's start vertex ───────────────────────────────────
// A wall from the player's own spot to the south-east, faced from its start:
// the player looks east, so the wall is inside the view.
function viewOnVertex() {
    const lumps = map([ROOM], ({ wall }) => {
        wall(512, 512, 900, 200, 0);
        wall(0, 0, 0, 1024, 0); wall(0, 1024, 1024, 1024, 0); wall(1024, 1024, 1024, 0, 0); wall(1024, 0, 0, 0, 0);
    }, [{ x: 512, y: 512, angle: 0, type: 1 }]);
    return { lumps, tics: idle(10) };
}

// ── sprites without the patch a view needs ───────────────────────────────────
function iwadLump(name) {
    const d = loadWad('doom2.wad');
    for (let i = 0, n = d.readInt32LE(4), o = d.readInt32LE(8); i < n; i++) {
        const e = o + 16 * i;
        if (d.toString('latin1', e + 8, e + 16).replace(/\0.*$/, '') === name)
            return Buffer.from(d.subarray(d.readInt32LE(e), d.readInt32LE(e) + d.readInt32LE(e + 4)));
    }
    throw new Error(`${name} not in doom2.wad`);
}
const sprites = names => [['S_START', Buffer.alloc(0)], ...names.map(n => [n, iwadLump(n)]), ['S_END', Buffer.alloc(0)]];
// the imp at (512, impY) facing impAngle; the player at (512, 128) faces north
function impRoom(impY, impAngle, extra, tics = idle(10)) {
    const lumps = map([ROOM], ({ wall }) => {
        wall(0, 0, 0, 1024, 0); wall(0, 1024, 1024, 1024, 0); wall(1024, 1024, 1024, 0, 0); wall(1024, 0, 0, 0, 0);
    }, [{ x: 512, y: impY, angle: impAngle, type: 3001 }, { x: 512, y: 128, angle: 90, type: 1 }]);
    return { lumps, tics, extra };
}
// facing away from the player, who is behind it: neither sees the other
const spriteNoRotation = () => impRoom(400, 90, sprites(['TROOA1']));
const spriteControl = () => impRoom(40, 270, sprites(['TROOA1']));
const weaponNoFrame = () => impRoom(400, 90, sprites(['PISGA0', 'PISGC0']),
    [...idle(15), ...Array.from({ length: 12 }, () => [{ buttons: 1 }]), ...idle(5)]);

const lmp = c => pwad([...(c.extra ?? []), ['MAP01', Buffer.alloc(0)], ...c.lumps,
                       ['DEMO', demoLump({ tics: c.tics, ...c.demo })]]);

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
// last { frame }, or { error }.  With `trace`, also { states }: every tic's
// web_demo_state (P_Random's index, player 0, every sector's heights and the
// thinker count).
async function play(c, { draw = false, trace = false } = {}) {
    const { tics } = c;
    const bytes = lmp(c);
    let err = null;
    const doom = await bootEngine(BUILD, [['doom2.wad', loadWad('doom2.wad')], ['crafted.wad', bytes]],
                                  { onDoomError: m => { err = m; } });
    const p = doom._malloc(24);    // web_demo_state writes six ints
    const states = [];
    try {
        doom.callMain(['-file', 'crafted.wad', '-playdemo', 'DEMO', ...(draw ? [] : ['-nodraw'])]);
        doom._web_set_singletics(1);
        if (!draw) doom._web_set_nodraw(1);
        for (let i = 0; i < tics.length - 2 && !err; i++) {
            doom._web_wipe_skip(); doom._web_frame();
            if (trace) { doom._web_demo_state(p); states.push(Array.from(doom.HEAP32.subarray(p / 4, p / 4 + 6)).join(' ')); }
        }
    } catch (e) {
        if (!err) return { error: `trapped: ${String(e.message ?? e).split('\n')[0]}`, states };
    }
    if (err) return { error: `I_Error: ${err}`, ierror: err, states };
    doom._web_demo_state(p);
    const fb = doom._web_framebuffer();
    return { y: doom.HEAP32[p / 4 + 2] / 65536, frame: draw ? Buffer.from(doom.HEAPU8.subarray(fb, fb + 320 * 200)) : null, states };
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
    ['weapon-no-frame', weaponNoFrame],
    ['view-on-vertex', viewOnVertex],
];
for (const [name, build] of RENDERED) await renders(name, build());

{
    const w = await play(spriteNoRotation(), { draw: true });
    const control = await play(spriteControl(), { draw: true });
    check('sprite-no-rotation: wasm draws it, and the frame equals the control with the imp out of view',
          w.frame && control.frame && w.frame.equals(control.frame),
          w.error ?? control.error ?? 'the frames differ');
    const n = playNative(spriteNoRotation(), { draw: true });
    check('sprite-no-rotation: nat-doom draws the demo with no sanitizer report', n.ran, n.sanitizer ?? n.crash ?? n.ierror);
}

const REFUSED = [
    ['brain-no-targets', brainNoTargets, 'A_BrainSpit'],
    ['dm-no-start', dmNoStart, 'P_SpawnPlayer'],
];
for (const [name, build, expected] of REFUSED) await refuses(name, build(), expected);

// The staircase beside a glass line: wasm against its control, tic by tic,
// and nat-doom under the sanitizers.
{
    const w = await play(stairsGlass(), { trace: true });
    const ctl = await play(stairsGlass(false), { trace: true });
    // what makes the control a test: the player crossed the line and both
    // steps rose; sector 2's 16 units at a quarter unit a tic are 64 tics on
    // which the world's part of the state moves
    const crossed = ctl.y > 200, moved = ctl.states.filter((s, i) => i && s.split(' ')[5] !== ctl.states[i - 1].split(' ')[5]).length;
    check(`stairs-glass: the control raises its stairs (player at y=${ctl.y?.toFixed(0)}, the world changed on ${moved} tics)`,
          !ctl.error && crossed && moved >= 64, ctl.error ?? 'the stairs did not rise');
    const d = w.states.findIndex((s, i) => s !== ctl.states[i]);
    check(`stairs-glass: wasm raises the same stairs with the glass line, every tic (${w.states.length} tics)`,
          !w.error && d < 0 && w.states.length === ctl.states.length,
          w.error ?? (d >= 0 ? `tic ${d}: [${w.states[d]}], the control [${ctl.states[d]}]` : `${w.states.length} tics, the control ${ctl.states.length}`));
    const n = playNative(stairsGlass());
    check('stairs-glass: nat-doom plays the demo with no sanitizer report', n.ran, n.sanitizer ?? n.crash ?? n.ierror);
}

// ── a real map past vanilla's visplane limit ─────────────────────────────────
// doom.wad as the engine's doomu.wad, sigil.wad, and a demo that stands at
// E5M6's start for 35 tics, drawn.
const SIGIL = { tics: idle(37), demo: { episode: 5, map: 6, skill: 2 } };
function nativeRun(bin, c) {
    const dir = mkdtempSync(join(tmpdir(), 'webdoom-crafted-'));
    try {
        symlinkSync(join(root, 'wads/lib/doom.wad'), join(dir, 'doomu.wad'));
        symlinkSync(join(root, 'wads/lib/sigil.wad'), join(dir, 'sigil.wad'));
        writeFileSync(join(dir, 'demo.wad'), pwad([['DEMO', demoLump({ tics: c.tics, ...c.demo })]]));
        const r = spawnSync(bin, ['-waddir', dir, '-file', 'sigil.wad', 'demo.wad', '-timedemo', 'DEMO'],
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
if (!existsSync(join(root, 'wads/lib/sigil.wad'))) fatal('needs wads/lib/sigil.wad for sigil-e5m6');
{
    let err = null;
    const doom = await bootEngine(BUILD, [['doomu.wad', loadWad('doom.wad')], ['sigil.wad', loadWad('sigil.wad')],
                                          ['demo.wad', pwad([['DEMO', demoLump({ tics: SIGIL.tics, ...SIGIL.demo })]])]],
                                  { onDoomError: m => { err = m; } });
    let frames = 0;
    try {
        doom.callMain(['-file', 'sigil.wad', 'demo.wad', '-playdemo', 'DEMO']);
        doom._web_set_singletics(1);
        for (let i = 0; i < SIGIL.tics.length - 2 && !err; i++) { doom._web_wipe_skip(); doom._web_frame(); frames++; }
    } catch (e) { err ??= `trapped: ${String(e.message ?? e).split('\n')[0]}`; }
    check(`sigil-e5m6: wasm draws ${SIGIL.tics.length - 2} frames of E5M6 (${frames} drawn)`, !err, err);
    const n = nativeRun(NAT_DOOM, SIGIL);
    check('sigil-e5m6: nat-doom draws E5M6 with no sanitizer report', n.ran, n.sanitizer ?? n.crash ?? n.ierror);
    const v = nativeRun(NAT_DOOM_VP128, SIGIL);
    check(`sigil-e5m6: with 128 visplanes nat-doom stops at R_CheckPlane, no sanitizer report (${Object.values(v)[0]})`,
          /^R_CheckPlane/.test(v.ierror ?? ''), v.sanitizer ?? v.crash ?? v.ierror ?? 'it ran on');
}

summary(`crafted maps reach their limits through the real loader and a demo (${5 + RENDERED.length + REFUSED.length} cases)`);
