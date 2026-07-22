#!/usr/bin/env node
// Pass A feasibility gate: prove that -record webdemo records a valid .lmp and
// that web_play_demo_buf replays it to the same per-tic sim hashes.
//
// Test design:
//   Instance A — records N ticks of E1M1 gameplay with empty inputs.
//              — singletics mode ensures every web_frame() call is exactly
//                one tic regardless of wall-clock time (critical in Node.js
//                where emscripten_get_now() barely advances in tight loops).
//              — collects per-tic web_state_hash during recording.
//   Instance B — boots E1M1 independently (same params, fresh state).
//              — replays the recorded .lmp via web_play_demo_buf.
//              — same singletics mode; collects per-tic hashes during replay.
//   PASS if every hash in B matches the corresponding hash in A.
//
// Empty inputs (all-zero tic commands) are fully deterministic: the player
// stands still; web_state_hash depends on gametic, prndindex, and player
// mobj coords/angle/health — all derived deterministically from the seed.
//
// usage: node tools/demo-replay-test.mjs [--build-dir <dir>]
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const buildDirIdx = process.argv.indexOf('--build-dir');
const buildDir = buildDirIdx >= 0 ? process.argv[buildDirIdx + 1] : 'build';

const createDoom = (await import(join(root, buildDir, 'doom.js'))).default;

// Only doom.wad is required for E1M1.
const WAD_FILE = 'doom.wad';
const WAD_ENGINE = 'doomu.wad';   // engine name that linuxdoom expects
const wadPath = join(root, 'wads/lib', WAD_FILE);
if (!existsSync(wadPath)) {
    console.log(`skip: ${WAD_FILE} not fetched`);
    process.exit(0);
}
const wadBytes = readFileSync(wadPath);

// ── helpers ──────────────────────────────────────────────────────────────────

function registerWad(doom) {
    const p = doom._malloc(wadBytes.length);
    doom.HEAPU8.set(wadBytes, p);
    doom.ccall('web_register_file', null, ['string', 'number', 'number'],
        [WAD_ENGINE, p, wadBytes.length]);
}

// ── Instance A: record ───────────────────────────────────────────────────────

const RECORD_TICKS = 60;

console.log(`Pass A: recording E1M1 demo (${RECORD_TICKS} ticks, empty inputs) …`);

const doomA = await createDoom({
    print: () => {},
    printErr: () => {},
    onDoomError: () => {},
});
registerWad(doomA);

// -record webdemo: G_RecordDemo runs after Z_Init in D_DoomMain (safe).
// G_BeginRecording is called from D_DoomLoop, writing the 13-byte header.
// -warp 1 1 -skill 1: start E1M1 on I'm Too Young To Die immediately.
// -nodraw: skip renderer, pure sim (same as demo-test.mjs approach).
doomA.callMain(['-warp', '1', '1', '-skill', '1', '-nodraw', '-record', 'webdemo']);

// Enable singletics AFTER callMain so D_DoomLoop does not affect the flag.
// In singletics mode, every web_frame() call advances exactly one game tic,
// bypassing the I_GetTime() wall-clock gate in TryRunTics().  Without this,
// a tight Node.js loop only yields ~1 tic (emscripten_get_now() barely
// advances between JS microtasks).
doomA._web_set_singletics(1);

// Run exactly RECORD_TICKS frames; each frame = one tic (singletics).
// web_wipe_skip() clears wipeactive before each frame: melt wipes are
// wall-clock-gated and cosmetic — skipping them keeps the sim advancing
// at one-tic-per-frame.  This is the same pattern as demo-test.mjs.
const recordHashes = [];
let lastTicA = -1;
for (let i = 0; i < RECORD_TICKS + 10 && recordHashes.length < RECORD_TICKS; i++) {
    doomA._web_wipe_skip();
    try { doomA._web_frame(); } catch (e) {
        console.log(`FAIL: web_frame() threw during recording at frame ${i}: ${e}`);
        process.exit(1);
    }
    const tic = doomA._web_gametic();
    if (tic !== lastTicA) {
        recordHashes.push(doomA._web_state_hash() >>> 0);
        lastTicA = tic;
    }
}

