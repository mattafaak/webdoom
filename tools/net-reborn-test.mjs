#!/usr/bin/env node
// Drop-in spawns, driven through the engine's own netgame entry points
// (web_net_setup, web_net_bundle, web_replay_tic) the way net.js drives them.
//
// A two-player co-op game on MAP01 of a PWAD built with tools/lib/mapkit.mjs:
// slot 1 leaves at tic 35, player 0 walks into an exit line, the intermission
// is skipped with attack taps, and on MAP02 a player drops in.
//
//   freed slot      the drop-in takes slot 1, the slot a player left on
//                   MAP01.  Its players[1].mo pointed at MAP01's mobj, freed
//                   with the level, so G_DoReborn wrote through it and
//                   G_CheckSpot took the corpse path (a bodyque entry and a
//                   teleport fog) for a player who had no corpse.  The world
//                   must equal the one a drop-in into never-used slot 2
//                   leaves: the same random index and the same sectors and
//                   thinker count (web_demo_state's world hash).
//   no start        MAP02 has player 1's start only, and the drop-in takes
//                   slot 1.  It spawns at another player's start (a
//                   sanctioned divergence: vanilla crashed, Chocolate
//                   refuses) instead of ending the session in P_SpawnPlayer.
//
// And a level loaded with a player who has no start of their own: a
// two-player demo on Chex Quest's E1M3, which has player 1's start only.  It
// must load (it stopped with "no player 2 start"), and player 2, spawned at
// player 1's start, must be able to walk: the world after 35 tics of player 2
// walking must differ from the world after 35 tics of player 2 standing.
//
// usage: node tools/net-reborn-test.mjs [--build-dir DIR]
// Copyright (C) 2026, GPL-2.0-or-later.
import { pwad, buildMap } from './lib/mapkit.mjs';
import { bootEngine, loadWad } from './lib/engine.mjs';
import { buildDirArg } from './lib/util.mjs';
import { check, summary } from './lib/report.mjs';

const BUILD = buildDirArg();
const NP = 4;
const ROOM = { floor: 0, ceil: 128, floorpic: 'FLOOR4_8', ceilpic: 'CEIL3_5', light: 192 };

// a square room with its walls, plus whatever `extra` adds
function room(size, starts, extra = () => {}) {
    const vertices = [], sides = [], lines = [];
    const v = (x, y) => {
        const i = vertices.findIndex(([a, b]) => a === x && b === y);
        return i >= 0 ? i : vertices.push([x, y]) - 1;
    };
    const side = (s, t = {}) => sides.push({ sector: s, ...t }) - 1;
    const wall = (x1, y1, x2, y2) => lines.push({ v1: v(x1, y1), v2: v(x2, y2), front: side(0, { mid: 'STARTAN3' }), flags: 1 });
    extra({ v, side, lines });
    wall(0, 0, 0, size); wall(0, size, size, size); wall(size, size, size, 0); wall(size, 0, 0, 0);
    return buildMap({ vertices, sectors: [ROOM], sides, lines, things: starts });
}
const start = (x, type) => ({ x, y: 200, angle: 90, type });
// MAP01: starts for players 1 and 2, and a walk-over exit (W1, special 52) at y=320
const MAP01 = room(512, [{ x: 128, y: 128, angle: 90, type: 1 }, { x: 384, y: 128, angle: 90, type: 2 }],
    ({ v, side, lines }) => lines.push({ v1: v(0, 320), v2: v(512, 320), front: side(0), back: side(0), flags: 4, special: 52 }));
const map02 = starts => pwad([['MAP01', Buffer.alloc(0)], ...MAP01, ['MAP02', Buffer.alloc(0)], ...room(1024, starts)]);
const WAD = map02([start(200, 1), start(400, 2), start(600, 3), start(800, 4)]);
const WAD_ONE_START = map02([start(200, 1)]);

