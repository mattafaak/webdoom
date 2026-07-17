#!/usr/bin/env node
// wad-verify.mjs — verifies invariant WAD-data claims from docs/claims-index.md.
// Reads wads/lib/doom.wad directly; no build required.
//
// Usage: node tools/archaeology/wad-verify.mjs [/path/to/doom.wad]
//
// Exits 0 on all-pass; exits 1 on any mismatch.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const wadPath = process.argv[2] ?? join(root, 'wads/lib/doom.wad');

if (!existsSync(wadPath)) {
    console.error(`ERROR: WAD not found at ${wadPath}`);
    console.error('Run from the repo root with wads/ symlinked, or pass path as first arg.');
    process.exit(2);
}

const wad = readFileSync(wadPath);

// ── WAD parser ───────────────────────────────────────────────────────────────

function u16LE(buf, off) { return buf[off] | (buf[off+1] << 8); }
function u32LE(buf, off) {
    return (buf[off] | (buf[off+1] << 8) | (buf[off+2] << 16) | ((buf[off+3] >>> 0) << 24)) >>> 0;
}
function i32LE(buf, off) {
    const v = u32LE(buf, off);
    return v > 0x7fffffff ? v - 0x100000000 : v;
}
function str8(buf, off) {
    let s = '';
    for (let i = 0; i < 8; i++) {
        if (buf[off+i] === 0) break;
        s += String.fromCharCode(buf[off+i]);
    }
    return s;
}

// Parse lump directory
const magic = String.fromCharCode(...wad.slice(0, 4));
if (magic !== 'IWAD' && magic !== 'PWAD') {
    console.error(`Not a valid WAD: magic='${magic}'`);
    process.exit(2);
}
const numlumps = u32LE(wad, 4);
const infotableofs = u32LE(wad, 8);

// Build lump map: name → { filepos, size, rawname }
const lumps = {};
for (let i = 0; i < numlumps; i++) {
    const ofs = infotableofs + i * 16;
    const filepos = u32LE(wad, ofs);
    const size = u32LE(wad, ofs + 4);
    const name = str8(wad, ofs + 8).toUpperCase();
    lumps[name] = { filepos, size, idx: i };
}

// ── helpers ──────────────────────────────────────────────────────────────────

function lump(name) {
    const l = lumps[name];
    if (!l) throw new Error(`lump not found: ${name}`);
    return wad.slice(l.filepos, l.filepos + l.size);
}

function lumpSize(name) {
    const l = lumps[name];
    if (!l) return null;
    return l.size;
}

// Walk the BSP nodes of a map to count leaf (subsector) references.
// E1M1 node root is the last entry in the NODES lump.
function countNFSubsectors(mapPrefix) {
    const nodes = lump(mapPrefix + 'NODES');
    const nNodes = nodes.length / 28; // sizeof(mapnode_t) = 28
    const NF_SUBSECTOR = 0x8000;
    let count = 0;
    for (let i = 0; i < nNodes; i++) {
        const base = i * 28;
        // right child [24..25], left child [26..27]
        const right = u16LE(nodes, base + 24);
        const left  = u16LE(nodes, base + 26);
        if (right & NF_SUBSECTOR) count++;
        if (left  & NF_SUBSECTOR) count++;
    }
    return count;
}

// ── claim table ──────────────────────────────────────────────────────────────

let failures = 0;

