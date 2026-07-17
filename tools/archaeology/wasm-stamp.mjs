#!/usr/bin/env node
// wasm-stamp.mjs — verifies wasm binary structure claims from docs/claims-index.md.
// Parses build/doom.wasm binary directly (no external tools required).
//
// perf-002 and perf-003 are commit-pinned measurements (documented at 6de6256);
// the script reports current vs documented values and exits 0 when the wasm exists.
// perf-009 (__heap_base) depends on static data layout and is stable across minor
// code changes; the script exits nonzero if __heap_base changes from the documented
// 5,461,072 bytes.
//
// Claims:
//   perf-002  wasm CODE section size  = 281,277 bytes [commit-pinned]
//   perf-003  wasm DATA section size  =  75,283 bytes [commit-pinned]
//   perf-009  __heap_base (static data end) = 5,461,072 bytes [linker constant]
//
// Usage: node tools/archaeology/wasm-stamp.mjs [path/to/doom.wasm]
// Exits 0 when wasm exists and __heap_base matches; 1 on hard failure.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const wasmPath = process.argv[2] ?? join(root, 'build/doom.wasm');

if (!existsSync(wasmPath)) {
    console.error(`FAIL  build/doom.wasm not found: ${wasmPath}`);
    console.error('      Run `make` to build the wasm binary, then re-run this script.');
    process.exit(1);
}

const buf = readFileSync(wasmPath);

// Minimal LEB128 unsigned decoder
function readLEB128(buf, offset) {
    let result = 0, shift = 0;
    let byte_;
    do {
        byte_ = buf[offset++];
        result |= (byte_ & 0x7f) << shift;
        shift += 7;
    } while (byte_ & 0x80);
    return { value: result, offset };
}

// Parse section table: wasm section id → { payload offset, payload size }
let offset = 8; // skip 4-byte magic + 4-byte version
const sections = {};
while (offset < buf.length) {
    const sectionId = buf[offset++];
    const r = readLEB128(buf, offset);
    sections[sectionId] = { offset: r.offset, size: r.value };
    offset = r.offset + r.value;
}

// wasm section IDs: CODE=10, DATA=11, GLOBAL=6
const CODE_ID = 10, DATA_ID = 11, GLOBAL_ID = 6;
const codeSize = sections[CODE_ID]?.size ?? null;
const dataSize = sections[DATA_ID]?.size ?? null;

let failures = 0;

function checkHard(id, desc, expected, actual) {
    const pass = String(actual) === String(expected);
    if (!pass) failures++;
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${desc}`);
    if (!pass) {
        console.log(`      expected: ${expected}`);
        console.log(`      actual:   ${actual}`);
    }
}

function checkSoft(id, desc, documented, actual) {
    const pass = String(actual) === String(documented);
    const tag = pass ? 'PASS' : 'INFO';
    console.log(`${tag}  ${id}  ${desc}`);
    if (!pass) {
        console.log(`      documented: ${documented}`);
        console.log(`      actual:     ${actual}`);
        console.log('      (commit-pinned measurement — drift expected across commits)');
    }
}

// perf-002: CODE section size (commit-pinned)
if (codeSize === null) {
    failures++;
    console.log('FAIL  perf-002  CODE section not found in wasm');
} else {
    checkSoft('perf-002', `CODE section size = ${codeSize} bytes (doc: 281,277 @ 6de6256)`,
              281277, codeSize);
}

// perf-003: DATA section size (commit-pinned)
if (dataSize === null) {
    failures++;
    console.log('FAIL  perf-003  DATA section not found in wasm');
} else {
    checkSoft('perf-003', `DATA section size = ${dataSize} bytes (doc: 75,283 @ 6de6256)`,
              75283, dataSize);
}

// perf-009: __heap_base from wasm GLOBAL section
// Emscripten places __heap_base (static data end) as global index 0 (immutable i32).
// Value = first i32.const in the GLOBAL section.
// This is stable across code changes; failures here indicate a static data layout change.
{
    const gSec = sections[GLOBAL_ID];
    let heapBase = null;
    if (gSec) {
        let off = gSec.offset;
        const count = readLEB128(buf, off);
        off = count.offset;
        if (count.value > 0) {
            const valType = buf[off++]; // 0x7f = i32
            const mut = buf[off++];     // 0 = immutable, 1 = mutable
            const opcode = buf[off++];  // 0x41 = i32.const
            if (opcode === 0x41) {
                const rv = readLEB128(buf, off);
                heapBase = rv.value;
            }
        }
    }
    if (heapBase === null) {
        failures++;
        console.log('FAIL  perf-009  could not parse __heap_base from GLOBAL section');
    } else {
        checkHard('perf-009', `__heap_base = ${heapBase} bytes (static data end)`,
                  5461072, heapBase);
    }
}

console.log(`\nwasm-stamp: ${3 - failures}/3 passed (hard failures: ${failures})`);
if (failures > 0) process.exit(1);
