#!/usr/bin/env node
// Gate: demo verification + divergence tool (task 19.4).
//
// Three sub-gates (all must pass):
//
//   A. 13 golden demos — each WAD demo lump is extracted and verified against
//      the existing sim golden trace via demo-verify.mjs's --all mode.
//
//   B. Doctored demo red-proof — take doom-demo1's lmp bytes, flip one tic's
//      input byte, run verify, assert that the FIRST divergent tic is reported
//      exactly at the modified tic position.
//
//   C. Hostile corpus — feed adversarial LMP payloads directly to the verify
//      logic; all must be rejected gracefully (no crash, appropriate error).
//
// usage: node tools/demo-verify-test.mjs [--build-dir <dir>]

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const buildDirIdx = process.argv.indexOf('--build-dir');
const buildDir = buildDirIdx >= 0 ? process.argv[buildDirIdx + 1] : 'build';

const goldenDir = join(root, 'tools/golden');
const wadDir    = join(root, 'wads/lib');

let passes   = 0;
let failures = 0;

function ok(label, cond) {
    if (cond) { passes++;   console.log(`  PASS  ${label}`); }
    else       { failures++; console.log(`  FAIL  ${label}`); }
}

// ── WAD lump extractor (mirrors demo-verify.mjs) ─────────────────────────────

function extractWadLump(wadBytes, lumpName) {
    const view = new DataView(wadBytes.buffer, wadBytes.byteOffset, wadBytes.byteLength);
    const magic = String.fromCharCode(...wadBytes.slice(0, 4));
    if (magic !== 'IWAD' && magic !== 'PWAD') return null;
    const numlumps  = view.getUint32(4, true);
    const dirOffset = view.getUint32(8, true);
    const target = lumpName.toUpperCase().padEnd(8, '\0');
    for (let i = 0; i < numlumps; i++) {
        const entry = dirOffset + i * 16;
        const name  = String.fromCharCode(...wadBytes.slice(entry + 8, entry + 16))
            .replace(/\0.*$/, '').padEnd(8, '\0');
        if (name === target) {
            const filepos = view.getUint32(entry, true);
            const size    = view.getUint32(entry + 4, true);
            return wadBytes.slice(filepos, filepos + size);
        }
    }
    return null;
}

// ── Engine loader ─────────────────────────────────────────────────────────────

const doomJsPath = join(root, buildDir, 'doom.js');
if (!existsSync(doomJsPath)) {
    console.log(`skip: engine not built (${buildDir}/doom.js absent)`);
    process.exit(0);
}
const createDoom = (await import(doomJsPath)).default;

// ── Core verify function (inlined from demo-verify.mjs for direct testing) ───
//
// Returns {ok, ...} same shape as demo-verify.mjs verifyDemo().

const REPLAY_TIC_CAP = 200_000;

