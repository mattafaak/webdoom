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
// usage: node tools/fuzz/crafted-maps.mjs [--build-dir DIR]
// Copyright (C) 2026, GPL-2.0-or-later.
import { pwad, buildMap, demoLump } from '../lib/mapkit.mjs';
import { bootEngine, loadWad } from '../lib/engine.mjs';
import { buildDirArg } from '../lib/util.mjs';
import { check, summary } from '../lib/report.mjs';

const BUILD = buildDirArg();
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
    const twoSided = (x1, y1, x2, y2, front, back, frontTex = {}, extra = {}) =>
        lines.push({ v1: v(x1, y1), v2: v(x2, y2), front: side(front, frontTex), back: side(back), flags: 4, ...extra });
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
        twoSided(0, 300, 1024, 300, 0, 1, { top: 'STARTAN3' }, { special: 46, tag: 1 });
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

// Play a case; returns { y } (player 0's y in map units) or { error }.
async function play({ lumps, tics }) {
    const bytes = pwad([['MAP01', Buffer.alloc(0)], ...lumps, ['DEMO', demoLump({ tics })]]);
    let err = null;
    const doom = await bootEngine(BUILD, [['doom2.wad', loadWad('doom2.wad')], ['crafted.wad', bytes]],
                                  { onDoomError: m => { err = m; } });
    try {
        doom.callMain(['-file', 'crafted.wad', '-playdemo', 'DEMO', '-nodraw']);
        doom._web_set_singletics(1);
        doom._web_set_nodraw(1);
        for (let i = 0; i < tics.length - 2 && !err; i++) { doom._web_wipe_skip(); doom._web_frame(); }
    } catch (e) {
        if (!err) return { error: `trapped: ${String(e.message ?? e).split('\n')[0]}` };
    }
    if (err) return { error: `I_Error: ${err}` };
    const p = doom._malloc(24);    // web_demo_state writes six ints
    doom._web_demo_state(p);
    return { y: doom.HEAP32[p / 4 + 2] / 65536 };
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

summary('crafted maps reach their limits through the real loader and a demo (2 cases)');
