// Local WAD library: user-imported WADs, in their own database so its version
// never collides with the WAD cache's.  'manifest' holds the entry and
// 'bytes' the file, both keyed by sha256 and written in one transaction.
// fetchWad() in main.js reads here before the network.

import { tx, withDB } from './idb.js';

const DB = ['webdoom-local-library', 1, ['manifest', 'bytes']];

export const libraryAdd = (entry, bytes) =>
    withDB(DB, db => tx(db, ['manifest', 'bytes'], 'readwrite', (m, b) => {
        m.put(entry, entry.sha256);
        b.put(bytes, entry.sha256);
    }));

// Every manifest entry (empty on IDB error).
export async function libraryList() {
    try { return (await withDB(DB, db => tx(db, 'manifest', 'readonly', s => s.getAll()))) ?? []; }
    catch (err) { console.warn('wad-library: IDB list error:', err); return []; }
}

// Uint8Array for the given sha256, or null on miss/error.
export async function libraryGetBytes(sha256) {
    try { return (await withDB(DB, db => tx(db, 'bytes', 'readonly', s => s.get(sha256)))) ?? null; }
    catch (err) { console.warn('wad-library: IDB bytes read error:', err); return null; }
}
