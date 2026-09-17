// Trace goldens on disk: {tics, trace, provenance}.  `trace` is one hex
// string, eight characters per tic (round 10; it was a decimal JSON array,
// 3.15 MB for the same 133,740 hashes).  Readers get numbers either way, so
// a golden written by an older tool still verifies, and the C writers keep
// emitting decimal arrays that these helpers accept unchanged.
import { readFileSync } from 'node:fs';

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
