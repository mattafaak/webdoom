#!/usr/bin/env node
// Pass B: demo seek equivalence gate (task 19.3).
//
// Proves that web_seek_demo(N) produces the same per-tic sim state as
// linear playback up to tic N — the core DoD equivalence assertion.
//
// Test design:
//   Instance A — records RECORD_TICKS of E1M1 gameplay with empty inputs.
//              — Stores the .lmp bytes and the full per-tic hash trace.
//   Instance B — linearly replays the .lmp and collects per-tic hashes.
//                This is the "ground truth" linear trace.
//   Instance C — for each seek target N ∈ TEST_SEEK_POINTS:
//                  web_play_demo_buf → web_seek_demo(N) → web_frame() ×1
//                  Records the sim hash at N and compares to B's trace.
//
// Zone-leak gate:
//   After three seeks on the same instance, web_zone_hwm() is sampled
//   before and after each seek.  The HWM must not grow on seek 2 or 3
//   (seek 1 may raise it as G_InitNew rebuilds the level from scratch;
//   subsequent seeks reuse the same level allocation, so the HWM is flat).
//
// Red-proof (intentional failure mode):
//   A fake seek that stops one tic short of the target produces a
//   diverging hash.  The test injects this, confirms FAIL, then proceeds.
//
// Latency measurement:
//   Measures seek latency for each N using performance.now() (Node.js
//   high-resolution timer).  Results are printed for docs/perf.md citation.
//
// usage: node tools/demo-seek-test.mjs [--build-dir <dir>]

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const buildDirIdx = process.argv.indexOf('--build-dir');
const buildDir = buildDirIdx >= 0 ? process.argv[buildDirIdx + 1] : 'build';

const createDoom = (await import(join(root, buildDir, 'doom.js'))).default;

const WAD_FILE   = 'doom.wad';
const WAD_ENGINE = 'doomu.wad';
const wadPath = join(root, 'wads/lib', WAD_FILE);
if (!existsSync(wadPath)) {
    console.log(`skip: ${WAD_FILE} not fetched`);
    process.exit(0);
}
const wadBytes = readFileSync(wadPath);

// Seek targets to test: tic 1, 30 (mid), 59 (near-end = RECORD_TICKS-1).
const RECORD_TICKS   = 60;
const TEST_SEEK_POINTS = [1, 30, 59];

// ── helpers ──────────────────────────────────────────────────────────────────

function registerWad(doom) {
    const p = doom._malloc(wadBytes.length);
    doom.HEAPU8.set(wadBytes, p);
    doom.ccall('web_register_file', null, ['string', 'number', 'number'],
        [WAD_ENGINE, p, wadBytes.length]);
}

function bootAndRecord(demoBytes_out) {
    // Returns per-tic hash array for RECORD_TICKS.
    // Fills demoBytes_out[0] with the recorded .lmp bytes.
    return createDoom({ print: () => {}, printErr: () => {}, onDoomError: () => {} })
        .then(doom => {
            registerWad(doom);
            doom.callMain(['-warp', '1', '1', '-skill', '1', '-nodraw', '-record', 'webdemo']);
            doom._web_set_singletics(1);
            const hashes = [];
            let lastTic = -1;
            for (let i = 0; i < RECORD_TICKS + 10 && hashes.length < RECORD_TICKS; i++) {
                doom._web_wipe_skip();
                doom._web_frame();
                const tic = doom._web_gametic();
                if (tic !== lastTic) { hashes.push(doom._web_state_hash() >>> 0); lastTic = tic; }
            }
            const cnt = doom._web_demo_stop();
            const ptr = doom._web_demo_buf_ptr();
            demoBytes_out[0] = doom.HEAPU8.slice(ptr, ptr + cnt);
            return hashes;
        });
}

