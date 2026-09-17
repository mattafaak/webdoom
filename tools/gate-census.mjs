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
import { dirname, join } from 'node:path';
import { root } from './lib/util.mjs';

const REGISTRY = join(root, 'tools/gates-not-in-suite.json');
const ROOTS = ['tools/run-tests.sh'];

// A tool is "gate-shaped" if its name says it checks something.  Deliberately a
// name heuristic: it must not need a registry entry to be DISCOVERED, or an
// unregistered orphan would be invisible to the census meant to find it.
// `bench` is in the list because spec.md:55 names bench.mjs as the PERF GATE.
// Without it, tools/bench.mjs and tools/fleet-bench.sh were not gate-shaped, so
// the census -- whose whole job is finding gates nothing runs -- could never
// have reported the spec's own required gate as orphaned. It was invisible to
// the instrument built to notice exactly that.
//
// Round 8 added stamp|ledger|drift|summary|index for the same reason: the whole
// claims-machinery class -- wasm-stamp, size-ledger, doc-drift, ledger-count,
// claims-summary -- was invisible to the census, and one of them (wasm-stamp)
// had never been run by any suite leg.  Adding them found zero new orphans, so
// this change closes NOTHING by itself; the stamp-full leg is the fix.  Note
// the limit that remains: reachability here is a text grep, so wasm-stamp.mjs
// counted as "run by the suite" while sitting inside `if [ "$FULL" = "1" ]` in
// verify-all.sh, which the default tier never takes.  The census cannot see tiers.
const GATEISH = /(^|[/-])(test|check|verify|fuzz|gate|witness|precache|smoke|census|bench|stamp|ledger|drift|summary|index)[-.]|[-](test|check|gate|bench|stamp|ledger|index)\.(mjs|sh)$|(^|\/)run-[a-z0-9-]+\.(mjs|sh)$/;   // a tools/run-*.sh IS a runner

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
    const out = [...text.matchAll(/tools\/[A-Za-z0-9_./-]+\.(?:mjs|sh)/g)].map(m => m[0]);

    // A sibling invoked through the caller's own directory is still a
    // reference, and the `tools/…` pattern above cannot see one.
    //
    // tools/freestanding/arm-check.sh ends with
    //     exec bash "$SCRIPT_DIR/be-check.sh" "$@"
    // and the green `arm-cross` leg runs arm-check.sh -- so be-check.sh IS
    // reachable from the suite. The census could not tell, so it stayed in
    // gates-not-in-suite.json under a reason ("wiring it would make the suite
    // permanently red") that the registry's own registeredButReachable
    // assertion exists to catch and could not.
    const dir = dirname(file);
    for (const m of text.matchAll(/\$\{?SCRIPT_DIR\}?\/([A-Za-z0-9_.-]+\.(?:mjs|sh))/g))
        out.push(join(dir, m[1]).replaceAll('\\', '/'));

    // An ES import is a reference too, and it is spelled RELATIVELY.
    //
    // This file's own header said "the fuzz runners import gen-map.mjs" while
    // the census counted gen-map.mjs as an orphan, because the pattern above
    // only sees a literal `tools/...` path and an import is `./gen-map.mjs`.
    // Three tools were being called unreachable while suite legs ran them
    // every time: png-stats.mjs (firefox-frame-test and browser-fire decode
    // their capture with it), gen-map.mjs (adversarial-map) and gen-demo.mjs
    // (fuzz-diff).  Registering those three as "outside the suite by design"
    // would have written down the opposite of what happens.
    for (const m of text.matchAll(/(?:from|import)\s*\(?\s*['"](\.[A-Za-z0-9_./-]+\.(?:mjs|js))['"]/g))
        out.push(join(dir, m[1]).replaceAll('\\', '/'));
    return out;
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
let registry = {}, measurement = {};
if (existsSync(REGISTRY)) {
    const parsed = JSON.parse(readFileSync(REGISTRY, 'utf8'));
    registry = parsed.not_in_suite ?? {};
    measurement = parsed.measurement_tools ?? {};
}

// ── the OTHER roster: tools that produce numbers, not verdicts ───────────────
//
// `not_in_suite` covers gate-shaped tools nothing runs.  This covers the rest:
// a tool that emits a table or an artifact has nothing for a leg to assert, so
// the census cannot grade it by reachability -- but it can insist the set is
// WRITTEN DOWN, and that the writing matches the tree both ways.
//
// It lived in tools/archaeology/README.md as a prose sentence with no checker,
// which is why deploy.sh was in neither list, and why that sentence said "no leg
// runs them" about bench.mjs and browser-pipeline.mjs -- both of which legs do
// run.  Prose about which tools exist rots exactly like a count does.
//
// MIND THE PATH SPELLING IN THESE COMMENTS.  Reachability is a text grep, so it
// cannot tell an invocation from a mention: writing the full `tools/<name>.sh`
// of a tool inside any suite-reachable file marks that tool as run by the suite.
// This very paragraph did it while being written -- deploy.sh, named in full one
// line up, was instantly "reachable" and the new assertion below failed on it.
// Name a tool by its basename in prose here, and keep full paths for real calls.
const measurementCandidates = tracked.filter(
    f => /\.(mjs|sh|py)$/.test(f) && !f.startsWith('tools/lib/'));
const unlisted = measurementCandidates.filter(
    f => !GATEISH.test(f) && !reachable.has(f) && !(f in measurement));
const staleMeasurement = Object.keys(measurement).filter(f => !existsSync(join(root, f)));
const measurementReachable = Object.keys(measurement).filter(f => reachable.has(f));

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
if (unlisted.length) {
    console.log(`FAIL gate-census: ${unlisted.length} tool(s) are neither gate-shaped, nor run by the suite, nor listed as measurement tools:`);
    for (const f of unlisted) console.log(`    ${f}`);
    console.log(`  Say what each one produces in ${REGISTRY.replace(root + '/', '')} under measurement_tools, or wire it into a leg.`);
    bad++;
}
if (staleMeasurement.length) {
    console.log(`FAIL gate-census: measurement_tools names ${staleMeasurement.length} file(s) that no longer exist:`);
    for (const f of staleMeasurement) console.log(`    ${f}`);
    bad++;
}
if (measurementReachable.length) {
    console.log(`FAIL gate-census: ${measurementReachable.length} file(s) are listed as measurement tools but the suite runs them:`);
    for (const f of measurementReachable) console.log(`    ${f}`);
    console.log('  A tool a leg runs is not outside the suite; drop the entry.');
    bad++;
}
if (bad) process.exit(1);

const inSuite = gates.filter(g => reachable.has(g)).length;
console.log(`PASS gate-census: ${gates.length} gate-shaped tools — ${inSuite} run by the suite, ` +
            `${Object.keys(registry).length} registered out-of-suite with a reason, 0 orphaned; ` +
            `${Object.keys(measurement).length} measurement tools listed, 0 unaccounted ` +
            `(of ${measurementCandidates.length} non-library tools)`);
