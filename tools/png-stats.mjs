// png-stats.mjs — decode a PNG far enough to say whether it is a PICTURE.
//
// "Static is also what an empty canvas looks like" (browser-fire arm f), and a
// white screen satisfies "the screenshot changed". A rendered-frame gate needs
// to measure the image, so this decodes one: IHDR, inflate the IDATs, unfilter
// the scanlines, and count distinct colours. No dependency -- zlib is built in.
import { inflateSync } from 'node:zlib';

const PAETH = (a, b, c) => {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
};

export function pngStats(buf) {
    if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
    let off = 8, ihdr = null;
    const idat = [];
    while (off < buf.length) {
        const len = buf.readUInt32BE(off);
        const type = buf.toString('ascii', off + 4, off + 8);
        const data = buf.subarray(off + 8, off + 8 + len);
        if (type === 'IHDR') ihdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4),
                                      depth: data[8], colour: data[9], interlace: data[12] };
        else if (type === 'IDAT') idat.push(data);
        else if (type === 'IEND') break;
        off += 12 + len;
    }
    if (!ihdr) throw new Error('no IHDR');
    if (ihdr.depth !== 8) throw new Error(`unsupported bit depth ${ihdr.depth}`);
    if (ihdr.interlace) throw new Error('interlaced PNG unsupported');
    const CH = { 0: 1, 2: 3, 4: 2, 6: 4 }[ihdr.colour];
    if (!CH) throw new Error(`unsupported colour type ${ihdr.colour}`);

    const raw = inflateSync(Buffer.concat(idat));
    const stride = ihdr.w * CH;
    const out = Buffer.alloc(ihdr.h * stride);
    let p = 0;
    for (let y = 0; y < ihdr.h; y++) {
        const filter = raw[p++];
        const row = raw.subarray(p, p + stride); p += stride;
        const cur = out.subarray(y * stride, (y + 1) * stride);
        const prev = y ? out.subarray((y - 1) * stride, y * stride) : null;
        for (let x = 0; x < stride; x++) {
            const a = x >= CH ? cur[x - CH] : 0;
            const b = prev ? prev[x] : 0;
            const c = (prev && x >= CH) ? prev[x - CH] : 0;
            const v = row[x];
            cur[x] = (filter === 0 ? v
                   : filter === 1 ? v + a
                   : filter === 2 ? v + b
                   : filter === 3 ? v + ((a + b) >> 1)
                   :                v + PAETH(a, b, c)) & 0xff;
        }
    }

    // Sample on a grid: a full 1280x960 frame is 1.2M pixels and the question
    // ("is this a picture or a flat fill?") does not need all of them.
    // FLATNESS, not whiteness. The first cut counted non-white pixels and read
    // "100% non-white" for about:blank, because under Xvfb a blank page captures
    // transparent and unfilters to 0,0,0 -- so the metric called the emptiest
    // possible image maximally interesting. What distinguishes a picture from a
    // fill is how much of it is NOT the dominant colour, whatever that is.
    const hist = new Map();
    let sampled = 0;
    const step = Math.max(1, Math.floor(Math.min(ihdr.w, ihdr.h) / 200));
    for (let y = 0; y < ihdr.h; y += step) {
        for (let x = 0; x < ihdr.w; x += step) {
            const i = y * stride + x * CH;
            const r = out[i], g = CH >= 3 ? out[i + 1] : r, b = CH >= 3 ? out[i + 2] : r;
            const k = (r << 16) | (g << 8) | b;
            hist.set(k, (hist.get(k) ?? 0) + 1);
            sampled++;
        }
    }
    let dominant = 0;
    for (const n of hist.values()) if (n > dominant) dominant = n;
    return { w: ihdr.w, h: ihdr.h, sampled, colours: hist.size,
             variedPct: Math.round(1000 * (sampled - dominant) / sampled) / 10 };
}
