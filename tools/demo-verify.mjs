#!/usr/bin/env node
// Demo verification tool + divergence visualizer (task 19.4).
//
// Verifies a .lmp file against a per-tic sim trace attestation (golden JSON).
// Uses web_play_demo_buf (the same replay path as demo-replay-test.mjs) to
// replay the demo and collect per-tic web_state_hash() values, then compares
// against the expected attestation.
//
// Divergence visualizer: on mismatch, names the FIRST divergent tic and prints
// both hashes plus a ±2-tic context window — no browser UI required.
//
// Replay tic cap: 200,000.  Demos that run longer than this are rejected so
// hostile infinite-loop inputs cannot stall the process.
//
// usage:
//   node tools/demo-verify.mjs <lmp-file> --wad <wad> --golden <golden.json>
//   node tools/demo-verify.mjs --all [--wad-dir wads/lib] [--golden-dir tools/golden]
//   node tools/demo-verify.mjs --stdin-lmp --wad <wad> --golden <golden.json>
//
// Exit 0 = VERIFIED, exit 1 = DIVERGED or error, exit 2 = usage error.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPLAY_TIC_CAP = 200_000;  // explicit cap; reject demos that run longer

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// ── CLI arg parsing ───────────────────────────────────────────────────────────

function usage() {
    console.error([
        'usage:',
        '  node tools/demo-verify.mjs <lmp-file> --wad <wad> --golden <golden.json>',
        '  node tools/demo-verify.mjs --all [--wad-dir wads/lib] [--golden-dir tools/golden]',
        '  node tools/demo-verify.mjs --stdin-lmp --wad <wad> --golden <golden.json>',
        '',
        'options:',
        '  --wad <path>         WAD file for engine boot (e.g. wads/lib/doom.wad)',
        '  --golden <path>      Expected attestation JSON {tics, trace}',
        '  --tic-cap <n>        Override default replay tic cap (default: 200000)',
        '  --build-dir <dir>    Engine build dir (default: build)',
        '  --json               Output JSON result',
        '  --all                Verify all 13 golden demos',
        '  --wad-dir <path>     WAD directory for --all mode (default: wads/lib)',
        '  --golden-dir <path>  Golden dir for --all mode (default: tools/golden)',
    ].join('\n'));
    process.exit(2);
}

const args = process.argv.slice(2);

let lmpFile = null;
let wadFile = null;
let goldenFile = null;
let buildDir = 'build';
let outputJson = false;
let allMode = false;
let wadDir = join(root, 'wads/lib');
let goldenDir = join(root, 'tools/golden');
let ticCap = REPLAY_TIC_CAP;
let stdinLmp = false;

for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--wad')         { wadFile   = args[++i]; continue; }
    if (a === '--golden')      { goldenFile = args[++i]; continue; }
    if (a === '--build-dir')   { buildDir  = args[++i]; continue; }
    if (a === '--tic-cap')     { ticCap    = +args[++i]; continue; }
    if (a === '--wad-dir')     { wadDir    = args[++i]; continue; }
    if (a === '--golden-dir')  { goldenDir = args[++i]; continue; }
    if (a === '--json')        { outputJson = true; continue; }
    if (a === '--all')         { allMode = true; continue; }
    if (a === '--stdin-lmp')   { stdinLmp = true; continue; }
    if (!a.startsWith('--'))   { lmpFile = a; continue; }
    console.error(`unknown option: ${a}`);
    usage();
}

// ── WAD lump extractor ────────────────────────────────────────────────────────
//
// Parses a DOOM WAD directory to extract a named lump's raw bytes.
// Format: 12-byte header (magic + numlumps + infotableofs) followed by
// the lump directory (16 bytes per entry: filepos + size + 8-char name).

function extractWadLump(wadBytes, lumpName) {
    const view = new DataView(wadBytes.buffer, wadBytes.byteOffset, wadBytes.byteLength);
    const magic = String.fromCharCode(...wadBytes.slice(0, 4));
    if (magic !== 'IWAD' && magic !== 'PWAD')
        throw new Error(`not a WAD file (magic: ${magic})`);
    const numlumps = view.getUint32(4, true);
    const dirOffset = view.getUint32(8, true);
    const target = lumpName.toUpperCase().padEnd(8, '\0');
    for (let i = 0; i < numlumps; i++) {
        const entry = dirOffset + i * 16;
        const name = String.fromCharCode(...wadBytes.slice(entry + 8, entry + 16))
            .replace(/\0.*$/, '').padEnd(8, '\0');
        if (name === target) {
            const filepos = view.getUint32(entry, true);
            const size    = view.getUint32(entry + 4, true);
            return wadBytes.slice(filepos, filepos + size);
        }
    }
    return null;  // lump not found
}

