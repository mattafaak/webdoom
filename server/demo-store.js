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

export const PER_DEMO_CAP  = 1_048_576;          // 1 MiB per demo
export const TOTAL_QUOTA   = 134_217_728;         // 128 MiB total
export const TTL_MS        = 86_400_000;          // 24 hours
export const FRAGMENT_MAX  = 6_000;               // raw bytes; above this, use server id

// Map<id, { bytes: Buffer, wad: string, expires: number }>
const store = new Map();
let usedBytes = 0;

function sha256hex(buf) {
    return createHash('sha256').update(buf).digest('hex');
}

// Remove all demos whose TTL has expired.
function gcExpired() {
    const now = Date.now();
    for (const [id, rec] of store) {
        if (rec.expires <= now) {
            usedBytes -= rec.bytes.length;
            store.delete(id);
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
        return null;
    }
    return { bytes: rec.bytes, wad: rec.wad };
}

// Diagnostic: current store state (for tests).
export function storeStats() {
    gcExpired();
    return { count: store.size, usedBytes, quota: TOTAL_QUOTA };
}
