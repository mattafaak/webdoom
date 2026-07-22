// SF2 SoundFont library — IDB storage for user-dropped .sf2 files.
//
// Validation: RIFF sfbk magic (bytes 0-3: "RIFF", bytes 8-11: "sfbk") + bounds
// check on the RIFF chunk-size field.  Hostile-input hardening mirrors wad-import.js.
//
// Storage: a separate DB ('webdoom-sf2') to avoid version-bump conflicts with
// the WAD library ('webdoom-local-library').  One "current" soundfont is kept
// at a time (key: 'current').  A future upgrade can add a named-list store.
//
// Exports:
//   Sf2Error          — user-visible rejection reason
//   validateSf2()     — throws Sf2Error on bad input; synchronous
//   sf2StoreCurrent() — store bytes + meta under key 'current'
//   sf2GetCurrentBytes() — Uint8Array | null
//   sf2GetCurrentMeta()  — { name, size } | null

const DB_NAME      = 'webdoom-sf2';
const DB_VERSION   = 1;
const META_STORE   = 'sf2-meta';
const BYTES_STORE  = 'sf2-bytes';
const CURRENT_KEY  = 'current';

// ── Sf2Error ──────────────────────────────────────────────────────────────────
export class Sf2Error extends Error {
    constructor(msg) { super(msg); this.name = 'Sf2Error'; }
}

// ── validateSf2 ───────────────────────────────────────────────────────────────
// Synchronous: throws Sf2Error if bytes are not a valid SF2 container.
// Does NOT parse the full SF2 structure — only the RIFF/sfbk header and
// the top-level chunk-size bounds, like wad-import.js bounds-checks the
// WAD header before attempting a lump scan.
export function validateSf2(bytes) {
    if (!(bytes instanceof Uint8Array)) throw new Sf2Error('expected Uint8Array');
    if (bytes.length === 0) throw new Sf2Error('zero-byte file');
    if (bytes.length < 12)
        throw new Sf2Error(`file too small to be an SF2 (${bytes.length} bytes; need ≥ 12)`);

    // RIFF magic
    if (bytes[0] !== 0x52 || bytes[1] !== 0x49 || bytes[2] !== 0x46 || bytes[3] !== 0x46) {
        const safe = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3])
            .replace(/[^\x20-\x7e]/g, '?');
        throw new Sf2Error(`not a RIFF file — magic is ${JSON.stringify(safe)}, expected RIFF`);
    }

    // sfbk form type (bytes 8-11)
    if (bytes[8]  !== 0x73 || bytes[9]  !== 0x66 ||
        bytes[10] !== 0x62 || bytes[11] !== 0x6B) {
        const form = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11])
            .replace(/[^\x20-\x7e]/g, '?');
        throw new Sf2Error(`not a SoundFont 2 file — RIFF form type is ${JSON.stringify(form)}, expected sfbk`);
    }

    // Chunk-size bounds check (uint32 LE at bytes 4-7)
    const dv        = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const riffSize  = dv.getUint32(4, true);
    if (riffSize + 8 > bytes.length) {
        throw new Sf2Error(
            `RIFF chunk size (${riffSize}) extends past EOF ` +
            `— file appears truncated (got ${bytes.length} bytes, need ${riffSize + 8})`,
        );
    }
}

// ── IDB helpers ───────────────────────────────────────────────────────────────
function _openSf2DB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(META_STORE))
                db.createObjectStore(META_STORE);
            if (!db.objectStoreNames.contains(BYTES_STORE))
                db.createObjectStore(BYTES_STORE);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror  = () => reject(req.error);
    });
}

// ── sf2StoreCurrent ───────────────────────────────────────────────────────────
// Persists meta + bytes for the current soundfont.  Replaces any previous entry.
export async function sf2StoreCurrent(name, bytes) {
    const db = await _openSf2DB();
    await new Promise((resolve, reject) => {
        const t = db.transaction([META_STORE, BYTES_STORE], 'readwrite');
        t.objectStore(META_STORE).put({ name, size: bytes.length }, CURRENT_KEY);
        t.objectStore(BYTES_STORE).put(bytes, CURRENT_KEY);
        t.oncomplete = resolve;
        t.onerror    = () => reject(t.error);
    });
    db.close();
}

// ── sf2GetCurrentBytes ────────────────────────────────────────────────────────
// Returns Uint8Array of the current soundfont, or null on miss/error.
export async function sf2GetCurrentBytes() {
    try {
        const db  = await _openSf2DB();
        const result = await new Promise((resolve, reject) => {
            const t   = db.transaction(BYTES_STORE, 'readonly');
            const req = t.objectStore(BYTES_STORE).get(CURRENT_KEY);
            t.oncomplete = () => resolve(req.result ?? null);
            t.onerror    = () => reject(t.error);
        });
        db.close();
        return result;
    } catch (err) {
        console.warn('sf2-library: IDB bytes read error:', err);
        return null;
    }
}

// ── sf2GetCurrentMeta ─────────────────────────────────────────────────────────
// Returns { name, size } of the current soundfont, or null on miss/error.
export async function sf2GetCurrentMeta() {
    try {
        const db  = await _openSf2DB();
        const result = await new Promise((resolve, reject) => {
            const t   = db.transaction(META_STORE, 'readonly');
            const req = t.objectStore(META_STORE).get(CURRENT_KEY);
            t.oncomplete = () => resolve(req.result ?? null);
            t.onerror    = () => reject(t.error);
        });
        db.close();
        return result;
    } catch (err) {
        console.warn('sf2-library: IDB meta read error:', err);
        return null;
    }
}
