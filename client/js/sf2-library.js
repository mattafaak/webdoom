// SF2 SoundFont library: the one "current" user-dropped .sf2, in its own
// database.  validateSf2() checks the RIFF/sfbk header and the chunk-size
// bound the way wad-import.js checks a WAD header -- hostile input is
// rejected with a reason, never parsed.

import { tx, withDB } from './idb.js';

const DB = ['webdoom-sf2', 1, ['sf2-meta', 'sf2-bytes']];
const CURRENT = 'current';

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

// Persist meta + bytes as the current soundfont, replacing any previous one.
export const sf2StoreCurrent = (name, bytes) =>
    withDB(DB, db => tx(db, ['sf2-meta', 'sf2-bytes'], 'readwrite', (m, b) => {
        m.put({ name, size: bytes.length }, CURRENT);
        b.put(bytes, CURRENT);
    }));

// Uint8Array of the current soundfont, or null on miss/error.
export async function sf2GetCurrentBytes() {
    try { return (await withDB(DB, db => tx(db, 'sf2-bytes', 'readonly', s => s.get(CURRENT)))) ?? null; }
    catch (err) { console.warn('sf2-library: IDB bytes read error:', err); return null; }
}

// { name, size } of the current soundfont, or null on miss/error.
export async function sf2GetCurrentMeta() {
    try { return (await withDB(DB, db => tx(db, 'sf2-meta', 'readonly', s => s.get(CURRENT)))) ?? null; }
    catch (err) { console.warn('sf2-library: IDB meta read error:', err); return null; }
}