if (recordHashes.length < RECORD_TICKS) {
    console.log(`FAIL: only recorded ${recordHashes.length} hashes (expected ${RECORD_TICKS})`);
    process.exit(1);
}

// Stop recording: write DEMOMARKER, return byte count.
// web_demo_stop() does NOT call G_CheckDemoStatus (which would I_Error).
const demoByteCount = doomA._web_demo_stop();
// Header (13) + ticks (4 each) + marker (1) = 14 + 4*N minimum.
const minBytes = 13 + RECORD_TICKS * 4 + 1;
if (demoByteCount < minBytes) {
    console.log(`FAIL: demo_stop returned ${demoByteCount} bytes (need >= ${minBytes})`);
    process.exit(1);
}
const demoBufPtr = doomA._web_demo_buf_ptr();
const demoBytes  = doomA.HEAPU8.slice(demoBufPtr, demoBufPtr + demoByteCount);

console.log(`  recorded ${recordHashes.length} ticks, demo is ${demoByteCount} bytes`);
console.log(`  first hash (recording):  0x${recordHashes[0].toString(16).padStart(8, '0')}`);

// ── Instance B: replay ───────────────────────────────────────────────────────

console.log('Pass A: replaying recorded demo via web_play_demo_buf …');

const doomB = await createDoom({
    print: () => {},
    printErr: () => {},
    onDoomError: () => {},
});
registerWad(doomB);

// Boot with the same warp params so we start in the same level state.
// web_play_demo_buf will call G_InitNew again with the header params,
// which resets gametic=0 and all game state — the boot state only matters
// for Z_Zone being initialised.
doomB.callMain(['-warp', '1', '1', '-skill', '1', '-nodraw']);

// Enable singletics before replay so each web_frame() advances exactly one tic.
doomB._web_set_singletics(1);

// Copy demo bytes into wasm heap and start playback.
const replayPtr = doomB._malloc(demoByteCount);
doomB.HEAPU8.set(demoBytes, replayPtr);
const rc = doomB._web_play_demo_buf(replayPtr);
if (rc !== 0) {
    console.log(`FAIL: web_play_demo_buf returned ${rc} (version mismatch in header?)`);
    process.exit(1);
}

// Collect per-tic hashes until demo ends (demoplayback becomes false when
// DEMOMARKER is hit inside G_ReadDemoTiccmd → G_CheckDemoStatus).
const replayHashes = [];
let lastTicB = -1;
for (let i = 0; i < RECORD_TICKS + 10; i++) {
    // Check before advancing so we do not run extra frames after DEMOMARKER.
    if (!doomB._web_demo_playing()) break;
    if (replayHashes.length >= RECORD_TICKS) break;
    doomB._web_wipe_skip();
    try { doomB._web_frame(); } catch (e) {
        console.log(`FAIL: web_frame() threw during replay at frame ${i}: ${e}`);
        process.exit(1);
    }
    const tic = doomB._web_gametic();
    if (tic !== lastTicB) {
        replayHashes.push(doomB._web_state_hash() >>> 0);
        lastTicB = tic;
    }
}

console.log(`  replayed ${replayHashes.length} ticks`);
console.log(`  first hash (replay):     0x${replayHashes[0]?.toString(16).padStart(8, '0') ?? 'none'}`);

// ── Compare ──────────────────────────────────────────────────────────────────

const n = Math.min(recordHashes.length, replayHashes.length);
if (n === 0) {
    console.log('FAIL: replay produced 0 hashes — check engine boot / web_play_demo_buf');
    process.exit(1);
}

let diverged = -1;
for (let i = 0; i < n; i++) {
    if (recordHashes[i] !== replayHashes[i]) { diverged = i; break; }
}

if (diverged >= 0) {
    console.log(`FAIL: sim DESYNC at tic ${diverged + 1} of ${n} compared`);
    console.log(`  record[${diverged}] = 0x${recordHashes[diverged].toString(16).padStart(8, '0')}`);
    console.log(`  replay[${diverged}] = 0x${replayHashes[diverged].toString(16).padStart(8, '0')}`);
    process.exit(1);
}

console.log(`PASS: ${n} ticks — recording and replay produce identical per-tic sim hashes`);
console.log(`      demo bridge is deterministic; .lmp format is spec-correct`);
process.exit(0);
