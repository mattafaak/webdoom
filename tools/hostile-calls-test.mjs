#!/usr/bin/env node
// tools/hostile-calls-test.mjs — the web layer's entry points, called with
// what a page script, a corrupted client or a hostile server could hand them.
//
//   input-keys   web_input_event with key codes outside 0..255.  G_Responder
//                indexed gamekeydown[data1] after checking only data1 < 256,
//                so a negative code wrote `true` before the array, and
//                -0x10000000 trapped (memory access out of bounds).  Every
//                such event must be ignored: the session must hash exactly
//                as the same session without them.  The control: a legal key
//                (up arrow) still moves the player, or the comparison sees
//                nothing.
//   state-hash   web_state_hash before the first level.  It walks the
//                thinker ring from thinkercap.next, which is NULL until
//                P_InitThinkers, so it never got back to &thinkercap and the
//                call never returned.  Called before callMain and at the
//                title screen it must return 0, in a child process with a
//                timeout; the control is a non-zero hash once a level runs.
//   argv-at      an argv word starting with '@' (a PWAD the server names
//                "@x", say).  FindResponseFile took it for a DOS response
//                file: fopen "succeeded" without a filesystem, the read came
//                back empty, a NUL went to address 0 through a NULL buffer,
//                and argv was rebuilt from nothing, dropping -file and -warp.
//                The PWAD (a room as E1M1) must load and the player stand at
//                its start, and address 0, painted before callMain, must be
//                as painted.
//
// usage: node tools/hostile-calls-test.mjs [--build-dir DIR]
// Copyright (C) 2026, GPL-2.0-or-later.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bootEngine, loadWad } from './lib/engine.mjs';
import { pwad, buildMap } from './lib/mapkit.mjs';
import { buildDirArg } from './lib/util.mjs';
import { check, summary } from './lib/report.mjs';

const BUILD = buildDirArg();
const KEY_UP = 0xad;
const why = e => String(e.message ?? e).split('\n')[0];

// E1M1 at HMP, drawing off, one tic per frame; `feed(frame)` posts that
// frame's events.  Returns the state hash and player 0's x, y after 70 frames.
async function session(feed) {
    let err = null;
    const doom = await bootEngine(BUILD, [['doomu.wad', loadWad('doom.wad')]], { onDoomError: m => { err = m; } });
    try {
        doom.callMain(['-warp', '1', '1', '-skill', '3', '-nodraw']);
        doom._web_set_singletics(1);
        doom._web_set_nodraw(1);
        for (let f = 0; f < 70 && !err; f++) {
            feed(doom, f);
            doom._web_wipe_skip();
            doom._web_frame();
        }
    } catch (e) {
        return { error: err ? `I_Error: ${err}` : `trapped: ${why(e)}` };
    }
    if (err) return { error: `I_Error: ${err}` };
    const p = doom._malloc(24);    // web_demo_state writes six ints
    doom._web_demo_state(p);
    const [x, y] = [doom.HEAP32[p / 4 + 1], doom.HEAP32[p / 4 + 2]];
    return { hash: doom._web_state_hash() >>> 0, at: `${x >> 16},${y >> 16}` };
}

// ── state-hash, child side ───────────────────────────────────────────────────
if (process.argv.includes('--state-hash-child')) {
    const doom = await bootEngine(BUILD, [['doomu.wad', loadWad('doom.wad')]]);
    const before = doom._web_state_hash() >>> 0;
    doom.callMain(['-nodraw']);
    const title = doom._web_state_hash() >>> 0;
    console.log(`CHILD-OK before=${before} title=${title}`);
    summary('state-hash child: the parent judges the line above');
    process.exit(0);
}

