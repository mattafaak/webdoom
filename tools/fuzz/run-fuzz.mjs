#!/usr/bin/env node
// tools/fuzz/run-fuzz.mjs — differential fuzzer: webdoom (wasm) vs nat-doom (native).
//
// For each seed:
//   1. gen-demo.mjs produces a seeded synthetic vanilla demo PWAD.
//   2. nat-doom (tools/native-sanitize/nat-doom) replays it, writing per-tic
//      sim hashes to a JSON file via -sim.
//   3. webdoom (build/doom.js wasm) replays the same PWAD, collecting per-tic
//      web_state_hash() values.
//   4. Traces are compared element-by-element; first divergent tic is reported.
//
// Both engines use the SAME hash function (verified: engine/web/i_main.c
// web_state_hash and native-sanitize/i_main.c nat_state_hash are byte-for-byte
// identical algorithms over the same state: gametic ^ prndindex ^ player mo
// x/y/angle/health).
//
// WAD choice: doom2.wad MAP01 (episode=1, map=1).
//   - doom2.wad is the most commonly available IWAD in this repo's wads/lib/.
//   - MAP01 is a simple, fast-loading map with a live player from tic 0.
//   - doom.wad E1M1 would also work; doom2.wad avoids episode logic.
//
// Usage:
//   node tools/fuzz/run-fuzz.mjs [--seeds N] [--build-dir DIR]
//   Exit code: 0 = all seeds identical or wasm-only mode; 1 = any divergence.

import { readFileSync, writeFileSync, mkdirSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ── args ─────────────────────────────────────────────────────────────────────
let numSeeds = 10;
let buildDir = 'build';
for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--seeds' && process.argv[i + 1]) {
        numSeeds = Number(process.argv[++i]);
    } else if (process.argv[i] === '--build-dir' && process.argv[i + 1]) {
        buildDir = process.argv[++i];
    }
}

const { genDemo } = await import('./gen-demo.mjs');
const createDoom = (await import(join(root, buildDir, 'doom.js'))).default;

// ── paths ────────────────────────────────────────────────────────────────────
const NAT_DOOM = join(root, 'tools/native-sanitize/nat-doom');
const IWAD_PATH = join(root, 'wads/lib/doom2.wad');
const IWAD_NAME = 'doom2.wad';
const LUMP_NAME = 'FUZZDEMO';
const PWAD_NAME = 'fuzz.wad'; // name used in both registries

// Check prerequisites
if (!existsSync(IWAD_PATH)) {
    console.error(`FATAL: ${IWAD_PATH} not found — run tools/fetch-wads.sh`);
    process.exit(1);
}

const natAvailable = existsSync(NAT_DOOM);
if (!natAvailable) {
    console.log('nat-doom not found — running wasm self-consistency mode (same seed x2)');
}

// ── webdoom per-tic trace ─────────────────────────────────────────────────────
async function runWasm(pwadBytes) {
    const iwadBytes = readFileSync(IWAD_PATH);
    let done = null;

    const doom = await createDoom({
        print: () => {},
        printErr: (t) => {
            const m = /timed (\d+) gametics/.exec(t);
            if (m) done = +m[1];
        },
        onDoomError: (msg) => {
            if (!/timed \d+ gametics/.test(msg)) done = `error: ${msg}`;
        },
    });

    // Register IWAD
    {
        const p = doom._malloc(iwadBytes.length);
        doom.HEAPU8.set(iwadBytes, p);
        doom.ccall('web_register_file', null, ['string', 'number', 'number'], [
            IWAD_NAME, p, iwadBytes.length,
        ]);
    }

    // Register PWAD
    {
        const p = doom._malloc(pwadBytes.length);
        doom.HEAPU8.set(pwadBytes, p);
        doom.ccall('web_register_file', null, ['string', 'number', 'number'], [
            PWAD_NAME, p, pwadBytes.length,
        ]);
    }

    const trace = [];
    try {
        doom.callMain(['-file', PWAD_NAME, '-timedemo', LUMP_NAME, '-nodraw']);
        let lastTic = -1;
        for (let i = 0; i < 200000 && done === null; i++) {
            doom._web_frame();
            const tic = doom._web_gametic();
            if (tic !== lastTic) {
                trace.push(doom._web_state_hash() >>> 0);
                lastTic = tic;
            }
        }
    } catch (_e) {
        // I_Error throws after writing "timed N gametics"; done is set.
    }

    if (typeof done !== 'number') {
        throw new Error(`wasm never finished: ${done ?? 'timeout'}`);
    }
    return { tics: done, trace };
}

