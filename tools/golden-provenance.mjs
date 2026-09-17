#!/usr/bin/env node
// tools/golden-provenance.mjs — a golden should say where it came from.
//
// WHY THIS EXISTS
// ---------------
// The project's most expensive recorded lesson (docs/archive/Plans-refinement-complete.md:80)
// is that "regolding a golden to make a failing gate pass can encode a real bug
// — a regold needs an independent correctness reference, not just
// self-consistency".  The 3.2 render regold had already encoded an artifact once.
//
// Task 21.2 closed the SILENT regold (a missing golden is now a hard error).
// This closes the other half: a DELIBERATE regold left no trace.  The sim and
// render goldens store `{tics, trace}` and nothing else — no commit, no build
// hash, no date, no reason — so after the fact there is no way to ask which
// build a golden came from or why it moved.  The browser-pipeline baselines
// already carried commit/host/timestamp; they were the only ones that did.
//
// It also refuses to record from a dirty tree without a stated reason.  A regold
// is a claim that the NEW output is correct; making the operator write down why,
// into the artifact, is the cheapest available substitute for the external
// reference the lesson actually demands.
//
// usage:
//   node tools/golden-provenance.mjs --check     # every golden carries provenance
//   node tools/golden-provenance.mjs --migrate   # stamp pre-21.3 goldens
//
// Copyright (C) 2026, GPL-2.0-or-later.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { packTrace, unpackTrace, isTraceDoc } from './lib/golden.mjs';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { root } from './lib/util.mjs';

const GOLDEN_DIR = join(root, 'tools/golden');

const sh = cmd => { try { return execSync(cmd, { cwd: root, encoding: 'utf8' }).trim(); } catch { return ''; } };

/** The stamp written into a golden at record time. */
export function provenance(tool, buildDir = 'build', reason = null) {
    const wasm = join(root, buildDir, 'doom.wasm');
    return {
        tool,
        recorded_at: new Date().toISOString(),
        commit:      sh('git rev-parse --short HEAD') || 'unknown',
        dirty:       sh('git status --porcelain') !== '',
        build_dir:   buildDir,
        wasm_md5:    existsSync(wasm) ? createHash('md5').update(readFileSync(wasm)).digest('hex') : null,
        reason,
    };
}

/**
 * Recording from a dirty tree without a stated reason is refused.  Returns the
 * reason string (possibly null on a clean tree).  Exits 2 rather than throwing,
 * so a recording tool fails the same way its argv validation does.
 */
export function recordReason(argv) {
    const i = argv.indexOf('--record-reason');
    const reason = i >= 0 ? argv[i + 1] : null;
    if (i >= 0 && (!reason || reason.startsWith('--'))) {
        console.error('FAIL: --record-reason needs a value');
        process.exit(2);
    }
    if (sh('git status --porcelain') !== '' && !reason) {
        console.error('FAIL: refusing to record goldens from a dirty working tree without a reason.');
        console.error('  A regold asserts the NEW output is correct.  Say why, and it is stored in');
        console.error('  the golden: --record-reason "20.3e: fake-flat now skips sky columns".');
        console.error('  Validate against a pre-change build, not against itself');
        console.error('  (docs/archive/Plans-refinement-complete.md:80 — a regold once encoded a real bug).');
        process.exit(2);
    }
    return reason;
}

// ── CLI ──────────────────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
    const mode = process.argv[2];
    if (!['--check', '--migrate', '--repack'].includes(mode)) {
        console.error('usage: golden-provenance.mjs --check | --migrate | --repack');
        process.exit(2);
    }

    const files = readdirSync(GOLDEN_DIR)
        .filter(f => f.endsWith('.json'))
        .filter(f => statSync(join(GOLDEN_DIR, f)).isFile());

    // Only per-tic trace goldens are in scope; the per-host perf baselines carry
    // their own provenance already and have a different shape.
    const traces = [];
    for (const f of files) {
        let doc;
        try { doc = JSON.parse(readFileSync(join(GOLDEN_DIR, f), 'utf8')); } catch { continue; }
        if (isTraceDoc(doc)) traces.push([f, doc]);
    }

    if (traces.length < 39) {
        console.log(`FAIL golden-provenance: found only ${traces.length} trace goldens; ` +
                    `tools/golden/ holds far more. The discovery is broken, which is not a pass.`);
        process.exit(1);
    }

    // --repack: the same hashes as one hex string per golden (round 10).  Not a
    // regold -- the values are unchanged and provenance is untouched -- so it
    // needs no reason and no clean tree.
    if (mode === '--repack') {
        let n = 0, before = 0, after = 0;
        for (const [f, doc] of traces) {
            const p = join(GOLDEN_DIR, f);
            const was = readFileSync(p, 'utf8');
            const values = unpackTrace(doc.trace);
            doc.trace = packTrace(values);
            const now = JSON.stringify(doc);
            if (now === was) continue;
            if (unpackTrace(doc.trace).some((v, i) => v !== values[i])) {
                console.log(`FAIL golden-provenance --repack: ${f} does not round-trip`);
                process.exit(1);
            }
            writeFileSync(p, now);
            n++; before += was.length; after += now.length;
        }
        console.log(`repacked ${n} of ${traces.length} golden(s): ${before} -> ${after} bytes, hashes unchanged`);
        process.exit(0);
    }

    if (mode === '--migrate') {
        let n = 0;
        for (const [f, doc] of traces) {
            if (doc.provenance) continue;
            doc.provenance = {
                tool: 'pre-21.3',
                recorded_at: null,
                commit: 'unknown',
                note: 'recorded before task 21.3 added provenance stamping; ' +
                      'the originating build and date were never captured',
            };
            writeFileSync(join(GOLDEN_DIR, f), JSON.stringify(doc));
            n++;
        }
        console.log(`migrated ${n} golden(s); ${traces.length - n} already carried provenance`);
        process.exit(0);
    }

    const missing = traces.filter(([, d]) => !d.provenance).map(([f]) => f);
    if (missing.length) {
        console.log(`FAIL golden-provenance: ${missing.length} of ${traces.length} goldens carry no provenance:`);
        for (const f of missing.slice(0, 10)) console.log(`    ${f}`);
        if (missing.length > 10) console.log(`    … and ${missing.length - 10} more`);
        console.log('  Re-record them, or run --migrate to mark them as pre-21.3.');
        process.exit(1);
    }
    const stamped = traces.filter(([, d]) => d.provenance.tool !== 'pre-21.3').length;
    console.log(`PASS golden-provenance: all ${traces.length} trace goldens carry provenance ` +
                `(${stamped} stamped at record time, ${traces.length - stamped} marked pre-21.3)`);
}