async function verifyDemoBytes(lmpBytes, wadPath, golden) {
    if (!existsSync(wadPath))
        return { ok: false, error: `WAD not found: ${wadPath}` };
    const wadBytes = readFileSync(wadPath);

    const doom = await createDoom({ print: () => {}, printErr: () => {}, onDoomError: () => {} });

    // Register WAD under the engine-expected name (doomu.wad for doom.wad,
    // same name for doom2/tnt/plutonia).  Only ONE registration — double-loading
    // a 12 MB WAD exceeds the WASM heap budget.
    const wadBase    = wadPath.split('/').pop();
    const engineName = wadBase === 'doom.wad' ? 'doomu.wad' : wadBase;
    {
        const p = doom._malloc(wadBytes.length);
        doom.HEAPU8.set(wadBytes, p);
        doom.ccall('web_register_file', null, ['string', 'number', 'number'],
            [engineName, p, wadBytes.length]);
    }

    // Boot with -warp 1 1 so the engine initialises a level (required for
    // Z_Zone and level data structures before web_play_demo_buf is called).
    // web_play_demo_buf will call G_InitNew again from the demo header,
    // resetting to the correct level — the boot level doesn't matter.
    // (-warp 1 1 works for both doom.wad and doom2/tnt/plutonia formats.)
    doom.callMain(['-warp', '1', '1', '-skill', '1', '-nodraw']);
    doom._web_set_singletics(1);

    const lmpPtr = doom._malloc(lmpBytes.length);
    doom.HEAPU8.set(lmpBytes, lmpPtr);
    const rc = doom._web_play_demo_buf(lmpPtr);
    if (rc !== 0)
        return { ok: false, error: `web_play_demo_buf returned ${rc}` };

    // Carousel guard + nodraw — mirrors demo-verify.mjs (see comment there).
    const myBuf = doom._web_demo_buf_ptr();
    doom._web_set_nodraw(1);

    const trace  = [];
    let lastTic  = -1;
    let cappedOut = false;
    for (let i = 0; i < REPLAY_TIC_CAP + 10 && doom._web_demo_playing(); i++) {
        if (doom._web_demo_buf_ptr() !== myBuf) break;  // carousel took over — demo ended
        if (trace.length >= REPLAY_TIC_CAP) { cappedOut = true; break; }
        doom._web_wipe_skip();
        try { doom._web_frame(); } catch (_) { break; }
        const tic = doom._web_gametic();
        if (tic !== lastTic) {
            trace.push(doom._web_state_hash() >>> 0);
            lastTic = tic;
        }
    }
    if (cappedOut) return { ok: false, error: `exceeded tic cap ${REPLAY_TIC_CAP}` };

    const n = Math.min(trace.length, golden.trace.length);
    if (n === 0) return { ok: false, error: 'replay produced 0 ticks' };

    for (let i = 0; i < n; i++) {
        if (trace[i] !== golden.trace[i]) {
            const ctx = [];
            for (let j = Math.max(0, i - 2); j < Math.min(n, i + 3); j++)
                ctx.push({ tic: j, expected: golden.trace[j], actual: trace[j] });
            return { ok: false, firstDivergentTic: i,
                expected: '0x' + golden.trace[i].toString(16).padStart(8, '0'),
                actual:   '0x' + trace[i].toString(16).padStart(8, '0'),
                context: ctx };
        }
    }
    if (golden.tics !== undefined && trace.length !== golden.tics)
        return { ok: false, error: `tic count mismatch: ${trace.length} vs golden ${golden.tics}` };
    return { ok: true, tics: trace.length };
}

// ── Gate A: 13 golden demos ───────────────────────────────────────────────────

console.log('\n── demo-verify-test: Gate A — 13 golden demo verifications ────────────');

const MATRIX = [
    ['doom.wad',     'doomu.wad', ['demo1', 'demo2', 'demo3', 'demo4']],
    ['doom2.wad',    'doom2.wad', ['demo1', 'demo2', 'demo3']],
    ['tnt.wad',      'tnt.wad',   ['demo1', 'demo2', 'demo3']],
    ['plutonia.wad', 'plutonia.wad', ['demo1', 'demo2', 'demo3']],
];

let goldenVerified = 0;
let goldenTotal    = 0;

for (const [wad, , demos] of MATRIX) {
    const wadPath = join(wadDir, wad);
    if (!existsSync(wadPath)) { console.log(`  skip ${wad}: not fetched`); continue; }
    const wadBytes = readFileSync(wadPath);

    for (const demo of demos) {
        goldenTotal++;
        const name = `${wad.replace('.wad', '')}-${demo}`;
        const goldenPath = join(goldenDir, `${name}.json`);
        if (!existsSync(goldenPath)) {
            ok(`${name}: golden exists`, false);
            continue;
        }
        const golden = JSON.parse(readFileSync(goldenPath, 'utf8'));

        const lmpBytes = extractWadLump(wadBytes, demo.toUpperCase());
        if (!lmpBytes) {
            ok(`${name}: lump extracted`, false);
            continue;
        }

        const result = await verifyDemoBytes(lmpBytes, wadPath, golden);
        if (result.ok) {
            ok(`${name}: VERIFIED (${result.tics} ticks)`, true);
            goldenVerified++;
        } else if (result.error) {
            ok(`${name}: ${result.error}`, false);
        } else {
            ok(`${name}: DIVERGED at tic ${result.firstDivergentTic}`, false);
            console.log(`        expected ${result.expected} got ${result.actual}`);
        }
    }
}

