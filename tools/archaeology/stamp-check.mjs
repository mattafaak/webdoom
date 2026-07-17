#!/usr/bin/env node
// stamp-check.mjs — verifies measurement claims from docs/claims-index.md.
// Reads golden JSON files and build artifacts; reports current vs documented values.
//
// For "invariant" measurements (golden tics, wad file sizes), the script
// exits nonzero if values do not match.
// For commit-pinned build artifact sizes (perf-001/004/005), the script
// always exits 0 when the artifact exists, reporting both current and
// documented values (these legitimately differ across commits).
//
// Claims verified:
//   ps-033  doom-demo1 total tics (E1M5)           = 1,710  [invariant golden]
//   ps-034  doom-demo4 total tics (E4M2)           = 818    [invariant golden]
//   perf-011 plutonia.wad file size                = 17,420,824 bytes [invariant]
//   perf-059 worst PWAD combo peak heap (tnt+tnt31)= 54.83 MB [arithmetic from files]
//   perf-001 wasm binary total size                = 357,978 bytes [commit-pinned]
//   perf-004 wasm gzip-9 compressed size           = 145,990 bytes [commit-pinned]
//   perf-005 doom.js gzip-9 compressed size        = 3,514 bytes   [commit-pinned]
//
// Usage: node tools/archaeology/stamp-check.mjs
// Exits 0 on all-pass (invariants match + artifacts exist), 1 on any hard failure.
import { readFileSync, statSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

let failures = 0;
const claimActuals = {};

function check(id, desc, expected, actual, soft = false) {
    const pass = String(actual) === String(expected);
    if (!pass && !soft) failures++;
    const tag = pass ? 'PASS' : (soft ? 'INFO' : 'FAIL');
    claimActuals[id] = actual === null || actual === undefined ? null : String(actual);
    console.log(`${tag}  ${id}  ${desc}`);
    if (!pass) {
        console.log(`      documented: ${expected}`);
        console.log(`      actual:     ${actual}`);
        if (soft) console.log('      (measurement claim — drift expected across commits)');
    }
    return pass;
}

function fileSize(path) {
    try {
        return statSync(path).size;
    } catch {
        return null;
    }
}

function gzipSize(path) {
    try {
        const out = execSync(`gzip -9kc "${path}" | wc -c`, { encoding: 'utf8' });
        return parseInt(out.trim(), 10);
    } catch {
        return null;
    }
}

// ── ps-033: doom-demo1 tics ──────────────────────────────────────────────────
{
    const goldenPath = join(root, 'tools/golden/doom-demo1.json');
    if (!existsSync(goldenPath)) {
        failures++;
        console.log('FAIL  ps-033  doom-demo1.json not found');
    } else {
        const g = JSON.parse(readFileSync(goldenPath));
        check('ps-033', `doom-demo1 total tics = ${g.tics} (E1M5; see FINDING-2 for frame vs tic)`,
              1710, g.tics);
    }
}

// ── ps-034: doom-demo4 tics ──────────────────────────────────────────────────
{
    const goldenPath = join(root, 'tools/golden/doom-demo4.json');
    if (!existsSync(goldenPath)) {
        failures++;
        console.log('FAIL  ps-034  doom-demo4.json not found');
    } else {
        const g = JSON.parse(readFileSync(goldenPath));
        check('ps-034', `doom-demo4 total tics = ${g.tics} (E4M2)`,
              818, g.tics);
    }
}

// ── perf-011: plutonia.wad size ──────────────────────────────────────────────
{
    const wadPath = join(root, 'wads/lib/plutonia.wad');
    const sz = fileSize(wadPath);
    if (sz === null) {
        failures++;
        console.log('FAIL  perf-011  wads/lib/plutonia.wad not found');
    } else {
        check('perf-011', `plutonia.wad size = ${sz} bytes`, 17420824, sz);
    }
}

// ── perf-059: worst PWAD combo peak heap (tnt.wad + tnt31.wad) ──────────────
// Formula: __heap_base + ZONESIZE + tnt.wad_size + tnt31.wad_size
// __heap_base = 5,461,072 bytes (linker constant; see perf-009)
// ZONESIZE    = 33,554,432 bytes (32 MB; see perf-008/perf-010)
// tnt.wad     = 18,195,736 bytes (measured here)
// tnt31.wad   = 282,000 bytes (measured here)
// perf.md:966: 5.21 + 32 + 17.62 = 54.83 MB
{
    const HEAP_BASE  = 5461072;
    const ZONE_SIZE  = 33554432;
    const tntPath    = join(root, 'wads/lib/tnt.wad');
    const tnt31Path  = join(root, 'wads/lib/tnt31.wad');
    const tntSz   = fileSize(tntPath);
    const tnt31Sz = fileSize(tnt31Path);
    if (tntSz === null || tnt31Sz === null) {
        failures++;
        console.log('FAIL  perf-059  tnt.wad or tnt31.wad not found');
    } else {
        const totalBytes = HEAP_BASE + ZONE_SIZE + tntSz + tnt31Sz;
        const MB = totalBytes / (1024 * 1024);
        const mbRounded = Math.round(MB * 100) / 100; // 2 decimal places
        check('perf-059',
              `worst PWAD heap = ${tntSz}+${tnt31Sz}+heap+zone = ${MB.toFixed(2)} MB ≈ 54.83 MB`,
              '54.83', MB.toFixed(2));
    }
}

// ── perf-001: doom.wasm total size (commit-pinned to 6de6256) ───────────────
{
    const wasmPath = join(root, 'build/doom.wasm');
    const sz = fileSize(wasmPath);
    if (sz === null) {
        failures++;
        console.log('FAIL  perf-001  build/doom.wasm not found (run make first)');
    } else {
        check('perf-001', `doom.wasm size = ${sz} bytes (doc: 357,978 @ commit 6de6256)`,
              357978, sz, /*soft=*/true);
    }
}

// ── perf-004: doom.wasm gzip-9 size (commit-pinned) ─────────────────────────
{
    const wasmPath = join(root, 'build/doom.wasm');
    if (existsSync(wasmPath)) {
        const gz = gzipSize(wasmPath);
        if (gz === null) {
            failures++;
            console.log('FAIL  perf-004  gzip failed on build/doom.wasm');
        } else {
            check('perf-004', `doom.wasm gzip-9 = ${gz} bytes (doc: 145,990 @ commit 6de6256)`,
                  145990, gz, /*soft=*/true);
        }
    } else {
        failures++;
        console.log('FAIL  perf-004  build/doom.wasm not found');
    }
}

// ── perf-005: doom.js gzip-9 size (commit-pinned) ───────────────────────────
{
    const jsPath = join(root, 'build/doom.js');
    if (!existsSync(jsPath)) {
        failures++;
        console.log('FAIL  perf-005  build/doom.js not found');
    } else {
        const gz = gzipSize(jsPath);
        if (gz === null) {
            failures++;
            console.log('FAIL  perf-005  gzip failed on build/doom.js');
        } else {
            check('perf-005', `doom.js gzip-9 = ${gz} bytes (doc: 3,514 @ commit 6de6256)`,
                  3514, gz, /*soft=*/true);
        }
    }
}

console.log(`\nstamp-check: ${7 - failures}/7 passed (hard failures: ${failures})`);
console.log(`CLAIMS_JSON ${JSON.stringify(claimActuals)}`);
if (failures > 0) process.exit(1);