// ── input-keys ───────────────────────────────────────────────────────────────
{
    const codes = [-0x10000000, -0x80000000, 0x7fffffff];
    for (let c = 1; c <= 300; c++) codes.push(-c);
    for (let c = 256; c < 600; c++) codes.push(c);
    const PER_FRAME = Math.ceil(codes.length / 50);
    const quiet = await session(() => {});
    const hostile = await session((doom, f) => {
        for (const c of codes.slice(f * PER_FRAME, (f + 1) * PER_FRAME)) {
            doom._web_input_event(0, c, 0, 0);
            doom._web_input_event(1, c, 0, 0);
        }
    });
    const walked = await session((doom, f) => {
        if (f === 10) doom._web_input_event(0, KEY_UP, 0, 0);
        if (f === 40) doom._web_input_event(1, KEY_UP, 0, 0);
    });
    check(`input-keys: ${codes.length} key codes outside 0..255, down and up, change nothing `
          + `(hash ${hostile.hash?.toString(16)} vs ${quiet.hash?.toString(16)})`,
          !hostile.error && hostile.hash === quiet.hash, hostile.error ?? quiet.error ?? 'the session diverged');
    check(`input-keys CONTROL: a legal key still moves the player (${quiet.at} -> ${walked.at})`,
          !walked.error && walked.at !== quiet.at, walked.error ?? 'the up arrow did nothing');
}

// ── state-hash ───────────────────────────────────────────────────────────────
{
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--build-dir', BUILD, '--state-hash-child'],
                        { encoding: 'utf8', timeout: 60_000 });
    const m = /CHILD-OK before=(\d+) title=(\d+)/.exec(r.stdout ?? '');
    const what = r.error?.code === 'ETIMEDOUT' ? 'HUNG (no return within 60s)'
               : m ? `before callMain ${m[1]}, at the title ${m[2]}`
               : `exit ${r.status}: ${(r.stderr ?? '').trim().split('\n').pop()}`;
    check(`state-hash: returns 0 before any level (${what})`, m && m[1] === '0' && m[2] === '0', what);
    const live = await session(() => {});
    check(`state-hash CONTROL: a running level hashes non-zero (${live.hash?.toString(16)})`,
          !live.error && live.hash !== 0, live.error ?? 'hash 0 in a level');
}

// ── argv-at ──────────────────────────────────────────────────────────────────
{
    const room = buildMap({
        vertices: [[0, 0], [0, 512], [512, 512], [512, 0]],
        sectors: [{ floor: 0, ceil: 128, floorpic: 'FLOOR4_8', ceilpic: 'CEIL3_5', light: 192 }],
        sides: [0, 1, 2, 3].map(() => ({ sector: 0, mid: 'STARTAN3' })),
        lines: [0, 1, 2, 3].map(i => ({ v1: i, v2: (i + 1) % 4, front: i })),
        things: [{ x: 256, y: 128, angle: 90, type: 1 }],
    });
    let err = null;
    const doom = await bootEngine(BUILD, [['doomu.wad', loadWad('doom.wad')],
                                          ['room.wad', pwad([['E1M1', Buffer.alloc(0)], ...room])]],
                                  { onDoomError: m => { err = m; } });
    doom.HEAPU8.fill(0xa5, 0, 8);
    let at = '';
    try {
        doom.callMain(['-file', 'room.wad', '-warp', '1', '1', '-skill', '3', '-nodraw', '@x']);
        doom._web_set_singletics(1);
        for (let f = 0; f < 5; f++) { doom._web_wipe_skip(); doom._web_frame(); }
        const p = doom._malloc(24);
        doom._web_demo_state(p);
        at = `${doom.HEAP32[p / 4 + 1] >> 16},${doom.HEAP32[p / 4 + 2] >> 16}`;
    } catch (e) {
        at = err ? `I_Error: ${err}` : `trapped: ${why(e)}`;
    }
    const zero = Array.from(doom.HEAPU8.subarray(0, 8), b => b.toString(16)).join(' ');
    check(`argv-at: -file and -warp survive an '@x' word, the player stands at the PWAD's start (${at})`,
          at === '256,128', at);
    check(`argv-at: address 0 is as painted before callMain (${zero})`, zero === 'a5 a5 a5 a5 a5 a5 a5 a5', zero);
}

summary('the web layer\'s entry points refuse hostile arguments (3 cases + controls)');