console.log(`\n  Gate A: ${goldenVerified}/${goldenTotal} golden demos verified`);

// ── Gate B: Doctored demo red-proof ──────────────────────────────────────────
//
// Modify tic 50 in doom-demo1 by flipping its forward-move byte.
// The sim must diverge starting at exactly tic 50 (0-indexed), and the
// first divergent tic must be reported as 50 (not earlier, not later).
//
// Note: modifying a tic byte changes player input at that tic, so the sim
// diverges from that tic onward.  The golden hash at tic 50 will differ.

console.log('\n── demo-verify-test: Gate B — doctored demo divergence ─────────────────');

const doomWadPath = join(wadDir, 'doom.wad');
if (!existsSync(doomWadPath)) {
    console.log('  skip Gate B: doom.wad not fetched');
} else {
    const doomWadBytes = readFileSync(doomWadPath);
    const demo1Lump    = extractWadLump(doomWadBytes, 'DEMO1');

    if (!demo1Lump) {
        ok('Gate B: DEMO1 lump extracted', false);
    } else {
        const goldenPath = join(goldenDir, 'doom-demo1.json');
        const golden     = JSON.parse(readFileSync(goldenPath, 'utf8'));

        // The demo header is 13 bytes.  Each tic is 4 bytes.
        // Tic 50 starts at offset 13 + 50*4 = 213.
        // Flip the forward-move byte (first byte of the tic command).
        const DOCTOR_TIC    = 50;
        const HEADER_BYTES  = 13;
        const doctored      = Buffer.from(demo1Lump);
        const ticOffset     = HEADER_BYTES + DOCTOR_TIC * 4;
        doctored[ticOffset] = (doctored[ticOffset] + 17) & 0xff;  // xor-like mutation

        const result = await verifyDemoBytes(doctored, doomWadPath, golden);

        ok('Gate B: doctored demo → DIVERGED (not VERIFIED)', !result.ok && !result.error);
        if (!result.ok && !result.error) {
            ok(`Gate B: first divergent tic is ${DOCTOR_TIC} (got ${result.firstDivergentTic})`,
                result.firstDivergentTic === DOCTOR_TIC);
            console.log(`        firstDivergentTic=${result.firstDivergentTic}`);
            console.log(`        expected=${result.expected}  actual=${result.actual}`);
            // Verify divergence tic context is present
            ok('Gate B: context window present', Array.isArray(result.context) && result.context.length > 0);
        }
    }
}

// ── Gate C: Hostile corpus ────────────────────────────────────────────────────
//
// Adversarial LMP inputs must be rejected gracefully by verifyDemoBytes().
// "Graceful" means: the function returns {ok: false, error: ...} rather than
// throwing or hanging.  web_play_demo_buf's existing bounds-checked header
// parse and marker scan guard against most attacks; this gate verifies the
// full chain.

console.log('\n── demo-verify-test: Gate C — hostile LMP corpus ──────────────────────');

// A valid-enough golden to compare against (any golden works since hostile
// inputs should be rejected before the comparison step).
let hostileGolden = null;
const hostileGoldenPath = join(goldenDir, 'doom-demo1.json');
const hostileWadPath    = join(wadDir, 'doom.wad');
const canRunHostile     = existsSync(hostileGoldenPath) && existsSync(hostileWadPath);
if (canRunHostile)
    hostileGolden = JSON.parse(readFileSync(hostileGoldenPath, 'utf8'));

async function hostileCase(label, lmpBytes) {
    if (!canRunHostile) { console.log(`  skip ${label}: doom.wad not fetched`); return; }
    let threw = false;
    let result;
    try {
        result = await verifyDemoBytes(lmpBytes, hostileWadPath, hostileGolden);
    } catch (e) {
        threw = true;
    }
    // Hostile inputs must NOT throw; they must return {ok: false}.
    const graceful = !threw && result && !result.ok;
    ok(`${label}: graceful reject (no crash, ok=false)`, graceful);
}

