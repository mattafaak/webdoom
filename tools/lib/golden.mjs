// Trace goldens on disk: {tics, trace, provenance}.  `trace` is one hex
// string, eight characters per tic (round 10; it was a decimal JSON array,
// 3.15 MB for the same 133,740 hashes).  Readers get numbers either way, so
// a golden written by an older tool still verifies, and the C writers keep
// emitting decimal arrays that these helpers accept unchanged.
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { root } from './util.mjs';

const sh = cmd => { try { return execSync(cmd, { cwd: root, encoding: 'utf8' }).trim(); } catch { return ''; } };

export const packTrace = u32s => u32s.map(v => (v >>> 0).toString(16).padStart(8, '0')).join('');

export function unpackTrace(t) {
    if (Array.isArray(t)) return t;
    if (typeof t !== 'string' || t.length % 8) return [];
    const out = new Array(t.length / 8);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(t.slice(i * 8, i * 8 + 8), 16);
    return out;
}

export const isTraceDoc = doc =>
    !!doc && typeof doc === 'object' &&
    (Array.isArray(doc.trace) || (typeof doc.trace === 'string' && doc.trace.length % 8 === 0));

// the parsed golden with `trace` as numbers
export function readGolden(path) {
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    if (doc && typeof doc === 'object' && 'trace' in doc) doc.trace = unpackTrace(doc.trace);
    return doc;
}

// The stamp a golden carries from the moment it was recorded, so a regold says
// which build produced it and why.
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

// A regold asserts the NEW output is correct.  From a dirty tree it is refused
// unless --record-reason says why, and the reason is stored in the golden.
// Validate the new output against a pre-change build, never against itself:
// a regold here once encoded a sprite artifact that shipped.
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
        console.error('  the golden: --record-reason "<why the output moved>".');
        console.error('  Validate against a pre-change build, not against itself.');
        process.exit(2);
    }
    return reason;
}
