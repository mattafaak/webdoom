// webdoom demo store: in-memory content-addressed demo storage.
//
// Policy (stated explicitly per DoD):
//   PER_DEMO_CAP   1,048,576 bytes (1 MiB) — upload rejected with 413 above this
//   TOTAL_QUOTA   134,217,728 bytes (128 MiB) — oldest demos evicted to make room
//   TTL_MS        86,400,000 ms (24 hours) — demos expire and are GC'd at access
//   FRAGMENT_MAX  6,000 bytes raw — URL-fragment embed only when demo ≤ 6 000 B
//
// Content addressing: id = sha256(demo_bytes) in lowercase hex (64 chars).
// Deduplication is automatic: uploading the same bytes returns the same id.
// The sha256 id is not guessable, preventing blind over-write attacks.
//
// No filesystem access: all storage is in the Map below.  Server restart
// clears all demos.  For persistence, replace the Map with a DB adapter.

import { createHash } from 'node:crypto';

// Operator-tunable, same shape as game.js's WEBDOOM_MAX_SPECTATORS: a server
// owner may legitimately want shorter retention or a smaller footprint, and it
// is what lets a gate drive real eviction and real expiry instead of asserting
// the policy by inspection.  Defaults are unchanged.
const envInt = (name, dflt) => {
    const v = +(process.env[name] ?? NaN);
    return Number.isInteger(v) && v > 0 ? v : dflt;
};

export const PER_DEMO_CAP  = envInt('WEBDOOM_DEMO_CAP', 1_048_576);        // 1 MiB per demo
export const TOTAL_QUOTA   = envInt('WEBDOOM_DEMO_QUOTA', 134_217_728);    // 128 MiB total
export const TTL_MS        = envInt('WEBDOOM_DEMO_TTL_MS', 86_400_000);    // 24 hours
export const FRAGMENT_MAX  = 6_000;               // raw bytes; above this, use server id

// Map<id, { bytes: Buffer, wad: string, expires: number }>
const store = new Map();
let usedBytes = 0;

function sha256hex(buf) {
    return createHash('sha256').update(buf).digest('hex');
}

// Remove all demos whose TTL has expired.
//
// Task A3: every one of the three deletion sites in this file -- here,
// evictOldest() and getDemo()'s expiry branch -- deleted from `store` and left
// the attestation behind, so deleteAttestation() sat exported, documented
// "called when demo is evicted", and called from NOWHERE.  The only pruning was
// the lazy one in getAttestation(), which fires only if somebody asks for that
// exact id after its demo is already gone.  Every evicted or expired demo
// therefore orphaned up to 800 KB of trace permanently, with no quota, no
// sweep, no accounting, and nothing in storeStats() to show it growing.
function gcExpired() {
    const now = Date.now();
    for (const [id, rec] of store) {
        if (rec.expires <= now) {
            usedBytes -= rec.bytes.length;
            store.delete(id);
            deleteAttestation(id);
        }
    }
}

// Evict oldest demos (by expiry time) until usedBytes + needed <= TOTAL_QUOTA.
function evictOldest(needed) {
    const sorted = [...store.entries()].sort((a, b) => a[1].expires - b[1].expires);
    for (const [id, rec] of sorted) {
        if (usedBytes + needed <= TOTAL_QUOTA) break;
        usedBytes -= rec.bytes.length;
        store.delete(id);
        deleteAttestation(id);
    }
}

// Store a demo.  Returns the content-addressed id.
// Throws an object { status, message } if the demo is too large or
// total quota cannot be satisfied even after eviction.
export function putDemo(bytes, wad = '') {
    if (bytes.length > PER_DEMO_CAP)
        throw { status: 413, message: `demo exceeds per-demo cap of ${PER_DEMO_CAP} bytes` };

    gcExpired();

    // Dedup: same content → same id, just extend TTL.
    const id = sha256hex(bytes);
    if (store.has(id)) {
        store.get(id).expires = Date.now() + TTL_MS;
        return id;
    }

    if (usedBytes + bytes.length > TOTAL_QUOTA) {
        evictOldest(bytes.length);
        if (usedBytes + bytes.length > TOTAL_QUOTA)
            throw { status: 507, message: 'demo store quota exhausted' };
    }

    store.set(id, { bytes: Buffer.from(bytes), wad, expires: Date.now() + TTL_MS });
    usedBytes += bytes.length;
    return id;
}

// Retrieve a demo by id.  Returns { bytes, wad } or null if not found/expired.
export function getDemo(id) {
    // id must be exactly 64 lowercase hex chars (sha256).
    if (!/^[0-9a-f]{64}$/.test(id)) return null;
    const rec = store.get(id);
    if (!rec) return null;
    if (rec.expires <= Date.now()) {
        usedBytes -= rec.bytes.length;
        store.delete(id);
        deleteAttestation(id);
        return null;
    }
    return { bytes: rec.bytes, wad: rec.wad };
}