// ── Engine loader ─────────────────────────────────────────────────────────────

let createDoom = null;

async function loadEngine() {
    if (createDoom) return;
    const doomJsPath = join(root, buildDir, 'doom.js');
    if (!existsSync(doomJsPath)) {
        console.error(`SKIP: engine not built (${doomJsPath} absent)`);
        process.exit(0);
    }
    createDoom = (await import(doomJsPath)).default;
}

// ── Core verify logic ─────────────────────────────────────────────────────────
//
// Given .lmp bytes, a WAD path (to boot the engine), and an expected golden
// trace {tics, trace}, replay the demo and compare per-tic sim hashes.
// Returns {ok: true} or {ok: false, firstDivergentTic, expected, actual, context}.
//
// web_play_demo_buf parses the demo header and calls G_InitNew internally, so
// the WAD just needs to be valid (engine must be initialised before calling it).

async function verifyDemo(lmpBytes, wadPath, golden) {
    if (!existsSync(wadPath))
        return { ok: false, error: `WAD not found: ${wadPath}` };

    const wadBytes = readFileSync(wadPath);

    const doom = await createDoom({
        print: () => {},
        printErr: () => {},
        onDoomError: () => {},
    });

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

    // Boot with -warp 1 1 so the engine initialises a level before
    // web_play_demo_buf is called.  web_play_demo_buf calls G_InitNew from
    // the demo header, overriding the boot level.
    doom.callMain(['-warp', '1', '1', '-skill', '1', '-nodraw']);

    // Singletics: each web_frame() = exactly one game tic (same as timedemo).
    doom._web_set_singletics(1);

    // Load .lmp into wasm heap and start playback.
    const lmpPtr = doom._malloc(lmpBytes.length);
    doom.HEAPU8.set(lmpBytes, lmpPtr);
    const rc = doom._web_play_demo_buf(lmpPtr);
    if (rc !== 0)
        return { ok: false, error: `web_play_demo_buf returned ${rc} (bad version or no marker)` };

    // Replay: collect per-tic web_state_hash().
    const trace = [];
    let lastTic = -1;
    let cappedOut = false;
    for (let i = 0; i < ticCap + 10 && doom._web_demo_playing(); i++) {
        if (trace.length >= ticCap) { cappedOut = true; break; }
        doom._web_wipe_skip();
        try { doom._web_frame(); } catch (_) { break; }
        const tic = doom._web_gametic();
        if (tic !== lastTic) {
            trace.push(doom._web_state_hash() >>> 0);
            lastTic = tic;
        }
    }

    if (cappedOut)
        return { ok: false, error: `demo exceeded replay tic cap of ${ticCap}` };

    // Compare against golden trace.
    const n = Math.min(trace.length, golden.trace.length);
    if (n === 0)
        return { ok: false, error: 'replay produced 0 tics — engine boot failed?' };

    for (let i = 0; i < n; i++) {
        if (trace[i] !== golden.trace[i]) {
            // Divergence visualizer: collect ±2-tic context.
            const ctx = [];
            for (let j = Math.max(0, i - 2); j < Math.min(n, i + 3); j++) {
                const mark = j === i ? '>>>' : '   ';
                ctx.push({
                    tic: j,
                    mark,
                    expected: '0x' + golden.trace[j].toString(16).padStart(8, '0'),
                    actual:   '0x' + (trace[j] ?? 0).toString(16).padStart(8, '0'),
                    match: trace[j] === golden.trace[j],
                });
            }
            return {
                ok: false,
                firstDivergentTic: i,
                expected: '0x' + golden.trace[i].toString(16).padStart(8, '0'),
                actual:   '0x' + trace[i].toString(16).padStart(8, '0'),
                context: ctx,
                replayTics: trace.length,
                goldenTics: golden.tics,
            };
        }
    }

    // Length check: tic count must match.
    if (golden.tics !== undefined && trace.length !== golden.tics) {
        return {
            ok: false,
            error: `tic count mismatch: replayed ${trace.length}, golden ${golden.tics}`,
        };
    }

    return { ok: true, tics: trace.length };
}

// ── Single .lmp mode ──────────────────────────────────────────────────────────

