// Client-side WAD identification — ported from tools/wad-identify.mjs.
//
// SHA-256 strategy:
//   crypto.subtle.digest('SHA-256', ...) requires a secure context (HTTPS,
//   localhost, 127.0.0.1).  On plain http://<LAN-IP> (insecure origin)
//   crypto.subtle is undefined.  We fall back to a compact pure-JS SHA-256
//   so the import flow works on insecure origins — the primary user environment.
//
// Hostile-WAD surface hardening:
//   All lump-directory reads are bounds-checked against the file size.
//   nlumps is capped at MAX_LUMPS before the directory scan begins.
//   No unbounded loops; negative counts/offsets are rejected immediately.

// ---------------------------------------------------------------------------
// Pure-JS SHA-256 (RFC 6234 algorithm) — only used when crypto.subtle absent
// ---------------------------------------------------------------------------
const _K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
    0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
    0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
    0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
    0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
    0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

// Note: safe for WAD files (< ~500 MB); bit-length upper word is zero for
// any WAD that fits in memory (JS Number can't represent > 2^53 bytes anyway).
function _sha256pure(data) {
    const rotr = (x, n) => (x >>> n) | (x << (32 - n));
    const h = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ];
    const msgLen = data.length;
    const padLen = (msgLen % 64 < 56) ? 56 - (msgLen % 64) : 120 - (msgLen % 64);
    const buf = new Uint8Array(msgLen + padLen + 8);
    buf.set(data);
    buf[msgLen] = 0x80;
    const dv = new DataView(buf.buffer);
    const bitLen = msgLen * 8;
    dv.setUint32(buf.byteLength - 4, bitLen >>> 0, false);
    dv.setUint32(buf.byteLength - 8, Math.floor(bitLen / 0x100000000) >>> 0, false);
    const w = new Uint32Array(64);
    for (let i = 0; i < buf.byteLength; i += 64) {
        for (let j = 0; j < 16; j++) w[j] = dv.getUint32(i + j * 4, false);
        for (let j = 16; j < 64; j++) {
            const s0 = rotr(w[j - 15], 7) ^ rotr(w[j - 15], 18) ^ (w[j - 15] >>> 3);
            const s1 = rotr(w[j - 2], 17) ^ rotr(w[j - 2], 19) ^ (w[j - 2] >>> 10);
            w[j] = (w[j - 16] + s0 + w[j - 7] + s1) >>> 0;
        }
        let [a, b, c, d, e, f, g, hh] = h;
        for (let j = 0; j < 64; j++) {
            const S1  = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
            const ch  = (e & f) ^ (~e & g);
            const t1  = (hh + S1 + ch + _K[j] + w[j]) >>> 0;
            const S0  = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const t2  = (S0 + maj) >>> 0;
            hh = g; g = f; f = e; e = (d + t1) >>> 0;
            d = c; c = b; b = a; a = (t1 + t2) >>> 0;
        }
        h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0;
        h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
        h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0;
        h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
    }
    return h.map(n => n.toString(16).padStart(8, '0')).join('');
}

// Returns a hex SHA-256 string for a Uint8Array.
// Uses crypto.subtle on secure contexts (HTTPS/localhost); pure-JS fallback
// on insecure origins where crypto.subtle is undefined.
export async function sha256hex(bytes) {
    if (typeof crypto !== 'undefined' && crypto.subtle) {
        const buf = await crypto.subtle.digest('SHA-256', bytes);
        return Array.from(new Uint8Array(buf))
            .map(b => b.toString(16).padStart(2, '0')).join('');
    }
    return _sha256pure(bytes);
}

// ---------------------------------------------------------------------------
// Known-WAD table (mirrors tools/wad-identify.mjs)
// ---------------------------------------------------------------------------
const KNOWN = {
    'doom.wad':          { title: 'The Ultimate Doom' },
    'doomu.wad':         { title: 'The Ultimate Doom', rename: 'doom.wad' },
    'doom2.wad':         { title: 'Doom II: Hell on Earth' },
    'tnt.wad':           { title: 'Final Doom: TNT — Evilution' },
    'plutonia.wad':      { title: 'Final Doom: The Plutonia Experiment' },
    'nerve.wad':         { title: 'No Rest for the Living', base: 'doom2.wad' },
    'chex.wad':          { title: 'Chex Quest', standalone: true },
    // HACX v2.0-r61 (GZDoom ACS remaster) is not runnable on a vanilla engine.
    'hacx.wad':          { skip: true, skipReason: 'HACX v2 is not vanilla-engine compatible (use HACX v1.2 as a doom2.wad PWAD instead)' },
    'sigil.wad':         { title: 'SIGIL', base: 'doom.wad' },
    'sigil_v1_21.wad':   { title: 'SIGIL', base: 'doom.wad', rename: 'sigil.wad' },
    'tnt31.wad':         { title: 'TNT: Evilution — MAP31 fix', base: 'tnt.wad', patch: true },
};
const MASTER_TITLES = {
    'attack.wad': 'Attack', 'blacktwr.wad': 'Black Tower',
    'bloodsea.wad': 'Bloodsea Keep', 'canyon.wad': 'Canyon',
    'catwalk.wad': 'The Catwalk', 'combine.wad': 'The Combine',
    'fistula.wad': 'The Fistula', 'garrison.wad': 'The Garrison',
    'geryon.wad': 'Geryon', 'manor.wad': 'Titan Manor',
    'mephisto.wad': "Mephisto's Mausoleum", 'minos.wad': "Minos' Judgement",
    'nessus.wad': 'Nessus', 'paradox.wad': 'Paradox',
    'subspace.wad': 'Subspace', 'subterra.wad': 'Subterra',
    'teeth.wad': 'The Express Elevator to Hell',
    'ttrap.wad': 'Trapped on Titan', 'vesperas.wad': 'Vesperas',
    'virgil.wad': "Virgil's Lead",
};

