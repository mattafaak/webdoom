#!/usr/bin/env node
// Gate: every leg is checked against the three ways a gate can lie to you.
//
// CLAUDE.md names three, all found in round 5 by writing gates rather than by
// theory, and round 12 found a fourth shape (a gate verifying the layer next to
// the hole).  Task 26.4 asked for the SURVEY those discoveries never got: all
// of them were found by tracing one bug, so nobody knows how many more there
// are.  This is that survey, as a gate, so the answer stops being a guess and a
// new leg cannot be born with the defect.
//
// The three rules, and how each is decided here:
//
//   R1  AN uncaughtException HANDLER LETS A TEST EXIT 0 AFTER GIVING UP.
//       With one registered, an uncaught error no longer kills the process:
//       module evaluation aborts where it threw, the event loop drains, and
//       node exits 0.  hostile-lobby-test printed 14 FAIL lines, died before
//       its summary, and exited zero.  A file that registers the handler must
//       also make the summary the only sanctioned exit -- a flag set when the
//       summary prints, and a `process.on('exit')` that fails if it did not.
//
//   R2  A PASS THAT CAN HAPPEN WITH NOTHING VERIFIED.  A WAD-less checkout
//       once skipped all 13 demos and still printed PASS.  A file that prints
//       a PASS line must gate it on a FLOOR: a comparison of its own assertion
//       count against a minimum, before the PASS.
//
//   R3  ONE CASE CAN DISARM THE NEXT.  hostile-lobby-test read 24 PASS / 1 FAIL
//       against a broken client because the first malformed frame threw out of
//       ws.onmessage, after which that socket delivered nothing and every later
//       assertion passed by observing NOTHING.  A file that drives more than
//       one hostile case must give each its own connection, process or module.
//
// A file may declare an exemption with a comment naming the rule and the
// reason, on its own line:
//
//   // VACUITY-EXEMPT R2: <why this file cannot have an assertion floor>
//
// An exemption is a claim a reader can check, which is the point; "it is fine"
// is not a reason.
//
// usage: node tools/vacuity-census.mjs [--list] [--json]
//
// Copyright (C) 2026, GPL-2.0-or-later.
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { root } from './lib/util.mjs';

const RUNNER = join(root, 'tools/run-tests.sh');

// ── which files are legs ─────────────────────────────────────────────────────
// Read the leg registry the way the runner declares it, so the census covers
// what the suite RUNS rather than what happens to look like a test.
const runner = readFileSync(RUNNER, 'utf8');
const legs = [], noTool = [];
// NOTE THE LEADING \s*.  The nineteen browser legs are declared INDENTED, inside
// the block that brings up their shared server, and a pattern anchored at `^leg`
// silently covered 63 of 82 and printed PASS -- this file committing, on its
// first run, the exact defect it exists to find.  The roster cross-check below
// is what makes that impossible to repeat.
for (const m of runner.matchAll(/^\s*leg\s+(\S+)\s+\S+\s+"[^"]*"\s+--\s+(.+)$/gm)) {
    const [, id, cmd] = m;
    const files = [...cmd.matchAll(/tools\/[A-Za-z0-9_./-]+\.(?:mjs|sh)/g)].map(x => x[0]);
    if (files.length) legs.push({ id, files });
    else noTool.push(id);
}

// THE ROSTER MUST MATCH THE SUITE'S OWN.  Counting what a regex happened to
// find, and calling that "every leg", is how a census reports a clean bill of
// health over two thirds of the tree.  `--list` is the runner's own answer.
const declared = Number(
    execSync('bash tools/run-tests.sh --list', { cwd: root, encoding: 'utf8' })
        .match(/\((\d+) legs\)/)?.[1] ?? 0);
