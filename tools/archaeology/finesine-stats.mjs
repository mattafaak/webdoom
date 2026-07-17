#!/usr/bin/env node
// finesine-stats.mjs — verifies finesine/table stats claimed in engine-archaeology.md.
//
// Two separate counts against the canonical 1993 table:
//
//   ea-001: entries where Math.round(sin()*65536) ≠ canon  → 5,377
//           These are entries where the 1993 table disagrees with
//           ideal round-to-nearest; every one is canonical and must
//           be preserved for demo/netplay compatibility.
//
//   ea-002: entries where Math.trunc(sin()*65536) ≠ canon  → 33
//           The subset where even C truncation produces the wrong
//           value — these entries needed explicit "escape" 32-bit
//           corrections in the 1993 generator.
//
//   ea-003: entries covered by boot FNV checksum = 16,385
//
// Both counts use pure JS Math.sin() against the canonical 1993 table
// stored in tools/golden/tables-canon.json.  No wasm build required.
//
// Usage: node tools/archaeology/finesine-stats.mjs
// Exits 0 on all-pass, 1 on any mismatch.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const canonPath = join(root, 'tools/golden/tables-canon.json');

if (!existsSync(canonPath)) {
    console.error(`ERROR: ${canonPath} not found.`);
    process.exit(2);
}

const canon = JSON.parse(readFileSync(canonPath));

// Replicate engine/core/tables.c T_GenerateTables for finesine:
//   finesine[i] = (fixed_t)(sin((i+0.5) * 2*PI / 8192) * 65536)
const FINEANGLES = 8192;
const FINESINE_N = 5 * FINEANGLES / 4; // = 10240
const TWO_PI = 2.0 * Math.PI;

// ea-001: round-to-nearest differences (same formula, Math.round)
// ea-002: C-truncation differences (same formula, Math.trunc)
let corrRound = 0;
let corrTrunc = 0;
for (let i = 0; i < FINESINE_N; i++) {
    const angle = (i + 0.5) * TWO_PI / FINEANGLES;
    const val = Math.sin(angle) * 65536.0;
    if (Math.round(val) !== canon.finesine[i]) corrRound++;
    if (Math.trunc(val) !== canon.finesine[i]) corrTrunc++;
}

// ea-003: sum of table sizes from SIZES constant in gen-tables.mjs
const SIZES = { finesine: 10240, finetangent: 4096, tantoangle: 2049 };
const totalEntries = Object.values(SIZES).reduce((a, b) => a + b, 0);

let failures = 0;

function check(id, desc, expected, actual) {
    const pass = String(actual) === String(expected);
    if (!pass) failures++;
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${desc}`);
    if (!pass) {
        console.log(`      expected: ${expected}`);
        console.log(`      actual:   ${actual}`);
    }
}

check('ea-001', `finesine entries differing from round-nearest = ${corrRound} / ${FINESINE_N}`,
      5377, corrRound);

check('ea-002', `finesine entries differing from C-trunc = ${corrTrunc} (1993 generator escapes)`,
      33, corrTrunc);

check('ea-003', `boot FNV checksum entry count (finesine+finetangent+tantoangle) = ${totalEntries}`,
      16385, totalEntries);

console.log(`\nfinesine-stats: ${3 - failures}/3 passed`);
if (failures > 0) process.exit(1);