function linearPlay(demoBytes) {
    // Replays .lmp linearly; returns per-tic hash array.
    return createDoom({ print: () => {}, printErr: () => {}, onDoomError: () => {} })
        .then(doom => {
            registerWad(doom);
            doom.callMain(['-warp', '1', '1', '-skill', '1', '-nodraw']);
            doom._web_set_singletics(1);
            const ptr = doom._malloc(demoBytes.length);
            doom.HEAPU8.set(demoBytes, ptr);
            doom._web_play_demo_buf(ptr);
            const hashes = [];
            let lastTic = -1;
            for (let i = 0; i < RECORD_TICKS + 10; i++) {
                if (!doom._web_demo_playing()) break;
                if (hashes.length >= RECORD_TICKS) break;
                doom._web_wipe_skip();
                doom._web_frame();
                const tic = doom._web_gametic();
                if (tic !== lastTic) { hashes.push(doom._web_state_hash() >>> 0); lastTic = tic; }
            }
            return hashes;
        });
}

// Seek to targetTic and return the hash at that point.
// fakeOff: if non-zero, artificially seek to (targetTic + fakeOff) to prove divergence.
//
// Hash collection: web_seek_demo(N) calls D_DoomFrame N times in singletics mode.
// After N calls, gametic == N.  web_state_hash() is read HERE (before the final
// rendering web_frame() that would advance gametic to N+1).  The rendering frame
// is still called for correct browser-UI semantics (renders gametic=N visually),
// but the sim-hash comparison must happen before it.
async function seekTo(demoBytes, targetTic, fakeOff = 0) {
    const doom = await createDoom({ print: () => {}, printErr: () => {}, onDoomError: () => {} });
    registerWad(doom);
    doom.callMain(['-warp', '1', '1', '-skill', '1', '-nodraw']);
    doom._web_set_singletics(1);
    const ptr = doom._malloc(demoBytes.length);
    doom.HEAPU8.set(demoBytes, ptr);
    doom._web_play_demo_buf(ptr);

    const seekTarget = targetTic + fakeOff;
    const t0 = performance.now();
    const reached = doom._web_seek_demo(seekTarget);
    const t1 = performance.now();

    // Collect hash at gametic==N BEFORE the final rendering frame.
    // web_seek_demo(N) leaves gametic==N; web_frame() below would advance to N+1.
    const hash = doom._web_state_hash() >>> 0;

    // Render one frame at the seek point (browser-UI semantics: shows gametic=N).
    doom._web_wipe_skip();
    doom._web_frame();

    return { hash, reached, ms: (t1 - t0) };
}

// Zone HWM flat test: run multiple seeks on one instance and assert HWM flat.
async function zoneHwmFlatTest(demoBytes, seekPoints) {
    const doom = await createDoom({ print: () => {}, printErr: () => {}, onDoomError: () => {} });
    registerWad(doom);
    doom.callMain(['-warp', '1', '1', '-skill', '1', '-nodraw']);
    doom._web_set_singletics(1);
    const ptr = doom._malloc(demoBytes.length);
    doom.HEAPU8.set(demoBytes, ptr);
    doom._web_play_demo_buf(ptr);

    doom._web_zone_hwm_reset();
    const hwms = [];
    for (const n of seekPoints) {
        doom._web_seek_demo(n);
        doom._web_zone_sample();
        hwms.push(doom._web_zone_hwm());
    }
    // HWM must not grow after seek 1: seeks 2 and 3 reuse level heap.
    const growing = hwms.slice(1).filter((h, i) => h > hwms[i]);
    return { hwms, growing };
}

// ── Test execution ────────────────────────────────────────────────────────────

let failures = 0;

// Step 1: Record
console.log(`Recording E1M1 demo (${RECORD_TICKS} ticks, empty inputs)…`);
const demoBytes_wrap = [null];
const recordHashes = await bootAndRecord(demoBytes_wrap);
const demoBytes = demoBytes_wrap[0];
if (recordHashes.length < RECORD_TICKS) {
    console.log(`FAIL: only recorded ${recordHashes.length} hashes`);
    process.exit(1);
}
console.log(`  recorded ${recordHashes.length} ticks, demo is ${demoBytes.length} bytes`);

// Step 2: Linear playback — ground truth
console.log('Linear playback to collect ground-truth hashes…');
const linearHashes = await linearPlay(demoBytes);
if (linearHashes.length < RECORD_TICKS) {
    console.log(`FAIL: linear replay only produced ${linearHashes.length} hashes`);
    process.exit(1);
}
console.log(`  linear: ${linearHashes.length} ticks replayed`);