// Play to MAP02 and drop a player into `slot` there.  Returns web_demo_state
// 20 tics after the drop-in, or { error }.
async function dropInAfterExit(slot, wad = WAD) {
    let error = null;
    const doom = await bootEngine(BUILD, [['doom2.wad', loadWad('doom2.wad')], ['c.wad', wad]],
                                  { onDoomError: m => { error = m; } });
    doom._web_net_setup(0, NP, 0b0011);
    doom.callMain(['-file', 'c.wad', '-warp', '1', '-skill', '2', '-nodraw']);
    doom._web_set_nodraw(1);
    const cmds = doom._malloc(8 * NP), ingame = doom._malloc(NP), st = doom._malloc(24);
    const state = () => { doom._web_demo_state(st); return Array.from(doom.HEAP32.subarray(st / 4, st / 4 + 6)); };
    let mask = 0b0011, onMap02 = -1, dropped = -1, crossed = false;
    for (let t = 0; t < 2000 && !error; t++) {
        const s = state();
        if (onMap02 < 0 && s[1] > 190 * 65536) onMap02 = t;          // player 0 at MAP02's start x
        if (s[2] > 300 * 65536) crossed = true;
        if (t === 35) mask &= ~0b0010;                                // slot 1 leaves on MAP01
        if (onMap02 >= 0 && t === onMap02 + 10) { mask |= 1 << slot; dropped = t; }
        doom.HEAPU8.fill(0, cmds, cmds + 8 * NP);
        if (onMap02 < 0 && t >= 40 && !crossed) doom.HEAPU8[cmds] = 25;      // walk north into the exit
        if (onMap02 < 0 && t >= 40) doom.HEAPU8[cmds + 7] = t % 4 < 2 ? 1 : 0; // attack taps end the intermission
        for (let i = 0; i < NP; i++) doom.HEAPU8[ingame + i] = (mask >> i) & 1;
        const g = doom._web_gametic();
        if (doom._web_net_bundle(g, cmds, ingame, 0xf) !== 1) return { error: `bundle refused at tic ${g}` };
        try { doom._web_replay_tic(); } catch (e) { error ??= `trapped: ${String(e.message ?? e).split('\n')[0]}`; }
        if (dropped >= 0 && t >= dropped + 20) return { onMap02, dropped, state: s };
    }
    return { error: error ?? `never reached MAP02 and the drop-in (MAP02 at ${onMap02})` };
}

const freed = await dropInAfterExit(1);
const fresh = await dropInAfterExit(2);
check(`freed slot: the drop-in into slot 1 on MAP02 runs (MAP02 at tic ${freed.onMap02}, drop-in at ${freed.dropped})`,
      !freed.error, freed.error);
check(`control: the drop-in into never-used slot 2 runs (MAP02 at tic ${fresh.onMap02})`, !fresh.error, fresh.error);
check('freed slot: the world equals the never-used slot\'s (random index, sectors and thinker count)',
      !freed.error && !fresh.error && freed.state[0] === fresh.state[0] && freed.state[5] === fresh.state[5],
      `prndindex ${freed.state?.[0]} vs ${fresh.state?.[0]}, world ${freed.state?.[5]} vs ${fresh.state?.[5]}`);

const noStart = await dropInAfterExit(1, WAD_ONE_START);
check(`no start: a drop-in into slot 1 on a map with player 1's start only spawns (${noStart.error ?? 'ran'})`,
      !noStart.error, noStart.error);

// ── a level loaded with a player who has no start ────────────────────────────
async function chexTwoPlayers(player2) {
    const { demoLump } = await import('./lib/mapkit.mjs');
    const tics = Array.from({ length: 37 }, () => [{}, player2]);
    let error = null;
    const doom = await bootEngine(BUILD, [['doomu.wad', loadWad('chex.wad')],
                                          ['demo.wad', pwad([['DEMO', demoLump({ episode: 1, map: 3, players: 2, tics })]])]],
                                  { onDoomError: m => { error = m; } });
    try {
        doom.callMain(['-file', 'demo.wad', '-playdemo', 'DEMO', '-nodraw']);
        doom._web_set_singletics(1);
        doom._web_set_nodraw(1);
        for (let i = 0; i < 35 && !error; i++) { doom._web_wipe_skip(); doom._web_frame(); }
    } catch (e) { error ??= `trapped: ${String(e.message ?? e).split('\n')[0]}`; }
    return error ? { error } : { hash: doom._web_state_hash() >>> 0, tic: doom._web_gametic() };
}
const stand = await chexTwoPlayers({});
const walk = await chexTwoPlayers({ forward: 25 });
check(`chex E1M3, two players: the level loads and runs (${stand.error ?? `tic ${stand.tic}`})`, !stand.error, stand.error);
check('chex E1M3: player 2, spawned at player 1\'s start, walks free (the world differs from standing still)',
      !stand.error && !walk.error && stand.hash !== walk.hash, walk.error ?? `hash ${stand.hash} both ways`);

summary('drop-ins and level loads spawn every player, whatever slot or start they have', { min: 6 });
