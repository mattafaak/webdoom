// One IndexedDB open, and one transaction wrapper.
//
// persist.js, wad-cache.js, wad-library.js and sf2-library.js each carried
// their own open-and-promisify dance — four copies of the same eleven lines,
// differing only in how many object stores they create.  Two of them then
// carried their own transaction wrapper too.  Nothing here is clever; the
// point is that the next module that needs IDB does not write a fifth copy,
// and that the error paths (onerror, onblocked) are handled once.
//
// onblocked is the one this consolidation adds: none of the four handled it,
// so an open racing a version change in another tab hung forever with no
// rejection — a frozen launcher with nothing in the console.

// stores: array of object-store names to create on upgrade.  Creation is
// guarded by objectStoreNames.contains(), so adding a store to an existing
// database is a version bump away and never a "store already exists" throw.
export function openDB(name, version, stores) {
    return new Promise((resolve, reject) => {
        let req;
        try { req = indexedDB.open(name, version); }
        catch (err) { reject(err); return; }        // private mode, disabled storage
        req.onupgradeneeded = () => {
            const db = req.result;
            for (const s of stores)
                if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => reject(req.error);
        req.onblocked = () => reject(new Error(
            `indexedDB.open("${name}") is blocked by another tab holding an older version`));
    });
}

// Run fn against one object store and resolve with whatever it returned,
// unwrapping an IDBRequest's .result so callers read a value, not a request.
export function tx(db, store, mode, fn) {
    return new Promise((resolve, reject) => {
        let t;
        try { t = db.transaction(store, mode); }
        catch (err) { reject(err); return; }        // store missing, db closing
        const out = fn(t.objectStore(store));
        t.oncomplete = () => resolve(out && typeof out === 'object' && 'result' in out ? out.result : out);
        t.onerror    = () => reject(t.error);
        t.onabort    = () => reject(t.error ?? new Error('transaction aborted'));
    });
}

// Two stores, one transaction — the atomic meta+bytes write wad-library and
// sf2-library both need.  fn receives the stores in the order named.
export function tx2(db, stores, mode, fn) {
    return new Promise((resolve, reject) => {
        let t;
        try { t = db.transaction(stores, mode); }
        catch (err) { reject(err); return; }
        const out = fn(...stores.map(s => t.objectStore(s)));
        t.oncomplete = () => resolve(out);
        t.onerror    = () => reject(t.error);
        t.onabort    = () => reject(t.error ?? new Error('transaction aborted'));
    });
}