// Diagnostic: current store state.
//
// This reported `store` only, so the attestation leak above was invisible to
// anyone holding the one instrument built to see it.  A store with no readout
// is a store nobody can prove is bounded.
export function storeStats() {
    gcExpired();
    return {
        count: store.size, usedBytes, quota: TOTAL_QUOTA,
        attestCount: attestStore.size, attestBytes, attestQuota: ATTEST_TOTAL_QUOTA,
    };
}

// ── Per-demo attestation store (task 19.4) ────────────────────────────────────
//
// Attestation: the per-tic full trace hash array produced by demo-verify.mjs.
// Stored in a separate map keyed by demo id (same 64-char sha256 hex as the
// demo itself).  Attestations share the demo TTL: when the demo expires or is
// evicted, its attestation is also removed.
//
// ATTEST_BODY_CAP: max JSON body size for POST /api/demos/:id/verify.
// A 200 000-tic trace of u32 values is at most ~1.6 MB as compact JSON
// (200000 × 10 chars + separators ≈ 2.1 MB).  Cap at 4 MiB to reject clearly
// hostile payloads while allowing the full tic cap.
export const ATTEST_BODY_CAP = 4_194_304;  // 4 MiB

// ATTEST_TOTAL_QUOTA: bytes of stored trace, across all attestations.
// With the demo TTL now actually propagating (see gcExpired), an attestation
// cannot outlive its demo, so this is belt-and-braces rather than the primary
// bound -- but a store with no budget and no accounting is exactly what let the
// leak above run unseen, and "it cannot grow because of an invariant elsewhere"
// is not something this store can check for itself.
// 128 MiB matches TOTAL_QUOTA: at 4 bytes/tic and the 200 000-tic cap, one
// attestation is at most 800 000 B, so this admits ~167 of the largest.
export const ATTEST_TOTAL_QUOTA = envInt('WEBDOOM_ATTEST_QUOTA', 134_217_728);  // 128 MiB
export const ATTEST_MAX_TICS    = 200_000;

// Map<id, { tics: number, trace: Uint32Array, storedAt: number }>
// The trace really is a Uint32Array now.  It was the validated JS Array, held
// as-is -- roughly 8 bytes per element on 64-bit V8 against the 4 the comment
// promised, so every figure anyone derived from this line was half the truth.
const attestStore = new Map();
let attestBytes = 0;

// Store an attestation for a demo id.
// id must match an existing demo in the store.
// trace must be an array of unsigned 32-bit integers (per-tic sim hashes).
// Throws {status, message} on validation failure.
export function putAttestation(id, tics, trace) {
    if (!/^[0-9a-f]{64}$/.test(id))
        throw { status: 400, message: 'invalid demo id' };
    if (!store.has(id))
        throw { status: 404, message: 'demo not found' };
    if (!Array.isArray(trace))
        throw { status: 400, message: 'attestation must have {tics: number, trace: Array}' };
    // `typeof tics === 'number'` admits NaN, Infinity and floats.  That mattered
    // once the GET response stopped round-tripping through JSON.stringify: a
    // NaN interpolated into the body is not valid JSON.  Validate the value,
    // not the typeof.
    if (!Number.isInteger(tics) || tics < 0)
        throw { status: 400, message: 'attestation tics must be a non-negative integer' };
    if (trace.length > ATTEST_MAX_TICS)
        throw { status: 413, message: 'attestation trace exceeds tic cap' };
    // Validate all entries are safe integers in u32 range.
    for (let i = 0; i < trace.length; i++) {
        if (!Number.isInteger(trace[i]) || trace[i] < 0 || trace[i] > 0xFFFFFFFF)
            throw { status: 400, message: `trace[${i}] is not a u32` };
    }

    const cost = trace.length * 4;
    // Replacing an existing attestation releases the old one's bytes first.
    deleteAttestation(id);
    if (attestBytes + cost > ATTEST_TOTAL_QUOTA) {
        evictOldestAttestations(cost);
        if (attestBytes + cost > ATTEST_TOTAL_QUOTA)
            throw { status: 507, message: 'attestation store quota exhausted' };
    }
    attestStore.set(id, { tics, trace: Uint32Array.from(trace), storedAt: Date.now() });
    attestBytes += cost;
}

// Drop the oldest attestations until `needed` more bytes fit.
function evictOldestAttestations(needed) {
    const sorted = [...attestStore.entries()].sort((a, b) => a[1].storedAt - b[1].storedAt);
    for (const [id] of sorted) {
        if (attestBytes + needed <= ATTEST_TOTAL_QUOTA) break;
        deleteAttestation(id);
    }
}

// Retrieve a stored attestation.  Returns {tics, trace, storedAt} or null.
export function getAttestation(id) {
    if (!/^[0-9a-f]{64}$/.test(id)) return null;
    // Evict if the underlying demo has expired.
    if (!store.has(id)) { deleteAttestation(id); return null; }
    return attestStore.get(id) ?? null;
}

// Remove attestation (called when a demo is evicted or expires — keeps the maps
// in sync, which until task A3 nothing did).
export function deleteAttestation(id) {
    const rec = attestStore.get(id);
    if (!rec) return false;
    attestBytes -= rec.trace.length * 4;
    attestStore.delete(id);
    return true;
}
