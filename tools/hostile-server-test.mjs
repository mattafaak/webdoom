#!/usr/bin/env node
// tools/hostile-server-test.mjs — the direction nobody fuzzed (task 23.8).
//
// Every existing fuzz gate points one way: hostile CLIENT into the server
// (net-fuzz-test, http-fuzz-test, demo-store-fuzz-test).  The other direction
// was untested and unguarded, and spec.md's primary deployment is plain HTTP on
// a LAN or tailnet -- so anything that can answer ws://host:8666 is inside the
// trust boundary this checks.
//
// It drives the engine's network entry points directly with values a hostile or
// buggy server could put on the wire, and asserts two things per case:
//   1. no write lands below the base of the tic-indexed arrays, and
//   2. the engine survives and keeps simulating.
//
// The out-of-bounds test is BY OBSERVATION, not by inference: it snapshots the
// heap, makes one call at tic 0 (the lowest legal slot) to find the floor, then
// makes the hostile call and checks nothing was written beneath it.
//
// RED-PROOF: remove the `tic < 0` guard in engine/web/d_net.c, rebuild, and the
// tic cases fail naming the bytes written below slot 0.
//
// usage: node tools/hostile-server-test.mjs [--build-dir DIR]
// Copyright (C) 2026, GPL-2.0-or-later.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { attachRelay, attachSpectate } from '../client/js/net.js';
import { root } from './lib/util.mjs';

const bdIdx = process.argv.indexOf('--build-dir');
const buildDir = bdIdx >= 0 ? process.argv[bdIdx + 1] : 'build';
for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--build-dir') { i++; continue; }
    console.error(`FAIL: unrecognised argument '${process.argv[i]}'`);
    process.exit(2);
}

const wadPath = join(root, 'wads/lib/doom.wad');
const doomJs  = join(root, buildDir, 'doom.js');
if (!existsSync(doomJs))  { console.log(`FAIL hostile-server: ${buildDir}/doom.js absent - verified nothing`); process.exit(1); }
if (!existsSync(wadPath)) { console.log('FAIL hostile-server: doom.wad not fetched - verified nothing'); process.exit(1); }

const createDoom = (await import(doomJs)).default;
const wad = readFileSync(wadPath);
const doom = await createDoom({ noInitialRun: true, print() {}, printErr() {} });
const wadPtr = doom._malloc(wad.length);
doom.HEAPU8.set(wad, wadPtr);
doom.ccall('web_register_file', 'null', ['string', 'number', 'number'], ['doom.wad', wadPtr, wad.length]);
doom.callMain(['-iwad', 'doom.wad', '-nodraw']);

const NP = 4;
doom._web_net_setup(0, NP, 0xf);
const cmds = doom._malloc(NP * 16);
const ingame = doom._malloc(NP);
for (let i = 0; i < NP; i++) doom.HEAPU8[ingame + i] = 1;
doom.HEAPU8.fill(0xAB, cmds, cmds + NP * 16);

// Find the floor once with a full-heap comparison, then narrow.  Snapshotting
// all 32 MB for every case made this take minutes; the question is only ever
// "did anything get written BELOW the floor", so after this the window is
// [0, FLOOR) and each case costs ~0.5 MB instead of 64.
const full  = () => Uint8Array.prototype.slice.call(doom.HEAPU8);
const wrote = (a, b, n = a.length) => { const o = []; for (let i = 0; i < n; i++) if (a[i] !== b[i]) o.push(i); return o; };

const beforeFloor = full();
doom._web_net_bundle(0, cmds, ingame, 0);
const floorWrites = wrote(beforeFloor, full());
if (!floorWrites.length) {
    console.log('FAIL hostile-server: the tic=0 reference call wrote nothing - the probe is broken,');
    console.log('  which is not a pass (it would make every hostile case look clean).');
    process.exit(1);
}
const FLOOR = Math.min(...floorWrites);
// Everything below the base of the tic-indexed arrays, and nothing else.
const below = () => Uint8Array.prototype.slice.call(doom.HEAPU8, 0, FLOOR);

let passes = 0, failures = 0;
const ok = (name, good, detail = '') => {
    console.log(`  ${good ? 'ok  ' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`);
    good ? passes++ : failures++;
};

function noWriteBelowFloor(name, fn) {
    const before = below();
    let threw = null;
    try { fn(); } catch (e) { threw = e; }
    const hits = wrote(before, below());
    if (threw) { ok(name, false, `threw: ${String(threw).slice(0, 80)}`); return; }
    ok(name, hits.length === 0,
       hits.length ? `${hits.length} byte(s) written below slot 0, ${FLOOR - Math.min(...hits)} bytes under the base`
                   : 'no write below slot 0');
}

console.log('\n-- hostile tic values (u32 on the wire, signed int in C) ------------');
for (const [label, tic] of [
    ['tic 0xFFFFFFFF (-1)',        0xFFFFFFFF],
    ['tic 0x80000000 (INT_MIN)',   0x80000000],
    ['tic 0xFFFFFFE0 (-32)',       0xFFFFFFE0],
    ['tic 0x7FFFFFFF (INT_MAX)',   0x7FFFFFFF],
    ['tic 0x80000022',             0x80000022],
]) noWriteBelowFloor(label, () => doom._web_net_bundle(tic, cmds, ingame, 0));

