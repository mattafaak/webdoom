// Savegame + config persistence: the engine writes into the wasm's
// in-memory FS, which dies with the page. This mirrors the files that
// matter into IndexedDB — savegames keyed per IWAD (a doom2 save is
// meaningless to doom.wad), config shared — and restores them before
// the engine boots.

const DB = 'webdoom';
const STORE = 'files';
const SAVES = [...Array(6).keys()].map(i => `/doomsav${i}.dsg`);
const CONFIG = '/home/web_user/.doomrc';

function db() {
    return new Promise((res, rej) => {
        const req = indexedDB.open(DB, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
    });
}

const tx = (d, mode, fn) => new Promise((res, rej) => {
    const t = d.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => res(out?.result ?? out);
    t.onerror = () => rej(t.error);
});

const keyFor = (iwad, path) => path === CONFIG ? `config:${path}` : `${iwad}:${path}`;

// → Map(path → Uint8Array), fetched before the engine boots
export async function loadPersisted(iwad) {
    const files = new Map();
    try {
        const d = await db();
        for (const path of [...SAVES, CONFIG]) {
            const bytes = await tx(d, 'readonly', s => s.get(keyFor(iwad, path)));
            if (bytes) files.set(path, bytes);
        }
        d.close();
    } catch (err) {
        console.warn('persistence unavailable:', err);
    }
    return files;
}

// call inside preRun, once the FS exists
export function restoreFiles(FS, files) {
    for (const [path, bytes] of files) {
        try { FS.writeFile(path, bytes); }
        catch (err) { console.warn(`restore failed for ${path}:`, err); }
    }
}

// mirror changes out every few seconds (+ on tab hide); cheap no-op
// when nothing changed
export function startSync(doom, iwad, intervalMs = 3000) {
    const lastLen = new Map();      // path → last synced byte length+sum

    const fingerprint = b => {
        let sum = 0;
        for (let i = 0; i < b.length; i++) sum = (sum * 31 + b[i]) | 0;
        return `${b.length}:${sum}`;
    };

    async function sync() {
        doom._web_save_defaults();
        let d = null;
        for (const path of [...SAVES, CONFIG]) {
            let bytes;
            try { bytes = doom.FS.readFile(path); } catch { continue; }
            const fp = fingerprint(bytes);
            if (lastLen.get(path) === fp) continue;
            try {
                d ??= await db();
                await tx(d, 'readwrite', s => s.put(bytes, keyFor(iwad, path)));
                lastLen.set(path, fp);
            } catch (err) {
                console.warn('save sync failed:', err);
                return;
            }
        }
        d?.close();
    }

    setInterval(sync, intervalMs);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') sync();
    });
    return { sync };
}