// Verify linear matches recording (sanity)
for (let i = 0; i < Math.min(recordHashes.length, linearHashes.length); i++) {
    if (recordHashes[i] !== linearHashes[i]) {
        console.log(`FAIL: sanity — linear diverges from recording at tic ${i + 1}`);
        process.exit(1);
    }
}
console.log(`  linear vs recording: ${Math.min(recordHashes.length, linearHashes.length)} ticks match`);

// Step 3: Seek equivalence
console.log('\nSeek equivalence tests:');
const seekLatencies = {};

for (const N of TEST_SEEK_POINTS) {
    const { hash, reached, ms } = await seekTo(demoBytes, N);
    seekLatencies[N] = ms;
    const expected = linearHashes[N - 1]; // linearHashes is 0-indexed; tic N is index N-1
    const ok = (hash === expected);
    if (!ok) {
        console.log(`  FAIL seek-to-${N}: hash=0x${hash.toString(16).padStart(8,'0')} expected=0x${expected.toString(16).padStart(8,'0')} reached=${reached}`);
        failures++;
    } else {
        console.log(`  PASS seek-to-${N}: hash=0x${hash.toString(16).padStart(8,'0')} in ${ms.toFixed(1)} ms (reached tic ${reached})`);
    }
}

// Step 4: Red-proof — seek to N-1 must diverge from linear hash at N
console.log('\nRed-proof (seek to N-1 should diverge from hash at N):');
const RED_N = 30;
const { hash: redHash } = await seekTo(demoBytes, RED_N, -1);
const expectedAtN = linearHashes[RED_N - 1];
if (redHash !== expectedAtN) {
    console.log(`  PASS red-proof: seek-to-${RED_N - 1} hash=0x${redHash.toString(16).padStart(8,'0')} != expected-at-${RED_N}=0x${expectedAtN.toString(16).padStart(8,'0')} (correct divergence)`);
} else {
    console.log(`  FAIL red-proof: seek-to-${RED_N - 1} unexpectedly matched hash at ${RED_N} — seek might be off-by-one`);
    failures++;
}

// Step 5: Zone HWM flat test (3 seeks: 1, 30, 59)
console.log('\nZone HWM flat test (3 seeks):');
const { hwms, growing } = await zoneHwmFlatTest(demoBytes, TEST_SEEK_POINTS);
console.log(`  HWMs after seeks: ${hwms.map((h, i) => `seek-to-${TEST_SEEK_POINTS[i]}=${h}`).join(', ')}`);
if (growing.length > 0) {
    console.log(`  FAIL: zone HWM grew on seeks 2+: ${growing.join(', ')}`);
    failures++;
} else {
    console.log(`  PASS: zone HWM flat after seek 1 (${hwms[1] === hwms[0] ? 'unchanged' : `${hwms[0]}→${hwms[1]}→${hwms[2]}, stable after first`})`);
}

// Step 6: Latency summary
console.log('\nSeek latency summary (Node.js, sim-only, singletics):');
for (const [n, ms] of Object.entries(seekLatencies)) {
    const ticsPerSec = (+n / (ms / 1000));
    const realtimeFactor = Math.round(ticsPerSec / 35);
    console.log(`  seek-to-${n}: ${ms.toFixed(1)} ms  (~${realtimeFactor}× realtime)`);
}
// Extrapolate worst-case for 44580 tics (DOOM2 demo3 length)
const longSeekN = 59;
const longSeekMs = seekLatencies[longSeekN];
if (longSeekMs) {
    const msPerTic = longSeekMs / longSeekN;
    const worstCaseMs = msPerTic * 44580;
    console.log(`  extrapolated 44580-tic seek: ${(worstCaseMs / 1000).toFixed(1)} s (at ${msPerTic.toFixed(3)} ms/tic)`);
    console.log(`  (wbox will be slower; see docs/perf.md §seek-latency for measured figures)`);
}

// ── Result ────────────────────────────────────────────────────────────────────
if (failures > 0) {
    console.log(`\nFAIL: ${failures} test(s) failed`);
    process.exit(1);
} else {
    console.log(`\nPASS: seek equivalence confirmed — web_seek_demo(N) matches linear hash at N`);
    process.exit(0);
}