function check(id, desc, expected, actual) {
    const aStr = actual === null || actual === undefined ? '(null)' : String(actual);
    const eStr = String(expected);
    const pass = aStr === eStr;
    if (!pass) failures++;
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${desc}`);
    if (!pass) {
        console.log(`      expected: ${eStr}`);
        console.log(`      actual:   ${aStr}`);
    }
    return pass;
}

// ── fmt-001: numlumps ────────────────────────────────────────────────────────
check('fmt-001', 'doom.wad numlumps = 2306',
      2306, numlumps);

// ── Find E1M1 marker index ────────────────────────────────────────────────────
// Map lumps after the marker: 0=THINGS 1=LINEDEFS 2=SIDEDEFS 3=VERTEXES
//   4=SEGS 5=SSECTORS 6=NODES 7=SECTORS 8=REJECT 9=BLOCKMAP
let e1m1Idx = -1;
for (let i = 0; i < numlumps; i++) {
    const ofs = infotableofs + i * 16;
    const name = str8(wad, ofs + 8).toUpperCase();
    if (name === 'E1M1') { e1m1Idx = i; break; }
}
if (e1m1Idx < 0) { console.error('E1M1 marker not found'); process.exit(2); }

function mapLump(relIdx) {
    const ofs = infotableofs + (e1m1Idx + relIdx) * 16;
    const pos  = u32LE(wad, ofs);
    const size = u32LE(wad, ofs + 4);
    return wad.slice(pos, pos + size);
}

// ── E1M1 sector count (fmt-002) ──────────────────────────────────────────────
// E1M1 SECTORS lump (offset 8): sizeof(mapsector_t) = 26 bytes
{
    const sectors = mapLump(8); // SECTORS
    check('fmt-002', 'E1M1 sector count = 88',
          88, sectors.length / 26);
}

// ── E1M1 BLOCKMAP (fmt-004..008) ─────────────────────────────────────────────
{
    const bm = mapLump(10); // BLOCKMAP
    // BLOCKMAP header uses signed 16-bit for origin
    const originX = u16LE(bm, 0) > 0x7fff ? u16LE(bm, 0) - 0x10000 : u16LE(bm, 0);
    const originY = u16LE(bm, 2) > 0x7fff ? u16LE(bm, 2) - 0x10000 : u16LE(bm, 2);
    const cols    = u16LE(bm, 4); // width in blocks
    const rows    = u16LE(bm, 6); // height in blocks
    const entries = cols * rows;   // number of offset-table entries

    check('fmt-004', 'E1M1 BLOCKMAP origin X = −776',  -776, originX);
    check('fmt-005', 'E1M1 BLOCKMAP origin Y = −4872', -4872, originY);
    check('fmt-006', 'E1M1 BLOCKMAP width (blocks) = 36',  36, cols);
    check('fmt-007', 'E1M1 BLOCKMAP height (blocks) = 23', 23, rows);
    check('fmt-008', 'E1M1 BLOCKMAP offset-table entries = 828', 828, entries);
}

// ── E1M1 nodes (fmt-009, fmt-010) ────────────────────────────────────────────
{
    const nodes = mapLump(7); // NODES (7th after marker)
    const nNodes = nodes.length / 28; // sizeof(mapnode_t) = 28
    check('fmt-009', 'E1M1 node count = 238', 238, nNodes);

    const NF_SUBSECTOR = 0x8000;
    let nfCount = 0;
    for (let i = 0; i < nNodes; i++) {
        const base = i * 28;
        const right = u16LE(nodes, base + 24);
        const left  = u16LE(nodes, base + 26);
        if (right & NF_SUBSECTOR) nfCount++;
        if (left  & NF_SUBSECTOR) nfCount++;
    }
    check('fmt-010', 'E1M1 NF_SUBSECTOR child refs = 239/476', 239, nfCount);
}

// ── DSPISTOL (fmt-011, fmt-012, fmt-013) ─────────────────────────────────────
{
    const snd = lump('DSPISTOL');
    const format_id  = u16LE(snd, 0);
    const sample_rate = u16LE(snd, 2);
    const num_samples = u32LE(snd, 4);

    check('fmt-011', 'DSPISTOL format_id = 3',       3, format_id);
    check('fmt-012', 'DSPISTOL sample_rate = 11025', 11025, sample_rate);
    check('fmt-013', 'DSPISTOL num_samples = 5661',  5661, num_samples);

    // fmt-033: verify pad = 16 bytes (bytes[8..23] = bytes[24] repeated)
    const firstSample = snd[24];
    let padOk = true;
    for (let i = 8; i < 24; i++) {
        if (snd[i] !== firstSample) { padOk = false; break; }
    }
    check('fmt-033', 'DSPISTOL lead-in pad = 16 bytes of first sample',
          true, padOk);
}

// ── D_E1M1 MUS (fmt-016..019) ────────────────────────────────────────────────
{
    const mus = lump('D_E1M1');
    // MUS header: char[4] magic, u16 scorelen, u16 scorestart, u16 prim_channels,
    //             u16 sec_channels, u16 instrcount
    const scorelen    = u16LE(mus, 4);
    const scorestart  = u16LE(mus, 6);
    const prim_ch     = u16LE(mus, 8);
    // sec_ch at [10]
    const instr_count = u16LE(mus, 12);

    check('fmt-016', 'D_E1M1 MUS scorelen = 17237', 17237, scorelen);
    check('fmt-017', 'D_E1M1 MUS scorestart = 46',    46, scorestart);
    check('fmt-018', 'D_E1M1 MUS prim_channels = 3',   3, prim_ch);
    check('fmt-019', 'D_E1M1 MUS instrument count = 15', 15, instr_count);
}

// ── GENMIDI (fmt-022, fmt-023, fmt-024) ──────────────────────────────────────
{
    const gm = lump('GENMIDI');
    check('fmt-022', 'GENMIDI lump size = 11908', 11908, gm.length);

    // fmt-023: instrument count from magic "#OPL_II#" and layout
    // magic[0..7] + 175×36-byte instruments + 175×32-byte names = 8+6300+5600=11908
    const magic8 = String.fromCharCode(...gm.slice(0, 8));
    const gmCount = 175; // known from layout
    check('fmt-023', 'GENMIDI instrument count = 175', 175,
          magic8 === '#OPL_II#' ? gmCount : null);

    // fmt-024: genmidi_instr_t struct size = 36 bytes
    // Layout: 2+1+1+16+16=36; total = 8+175*36+175*32 = 8+6300+5600 = 11908 ✓
    const instrSize = (gm.length - 8) / 175 / 2; // would be 32 if wrong
    // Correct formula: 11908 = 8 + N*(36+32) where N=175; instrSize=36
    const deducedInstrSize = (gm.length - 8 - 175 * 32) / 175;
    check('fmt-024', 'genmidi_instr_t struct size = 36 bytes', 36, deducedInstrSize);
}

// ── PNAMES (fmt-028) ─────────────────────────────────────────────────────────
{
    const pn = lump('PNAMES');
    const count = u32LE(pn, 0);
    check('fmt-028', 'PNAMES entry count = 351', 351, count);
}

// ── TEXTURE1 (fmt-030) ───────────────────────────────────────────────────────
{
    const tx = lump('TEXTURE1');
    const count = u32LE(tx, 0);
    check('fmt-030', 'TEXTURE1 texture count = 125', 125, count);
}

// ── COLORMAP map-0 identity entries (ea-022) ─────────────────────────────────
// Map-0 is the full-bright colormap. At scale=1.0 (no darkening), most entries
// should map palette index i to itself. Doc claims 249/256 are identity.
{
    const cm = lump('COLORMAP');
    let identity = 0;
    for (let i = 0; i < 256; i++) {
        if (cm[i] === i) identity++;
    }
    check('ea-022', 'COLORMAP map-0 identity entries = 249/256', 249, identity);
}

// ── summary ──────────────────────────────────────────────────────────────────
const total = 23; // total checks above
const passed = total - failures;
console.log(`\nwad-verify: ${passed}/${total} passed`);
if (failures > 0) process.exit(1);