if (declared === 0) {
    console.log('FAIL vacuity-census: could not read the leg count from tools/run-tests.sh --list');
    process.exit(1);
}
if (legs.length + noTool.length !== declared) {
    console.log(`FAIL vacuity-census: the runner declares ${declared} legs, this census found ` +
                `${legs.length + noTool.length} (${legs.length} with a tool file, ${noTool.length} without). ` +
                'A census that covers a subset and says PASS is the defect it is looking for.');
    process.exit(1);
}

// ── the rules ────────────────────────────────────────────────────────────────
const exempt = (text, rule) =>
    new RegExp(`VACUITY-EXEMPT\\s+${rule}\\b`).test(text);

// R1: registers uncaughtException, and nothing makes the process fail anyway.
//
// Two sanctioned guards, and the first is the common one: the HANDLER ITSELF
// exits nonzero, so the throw it caught is still fatal.  The other is the
// report.mjs shape -- let the handler observe, and fail from a `process.on
// ('exit')` hook when the summary never printed.  A first cut of this rule
// checked only the second and called all six netcode legs defective; every one
// of them ends its handler with process.exit(1), which is correct, and the
// round-5 lesson turned out to be applied consistently across the tree.
function r1(text) {
    const m = /process\.on\(\s*['"]uncaughtException['"][\s\S]{0,400}?\n\}\)|process\.on\(\s*['"]uncaughtException['"][^\n]*\n?/.exec(text);
    if (!m) return null;
    const body = m[0];
    const handlerFails = /process\.exit\(\s*[1-9]/.test(body)
        || /process\.exitCode\s*=\s*[1-9]/.test(body);
    const exitHookFails = /process\.on\(\s*['"]exit['"]/.test(text)
        && /(printed|summarised|summarized|reported|finished|done)\b/.test(text);
    return (handlerFails || exitHookFails)
        ? null
        : 'registers uncaughtException and neither the handler nor an exit hook fails: an uncaught error exits 0';
}

// R2: prints PASS, but nothing gates that PASS on how much actually ran.
//
// The floor may be spelled either way round -- `if (n > 0)` before the PASS, or
// `if (n < MIN) fail` before it -- and the first spelling is the common one, so
// a pattern that only knows `<` reports every gate in the tree.  It did: the
// first run of this file called 44 of 54 tools vacuous, and firefox-smoke, whose
// PASS sits inside `if (ua > 0 && wads > 0)`, was among them.  Grading on the
// comparison you happened to think of first is the "wrong quantity" failure
// this census exists to find.
function r2(text) {
    if (!/(^|\n)\s*(console\.log|print|echo)[^\n]*\bPASS\b/.test(text)) return null;
    const COUNTER = '(?:passes|passed|checks|checked|asserts|assertions|verified|count|counts|n|ok|oks|total|cases|tested|failures|fails|errors|hits|found|seeds|demos|frames|rows|entries|files|\\w*[Cc]ount)';
    const floor = new RegExp(`\\b${COUNTER}\\b\\s*(?:<|<=|>|>=|===?\\s*0|!==?\\s*0)`, 'i').test(text)
        || new RegExp(`\\b(?:if|assert|ok)\\s*\\(\\s*!?\\s*${COUNTER}\\b`, 'i').test(text)
        || /\bMIN_[A-Z_]+/.test(text)
        || /lib\/report\.mjs/.test(text);
    return floor ? null : 'prints PASS with no floor on how many assertions ran';
}

// R3: more than one hostile case, one connection or module for all of them,
// AND nothing afterwards proving the subject still works.
//
// The second half matters, because sharing a subject is not the defect -- the
// defect is not noticing when a case has silently disabled it.  CLAUDE.md gives
// two acceptable answers, and a file needs only one: a fresh connection or
// process per case, or an assertion AFTER the cases that the normal path still
// functions.  hostile-server-test.mjs takes the second (`a valid bundle still
// lands in the tic ring`, under a comment saying exactly why), and a rule
// blind to that called it defective.
function r3(text, file) {
    if (!/hostile|adversarial|fuzz|malformed|corrupt/i.test(file + text)) return null;
    const cases = (text.match(/\bcase\s*\d|\bCASES\b|\bcases\s*=\s*\[/gi) || []).length;
    if (cases < 2) return null;
    const conns = (text.match(/new WebSocket\(|bootEngine\(|createDoom\(|spawn(Sync)?\(/g) || []).length;
    if (conns !== 1) return null;
    const stillAlive = /still (works|lands|accepted|simulating|running|alive)|legitimate .*still|normal path/i.test(text);
    return stillAlive
        ? null
        : 'drives several hostile cases through one connection or module, and never checks afterwards that the subject still works';
}

// R1 and R3 are GRADED.  R2 is REPORTED AND NEVER GRADED, and the reason is
// the finding rather than a shortcoming of this file: a floor is spelled in
// whatever the author named the counter -- `failures > 0`, `ua > 0 && wads > 0`,
// `gates.length < 20`, `passes < MIN_ASSERTIONS` -- so deciding it textually
// means keeping a list of every identifier anyone might pick.  Two tries at that
// list called 44 then 29 of 54 tools vacuous, including gate-census.mjs and
// firefox-smoke.mjs, both of which gate their PASS correctly.  Grading that
// would alarm on correct behaviour, which this project treats as a defect in
// its own right, and answering the red by loosening the pattern would make the
// rule unable to fire at all.  Deciding R2 needs reading, so it prints a read
// list and a count, and the count is the thing to watch.
const RULES = [['R1', r1], ['R3', r3]];
const SURVEY = [['R2', r2]];

// ── run it ───────────────────────────────────────────────────────────────────
const seen = new Map();         // file -> {legs:[], text}
for (const leg of legs)
    for (const f of leg.files) {
        if (!existsSync(join(root, f))) continue;
        if (!seen.has(f)) seen.set(f, { legs: [], text: readFileSync(join(root, f), 'latin1') });
        seen.get(f).legs.push(leg.id);
    }

const findings = [], exemptions = [], survey = [];
let checked = 0;
for (const [file, { legs: ls, text }] of seen) {
    checked++;
    for (const [name, fn] of RULES) {
        const why = fn(text, file);
        if (!why) continue;
        if (exempt(text, name)) { exemptions.push({ file, rule: name }); continue; }
        findings.push({ file, rule: name, why, legs: ls });
    }
    for (const [name, fn] of SURVEY) {
        const why = fn(text, file);
        if (why && !exempt(text, name)) survey.push({ file, rule: name, why, legs: ls });
    }
}

if (process.argv.includes('--list')) {
    for (const [file, { legs: ls }] of seen) console.log(`  ${file}  (${ls.join(', ')})`);
    process.exit(0);
}
if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ checked, findings, survey, exemptions }, null, 2));
    process.exit(findings.length ? 1 : 0);
}

for (const f of findings)
    console.log(`FAIL  ${f.rule}  ${f.file} [${f.legs.join(', ')}]\n        ${f.why}`);

console.log(`\nR2 read list (reported, never graded — see the comment on RULES): ` +
            `${survey.length} of ${checked} leg tools have no floor this file can SEE on the PASS they print.`);
for (const f of survey) console.log(`  ${f.file} [${f.legs.join(', ')}]`);

const tail = `${checked} leg tool(s) from ${legs.length} legs (${noTool.length} legs run no tools/ file), ` +
             `${exemptions.length} declared exemption(s)`;
if (findings.length) {
    console.log(`\nFAIL vacuity-census: ${findings.length} finding(s) across ${tail}`);
    console.log('  Fix it, or declare `// VACUITY-EXEMPT R<n>: <reason>` and say why in the commit.');
    process.exit(1);
}
console.log(`PASS vacuity-census: no leg tool exits 0 after giving up (R1) and none drives hostile ` +
            `cases through a shared subject without checking it afterwards (R3) — ${tail}, ` +
            `all ${declared} declared legs accounted for. R2 is reported above, not graded.`);
