#!/usr/bin/env node
// size-ledger.mjs — CI-tracked size ledger for doom.wasm and fs-doom.
//
// Tracks three size metrics and enforces a committed byte budget:
//   size-001  doom.wasm raw bytes     [HARD: FAIL if > doom_wasm_raw_budget]
//   size-002  doom.wasm gzip-9 bytes  [soft: informational, no ceiling]
//   size-003  fs-doom .text bytes     [soft: best-effort, pre-built binary]
//   size-004  README.md "NNN KB of wasm" must equal round(raw_bytes / 1024)
//             and claims.json readme-001.expected must match too [HARD]
//
// Budget source: tools/archaeology/size-budget.json (committed; raise with justification).
//
// README update path (when wasm size changes):
//   1. Build doom.wasm:  (cd engine && make -j8)
//   2. Run this script:  node tools/archaeology/size-ledger.mjs
//      — it will print the FAIL message with the correct KB value.
//   3. Update README.md: change "NNN KB of wasm" to the reported KB value.
//   4. Update claims.json readme-001.expected to the same KB value (as a string).
//   5. Re-run: verify-all.sh --full → ALL PASS.
//
// fs-doom .text: uses the locally built tools/freestanding/fs-doom ELF
// (gitignored build product, NOT committed — present only where a maintainer
// has run make in tools/freestanding). Soft check only — SKIPs when absent.
//
// Usage: node tools/archaeology/size-ledger.mjs
// Exits 0 iff all HARD checks pass. Soft failures are INFO-only.