async function runSingle() {
    if (!wadFile)    { console.error('--wad is required'); usage(); }
    if (!goldenFile) { console.error('--golden is required'); usage(); }

    let lmpBytes;
    if (stdinLmp) {
        // Read from stdin (for piping in test harnesses).
        const chunks = [];
        for await (const chunk of process.stdin) chunks.push(chunk);
        lmpBytes = Buffer.concat(chunks);
    } else {
        if (!lmpFile) { console.error('<lmp-file> is required'); usage(); }
        if (!existsSync(lmpFile)) {
            console.error(`FAIL: lmp file not found: ${lmpFile}`);
            process.exit(1);
        }
        lmpBytes = readFileSync(lmpFile);
    }

    if (lmpBytes.length > 1_048_576) {
        const msg = `lmp file exceeds 1 MiB cap (${lmpBytes.length} bytes)`;
        if (outputJson) console.log(JSON.stringify({ ok: false, error: msg }));
        else console.log(`FAIL: ${msg}`);
        process.exit(1);
    }

    if (!existsSync(goldenFile)) {
        console.error(`FAIL: golden not found: ${goldenFile}`);
        process.exit(1);
    }
    const golden = JSON.parse(readFileSync(goldenFile, 'utf8'));

    const wadPath = wadFile.startsWith('/') ? wadFile : join(root, wadFile);
    await loadEngine();
    const result = await verifyDemo(lmpBytes, wadPath, golden);

    if (outputJson) {
        console.log(JSON.stringify(result));
    } else {
        printResult(lmpFile ?? '<stdin>', result);
    }
    process.exit(result.ok ? 0 : 1);
}

function printResult(label, result) {
    if (result.ok) {
        console.log(`VERIFIED ${label}: ${result.tics} ticks — trace matches attestation`);
    } else if (result.error) {
        console.log(`FAIL ${label}: ${result.error}`);
    } else {
        console.log(`DIVERGED ${label}: first divergent tic ${result.firstDivergentTic}`);
        console.log(`  expected: ${result.expected}`);
        console.log(`  actual:   ${result.actual}`);
        console.log(`  context (tic: expected / actual):`);
        for (const c of result.context) {
            const status = c.match ? 'OK ' : 'BAD';
            console.log(`    ${c.mark} tic ${c.tic}: ${status} expected=${c.expected} actual=${c.actual}`);
        }
    }
}

// ── --all mode: verify all 13 golden demos ────────────────────────────────────
//
// Extracts DEMO1-4 lumps from each WAD file and verifies them against the
// existing golden sim traces in tools/golden/.

const ALL_MATRIX = [
    ['doom.wad',     'doomu.wad', ['demo1', 'demo2', 'demo3', 'demo4']],
    ['doom2.wad',    'doom2.wad', ['demo1', 'demo2', 'demo3']],
    ['tnt.wad',      'tnt.wad',   ['demo1', 'demo2', 'demo3']],
    ['plutonia.wad', 'plutonia.wad', ['demo1', 'demo2', 'demo3']],
];

async function runAll() {
    await loadEngine();
    let failures = 0;
    let total = 0;

    for (const [wad, , demos] of ALL_MATRIX) {
        const wadPath = join(wadDir, wad);
        if (!existsSync(wadPath)) {
            console.log(`skip ${wad}: not fetched`);
            continue;
        }
        const wadBytes = readFileSync(wadPath);

        for (const demo of demos) {
            total++;
            const name = `${wad.replace('.wad', '')}-${demo}`;
            const goldenPath = join(goldenDir, `${name}.json`);
            if (!existsSync(goldenPath)) {
                console.log(`FAIL ${name}: golden absent (${goldenPath})`);
                failures++;
                continue;
            }
            const golden = JSON.parse(readFileSync(goldenPath, 'utf8'));

            // Extract demo lump from WAD (e.g. "DEMO1" lump from doom.wad).
            const lumpName = demo.toUpperCase();  // demo1 → DEMO1
            const lmpBytes = extractWadLump(wadBytes, lumpName);
            if (!lmpBytes) {
                console.log(`FAIL ${name}: lump ${lumpName} not found in ${wad}`);
                failures++;
                continue;
            }

            const result = await verifyDemo(lmpBytes, wadPath, golden);
            if (outputJson) {
                console.log(JSON.stringify({ name, ...result }));
            } else {
                printResult(name, result);
            }
            if (!result.ok) failures++;
        }
    }

    if (!outputJson) {
        if (failures) {
            console.log(`\n${failures}/${total} golden demo(s) FAILED`);
        } else {
            console.log(`\nPASS — all ${total} golden demos VERIFIED`);
        }
    }
    process.exit(failures > 0 ? 1 : 0);
}

// ── Entry point ───────────────────────────────────────────────────────────────

if (allMode) {
    runAll();
} else {
    runSingle();
}
