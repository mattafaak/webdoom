#!/usr/bin/env node
// Shared demo links and the scrubber replay through web_play_demo_buf, never
// -timedemo, so the sim goldens (recorded with -timedemo) say nothing about
// them.  This drives web_play_demo_buf and web_seek_demo the way
// client/js/demo.js and main.js do, in singletics, and requires:
//
//   1. each of the 13 IWAD demos replays tic-identical to its golden, reaches
//      its end marker without an engine error, and the engine keeps running;
//   2. after watching to tic 300, seeking back to tic 100 lands on the state
//      linear replay had at tic 100 -- before and after the end marker;
//   3. a demo recorded with -fast survives repeated seeks (run in a child
//      process, so a hang is a failure rather than a stuck suite);
//   4. a two-player demo replays as vanilla replays it (-timedemo of the
//      same bytes from a PWAD), which needs netgame set for a net demo.
//
// usage: node tools/demo-replay-test.mjs [--build-dir DIR]
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootEngine, loadWad } from './lib/engine.mjs';
import { readGolden } from './lib/golden.mjs';
import { root, buildDirArg } from './lib/util.mjs';
import { check, summary, fatal } from './lib/report.mjs';

const BUILD = buildDirArg();
const IWADS = [
    ['doom.wad', 'doomu.wad', ['DEMO1', 'DEMO2', 'DEMO3', 'DEMO4']],
    ['doom2.wad', 'doom2.wad', ['DEMO1', 'DEMO2', 'DEMO3']],
    ['tnt.wad', 'tnt.wad', ['DEMO1', 'DEMO2', 'DEMO3']],
    ['plutonia.wad', 'plutonia.wad', ['DEMO1', 'DEMO2', 'DEMO3']],
];

function lump(wad, name) {
    const n = wad.readUInt32LE(4), dir = wad.readUInt32LE(8);
    for (let i = 0; i < n; i++) {
        const e = dir + 16 * i;
        if (wad.toString('latin1', e + 8, e + 16).replace(/\0.*$/, '') === name)
            return wad.subarray(wad.readUInt32LE(e), wad.readUInt32LE(e) + wad.readUInt32LE(e + 4));
    }
    return null;
}

function pwad(name, data) {
    const head = Buffer.alloc(12), dir = Buffer.alloc(16);
    head.write('PWAD', 0, 'latin1'); head.writeUInt32LE(1, 4); head.writeUInt32LE(12 + data.length, 8);
    dir.writeUInt32LE(12, 0); dir.writeUInt32LE(data.length, 4); dir.write(name, 8, 'latin1');
    return Buffer.concat([head, Buffer.from(data), dir]);
}

// Boot, then start the replay before any frame has run, as startReplay does
// on a fresh instance.  Returns null if the engine refused the demo.
async function replay(files, bytes) {
    const state = { error: null };
    const doom = await bootEngine(BUILD, files, { onDoomError: m => { state.error = m; } });
    doom.callMain(['-nodraw']);
    doom._web_set_singletics(1);
    const p = doom._malloc(bytes.length);
    doom.HEAPU8.set(bytes, p);
    const rc = doom._web_play_demo_buf(p, bytes.length);
    doom._free(p);
    if (rc !== 0) return null;
    const hash = () => doom._web_state_hash() >>> 0;
    // The melt wipe is paced by wall time and holds the sim, so it is skipped
    // (it is cosmetic); the renderer still runs every frame.  An engine error
    // throws out of the frame after onDoomError.
    const frame = () => {
        try { doom._web_wipe_skip(); doom._web_frame(); } catch (e) { state.error ??= String(e.message ?? e); }
    };
    const step = () => {
        const t = doom._web_gametic();
        for (let i = 0; i < 5 && doom._web_gametic() === t && !state.error; i++) frame();
        return hash();
    };
    return { doom, state, hash, step, frame };
}

// ── the -fast child: seek twice into a -fast demo; a hang is the failure ────
if (process.argv.includes('--fast-child')) {
    const wad = loadWad('doom.wad');
    const demo = Buffer.from(lump(wad, 'DEMO1'));
    demo[6] = 1;                                   // header byte 6: fast monsters
    const r = await replay([['doomu.wad', wad]], demo);
    const linear = [];
    for (let i = 0; i < 400 && r.doom._web_demo_playing(); i++) linear.push(r.step());
    const sought = [];
    for (let k = 0; k < 3; k++) { r.doom._web_seek_demo(300); sought.push(r.hash()); }
    // linear[299] is the state after 300 tics; so is a seek to 300
    console.log(JSON.stringify({ error: r.state.error, linear: linear[299], sought }));
    process.exit(0);
}

for (const [file] of IWADS)
    if (!existsSync(join(root, 'wads/lib', file))) fatal(`wads/lib/${file} absent (tools/fetch-wads.sh)`);