import { readFileSync, statSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

// Load budget
const budgetPath = join(root, 'tools/archaeology/size-budget.json');
const budget = JSON.parse(readFileSync(budgetPath));
const WASM_RAW_BUDGET = budget.doom_wasm_raw_budget;

let hardFailures = 0;
const claimActuals = {};

function fileSize(path) {
    try { return statSync(path).size; } catch { return null; }
}

function gzipSize(path) {
    try {
        const out = execSync(`gzip -9kc "${path}" | wc -c`, { encoding: 'utf8' });
        return parseInt(out.trim(), 10);
    } catch { return null; }
}

function fsDoomTextSize(binPath) {
    try {
        // `size` output: "   text\t   data\t    bss\t    dec\t    hex\tfilename"
        // second line:   " 294721\t  56040\t24962552\t..." (fresh at 31e436a)
        const out = execSync(`size "${binPath}"`, { encoding: 'utf8' });
        const lines = out.trim().split('\n');
        if (lines.length < 2) return null;
        const cols = lines[1].trim().split(/\s+/);
        return parseInt(cols[0], 10);
    } catch { return null; }
}

// ── size-001: doom.wasm raw bytes vs. committed budget (HARD) ────────────────
const wasmPath = join(root, 'build/doom.wasm');
let wasmRaw = null;
{
    wasmRaw = fileSize(wasmPath);
    if (wasmRaw === null) {
        hardFailures++;
        claimActuals['size-001'] = null;
        console.log('FAIL  size-001  build/doom.wasm not found (run make first)');
    } else {
        const pass = wasmRaw <= WASM_RAW_BUDGET;
        if (!pass) hardFailures++;
        claimActuals['size-001'] = String(wasmRaw);
        const tag = pass ? 'PASS' : 'FAIL';
        console.log(`${tag}  size-001  doom.wasm raw = ${wasmRaw.toLocaleString()} bytes  (budget ≤${WASM_RAW_BUDGET.toLocaleString()} B)`);
        if (!pass) {
            const over = wasmRaw - WASM_RAW_BUDGET;
            console.log(`      OVER BUDGET by ${over.toLocaleString()} bytes`);
            console.log(`      Shrink doom.wasm or raise the budget in tools/archaeology/size-budget.json`);
            console.log(`      (raise only with a documented regression investigation in Plans.md)`);
        }
    }
}

// ── size-002: doom.wasm gzip-9 bytes (soft, informational) ──────────────────
{
    if (wasmRaw !== null) {
        const gz = gzipSize(wasmPath);
        if (gz === null) {
            console.log('WARN  size-002  gzip failed on build/doom.wasm');
            claimActuals['size-002'] = null;
        } else {
            claimActuals['size-002'] = String(gz);
            const ratio = (wasmRaw / gz).toFixed(2);
            console.log(`INFO  size-002  doom.wasm gzip-9 = ${gz.toLocaleString()} bytes  (${ratio}× compression vs raw)`);
        }
    } else {
        claimActuals['size-002'] = null;
        console.log('SKIP  size-002  doom.wasm absent — skipping gzip measurement');
    }
}

// ── size-003: fs-doom .text bytes (soft, best-effort pre-built binary) ───────
{
    const fsBinPath = join(root, 'tools/freestanding/fs-doom');
    if (!existsSync(fsBinPath)) {
        claimActuals['size-003'] = null;
        console.log('SKIP  size-003  tools/freestanding/fs-doom not found — skipping .text measurement');
    } else {
        const textSz = fsDoomTextSize(fsBinPath);
        if (textSz === null) {
            claimActuals['size-003'] = null;
            console.log('WARN  size-003  `size` failed on tools/freestanding/fs-doom');
        } else {
            claimActuals['size-003'] = String(textSz);
            console.log(`INFO  size-003  fs-doom .text = ${textSz.toLocaleString()} bytes  (locally built i386 ELF; best-effort)`);
        }
    }
}

// ── size-004: README.md "NNN KB of wasm" == round(raw/1024) (HARD) ───────────
// Also verifies claims.json readme-001.expected matches the same computed KB.
// This closes the "12.1 seed" staleness class: no manual step can diverge
// README.md from the actual build without this check failing.
{
    if (wasmRaw !== null) {
        const expectedKB = Math.round(wasmRaw / 1024);

        // (a) README.md check
        const readmePath = join(root, 'README.md');
        const readme = existsSync(readmePath) ? readFileSync(readmePath, 'utf8') : null;
        const readmeMatch = readme ? readme.match(/(\d+)\s*KB of wasm/) : null;
        let readmePass = false;
        let readmeKB = null;
        if (!readmeMatch) {
            hardFailures++;
            console.log(`FAIL  size-004a  README.md: "NNN KB of wasm" figure not found`);
        } else {
            readmeKB = parseInt(readmeMatch[1], 10);
            readmePass = readmeKB === expectedKB;
            if (!readmePass) hardFailures++;
            const tag = readmePass ? 'PASS' : 'FAIL';
            console.log(`${tag}  size-004a  README KB = ${readmeKB}  (build ${wasmRaw.toLocaleString()} B → round/1024 = ${expectedKB} KB)`);
            if (!readmePass) {
                console.log(`      README.md says ${readmeKB} KB but build rounds to ${expectedKB} KB`);
                console.log(`      Fix: change README.md line to "${expectedKB} KB of wasm"`);
                console.log(`      Then update claims.json readme-001.expected to "${expectedKB}"`);
            }
        }

        // (b) claims.json readme-001.expected check
        const claimsPath = join(root, 'tools/archaeology/claims.json');
        let manifestKB = null;
        let manifestPass = false;
        if (existsSync(claimsPath)) {
            const manifest = JSON.parse(readFileSync(claimsPath));
            const entry = manifest.claims?.['readme-001'];
            if (!entry || entry.expected === null || entry.expected === undefined) {
                hardFailures++;
                console.log(`FAIL  size-004b  claims.json readme-001.expected not found`);
            } else {
                manifestKB = parseInt(entry.expected, 10);
                manifestPass = manifestKB === expectedKB;
                if (!manifestPass) hardFailures++;
                const tag = manifestPass ? 'PASS' : 'FAIL';
                console.log(`${tag}  size-004b  claims.json readme-001.expected = ${manifestKB}  (build → ${expectedKB} KB)`);
                if (!manifestPass) {
                    console.log(`      claims.json readme-001.expected is "${manifestKB}" but build rounds to ${expectedKB} KB`);
                    console.log(`      Fix: update claims.json readme-001.expected to "${expectedKB}"`);
                }
            }
        } else {
            console.log('SKIP  size-004b  claims.json not found — skipping manifest KB check');
        }

        claimActuals['size-004'] = readmeKB !== null ? String(readmeKB) : null;
    } else {
        console.log('SKIP  size-004   build/doom.wasm absent — cannot verify README KB');
        claimActuals['size-004'] = null;
    }
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\nsize-ledger: hard failures = ${hardFailures}  (size-001 budget, size-004a README, size-004b manifest)`);
if (hardFailures === 0) {
    console.log('PASS  size-ledger: all hard checks green');
} else {
    console.log(`FAIL  size-ledger: ${hardFailures} hard check(s) failed`);
}
console.log(`CLAIMS_JSON ${JSON.stringify(claimActuals)}`);
if (hardFailures > 0) process.exit(1);
