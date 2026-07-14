// DOOM UI assets, straight from the server's IWAD (/api/ui-assets):
// the STCFN HUD font (red), the menu skull cursor, the M_DOOM logo,
// PLAYPAL. Decodes the patch format to canvases and renders text with
// optional player-color translation (same index-range remap the engine
// uses for player sprites).

const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

// palette index ranges, as in r_draw.c translation tables
const COLOR_BASE = { Green: 0x70, Indigo: 0x60, Brown: 0x40, Red: 0xb0 };
const FONT_RANGE = [0xb0, 0xbf];        // STCFN glyphs live in the red run

export async function loadDoomFont() {
    const { lumps } = await (await fetch('/api/ui-assets')).json();
    const playpal = b64(lumps.PLAYPAL);

    function decodePatch(bytes, remapBase = null) {
        const v = new DataView(bytes.buffer, bytes.byteOffset);
        const w = v.getUint16(0, true), h = v.getUint16(2, true);
        if (!w || !h || w > 320 || h > 200) return null;
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        const img = ctx.createImageData(w, h);
        for (let x = 0; x < w; x++) {
            let o = v.getUint32(8 + 4 * x, true);
            for (;;) {
                const top = bytes[o];
                if (top === 0xff) break;
                const len = bytes[o + 1];
                for (let i = 0; i < len; i++) {
                    let idx = bytes[o + 3 + i];
                    if (remapBase !== null && idx >= FONT_RANGE[0] && idx <= FONT_RANGE[1])
                        idx = remapBase + (idx - FONT_RANGE[0]);
                    const p = ((top + i) * w + x) * 4;
                    img.data[p]     = playpal[idx * 3];
                    img.data[p + 1] = playpal[idx * 3 + 1];
                    img.data[p + 2] = playpal[idx * 3 + 2];
                    img.data[p + 3] = 255;
                }
                o += len + 4;
            }
        }
        ctx.putImageData(img, 0, 0);
        return canvas;
    }

    // glyph cache: color → char code → canvas
    const glyphs = new Map();
    const glyph = (c, color) => {
        const key = color ?? 'Red';
        if (!glyphs.has(key)) glyphs.set(key, new Map());
        const cache = glyphs.get(key);
        if (!cache.has(c)) {
            const lump = lumps[`STCFN${String(c).padStart(3, '0')}`];
            cache.set(c, lump ? decodePatch(b64(lump),
                color && color !== 'Red' ? COLOR_BASE[color] : null) : null);
        }
        return cache.get(c);
    };

    // charset is ASCII 33–95, uppercase only
    const normalize = s => s.toUpperCase()
        .replace(/[—–]/g, '-').replace(/[’']/g, "'").replace(/[^\x20-\x5f]/g, '');

    function text(str, { scale = 2, color = null } = {}) {
        const chars = [...normalize(str)];
        const SPACE = 4, LH = 9;
        let w = 0;
        const parts = chars.map(ch => {
            const c = ch.charCodeAt(0);
            const g = c === 32 ? null : glyph(c, color);
            const adv = g ? g.width : SPACE;
            const part = { g, x: w };
            w += adv;
            return part;
        });
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, w * scale);
        canvas.height = LH * scale;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        for (const p of parts)
            if (p.g) ctx.drawImage(p.g, p.x * scale, 0, p.g.width * scale, p.g.height * scale);
        return canvas;
    }

    function patch(name, scale = 2) {
        const c = decodePatch(b64(lumps[name]));
        if (!c) return null;
        const out = document.createElement('canvas');
        out.width = c.width * scale;
        out.height = c.height * scale;
        const ctx = out.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(c, 0, 0, out.width, out.height);
        return out;
    }

    return { text, patch };
}
