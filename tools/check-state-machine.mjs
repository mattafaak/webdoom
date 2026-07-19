#!/usr/bin/env node
// check-state-machine.mjs — mechanical edge↔test mapping checker.
// Validates that docs/state-machine.md edge IDs are fully mapped to live tests.
//
// Checks (fail rc≠0 on any):
//   (a) Transition-table edge ID missing from the mapping table
//   (b) Mapping row's test file does not exist
//   (c) Mapping row's test file does not reference the edge ID (Txx token)
//   (d) Mermaid diagram references an edge ID absent from the transition table
//   (e) Coverage prose claim ("N/N edges covered") does not match actual count
//
// usage: node tools/check-state-machine.mjs [--doc <path>] [--tools-dir <path>]

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, '..');

function parseArgs() {
    const args = process.argv.slice(2);
    let docPath = resolve(repoRoot, 'docs/state-machine.md');
    let toolsDir = resolve(repoRoot, 'tools');
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--doc' && args[i + 1]) docPath = resolve(args[++i]);
        if (args[i] === '--tools-dir' && args[i + 1]) toolsDir = resolve(args[++i]);
    }
    return { docPath, toolsDir };
}

const { docPath, toolsDir } = parseArgs();

if (!existsSync(docPath)) {
    console.error(`FAIL: doc not found: ${docPath}`);
    process.exit(1);
}
const doc = readFileSync(docPath, 'utf8');
const lines = doc.split('\n');

// ── (1) Parse transition table: extract all edge IDs from | Txx | ... rows ──
// Matches lines like: | T07 | LANDING | MP-LOBBY | ... |
const transitionTableEdges = new Set();
const transitionTableRegex = /^\|\s*(T\d+)\s*\|/;

// We want only the rows inside the Transitions section (before mermaid).
// Find the section boundaries to avoid picking up mapping table rows.
const transitionsStart = lines.findIndex(l => l.trim() === '## Transitions');
const mermaidStart = lines.findIndex(l => l.trim() === '## Mermaid state diagram');
const edgeMapStart = lines.findIndex(l => l.trim() === '## Edge → test coverage');

if (transitionsStart === -1 || mermaidStart === -1 || edgeMapStart === -1) {
    console.error('FAIL: could not locate required sections in state-machine.md');
    console.error(`  ## Transitions: ${transitionsStart}`);
    console.error(`  ## Mermaid state diagram: ${mermaidStart}`);
    console.error(`  ## Edge → test coverage: ${edgeMapStart}`);
    process.exit(1);
}

for (let i = transitionsStart; i < mermaidStart; i++) {
    const m = lines[i].match(transitionTableRegex);
    if (m) transitionTableEdges.add(m[1]);
}

// ── (2) Parse edge→test mapping table ────────────────────────────────────────
// Rows like: | T07 | LANDING → MP-LOBBY | `lobby-menu-nav` | browser-lobby-test.mjs |
const mappingRows = [];   // { edgeId, transition, testName, fileName, lineNum }
const mappingEdgeIds = new Set();

