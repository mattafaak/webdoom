// Savegame + config persistence. The engine has no filesystem: small
// files (savegames, .doomrc) live in a JS Map (Module.fileMap) bridged
// through three wasm imports. This module fills the Map from IndexedDB
// before boot and mirrors changes back — savegames keyed per IWAD,
// config shared.

const DB = 'webdoom';
const STORE = 'files';
const SAVES = [...Array(6).keys()].map(i => `doomsav${i}.dsg`);
const CONFIG = '.doomrc';

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

const keyFor = (iwad, name) => name === CONFIG ? `config:${name}` : `${iwad}:${name}`;
// pre-registry builds keyed by MEMFS paths
const legacyKeyFor = (iwad, name) =>
    name === CONFIG ? 'config:/home/web_user/.doomrc' : `${iwad}:/${name}`;

// → Map(name → Uint8Array), fetched before the engine boots
export async function loadPersisted(iwad) {
    const files = new Map();
    try {
        const d = await db();
        for (const name of [...SAVES, CONFIG]) {
            const bytes = await tx(d, 'readonly', s => s.get(keyFor(iwad, name)))
                ?? await tx(d, 'readonly', s => s.get(legacyKeyFor(iwad, name)));
            if (bytes) files.set(name, bytes);
        }
        d.close();
    } catch (err) {
        console.warn('persistence unavailable:', err);
    }
    return files;
}

// mirror fileMap changes out every few seconds (+ on tab hide)
export function startSync(doom, iwad, intervalMs = 3000) {
    const lastFp = new Map();

    const fingerprint = b => {
        let sum = 0;
        for (let i = 0; i < b.length; i++) sum = (sum * 31 + b[i]) | 0;
        return `${b.length}:${sum}`;
    };

    async function sync() {
        try {
            doom._web_save_defaults();  // flush live config into the Map
        } catch { return; }             // wasm aborted after quit — ignore
        const m = doom['fileMap'];
        if (!m) return;
        let d = null;
        for (const name of [...SAVES, CONFIG]) {
            const bytes = m.get(name);
            if (!bytes) continue;
            const fp = fingerprint(bytes);
            if (lastFp.get(name) === fp) continue;
            try {
                d ??= await db();
                await tx(d, 'readwrite', s => s.put(bytes, keyFor(iwad, name)));
                lastFp.set(name, fp);
            } catch (err) {
                console.warn('save sync failed:', err);
                return;
            }
        }
        d?.close();
    }

    const timer = setInterval(sync, intervalMs);
    const onHide = () => { if (document.visibilityState === 'hidden') sync(); };
    document.addEventListener('visibilitychange', onHide);

    function stop() {
        clearInterval(timer);
        document.removeEventListener('visibilitychange', onHide);
    }

    return { sync, stop };
}
