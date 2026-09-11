#!/usr/bin/env node
// tools/gate-census.mjs — every gate-shaped tool is either reachable from the
// suite or listed, with a reason, as deliberately outside it.
//
// WHY THIS EXISTS
// ---------------
// Commit 5ea1f08 wired five orphaned feature tests into the suite by hand and
// judged the rest "correctly unwired".  That judgement was right about some and
// wrong about others, and nothing preserved it either way: tools/demo-verify.mjs
// (the shipped 19.4 CLI) is invoked by nothing and its test re-implements the
// logic instead of importing it, and README advertises the native ASan demo
// suite as part of the gate set while tools/native-sanitize/run-all.sh is run
// only by hand.  A one-time audit decays; a census does not.
//
// Reachability is TRANSITIVE: lint.sh runs check-pipe-exit.mjs, verify-all.sh
// runs seven archaeology verifiers, the fuzz runners import gen-map.mjs.  A
// direct grep of run-tests.sh would call all of those orphans and teach the
// reader to ignore the list.
//
// usage: node tools/gate-census.mjs [--list]
// Exit 0 iff every discovered gate is reachable or registered.
//
// Copyright (C) 2026, GPL-2.0-or-later.
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = join(root, 'tools/gates-not-in-suite.json');
const ROOTS = ['tools/run-tests.sh'];

// A tool is "gate-shaped" if its name says it checks something.  Deliberately a
// name heuristic: it must not need a registry entry to be DISCOVERED, or an
// unregistered orphan would be invisible to the census meant to find it.
const GATEISH = /(^|[/-])(test|check|verify|fuzz|gate|witness|precache|smoke|census)[-.]|[-](test|check|gate)\.(mjs|sh)$|(^|\/)run-[a-z0-9-]+\.(mjs|sh)$/;   // a tools/run-*.sh IS a runner

const tracked = execSync('git ls-files tools', { cwd: root, encoding: 'utf8' })
    .split('\n').filter(Boolean);
const gates = tracked.filter(f => /\.(mjs|sh)$/.test(f) && GATEISH.test(f));

// ── transitive reachability from the suite ───────────────────────────────────
const refsIn = file => {
    const abs = join(root, file);
    if (!existsSync(abs)) return [];
    let text;
    // Several of these embed raw fuzz bytes; read as latin1 so a non-UTF-8 byte
    // cannot truncate the scan (the same reason headline() uses `grep -a`).
    try { text = readFileSync(abs, 'latin1'); } catch { return []; }
    return [...text.matchAll(/tools\/[A-Za-z0-9_./-]+\.(?:mjs|sh)/g)].map(m => m[0]);
};
const reachable = new Set();
const queue = [...ROOTS];
while (queue.length) {
    const f = queue.pop();
    if (reachable.has(f)) continue;
    reachable.add(f);
    for (const r of refsIn(f)) if (!reachable.has(r)) queue.push(r);
}

// ── the registry of deliberate exclusions ────────────────────────────────────
let registry = {};
if (existsSync(REGISTRY)) registry = JSON.parse(readFileSync(REGISTRY, 'utf8')).not_in_suite ?? {};

const orphans = gates.filter(g => !reachable.has(g) && !(g in registry));
const staleEntries = Object.keys(registry).filter(f => !existsSync(join(root, f)));
const registeredButReachable = Object.keys(registry).filter(f => reachable.has(f));

if (process.argv.includes('--list')) {
    for (const g of gates)
        console.log(`  ${reachable.has(g) ? 'in-suite ' : (g in registry ? 'registered' : 'ORPHAN   ')} ${g}`);
    process.exit(0);
}

// A census that discovered almost nothing is a broken census, not a clean bill
// of health — the roster-discovery lesson.
if (gates.length < 20) {
    console.log(`FAIL gate-census: discovered only ${gates.length} gate-shaped tools; the repo has more`);
    process.exit(1);
}
if (reachable.size < 10) {
    console.log(`FAIL gate-census: reached only ${reachable.size} files from the suite; the walk is broken`);
    process.exit(1);
}

let bad = 0;
if (orphans.length) {
    console.log(`FAIL gate-census: ${orphans.length} gate-shaped tool(s) neither run by the suite nor registered:`);
    for (const o of orphans) console.log(`    ${o}`);
    console.log(`  Wire it into tools/run-tests.sh, or add it to ${REGISTRY.replace(root + '/', '')} with a reason.`);
    bad++;
}
if (staleEntries.length) {
    console.log(`FAIL gate-census: registry names ${staleEntries.length} file(s) that no longer exist:`);
    for (const f of staleEntries) console.log(`    ${f}`);
    bad++;
}
if (registeredButReachable.length) {
    console.log(`FAIL gate-census: ${registeredButReachable.length} file(s) are registered as out-of-suite but the suite runs them:`);
    for (const f of registeredButReachable) console.log(`    ${f}`);
    bad++;
}
if (bad) process.exit(1);

const inSuite = gates.filter(g => reachable.has(g)).length;
console.log(`PASS gate-census: ${gates.length} gate-shaped tools — ${inSuite} run by the suite, ` +
            `${Object.keys(registry).length} registered out-of-suite with a reason, 0 orphaned`);