for (let i = edgeMapStart; i < lines.length; i++) {
    const l = lines[i];
    // Skip header and separator rows
    if (!l.startsWith('|') || l.includes('Edge ID') || /^\|[-\s|]+\|$/.test(l.trim())) continue;
    // Match: | Txx | anything | `test-name` | file.mjs |
    // The test name cell may have backticks or be plain; the file cell ends the row.
    // Use a permissive split to handle prose in the transition column.
    const cells = l.split('|').map(c => c.trim()).filter((_, idx) => idx > 0);
    // cells[0]=edgeId, cells[1]=transition, cells[2]=testName, cells[3]=fileName
    if (cells.length < 4) continue;
    const edgeId = cells[0];
    if (!/^T\d+$/.test(edgeId)) continue;
    // fileName may have trailing spaces or inline notes — take first word
    const rawFile = cells[3].split(/\s/)[0];
    const testName = cells[2].replace(/`/g, '');
    mappingRows.push({ edgeId, transition: cells[1], testName, fileName: rawFile, lineNum: i + 1 });
    mappingEdgeIds.add(edgeId);
}

// ── (3) Parse mermaid diagram for edge ID tokens (Txx) ───────────────────────
const mermaidEnd = lines.findIndex((l, i) => i > mermaidStart && l.trim() === '```');
const mermaidEdges = new Set();
const mermaidEdgeRegex = /\((T\d+)\)/g;

for (let i = mermaidStart; i < (mermaidEnd === -1 ? lines.length : mermaidEnd + 1); i++) {
    let match;
    while ((match = mermaidEdgeRegex.exec(lines[i])) !== null) {
        mermaidEdges.add(match[1]);
    }
}

// ── (4) Parse coverage claim ──────────────────────────────────────────────────
// Matches: "Coverage: **25 / 25 edges** covered."
let claimedCovered = -1, claimedTotal = -1;
for (const l of lines) {
    const m = l.match(/Coverage:\s*\*?\*?(\d+)\s*\/\s*(\d+)\s*edge/i);
    if (m) { claimedCovered = parseInt(m[1]); claimedTotal = parseInt(m[2]); break; }
}

// ── Run checks ────────────────────────────────────────────────────────────────
let failures = 0;
const findings = [];   // aspirational-row annotations (warn, not fail)

function fail(msg) {
    console.error(`  FAIL  ${msg}`);
    failures++;
}
function warn(msg) {
    console.warn(`  WARN  ${msg}`);
    findings.push(msg);
}
function ok(msg) {
    console.log(`  ok    ${msg}`);
}

console.log(`\n── check-state-machine: ${docPath} ──────────────────────────────`);
console.log(`  Transition-table edges: ${[...transitionTableEdges].sort().join(', ')}`);
console.log(`  Mapping rows: ${mappingRows.length}`);
console.log(`  Mermaid edge tokens: ${[...mermaidEdges].sort().join(', ')}`);
console.log('');

// (a) Every transition-table edge must appear in the mapping table
for (const id of [...transitionTableEdges].sort()) {
    if (!mappingEdgeIds.has(id)) {
        fail(`(a) ${id}: in transition table but missing from edge→test mapping`);
    }
}

// (b) + (c) Each mapping row: file must exist; file must reference the edge ID
for (const row of mappingRows) {
    const filePath = resolve(toolsDir, row.fileName);
    if (!existsSync(filePath)) {
        fail(`(b) ${row.edgeId}: test file does not exist: ${row.fileName} (line ${row.lineNum})`);
        continue;
    }
    const src = readFileSync(filePath, 'utf8');
    // grep for the Txx token as a word-boundary match
    const pattern = new RegExp(`\\b${row.edgeId}\\b`);
    if (!pattern.test(src)) {
        fail(`(c) ${row.edgeId}: not referenced in ${row.fileName} (grep for '${row.edgeId}' found nothing)`);
    } else {
        ok(`${row.edgeId} → ${row.fileName} (token found)`);
    }
}

// (d) Every mermaid edge ID must exist in the transition table
for (const id of [...mermaidEdges].sort()) {
    if (!transitionTableEdges.has(id)) {
        fail(`(d) ${id}: mermaid references edge ID absent from transition table`);
    }
}

// (e) Coverage claim must match actual mapping count
const actualMapped = mappingEdgeIds.size;
const totalTransitions = transitionTableEdges.size;
if (claimedCovered === -1) {
    fail(`(e) Coverage claim not found in doc`);
} else if (claimedCovered !== actualMapped) {
    fail(`(e) Coverage claim says ${claimedCovered} covered but mapping table has ${actualMapped} rows`);
} else if (claimedTotal !== totalTransitions) {
    fail(`(e) Coverage claim says ${claimedTotal} total but transition table has ${totalTransitions} edges`);
} else {
    ok(`(e) Coverage claim ${claimedCovered}/${claimedTotal} matches actual mapping (${actualMapped}/${totalTransitions})`);
}

// ── Summary ────────────────────────────────────────────────────────────────────
console.log('');
if (failures === 0) {
    console.log(`PASS — check-state-machine: ${actualMapped}/${totalTransitions} edges verified, 0 failures`);
    if (findings.length > 0) {
        console.log(`  (${findings.length} warnings — all annotated above)`);
    }
    process.exit(0);
} else {
    console.log(`FAIL — check-state-machine: ${failures} failure(s) above`);
    process.exit(1);
}
