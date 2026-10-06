#!/usr/bin/env node
// Two ways a test tool here has lied about its result (CLAUDE.md, "Three ways a
// gate you just wrote can lie to you"), checked over every tool:
//
//   R1  registers uncaughtException, and neither the handler nor an exit hook
//       fails, so an uncaught error ends the test with exit 0
//   R3  drives several hostile cases through one connection or engine, and
//       never checks afterwards that the subject still works, so the first
//       case can silence the rest
//
// A tool that is right for a reason this cannot see says so on a line of its
// own: `// VACUITY-EXEMPT R<n>: <reason>`.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { root } from './lib/util.mjs';

const dirs = ['tools', 'tools/fuzz', 'tools/lib'];
const files = dirs.flatMap(d => readdirSync(join(root, d)).filter(f => f.endsWith('.mjs')).map(f => `${d}/${f}`));

function r1(text) {
    const m = /process\.on\(\s*['"]uncaughtException['"][\s\S]{0,400}?\n\}\)|process\.on\(\s*['"]uncaughtException['"][^\n]*\n?/.exec(text);
    if (!m) return null;
    // a handler that exits non-zero itself, or through a cleanup/fail helper
    const handlerFails = /process\.exit\(\s*[1-9]|process\.exitCode\s*=\s*[1-9]|\b(?:cleanup|fail|fatal|die|bail)\s*\(\s*(?:[1-9]|['"`])/.test(m[0]);
    const exitHookFails = /lib\/report\.mjs/.test(text)
        || (/process\.on\(\s*['"]exit['"]/.test(text) && /(printed|summarised|summarized|reported|finished|done)\b/.test(text));
    return handlerFails || exitHookFails ? null
        : 'registers uncaughtException and neither the handler nor an exit hook fails: an uncaught error exits 0';
}
function r3(text, file) {
    if (!/hostile|adversarial|fuzz|malformed|corrupt/i.test(file + text)) return null;
    if ((text.match(/\bcase\s*\d|\bCASES\b|\bcases\s*=\s*\[/gi) || []).length < 2) return null;
    if ((text.match(/new WebSocket\(|bootEngine\(|createDoom\(|spawn(Sync)?\(/g) || []).length !== 1) return null;
    return /still (works|lands|accepted|simulating|running|alive)|legitimate .*still|normal path/i.test(text) ? null
        : 'drives several hostile cases through one connection or engine and never checks afterwards that it still works';
}

let findings = 0;
for (const f of files) {
    const text = readFileSync(join(root, f), 'utf8');
    for (const [name, rule] of [['R1', r1], ['R3', r3]]) {
        const why = rule(text, f);
        if (!why || new RegExp(`VACUITY-EXEMPT\\s+${name}\\b`).test(text)) continue;
        findings++;
        console.log(`FAIL  ${name}  ${f}: ${why}`);
    }
}
if (files.length < 50) { console.log(`FAIL check-test-exits: found only ${files.length} tool files`); process.exit(1); }
if (findings) { console.log(`FAIL check-test-exits: ${findings} finding(s) in ${files.length} tool files`); process.exit(1); }
console.log(`check-test-exits: ${files.length} tool files, none can exit 0 after giving up (R1) or disarm its own later cases (R3)`);