console.log('\n-- hostile roster from a welcome/launch -----------------------------');
for (const [label, slot, np] of [
    ['web_net_setup slot 99',      99, NP],
    ['web_net_setup slot -1',      -1, NP],
    ['web_net_setup numplayers 9',  0, 9],
    ['web_net_setup numplayers 0',  0, 0],
    ['web_net_setup numplayers -3', 0, -3],
]) noWriteBelowFloor(label, () => doom._web_net_setup(slot, np, 0xf));

console.log('\n-- hostile console player -------------------------------------------');
for (const [label, p] of [['web_set_console 99', 99], ['web_set_console -1', -1]])
    noWriteBelowFloor(label, () => doom._web_set_console(p));

// -- a hostile launch through the SHIPPED client path --------------------------
//
// Everything above calls the C exports DIRECTLY, which proves the engine's own
// guards and proves nothing about the layer a hostile server actually reaches
// first.  It reaches client/js/net.js, and net.js sizes two fixed allocations
// on `numplayers` straight off the wire: an 8-byte _malloc for the per-tic
// ingame ring and the engine's `static ticcmd_t scratch[MAXPLAYERS]` (32 B).
// web_net_setup's rejection does not help -- it runs first and only bounds the
// C-side write loop, so the JS loop had already written by then.
//
// So this drives the exported attach functions with a stub socket, which is the
// same code path the browser runs.  RED-PROOF: remove the checkNetShape() calls
// from net.js and every case below reports "accepted".
class StubWS {
    constructor(url) { this.url = url; this.readyState = 0; this.binaryType = ''; }
    send() {}
    close() { this.readyState = 3; }
}
function mustRefuse(name, fn) {
    let threw = null;
    try { fn(); } catch (e) { threw = e; }
    ok(name, !!threw, threw ? `refused: ${String(threw.message ?? threw).slice(0, 72)}` : 'ACCEPTED');
}

console.log('\n-- a hostile launch through client/js/net.js --------------------------');
for (const [label, np, slots] of [
    ['relay numplayers 1000',      1000, [0]],
    ['relay numplayers 9',            9, null],
    ['relay numplayers 0',            0, null],
    ['relay numplayers -3',          -3, null],
    ['relay numplayers 2.5',        2.5, null],
    ['relay numplayers "4" (string)', '4', null],
    ['relay numplayers null',      null, null],
    ['relay numplayers 2**31',    2 ** 31, null],
    ['relay slots [99]',              4, [99]],
    ['relay slots [-1]',              4, [-1]],
    ['relay slots [0,1,2,1e6]',       4, [0, 1, 2, 1e6]],
    ['relay slots not an array',      4, { 0: 0 }],
]) mustRefuse(label, () => attachRelay(
    doom, 'ws://127.0.0.1:1', { slot: 0, numplayers: np, slots }, StubWS));

for (const [label, np, slots] of [
    ['spectate numplayers 1000', 1000, [0]],
    ['spectate slots [1e6]',        4, [1e6]],
]) mustRefuse(label, () => attachSpectate(
    doom, 'ws://127.0.0.1:1', { numplayers: np, slots }, StubWS));

// Anti-vacuity: a guard that refuses everything would pass every case above.
{
    let threw = null;
    try { attachRelay(doom, 'ws://127.0.0.1:1', { slot: 0, numplayers: 4, slots: [0, 1, 2, 3] }, StubWS); }
    catch (e) { threw = e; }
    ok('a legitimate 4-player launch is still accepted', !threw,
       threw ? `WRONGLY refused: ${String(threw.message ?? threw).slice(0, 72)}` : 'accepted');
}

// A guard that returns early is only correct if the NORMAL path still works.
// (Running frames here would block: web_net_setup made this a netgame and
// TryRunTics waits for tics, which hung the first version of this test.)
console.log('\n-- the legitimate path still works ------------------------------------');
doom._web_net_setup(0, NP, 0xf);
const beforeGood = full();
doom._web_net_bundle(7, cmds, ingame, 0);
const goodWrites = wrote(beforeGood, full());
ok('a valid bundle still lands in the tic ring', goodWrites.length > 0 && Math.min(...goodWrites) >= FLOOR,
   goodWrites.length ? `wrote ${goodWrites.length} bytes at or above slot 0` : 'wrote nothing');

const EXPECTED = 28;   // 5 tic + 5 roster + 2 console + 14 hostile-launch + 1 anti-vacuity + 1 liveness
console.log(`\n  ${passes} passed, ${failures} failed`);
if (failures) { console.log(`FAIL hostile-server-test: ${failures} case(s) let a hostile value through`); process.exit(1); }
if (passes < EXPECTED) {
    console.log(`FAIL hostile-server-test: only ${passes} of ${EXPECTED} cases ran - not a pass`);
    process.exit(1);
}
console.log(`PASS - hostile-server-test: ${passes} cases, no write below slot 0, engine still simulating`);
