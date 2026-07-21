// WAD cache — IndexedDB fallback store for insecure origins.
//
// The service worker (sw.js) handles WAD caching on secure contexts (HTTPS /
// localhost / 127.0.0.1) via the 'webdoom-wads-v1' cache. On plain
// http://<LAN-IP> or plain-HTTP hostnames (e.g. http://192.168.1.x:8666)
// navigator.serviceWorker is absent and the SW never engages. This module
// provides an IndexedDB-backed fallback so WADs survive session boundaries
// even without the SW.
//
// Usage rule: this module is consulted ONLY when the SW is unavailable.
// fetchWad() in main.js detects SW presence via navigator.serviceWorker.controller
// and skips IDB writes entirely on secure origins — no duplicate storage.
//
// Storage arithmetic:
//   Typical WAD sizes: doom.wad ~12 MB, doom2.wad ~14 MB, sigil.wad ~4 MB,
//   nerve.wad ~4 MB, tnt.wad ~17 MB, plutonia.wad ~17 MB, chex.wad ~6 MB.
//   A full library (8 IWADs + PWADs) totals roughly 80–120 MB.
//   Browser IDB quota: Chrome allows up to ~60 % of available disk (Origin
//   Private File System excluded); in practice >>1 GB on a modern device.
//   80–120 MB is well within quota without navigator.storage.persist().
//   With persist() (requested after first successful write), the browser
//   marks the data as persistent and will not evict it under storage
//   pressure. Without persist(), IDB data can be evicted by the browser;
//   the eviction story is: WAD re-downloads on next session (same as the
//   pre-fix behaviour), so eviction degrades performance but does not
//   corrupt game state.

const DB_NAME = 'webdoom-wads';
const STORE_NAME = 'wads';
const DB_VERSION = 1;

function openWadDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            req.result.createObjectStore(STORE_NAME);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

let _persistRequested = false;

async function requestPersistOnce() {
    if (_persistRequested) return;
    _persistRequested = true;
    try {
        if (navigator.storage?.persist) {
            const granted = await navigator.storage.persist();
            if (!granted)
                console.warn('wad-cache: storage.persist() not granted — IDB eviction possible under storage pressure');
        }
    } catch (err) {
        console.warn('wad-cache: storage.persist() failed:', err);
    }
}

// Returns a Uint8Array for the WAD keyed by sha256, or null on miss/error.
export async function wadCacheGet(sha256) {
    try {
        const db = await openWadDB();
        const result = await new Promise((resolve, reject) => {
            const t = db.transaction(STORE_NAME, 'readonly');
            const req = t.objectStore(STORE_NAME).get(sha256);
            t.oncomplete = () => resolve(req.result ?? null);
            t.onerror = () => reject(t.error);
        });
        db.close();
        return result;
    } catch (err) {
        console.warn('wad-cache: IDB read error:', err);
        return null;
    }
}

// Stores bytes (Uint8Array) under sha256 key. Fire-and-forget safe: errors are
// logged but never propagated to the caller. Requests storage.persist() once
// after the first successful write.
export async function wadCachePut(sha256, bytes) {
    try {
        const db = await openWadDB();
        await new Promise((resolve, reject) => {
            const t = db.transaction(STORE_NAME, 'readwrite');
            t.objectStore(STORE_NAME).put(bytes, sha256);
            t.oncomplete = resolve;
            t.onerror = () => reject(t.error);
        });
        db.close();
        // Request durable storage after first write so the browser does not
        // evict our WAD data under storage pressure.
        await requestPersistOnce();
    } catch (err) {
        console.warn('wad-cache: IDB write error:', err);
    }
}
