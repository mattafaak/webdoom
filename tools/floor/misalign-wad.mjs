#!/usr/bin/env node
// Rewrite a WAD so that every lump, and the directory, starts at an odd
// offset: the same lumps, names, sizes and order, the same bytes in each, only
// where they sit in the file moves.  A port that reads lumps in place
// (WEB_LUMPS_IN_PLACE, engine/core/w_wad.h) then reads every multi-byte field
// of every lump unaligned; on a CPU that traps an unaligned access (the
// armv6m board, tools/cortexm) only byte-safe reads survive.  The IWADs
// themselves never show this: id padded every lump to 4 bytes.
//
// Each lump goes at an offset = 1 (mod 4), so a short is at an odd address
// and an int at one 1 past a multiple of 4.  Lumps that shared their bytes
// in the source (the same filepos and size) share them here too.  A lump of
// size 0 keeps a position just past the previous lump's data.
//
// usage: node tools/floor/misalign-wad.mjs IN.wad OUT.wad
// Prints one line: how many lumps moved and the new file's size.
// Copyright (C) 2026, GPL-2.0-or-later.
import { readFileSync, writeFileSync } from 'node:fs';

const [inPath, outPath] = process.argv.slice(2);
if (!inPath || !outPath) { console.log('usage: misalign-wad.mjs IN.wad OUT.wad'); process.exit(2); }
const src = readFileSync(inPath);
const ident = src.toString('latin1', 0, 4);
if (ident !== 'IWAD' && ident !== 'PWAD') { console.log(`FAIL misalign-wad: ${inPath} is not a WAD`); process.exit(1); }
const n = src.readInt32LE(4), dirofs = src.readInt32LE(8);
if (n <= 0 || dirofs < 12 || dirofs + 16 * n > src.length) { console.log(`FAIL misalign-wad: ${inPath}: directory out of range`); process.exit(1); }

const odd = off => off + ((1 - off) % 4 + 4) % 4;   // the next offset = 1 (mod 4)
const chunks = [src.subarray(0, 12)];
let at = 12;
const dir = Buffer.alloc(16 * n);
const placed = new Map();   // "pos:size" -> new pos
let moved = 0;
for (let i = 0; i < n; i++) {
    const e = dirofs + 16 * i;
    const pos = src.readInt32LE(e), size = src.readInt32LE(e + 4);
    if (pos < 0 || size < 0 || pos + size > src.length) { console.log(`FAIL misalign-wad: lump ${i} runs past the end of ${inPath}`); process.exit(1); }
    let np;
    if (size === 0) np = at;
    else if (placed.has(`${pos}:${size}`)) np = placed.get(`${pos}:${size}`);
    else {
        np = odd(at);
        chunks.push(Buffer.alloc(np - at), src.subarray(pos, pos + size));
        at = np + size;
        placed.set(`${pos}:${size}`, np);
        if (np % 4 !== pos % 4) moved++;
    }
    dir.writeInt32LE(np, 16 * i);
    dir.writeInt32LE(size, 16 * i + 4);
    src.copy(dir, 16 * i + 8, e + 8, e + 16);
}
const nd = odd(at) + 2;   // the directory too: = 3 (mod 4)
chunks.push(Buffer.alloc(nd - at), dir);
const out = Buffer.concat(chunks);
out.writeInt32LE(nd, 8);
writeFileSync(outPath, out);
console.log(`misalign-wad: ${outPath}: ${n} lumps, ${moved} moved off their alignment, every lump at = 1 (mod 4), directory at ${nd} (= ${nd % 4} mod 4), ${out.length} B`);