// 1. the 13 IWAD demos against their goldens, through to the marker and past it
let demos = 0, tics = 0;
for (const [file, engineName, names] of IWADS) {
    const wad = loadWad(file);
    for (const name of names) {
        const label = `${file.replace('.wad', '')}-${name.toLowerCase()}`;
        const golden = readGolden(join(root, `tools/golden/${label}.json`));
        const r = await replay([[engineName, wad]], lump(wad, name));
        if (!check(`${label}: web_play_demo_buf accepts the IWAD's own demo`, r)) continue;
        const trace = [];
        while (r.doom._web_demo_playing() && !r.state.error && trace.length < golden.tics + 10) trace.push(r.step());
        let diverged = -1;
        for (let i = 0; i < golden.trace.length; i++) if (trace[i] !== golden.trace[i]) { diverged = i; break; }
        check(`${label}: ${golden.trace.length} tics identical to the golden`, diverged < 0,
              diverged < 0 ? '' : `first difference at tic ${diverged}`);
        for (let i = 0; i < 70 && !r.state.error; i++) r.frame();
        check(`${label}: the end marker and 70 frames after it raise no engine error`, !r.state.error, r.state.error);
        demos++; tics += golden.trace.length;
    }
}

// 2. the scrubber: watch, then seek back -- before and after the end marker
{
    const wad = loadWad('doom2.wad');
    const demo = lump(wad, 'DEMO1');
    const r = await replay([['doom2.wad', wad]], demo);
    const linear = [];
    while (linear.length < 300) linear.push(r.step());
    r.doom._web_seek_demo(100);
    check('seek back from tic 300 to tic 100 lands on the linear state at 100', r.hash() === linear[99],
          `${r.hash().toString(16)} vs ${linear[99].toString(16)}`);
    while (r.doom._web_demo_playing() && !r.state.error) r.step();
    for (let i = 0; i < 200 && !r.state.error; i++) r.frame();   // the attract loop runs on
    let rc;
    try { rc = r.doom._web_seek_demo(100); } catch (e) { r.state.error ??= String(e.message ?? e); }
    check('seek after the end marker replays from the start again', rc === 100 && r.hash() === linear[99] && !r.state.error,
          `rc ${rc}, ${r.hash().toString(16)} vs ${linear[99].toString(16)}, error ${r.state.error}`);
}

// 3. -fast: seeking re-runs G_InitNew, which must not halve the tables again
{
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--fast-child', '--build-dir', BUILD],
                            { encoding: 'utf8', timeout: 60_000 });
    let out = null;
    try { out = JSON.parse(child.stdout.split('\n').find(l => l.startsWith('{'))); } catch { /* reported below */ }
    check('a -fast demo survives three seeks', out && !out.error,
          child.error ? `no result in 60 s (${child.error.code})` : (out?.error ?? child.stderr.slice(-200)));
    if (out) check('every seek of the -fast demo lands on the linear state', out.sought.every(h => h === out.linear),
                   `${out.sought.map(h => h.toString(16))} vs ${out.linear?.toString(16)}`);
}

// 4. a two-player demo: web_play_demo_buf against -timedemo of the same bytes
{
    const T = 200;
    const head = [109, 2, 1, 1, 0, 0, 0, 0, 0, 1, 1, 0, 0];
    const body = [];
    for (let t = 0; t < T; t++) body.push(25, 0, t < 100 ? 0 : 4, 0,  20, 0, 0xfc, t % 35 === 0 ? 1 : 0);
    const demo = Uint8Array.from([...head, ...body, 0x80]);
    const wad = loadWad('doom.wad');
    const r = await replay([['doomu.wad', wad]], demo);
    const viaBuf = [];
    for (let t = 0; t < T; t++) viaBuf.push(r.step());

    const state = { error: null };
    const v = await bootEngine(BUILD, [['doomu.wad', wad], ['twop.wad', pwad('DEMO1', demo)]],
                               { onDoomError: m => { state.error = m; } });
    const viaTimedemo = [];
    try {
        v.callMain(['-file', 'twop.wad', '-timedemo', 'demo1', '-nodraw']);
        let last = -1;
        for (let i = 0; i < T * 2 && viaTimedemo.length < T && !state.error; i++) {
            v._web_frame();
            if (v._web_gametic() !== last) { last = v._web_gametic(); viaTimedemo.push(v._web_state_hash() >>> 0); }
        }
    } catch { /* -timedemo ends in I_Error; state.error holds it */ }
    const same = viaBuf.filter((h, i) => h === viaTimedemo[i]).length;
    check(`a two-player demo replays as vanilla does (${same} of ${T} tics identical)`, same === T && viaTimedemo.length === T);
}

if (demos !== 13) fatal(`replayed ${demos} of 13 IWAD demos`);
summary(`replay through web_play_demo_buf: 13 IWAD demos (${tics} tics) identical to the goldens and past their markers; seek, -fast and two-player demos as vanilla`);