// Case 1: Truncated header (only 4 bytes)
await hostileCase('truncated header (4 bytes)',
    Buffer.from([0x6e, 0x01, 0x01, 0x01]));

// Case 2: Wrong version byte (0x00)
await hostileCase('bad version (0x00)',
    Buffer.from([0x00, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00,
                 0x00, 0x00, 0x00, 0x00, 0x00,   // 13-byte header
                 0x00, 0x00, 0x00, 0x80]));        // 1 tic + marker

// Case 3: No DEMOMARKER (marker scan must exhaust without crashing)
// Build a 14-byte payload: valid header (ver=110) + 1 tic, no 0x80 at boundary.
{
    const b = Buffer.alloc(17, 0x00);
    b[0] = 110;   // valid version
    b[1] = 1;     // skill
    b[2] = 1;     // episode
    b[3] = 1;     // map
    // bytes 4-12: zeros (game flags + players)
    // bytes 13-16: tic data, no DEMOMARKER
    b[13] = 0x01; b[14] = 0x00; b[15] = 0x00; b[16] = 0x00;
    await hostileCase('no DEMOMARKER (marker absent in tic data)', b);
}

// Case 4: Oversized (> 1 MiB) — must be rejected fast (demo-verify.mjs size check).
// verifyDemoBytes() itself doesn't check size; the CLI does.  But web_play_demo_buf
// bounds its marker scan at 1 MiB, so a 1.1 MiB no-marker payload → ok=false.
{
    const oversized = Buffer.alloc(1_100_000, 0x00);
    oversized[0] = 110; oversized[1] = 1; oversized[2] = 1; oversized[3] = 1;
    await hostileCase('oversized (1.1 MiB, no marker)', oversized);
}

// Case 5: All-zeros beyond header (valid version, all-zero tic data, no marker
//         until the scan cap).  The scan runs 4 bytes at a time and finds 0x80
//         at offset ~1 MiB, but the episode/map in header are 0 so G_InitNew
//         is skipped — the sim should hash 0 ticks and report ok=false.
{
    const b = Buffer.alloc(200, 0x00);
    b[0] = 110;  // valid version
    // episode=0, map=0: web_play_demo_buf returns -1 BEFORE G_InitNew (19.4
    // bounds guard rejects out-of-range level indices outright)
    // The demo will play 0 tics (no level) and demoplayback ends quickly.
    // We put the marker at byte 17 (first 4-byte boundary after header).
    b[17] = 0x80;
    await hostileCase('ep=0 map=0 demo (no G_InitNew, marker at byte 17)', b);
}

{
    // Early DEMOMARKER: valid header (ep=1 map=1), marker as the very first
    // tic byte — a 0-tic demo.  Must reject gracefully (trace too short),
    // never crash or hang.
    const b = new Uint8Array(14);
    b[0] = 109;      // version
    b[1] = 2;        // skill
    b[2] = 1;        // episode
    b[3] = 1;        // map
    b[9] = 1;        // playeringame[0] = 1 (valid header otherwise)
    b[13] = 0x80;    // DEMOMARKER at first tic position → 0-tic demo
    await hostileCase('early DEMOMARKER (0-tic demo, marker at byte 13)', b);
}

{
    // Zero-player demo: valid level/skill but playeringame[] all false.
    // No player ever consumes ticcmds, so the marker is never read and the
    // engine drifts into undefined attract states — must reject at load.
    const b = new Uint8Array(18);
    b[0] = 109; b[1] = 2; b[2] = 1; b[3] = 1;
    b[17] = 0x80;    // marker after one 4-byte tic
    await hostileCase('zero-player demo (playeringame all false)', b);
}

// Case 6: Garbage (random bytes)
{
    const garbage = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x13, 0x37, 0xc0, 0xde,
                                 0x42, 0x00, 0xff, 0xab, 0xcd, 0x00, 0x00, 0x00, 0x80]);
    await hostileCase('random garbage bytes', garbage);
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n  ${passes} passed, ${failures} failed`);
if (failures) {
    console.log(`demo-verify-test: ${failures} failure(s)`);
    process.exit(1);
}
console.log('PASS — demo-verify-test: all gates green');
process.exit(0);
