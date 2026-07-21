// Local WAD library — IndexedDB store for user-imported WADs.
//
// Uses a dedicated DB ('webdoom-local-library') to avoid version conflicts
// with the WAD cache DB ('webdoom-wads') from wad-cache.js.
//
// Two object stores in the same DB (written in one transaction for atomicity):
//   'manifest' — keyed by sha256; value = manifest entry object
//   'bytes'    — keyed by sha256; value = Uint8Array of WAD contents
//
// Usage: imported WADs are stored here; fetchWad() in main.js consults
// libraryGetBytes() before the network so local WADs load without a server.

const DB_NAME      = 'webdoom-local-library';
const DB_VERSION   = 1;
const MANIFEST_STORE = 'manifest';
const BYTES_STORE    = 'bytes';

function _openLibDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(MANIFEST_STORE))
                db.createObjectStore(MANIFEST_STORE);
            if (!db.objectStoreNames.contains(BYTES_STORE))
                db.createObjectStore(BYTES_STORE);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror  = () => reject(req.error);
    });
}

// Store a manifest entry + its raw bytes atomically (one transaction).
// entry.sha256 is the key for both stores.
export async function libraryAdd(entry, bytes) {
    const db = await _openLibDB();
    await new Promise((resolve, reject) => {
        const t = db.transaction([MANIFEST_STORE, BYTES_STORE], 'readwrite');
        t.objectStore(MANIFEST_STORE).put(entry, entry.sha256);
        t.objectStore(BYTES_STORE).put(bytes, entry.sha256);
        t.oncomplete = resolve;
        t.onerror    = () => reject(t.error);
    });
    db.close();
}

// Returns all manifest entries as an array (empty on IDB error).
export async function libraryList() {
    try {
        const db = await _openLibDB();
        const entries = await new Promise((resolve, reject) => {
            const t   = db.transaction(MANIFEST_STORE, 'readonly');
            const req = t.objectStore(MANIFEST_STORE).getAll();
            t.oncomplete = () => resolve(req.result ?? []);
            t.onerror    = () => reject(t.error);
        });
        db.close();
        return entries;
    } catch (err) {
        console.warn('wad-library: IDB list error:', err);
        return [];
    }
}

// Returns Uint8Array for the given sha256, or null on miss/error.
export async function libraryGetBytes(sha256) {
    try {
        const db = await _openLibDB();
        const result = await new Promise((resolve, reject) => {
            const t   = db.transaction(BYTES_STORE, 'readonly');
            const req = t.objectStore(BYTES_STORE).get(sha256);
            t.oncomplete = () => resolve(req.result ?? null);
            t.onerror    = () => reject(t.error);
        });
        db.close();
        return result;
    } catch (err) {
        console.warn('wad-library: IDB bytes read error:', err);
        return null;
    }
}

// Returns the count of entries in the local library (0 on error).
export async function libraryCount() {
    try {
        const db = await _openLibDB();
        const n = await new Promise((resolve, reject) => {
            const t   = db.transaction(MANIFEST_STORE, 'readonly');
            const req = t.objectStore(MANIFEST_STORE).count();
            t.oncomplete = () => resolve(req.result ?? 0);
            t.onerror    = () => reject(t.error);
        });
        db.close();
        return n;
    } catch (err) {
        return 0;
    }
}
