// WAD cache for insecure origins.  On https / localhost the service worker
// caches WADs (webdoom-wads-v1); on plain http://<LAN-IP> there is no service
// worker, so fetchWad() in main.js keeps WADs here instead -- one store per
// WAD, never both.  Eviction under storage pressure costs a re-download, not
// game state; storage.persist() is asked for once after the first write.

import { tx, withDB } from './idb.js';

const DB = ['webdoom-wads', 1, ['wads']];

let persistAsked = false;
async function requestPersistOnce() {
    if (persistAsked) return;
    persistAsked = true;
    try {
        if (navigator.storage?.persist && !(await navigator.storage.persist()))
            console.warn('wad-cache: storage.persist() not granted — IDB eviction possible under storage pressure');
    } catch (err) {
        console.warn('wad-cache: storage.persist() failed:', err);
    }
}

// Uint8Array for the WAD keyed by sha256, or null on miss/error.
export async function wadCacheGet(sha256) {
    try { return (await withDB(DB, db => tx(db, 'wads', 'readonly', s => s.get(sha256)))) ?? null; }
    catch (err) { console.warn('wad-cache: IDB read error:', err); return null; }
}

// Fire-and-forget safe: errors are logged, never thrown.
export async function wadCachePut(sha256, bytes) {
    try {
        await withDB(DB, db => tx(db, 'wads', 'readwrite', s => s.put(bytes, sha256)));
        await requestPersistOnce();
    } catch (err) {
        console.warn('wad-cache: IDB write error:', err);
    }
}

// Delete every cached WAD whose sha256 is not in keepShas (the server's
// manifest).  A replaced or removed WAD can never be asked for again, and
// would otherwise keep its 4-18 MB here for good.  An empty set says nothing
// about what to keep, so it prunes nothing.  Never throws: a launcher that
// cannot prune still starts.  Resolves with the keys it deleted.
export async function wadCachePrune(keepShas) {
    if (!keepShas?.size) return [];
    try {
        return await withDB(DB, db => tx(db, 'wads', 'readwrite', s => {
            const dropped = [];
            s.getAllKeys().onsuccess = e => {
                for (const k of e.target.result)
                    if (!keepShas.has(k)) { s.delete(k); dropped.push(k); }
            };
            return dropped;
        }));
    } catch (err) {
        console.warn('wad-cache: prune failed:', err);
        return [];
    }
}
