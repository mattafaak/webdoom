#!/usr/bin/env node
// tools/toggle-identity-check.mjs — the ledger's md5 claims, checked.
//
// WHY THIS EXISTS
// ---------------
// docs/optimization-ledger.md makes the load-bearing claim of the whole 20.3
// FastDoom harvest four times over:
//
//     | **toggle-off byte-identity** | `build/doom.wasm` md5 = `c669...` (proven) |
//
// "proven" meant a human ran md5sum once.  Nothing re-checked it, so the claim
// that every toggle is inert when off — the thing that makes it safe to ship
// four compile-time switches into a vanilla-exact engine — rested on a number
// typed into a document.  That is failure mode #2: a value that reports itself
// is not the value that is in force.
//
// Each entry also pins the toggle-ON artifact's md5 and size, so a toggle build
// that silently changed is catchable the same way.
//
// usage: node tools/toggle-identity-check.mjs
// Exit 0 iff every md5/size the ledger states matches the artifact on disk (or
// the artifact is absent, which is reported and counted, never silently passed).
//
// Copyright (C) 2026, GPL-2.0-or-later.
import { readFileSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const LEDGER = join(root, 'docs/optimization-ledger.md');

const text = readFileSync(LEDGER, 'utf8');

// `build-potato/doom.wasm` md5 = `abc...`. Size 123,456 bytes
const CLAIM = /`(build[a-z-]*)\/doom\.wasm`\s*md5\s*=\s*`([0-9a-f]{32})`(?:[^|\n]*?Size\s+([\d,]+)\s+bytes)?/g;

const claims = [];
for (const m of text.matchAll(CLAIM)) {
    claims.push({ dir: m[1], md5: m[2], size: m[3] ? Number(m[3].replace(/,/g, '')) : null });
}

// A check that found no claims is broken, not clean — if the ledger's table
// formatting changes, this must fail rather than silently verify nothing.
if (claims.length < 4) {
    console.log(`FAIL toggle-identity: found only ${claims.length} md5 claim(s) in the ledger; ` +
                `the 20.3a-d entries state at least 4. The parser or the doc changed.`);
    process.exit(1);
}

const md5of = p => createHash('md5').update(readFileSync(p)).digest('hex');
let checked = 0, absent = 0, bad = 0;
const seen = new Map();      // dir -> md5 the doc claims, to catch self-contradiction

for (const c of claims) {
    const prior = seen.get(c.dir);
    if (prior && prior !== c.md5) {
        console.log(`FAIL toggle-identity: the ledger states two different md5s for ${c.dir}/doom.wasm:`);
        console.log(`    ${prior}  and  ${c.md5}`);
        bad++;
        continue;
    }
    seen.set(c.dir, c.md5);

    const file = join(root, c.dir, 'doom.wasm');
    if (!existsSync(file)) {
        console.log(`  NOT BUILT ${c.dir}/doom.wasm — claim ${c.md5.slice(0, 12)}… not checked`);
        absent++;
        continue;
    }
    const actual = md5of(file);
    const actualSize = statSync(file).size;
    if (actual !== c.md5) {
        console.log(`FAIL ${c.dir}/doom.wasm: ledger says md5 ${c.md5}, artifact is ${actual}`);
        if (c.dir === 'build')
            console.log('     this is the toggle-off byte-identity claim: every 20.3 toggle rests on it');
        bad++;
        continue;
    }
    if (c.size !== null && c.size !== actualSize) {
        console.log(`FAIL ${c.dir}/doom.wasm: ledger says ${c.size} bytes, artifact is ${actualSize}`);
        bad++;
        continue;
    }
    console.log(`  ok ${c.dir}/doom.wasm md5 ${actual.slice(0, 12)}…${c.size !== null ? ` size ${actualSize}` : ''}`);
    checked++;
}

if (bad) {
    console.log(`FAIL toggle-identity: ${bad} of ${claims.length} ledger md5 claim(s) do not match the artifacts`);
    console.log('');
    console.log('  The question this red asks is: DID YOU CHANGE THE ENGINE?');
    console.log('    yes -> expected. Every toggle build is the same engine plus one #ifdef, so');
    console.log('           an engine change moves all five md5s. Update the rows in the SAME');
    console.log('           commit as the change; the diff is then the evidence.');
    console.log('    no  -> something is wrong. A toggle artifact drifted without a source change,');
    console.log('           or a row was edited, or a build is not reproducible.');
    console.log('  Current values, for the rows:');
    for (const [dir] of seen) {
        const f = join(root, dir, 'doom.wasm');
        if (existsSync(f))
            console.log(`    \`${dir}/doom.wasm\` md5 = \`${md5of(f)}\`. Size ` +
                        `${statSync(f).size.toLocaleString('en-US')} bytes`);
    }
    process.exit(1);
}
if (!checked) {
    console.log(`FAIL toggle-identity: ${claims.length} claim(s) found but NONE could be checked ` +
                `(no artifacts built) — this is not a pass`);
    process.exit(1);
}
console.log(`PASS toggle-identity: ${checked} of ${claims.length} ledger md5 claims verified against ` +
            `the artifacts${absent ? `, ${absent} not built` : ''}`);
