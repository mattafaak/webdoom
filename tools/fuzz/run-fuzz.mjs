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
//   node tools/fuzz/run-fuzz.mjs [--seeds N] [--parallel J] [--build-dir DIR]
//
//   --parallel J   Concurrency level (default: min(8, ceil(cpuCount/3))).
//                  Each seed gets a fresh wasm module instance (no shared heap)
//                  and an independent nat-doom child process. Results for seed N
//                  are identical whether run sequentially or in parallel.
//
// Tiers:
//   Fast / CI tier (run-tests.sh):  --seeds 20  --parallel 8   (~1 min)
//   Full / release tier:            --seeds 1000 --parallel 8  (~30 min)
//
// Exit code: 0 = all seeds identical or wasm-only mode; 1 = any divergence.
//
// Test-only flag: FUZZ_FORCE_DIVERGE=1 injects a fake divergence on seed 0.
//   Use only to verify that CI correctly fails on divergence. Never set in
//   production.

import { readFileSync, writeFileSync, mkdirSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { tmpdir, cpus } from 'node:os';
import { createHash } from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ── args ─────────────────────────────────────────────────────────────────────
let numSeeds = 10;
let buildDir = 'build';
let parallelism = Math.min(8, Math.max(1, Math.ceil(cpus().length / 3)));
for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--seeds' && process.argv[i + 1]) {
        numSeeds = Number(process.argv[++i]);
    } else if (process.argv[i] === '--build-dir' && process.argv[i + 1]) {
        buildDir = process.argv[++i];
    } else if (process.argv[i] === '--parallel' && process.argv[i + 1]) {
        parallelism = Number(process.argv[++i]);
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
// Each call to createDoom() returns a fresh, independent Emscripten module with
// its own heap (HEAPU8), malloc arena, and global state. No mutable state is
// shared between concurrent wasm instances, so parallel seeds are deterministic.
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
// Async: uses spawn (not spawnSync) so multiple nat-doom processes can run in
// parallel when --parallel > 1. Each seed gets an isolated tmpdir keyed by
// seed number, so concurrent runs never collide on the filesystem.
function runNative(pwadBytes, seed) {
    return new Promise((resolve, reject) => {
        const tmpDir = join(tmpdir(), `webdoom-fuzz-${process.pid}-${seed}`);
        mkdirSync(tmpDir, { recursive: true });

        const cleanup = () => {
            try { rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
        };

        try {
            symlinkSync(IWAD_PATH, join(tmpDir, IWAD_NAME));
            writeFileSync(join(tmpDir, PWAD_NAME), pwadBytes);
        } catch (e) {
            cleanup();
            return reject(e);
        }

        const simOut = join(tmpDir, 'sim.json');
        const child = spawn(
            NAT_DOOM,
            ['-waddir', tmpDir, '-file', PWAD_NAME, '-timedemo', LUMP_NAME, '-sim', simOut],
            {
                env: {
                    ...process.env,
                    ASAN_OPTIONS: 'halt_on_error=1:print_stats=0',
                    UBSAN_OPTIONS: 'halt_on_error=1:print_stacktrace=1',
                },
            }
        );

        const stderrChunks = [];
        child.stderr.on('data', (d) => stderrChunks.push(d));

        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            cleanup();
            reject(new Error('nat-doom timed out (60s)'));
        }, 60000);

        child.on('close', (code) => {
            clearTimeout(timer);
            try {
                if (code !== 0) {
                    const stderr = Buffer.concat(stderrChunks).toString().slice(0, 200);
                    return reject(new Error(`nat-doom exited ${code}: ${stderr}`));
                }
                if (!existsSync(simOut)) {
                    return reject(new Error('nat-doom did not write sim.json'));
                }
                const sim = JSON.parse(readFileSync(simOut, 'utf8'));
                resolve({ tics: sim.tics, trace: sim.trace });
            } catch (e) {
                reject(e);
            } finally {
                cleanup();
            }
        });

        child.on('error', (err) => {
            clearTimeout(timer);
            cleanup();
            reject(err);
        });
    });
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

// ── per-seed runner ───────────────────────────────────────────────────────────
async function runSeed(seed) {
    // FUZZ_FORCE_DIVERGE=1 — test-only: inject a fake divergence on seed 0
    // to verify CI correctly fails on divergence. Never set in production.
    if (process.env.FUZZ_FORCE_DIVERGE === '1' && seed === 0) {
        return `seed ${seed}: DIVERGED at tic 0 (wasm=00000001 native=fffffffe) [FORCED — test-only]`;
    }

    const pwadBytes = genDemo(seed);

    let wasmResult;
    try {
        wasmResult = await runWasm(pwadBytes);
    } catch (e) {
        return `seed ${seed}: WASM ERROR — ${e.message}`;
    }

    if (!natAvailable) {
        // Self-consistency: run wasm again with same seed — must be identical.
        let wasmResult2;
        try {
            wasmResult2 = await runWasm(pwadBytes);
        } catch (e) {
            return `seed ${seed}: WASM2 ERROR — ${e.message}`;
        }
        const cmp = compareTraces(
            { trace: wasmResult.trace },
            { trace: wasmResult2.trace }
        );
        if (cmp.diverged) {
            return `seed ${seed}: SELF-INCONSISTENT at tic ${cmp.tic} (run1=${cmp.wasm} run2=${cmp.native})`;
        }
        return `seed ${seed}: ${wasmResult.tics} tics, wasm self-consistent (native blocked)`;
    }

    let nativeResult;
    try {
        nativeResult = await runNative(pwadBytes, seed);
    } catch (e) {
        return `seed ${seed}: NATIVE ERROR — ${e.message}`;
    }

    const cmp = compareTraces(wasmResult, nativeResult);
    if (cmp.diverged) {
        return `seed ${seed}: DIVERGED at tic ${cmp.tic} (wasm=${cmp.wasm} native=${cmp.native})`;
    }
    return `seed ${seed}: ${wasmResult.tics} tics, hashes identical`;
}

// ── parallel seed pool ────────────────────────────────────────────────────────
// Runs up to `parallelism` seeds concurrently. Results are stored by seed index
// so the summary is always printed in seed order regardless of completion order.
// With parallelism=1 this is equivalent to sequential execution.
async function runPool() {
    const results = new Array(numSeeds);
    let next = 0;

    async function worker() {
        while (true) {
            const seed = next++;
            if (seed >= numSeeds) break;
            const line = await runSeed(seed);
            console.log(' ', line);
            results[seed] = line;
        }
    }

    const workers = Array.from({ length: Math.min(parallelism, numSeeds) }, worker);
    await Promise.all(workers);
    return results;
}

// ── main ──────────────────────────────────────────────────────────────────────
const modeLabel = natAvailable ? 'native (differential)' : 'wasm-only self-consistency';
console.log(`webdoom fuzzer: ${numSeeds} seeds, parallel=${parallelism}, wasm vs ${modeLabel}`);
console.log(`IWAD: ${IWAD_NAME} / MAP01 (episode=1, map=1), 700 tics per seed\n`);

// Reproducibility: verify seed 0 twice
const reproSha = checkReproducibility(0);
console.log(`reproducibility: seed 0 sha256=${reproSha.slice(0, 16)}... (identical both runs)\n`);

console.log('── per-seed results (in completion order) ───────────────────────');
const results = await runPool();

// ── summary ───────────────────────────────────────────────────────────────────
console.log('\n── summary (seed order) ─────────────────────────────────────────');
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