// ── nat-doom per-tic trace ────────────────────────────────────────────────────
function runNative(pwadBytes) {
    // Build an isolated temp WAD dir with: IWAD symlink + PWAD file.
    const tmpDir = join(tmpdir(), `webdoom-fuzz-${process.pid}-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    try {
        symlinkSync(IWAD_PATH, join(tmpDir, IWAD_NAME));
        writeFileSync(join(tmpDir, PWAD_NAME), pwadBytes);

        const simOut = join(tmpDir, 'sim.json');
        const result = spawnSync(
            NAT_DOOM,
            ['-waddir', tmpDir, '-file', PWAD_NAME, '-timedemo', LUMP_NAME, '-sim', simOut],
            {
                env: {
                    ...process.env,
                    ASAN_OPTIONS: 'halt_on_error=1:print_stats=0',
                    UBSAN_OPTIONS: 'halt_on_error=1:print_stacktrace=1',
                },
                maxBuffer: 64 * 1024 * 1024,
                timeout: 60000,
            }
        );

        if (result.status !== 0) {
            const stderr = result.stderr?.toString() ?? '';
            throw new Error(`nat-doom exited ${result.status}: ${stderr.slice(0, 200)}`);
        }

        if (!existsSync(simOut)) {
            throw new Error('nat-doom did not write sim.json');
        }

        const sim = JSON.parse(readFileSync(simOut, 'utf8'));
        return { tics: sim.tics, trace: sim.trace };
    } finally {
        try { rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }
}

// ── comparison ────────────────────────────────────────────────────────────────
function compareTraces(wasm, native) {
    const minLen = Math.min(wasm.trace.length, native.trace.length);
    for (let i = 0; i < minLen; i++) {
        if ((wasm.trace[i] >>> 0) !== (native.trace[i] >>> 0)) {
            return {
                diverged: true,
                tic: i,
                wasm: (wasm.trace[i] >>> 0).toString(16).padStart(8, '0'),
                native: (native.trace[i] >>> 0).toString(16).padStart(8, '0'),
            };
        }
    }
    if (wasm.trace.length !== native.trace.length) {
        return {
            diverged: true,
            tic: minLen,
            wasm: `length ${wasm.trace.length}`,
            native: `length ${native.trace.length}`,
        };
    }
    return { diverged: false };
}

// ── reproducibility check: same seed x2 → byte-identical PWAD ────────────────
function checkReproducibility(seed) {
    const a = genDemo(seed);
    const b = genDemo(seed);
    const ha = createHash('sha256').update(a).digest('hex');
    const hb = createHash('sha256').update(b).digest('hex');
    if (ha !== hb) throw new Error(`seed ${seed} not reproducible: ${ha} vs ${hb}`);
    return ha;
}

// ── main ──────────────────────────────────────────────────────────────────────
console.log(`webdoom fuzzer: ${numSeeds} seeds, wasm vs ${natAvailable ? 'native (differential)' : 'wasm-only self-consistency'}`);
console.log(`IWAD: ${IWAD_NAME} / MAP01 (episode=1, map=1), 700 tics per seed\n`);

// Reproducibility: verify seed 0 twice
const reproSha = checkReproducibility(0);
console.log(`reproducibility: seed 0 sha256=${reproSha.slice(0, 16)}... (identical both runs)\n`);

const results = [];
let anyDivergence = false;

for (let seed = 0; seed < numSeeds; seed++) {
    process.stdout.write(`seed ${seed}: `);
    const pwadBytes = genDemo(seed);

    let wasmResult;
    try {
        wasmResult = await runWasm(pwadBytes);
    } catch (e) {
        const msg = `seed ${seed}: WASM ERROR — ${e.message}`;
        console.log('WASM ERROR —', e.message);
        results.push(msg);
        anyDivergence = true;
        continue;
    }

    if (!natAvailable) {
        // Self-consistency: run wasm again with same seed — must be identical.
        let wasmResult2;
        try {
            wasmResult2 = await runWasm(pwadBytes);
        } catch (e) {
            const msg = `seed ${seed}: WASM2 ERROR — ${e.message}`;
            console.log('WASM2 ERROR —', e.message);
            results.push(msg);
            anyDivergence = true;
            continue;
        }
        const cmp = compareTraces(
            { trace: wasmResult.trace },
            { trace: wasmResult2.trace }
        );
        if (cmp.diverged) {
            const msg = `seed ${seed}: SELF-INCONSISTENT at tic ${cmp.tic} (run1=${cmp.wasm} run2=${cmp.native})`;
            console.log(msg);
            results.push(msg);
            anyDivergence = true;
        } else {
            const msg = `seed ${seed}: ${wasmResult.tics} tics, wasm self-consistent (native blocked)`;
            console.log(msg);
            results.push(msg);
        }
        continue;
    }

    let nativeResult;
    try {
        nativeResult = runNative(pwadBytes);
    } catch (e) {
        const msg = `seed ${seed}: NATIVE ERROR — ${e.message}`;
        console.log('NATIVE ERROR —', e.message);
        results.push(msg);
        anyDivergence = true;
        continue;
    }

    const cmp = compareTraces(wasmResult, nativeResult);
    if (cmp.diverged) {
        const msg = `seed ${seed}: DIVERGED at tic ${cmp.tic} (wasm=${cmp.wasm} native=${cmp.native})`;
        console.log(msg);
        results.push(msg);
        anyDivergence = true;
    } else {
        const msg = `seed ${seed}: ${wasmResult.tics} tics, hashes identical`;
        console.log(msg);
        results.push(msg);
    }
}

// ── summary ───────────────────────────────────────────────────────────────────
console.log('\n── summary ──────────────────────────────────────────────────────');
for (const r of results) {
    console.log(' ', r);
}
console.log('─────────────────────────────────────────────────────────────────');

const divergences = results.filter((r) => r.includes('DIVERGED') || r.includes('ERROR') || r.includes('SELF-INCONSISTENT'));
if (divergences.length > 0) {
    console.log(`\nFAIL: ${divergences.length} divergence(s) detected`);
    process.exit(1);
} else {
    console.log(`\nPASS: all ${numSeeds} seeds ${natAvailable ? 'bit-identical (wasm ≡ native)' : 'self-consistent (native blocked)'}`);
    process.exit(0);
}
