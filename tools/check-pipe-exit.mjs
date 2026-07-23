#!/usr/bin/env node
// tools/check-pipe-exit.mjs — static gate against the pipe-exit-code trap.
//
// The trap: without `pipefail`, a shell pipeline reports the exit status of
// the LAST command, not the failing one.  So
//
//     node tools/demo-test.mjs | tail -1     # demo-test FAILS
//     rc=$?                                  # rc == 0  (tail succeeded)
//
// reports a red gate as green.  This has happened six times in this project.
//
// With `set -o pipefail` the same code is correct: the pipeline takes the
// rightmost non-zero status, so `$?` reflects the real failure.  That makes
// the rule below both complete and free of false positives:
//
//     any shell script containing a pipeline MUST enable pipefail.
//
// For interactive / ad-hoc commands (where this bug has actually bitten most
// often) there is no script to lint — use tools/gate.sh, which runs the
// command outside any pipeline and prints its true code.
//
// Usage:
//   node tools/check-pipe-exit.mjs          # check committed *.sh
//   node tools/check-pipe-exit.mjs FILE...  # check specific files

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

// Strip comments and quoted spans so a `|` inside them is not read as a pipe.
function stripNoise(line) {
    let out = '';
    let quote = null;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quote) {
            if (c === quote && line[i - 1] !== '\\') quote = null;
            continue;                      // drop quoted content
        }
        if (c === '"' || c === "'") { quote = c; continue; }
        if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) break;  // comment
        out += c;
    }
    return out;
}

// A real pipe: a single `|` that is not part of `||`.
function hasPipe(line) {
    const s = stripNoise(line);
    for (let i = 0; i < s.length; i++) {
        if (s[i] !== '|') continue;
        if (s[i + 1] === '|') { i++; continue; }   // logical OR
        if (s[i - 1] === '|') continue;            // second half of ||
        if (s[i + 1] === '&') continue;            // |& (stderr redirect)
        return true;
    }
    return false;
}

const PIPEFAIL = /set\s+-[a-zA-Z]*o\s+pipefail|set\s+-o\s+pipefail|setopt\s+.*pipefail/;

const files = process.argv.length > 2
    ? process.argv.slice(2)
    : execSync("git ls-files '*.sh'", { encoding: 'utf8' }).trim().split('\n').filter(Boolean);

let failures = 0;
let checked = 0;
let withPipes = 0;

for (const file of files) {
    let text;
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    checked++;

    const lines = text.split('\n');
    const pipeLines = [];
    lines.forEach((line, i) => { if (hasPipe(line)) pipeLines.push(i + 1); });
    if (pipeLines.length === 0) continue;
    withPipes++;

    if (PIPEFAIL.test(text)) continue;

    failures++;
    const shown = pipeLines.slice(0, 3).join(', ');
    const more = pipeLines.length > 3 ? ` (+${pipeLines.length - 3} more)` : '';
    console.log(`FAIL ${file}: uses pipelines (line ${shown}${more}) but never enables pipefail`);
    console.log('     without pipefail a failing command inside a pipeline reports exit 0');
    console.log("     fix: add `set -o pipefail` (or `set -eo pipefail`) near the top");
}

console.log(`pipe-exit check: ${checked} script(s), ${withPipes} using pipelines, ${failures} failure(s)`);
if (failures) {
    console.log('FAIL — see tools/gate.sh for the ad-hoc/interactive equivalent');
    process.exit(1);
}
console.log('PASS — every pipeline-using shell script enables pipefail');