// ---------------------------------------------------------------------------
// WadError — user-visible rejection reason
// ---------------------------------------------------------------------------
export class WadError extends Error {
    constructor(msg) { super(msg); this.name = 'WadError'; }
}

// ---------------------------------------------------------------------------
// Bounds-checked lump directory scan
// ---------------------------------------------------------------------------
// Hard cap on nlumps: prevents O(n) scans on hostile inputs.
const MAX_LUMPS = 65536;

function _scanLumps(dv, fileSize) {
    if (fileSize < 12) throw new WadError('file too small to contain a WAD header (< 12 bytes)');

    const nlumps = dv.getInt32(4, true);
    const dirOfs = dv.getInt32(8, true);

    if (nlumps < 0)         throw new WadError(`absurd lump count: ${nlumps} (negative)`);
    if (nlumps > MAX_LUMPS) throw new WadError(`absurd lump count: ${nlumps} (max ${MAX_LUMPS})`);
    if (dirOfs < 0)         throw new WadError(`directory offset negative: ${dirOfs}`);
    if (dirOfs > fileSize)  throw new WadError(`directory offset ${dirOfs} is past EOF (file is ${fileSize} bytes)`);

    const dirEnd = dirOfs + nlumps * 16;
    if (dirEnd < 0 || dirEnd > fileSize) {
        throw new WadError(
            `lump directory (${nlumps} entries @ offset ${dirOfs}) extends to byte ${dirEnd} ` +
            `but file is only ${fileSize} bytes`,
        );
    }

    const maps = [];
    for (let i = 0; i < nlumps; i++) {
        const o        = dirOfs + i * 16;
        const lumpOfs  = dv.getInt32(o,     true);
        const lumpSize = dv.getInt32(o + 4, true);

        if (lumpSize < 0) throw new WadError(`lump ${i}: negative size (${lumpSize})`);
        if (lumpOfs  < 0) throw new WadError(`lump ${i}: negative offset (${lumpOfs})`);
        if (lumpSize > 0 && lumpOfs + lumpSize > fileSize) {
            throw new WadError(
                `lump ${i}: data extends to byte ${lumpOfs + lumpSize} ` +
                `but file is only ${fileSize} bytes`,
            );
        }

        // Read lump name: 8 null-padded ASCII bytes
        let name = '';
        for (let j = 0; j < 8; j++) {
            const ch = dv.getUint8(o + 8 + j);
            if (ch === 0) break;
            name += String.fromCharCode(ch);
        }
        if (/^(E\dM\d|MAP\d{2})$/.test(name)) maps.push(name);
    }
    return maps;
}

// ---------------------------------------------------------------------------
// Main export: identify a WAD file from raw bytes
// ---------------------------------------------------------------------------
// bytes    — Uint8Array of the file contents
// filename — original filename string (basename extraction applied here)
//
// Returns a manifest entry:
//   { file, title, kind, base?, sha256, size, maps?, patch?, local:true }
//
// Throws WadError with a user-visible reason on any invalid/unsupported input.
export async function identifyWad(bytes, filename) {
    if (!bytes || bytes.length === 0) throw new WadError('zero-byte file');
    if (bytes.length < 12) throw new WadError('file too small to be a WAD (< 12 bytes)');

    // Check WAD magic
    const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    if (magic !== 'IWAD' && magic !== 'PWAD') {
        const safe = magic.replace(/[^\x20-\x7e]/g, '?');
        throw new WadError(`not a WAD file — magic bytes are ${JSON.stringify(safe)}, expected IWAD or PWAD`);
    }

    // Canonicalize filename: basename, lowercase
    const rawName = filename.replace(/^.*[/\\]/, '').toLowerCase();

    // Engine name limit: files.c uses name[32] (31 chars + null terminator)
    if (rawName.length > 31) {
        throw new WadError(
            `filename too long: "${rawName}" is ${rawName.length} chars; engine limit is 31`,
        );
    }
    if (!rawName.endsWith('.wad')) {
        throw new WadError(`not a .wad file: "${rawName}"`);
    }

    const known = KNOWN[rawName];
    if (known?.skip) {
        throw new WadError(known.skipReason ?? `${rawName}: not vanilla-engine compatible`);
    }

    // Bounds-checked lump scan using a DataView that honours byteOffset
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const maps = _scanLumps(dv, bytes.length);

    const canonical = known?.rename ?? rawName;
    const kind = (magic === 'IWAD' || known?.standalone) ? 'IWAD' : 'PWAD';

    let base = null;
    if (kind === 'PWAD') {
        base = known?.base
            ?? (MASTER_TITLES[rawName]
                ? 'doom2.wad'
                : (maps[0]?.startsWith('MAP') ? 'doom2.wad' : 'doom.wad'));
    }

    const sha = await sha256hex(bytes);

    const entry = {
        file:   canonical,
        title:  known?.title ?? MASTER_TITLES[rawName] ?? rawName.replace(/\.wad$/, ''),
        kind,
        sha256: sha,
        size:   bytes.length,
        local:  true,
    };
    if (base !== null)  entry.base  = base;
    if (known?.patch)   entry.patch = true;
    if (maps.length)    entry.maps  = maps;

    return entry;
}
