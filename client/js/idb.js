// One IndexedDB open, one transaction wrapper, one open-run-close.
//
// Every module that keeps something in IndexedDB (persist, wad-cache,
// wad-library) goes through these three, so the error paths --
// onerror, onabort, and onblocked, the one that hung the launcher when an
// open raced a version change in another tab -- are handled once.

// stores: object-store names to create on upgrade, guarded so adding a store
// to an existing database is a version bump, never a "store exists" throw.
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

// Run fn against one store (a name) or several (an array, fn gets them in
// order) and resolve with what it returned; an IDBRequest is unwrapped to
// its .result so callers read a value.
export function tx(db, stores, mode, fn) {
    return new Promise((resolve, reject) => {
        let t;
        try { t = db.transaction(stores, mode); }
        catch (err) { reject(err); return; }        // store missing, db closing
        const out = Array.isArray(stores)
            ? fn(...stores.map(s => t.objectStore(s)))
            : fn(t.objectStore(stores));
        t.oncomplete = () => resolve(out && typeof out === 'object' && 'result' in out ? out.result : out);
        t.onerror    = () => reject(t.error);
        t.onabort    = () => reject(t.error ?? new Error('transaction aborted'));
    });
}

// Open, run fn(db), close.  spec = [name, version, stores].
export async function withDB(spec, fn) {
    const db = await openDB(...spec);
    try { return await fn(db); } finally { db.close(); }
}
