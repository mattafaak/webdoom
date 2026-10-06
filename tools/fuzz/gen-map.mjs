#!/usr/bin/env node
// tools/fuzz/gen-map.mjs — seeded E1M1 map-mutation PWAD generator.
//
// Reads doom.wad's E1M1 map lumps (THINGS/LINEDEFS/SIDEDEFS/VERTEXES/SEGS/
// SSECTORS/NODES/SECTORS/REJECT/BLOCKMAP) and produces a PWAD replacing E1M1
// with a mutated copy, plus a short idle FUZZDEMO lump for timedemo playback.
//
// Mutation policy:
//   Benign mode: mutates non-geometry fields within valid ranges.
//     - THINGS: type (0-136 vanilla mobjinfo range), angle (0-359),
//               flags (valid thing flags), x/y clamped to E1M1 bbox
//     - LINEDEFS: flags (bit 0-8), special (0-255), tag (0-255)
//     - SIDEDEFS: x/y texture offset (full i16 range), texture names
//                 (random but 8-char null-padded)
//     - SECTORS: floor/ceiling height (clamped range), lightlevel (0-255),
//               special (0-17), tag (0-255)
//   Adversarial mode: also includes out-of-range mutations.
//     - THINGS type beyond mobjinfo table (>= 137)
//     - SECTORS special beyond switch table (>= 18)
//     - SIDEDEFS sector index out of range (>= numSectors)
//     These stress the unguarded load paths ASan can catch.
//
// Geometry (VERTEXES/SEGS/SSECTORS/NODES/BLOCKMAP) is NEVER mutated by those
// two modes.  No node rebuild is needed; the map stays loadable with original
// BSP data.  genGeometryMap is the exception: it puts ONE impossible value --
// an index past the array it selects, a missing side, a list with no end --
// into the geometry lumps, and every such map must be refused at load.  Its
// two accepted kinds are odd data real PWADs have, which the loader handles as
// Chocolate Doom does: a short REJECT (padded) and a two-sided linedef with no
// back side (the "glass hack", given Chocolate's null sector).
//
// Demo lump:
//   A short idle demo (35 tics, all-zero ticcmds) for doom.wad episode 1 map 1.
//   The player just stands at the E1M1 spawn point — valid for any geometry-
//   preserving mutation.
//
// Usage (CLI):
//   node tools/fuzz/gen-map.mjs <seed> [--adversarial] [<outfile>]
//   — writes the PWAD to outfile (default: mapfuzz<seed>.wad)
//
// API (import):
//   import { genMutatedMap } from './gen-map.mjs';
//   const { pwad, mutations, numSectors } = genMutatedMap(seed, { adversarial: false });

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mulberry32 } from './gen-demo.mjs';
import { root } from '../lib/util.mjs';

const DOOM_WAD = join(root, 'wads/lib/doom.wad');

// ── WAD directory parser ──────────────────────────────────────────────────────
function parseWadDir(buf) {
    const magic = buf.slice(0, 4).toString('ascii');
    if (magic !== 'IWAD' && magic !== 'PWAD') {
        throw new Error(`Not a WAD file (magic: ${magic})`);
    }
    const numlumps = buf.readUInt32LE(4);
    const infotableofs = buf.readUInt32LE(8);
    const lumps = [];
    for (let i = 0; i < numlumps; i++) {
        const ofs = infotableofs + i * 16;
        const filepos = buf.readUInt32LE(ofs);
        const size = buf.readUInt32LE(ofs + 4);
        // Name: 8 bytes, null-padded, null-terminated
        const nameRaw = buf.slice(ofs + 8, ofs + 16);
        let name = '';
        for (let j = 0; j < 8 && nameRaw[j] !== 0; j++) {
            name += String.fromCharCode(nameRaw[j]);
        }
        lumps.push({ filepos, size, name });
    }
    return lumps;
}

// ── Read lump data from WAD buffer ────────────────────────────────────────────
function readLump(wadBuf, lumpEntry) {
    if (lumpEntry.size === 0) return Buffer.alloc(0);
    return Buffer.from(wadBuf.slice(lumpEntry.filepos, lumpEntry.filepos + lumpEntry.size));
}

// ── Texture name reader (parsed from the IWAD at runtime) ────────────────────
// Reads TEXTURE1 lump (wall textures) and F_START/F_END section (flat textures)
// directly from the doom.wad buffer so mutation selections are always valid for
// the IWAD in use — no hardcoded lists that can include DOOM2-only names.
function readWadTextures(wadBuf) {
    const lumps = parseWadDir(wadBuf);

    // Wall textures: parse TEXTURE1 lump
    const wallTextures = ['-'];  // always include "no texture" sentinel
    const t1Entry = lumps.find(l => l.name === 'TEXTURE1');
    if (t1Entry && t1Entry.size > 0) {
        const t1 = wadBuf.slice(t1Entry.filepos, t1Entry.filepos + t1Entry.size);
        const numtex = t1.readUInt32LE(0);
        for (let i = 0; i < numtex; i++) {
            const tofs = t1.readUInt32LE(4 + i * 4);
            let name = '';
            for (let j = 0; j < 8; j++) {
                const c = t1[tofs + j];
                if (c === 0) break;
                name += String.fromCharCode(c);
            }
            if (name) wallTextures.push(name);
        }
    }

    // Flat textures: names between F_START and F_END markers
    const flatTextures = [];
    let inFlats = false;
    for (const l of lumps) {
        if (l.name === 'F_START' || l.name === 'FF_START') { inFlats = true; continue; }
        if (l.name === 'F_END'   || l.name === 'FF_END')   { inFlats = false; continue; }
        if (inFlats && l.size === 4096) flatTextures.push(l.name);  // flats are 64×64
    }

    return { wallTextures, flatTextures };
}

// Read at module load time (only once per process).
const _wadBufForTextures = readFileSync(DOOM_WAD);
const { wallTextures: WALL_TEXTURES, flatTextures: FLAT_TEXTURES } = readWadTextures(_wadBufForTextures);
if (WALL_TEXTURES.length < 2) throw new Error('Failed to read wall textures from doom.wad');
if (FLAT_TEXTURES.length < 4) throw new Error('Failed to read flat textures from doom.wad');

// ── PWAD name encoding ────────────────────────────────────────────────────────
function encodeName(name) {
    const b = Buffer.alloc(8, 0);
    const s = name.toUpperCase().slice(0, 8);
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
    return b;
}

// ── Build a minimal idle demo lump ────────────────────────────────────────────
// 35 tics of zero ticcmds on doom.wad episode 1 map 1 (E1M1).
function buildIdleDemo({ tics = 35, skill = 2, episode = 1, map = 1 } = {}) {
    // Demo header: 13 bytes (vanilla v1.9 format, same as gen-demo.mjs)
    const HEADER_SIZE = 13;
    const TERM_SIZE = 1;
    const lumpSize = HEADER_SIZE + tics * 4 + TERM_SIZE;
    const lump = Buffer.alloc(lumpSize, 0);
    let p = 0;

    lump[p++] = 109;    // version: vanilla v1.9
    lump[p++] = skill;  // gameskill
    lump[p++] = episode;// gameepisode
    lump[p++] = map;    // gamemap
    lump[p++] = 0;      // deathmatch
    lump[p++] = 0;      // respawnparm
    lump[p++] = 0;      // fastparm
    lump[p++] = 0;      // nomonsters
    lump[p++] = 0;      // consoleplayer
    lump[p++] = 1;      // playeringame[0]
    lump[p++] = 0;      // playeringame[1]
    lump[p++] = 0;      // playeringame[2]
    lump[p++] = 0;      // playeringame[3]

    // Tics: all zero (idle — forwardmove=0, sidemove=0, angle=0, buttons=0)
    // Zero bytes already from alloc, so just advance pointer
    p += tics * 4;

    // Demo terminator
    lump[p++] = 0x80;

    return lump;
}

// ── Map lump record sizes ─────────────────────────────────────────────────────
const THING_SIZE   = 10;  // x(2) y(2) angle(2) type(2) flags(2)
const LINEDEF_SIZE = 14;  // v1(2) v2(2) flags(2) special(2) tag(2) sidenum[2](4)
const SIDEDEF_SIZE = 30;  // xoff(2) yoff(2) upper[8] lower[8] mid[8] sector(2)
const SECTOR_SIZE  = 26;  // floorh(2) ceilh(2) floortex[8] ceiltex[8] light(2) special(2) tag(2)

// The 10 map sub-lumps follow the marker
const MAP_SUBLUMPS = ['THINGS','LINEDEFS','SIDEDEFS','VERTEXES','SEGS',
                      'SSECTORS','NODES','SECTORS','REJECT','BLOCKMAP'];

// E1M1's ten lumps from doom.wad, as fresh Buffers keyed by name.
function readE1M1() {
    const wadBuf = readFileSync(DOOM_WAD);
    const lumps = parseWadDir(wadBuf);

    // Find E1M1 marker
    const e1m1Idx = lumps.findIndex(l => l.name === 'E1M1');
    if (e1m1Idx < 0) throw new Error('E1M1 not found in doom.wad');

    const subLumps = {};
    for (let i = 0; i < MAP_SUBLUMPS.length; i++) {
        const l = lumps[e1m1Idx + 1 + i];
        if (!l || l.name !== MAP_SUBLUMPS[i]) {
            throw new Error(`Expected ${MAP_SUBLUMPS[i]} at index ${e1m1Idx + 1 + i}, got ${l?.name}`);
        }
        subLumps[l.name] = readLump(wadBuf, l);
    }
    return subLumps;
}

// ── genMutatedMap ─────────────────────────────────────────────────────────────
// Returns { pwad: Buffer, mutations: string[], numSectors: number }.
export function genMutatedMap(seed, { adversarial = false } = {}) {
    const subLumps = readE1M1();

    const prng = mulberry32(seed >>> 0);
    const rng = () => prng();
    const mutations = [];

    // ── Compute map bounds from VERTEXES for THINGS x/y clamping ─────────────
    const vtxBuf = subLumps['VERTEXES'];
    const numVerts = vtxBuf.length / 4;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < numVerts; i++) {
        const x = vtxBuf.readInt16LE(i * 4);
        const y = vtxBuf.readInt16LE(i * 4 + 2);
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
    }

    // ── THINGS mutation ───────────────────────────────────────────────────────
    const thingBuf = Buffer.from(subLumps['THINGS']);
    const numThings = thingBuf.length / THING_SIZE;
    // Probability: mutate ~30% of things
    const VANILLA_MOBJINFO_COUNT = 137;  // info.c table size in vanilla doom
    let thingMutations = 0;
    for (let i = 0; i < numThings; i++) {
        const off0 = i * THING_SIZE;
        // Preserve player starts (types 1-4). Mutating a player-1 start away
        // leaves player->mo null → P_PlayerThink derefs it (p_user.c:264),
        // which is vanilla's own "trusts its WAD" behaviour, not a webdoom bug
        // or a wasm-vs-native divergence — it just made an UNLOADABLE map and
        // drowned the real map-load parity signal in null-deref noise. Keeping
        // the start makes each mutated map actually playable.
        const curType = thingBuf.readUInt16LE(off0 + 6);
        if (curType >= 1 && curType <= 4) continue;
        if (rng() < 0.3) {
            const off = i * THING_SIZE;
            const field = Math.floor(rng() * 5);
            if (field === 0) {
                // x within map bounds
                const newX = Math.floor(rng() * (maxX - minX)) + minX;
                thingBuf.writeInt16LE(newX, off);
            } else if (field === 1) {
                // y within map bounds
                const newY = Math.floor(rng() * (maxY - minY)) + minY;
                thingBuf.writeInt16LE(newY, off + 2);
            } else if (field === 2) {
                // angle: 0-359 in degree units (stored as degrees)
                const newAngle = Math.floor(rng() * 360);
                thingBuf.writeUInt16LE(newAngle, off + 4);
            } else if (field === 3) {
                // type: in benign mode stay in mobjinfo range
                let newType;
                if (adversarial && rng() < 0.3) {
                    // Out-of-range type (beyond mobjinfo table)
                    newType = VANILLA_MOBJINFO_COUNT + Math.floor(rng() * 200);
                } else {
                    // Skip type 0 (invalid) — use 1..VANILLA_MOBJINFO_COUNT
                    newType = 1 + Math.floor(rng() * (VANILLA_MOBJINFO_COUNT - 1));
                }
                thingBuf.writeUInt16LE(newType, off + 6);
            } else {
                // flags: valid doom thing flags (bits 0-4)
                // Bit 0: skill 1-2, Bit 1: skill 3, Bit 2: skill 4-5,
                // Bit 3: ambush, Bit 4: network-only (not single-player)
                const newFlags = Math.floor(rng() * 32);
                thingBuf.writeUInt16LE(newFlags, off + 8);
            }
            thingMutations++;
        }
    }
    if (thingMutations > 0) mutations.push(`THINGS.mixed ×${thingMutations}`);

    // ── LINEDEFS mutation ─────────────────────────────────────────────────────
    const linedefBuf = Buffer.from(subLumps['LINEDEFS']);
    const numLinedefs = linedefBuf.length / LINEDEF_SIZE;
    // Offsets in 14-byte linedef record:
    //   0: v1(2) 2: v2(2) 4: flags(2) 6: special(2) 8: tag(2) 10: sidenum[0](2) 12: sidenum[1](2)
    let linedefMutations = 0;
    for (let i = 0; i < numLinedefs; i++) {
        if (rng() < 0.25) {
            const off = i * LINEDEF_SIZE;
            const field = Math.floor(rng() * 3);
            if (field === 0) {
                // flags: bits 0-8 (impassable, block monsters, two-sided, unpegged, secret, soundblock, hidden, mapped, passthru)
                const newFlags = Math.floor(rng() * 512);
                linedefBuf.writeUInt16LE(newFlags, off + 4);
            } else if (field === 1) {
                // special: 0-255 (line special type)
                const newSpecial = Math.floor(rng() * 256);
                linedefBuf.writeUInt16LE(newSpecial, off + 6);
            } else {
                // tag: 0-255 (sector tag)
                const newTag = Math.floor(rng() * 256);
                linedefBuf.writeUInt16LE(newTag, off + 8);
            }
            linedefMutations++;
        }
    }
    if (linedefMutations > 0) mutations.push(`LINEDEFS.mixed ×${linedefMutations}`);

    // ── SIDEDEFS mutation ─────────────────────────────────────────────────────
    const sidedefBuf = Buffer.from(subLumps['SIDEDEFS']);
    const numSidedefs = sidedefBuf.length / SIDEDEF_SIZE;
    // Read sector count from SECTORS lump (for adversarial range checks)
    const numSectors = subLumps['SECTORS'].length / SECTOR_SIZE;
    // Sidedef offsets:
    //   0: xoff(2) 2: yoff(2) 4: upper[8] 12: lower[8] 20: mid[8] 28: sector(2)
    let sidedefMutations = 0;
    for (let i = 0; i < numSidedefs; i++) {
        if (rng() < 0.2) {
            const off = i * SIDEDEF_SIZE;
            const field = Math.floor(rng() * 4);
            if (field === 0) {
                // xoffset: full i16 range
                const newX = Math.floor(rng() * 65536) - 32768;
                sidedefBuf.writeInt16LE(newX, off);
            } else if (field === 1) {
                // yoffset: full i16 range
                const newY = Math.floor(rng() * 65536) - 32768;
                sidedefBuf.writeInt16LE(newY, off + 2);
            } else if (field === 2) {
                // Texture name (upper, lower, or mid)
                const texField = Math.floor(rng() * 3);
                const texOff = off + 4 + texField * 8;
                const texName = WALL_TEXTURES[Math.floor(rng() * WALL_TEXTURES.length)];
                const nameBytes = encodeName(texName);
                nameBytes.copy(sidedefBuf, texOff);
            } else {
                // sector index
                if (adversarial && rng() < 0.4) {
                    // Out-of-range sector index — key adversarial surface
                    // (p_setup.c loads sidedefs and directly indexes the sector array)
                    const oobSector = numSectors + Math.floor(rng() * 256);
                    sidedefBuf.writeUInt16LE(oobSector, off + 28);
                } else {
                    // Valid sector index (0..numSectors-1)
                    const validSector = Math.floor(rng() * numSectors);
                    sidedefBuf.writeUInt16LE(validSector, off + 28);
                }
            }
            sidedefMutations++;
        }
    }
    if (sidedefMutations > 0) {
        mutations.push(adversarial
            ? `SIDEDEFS.mixed ×${sidedefMutations} (incl. sector-OOB)`
            : `SIDEDEFS.mixed ×${sidedefMutations}`);
    }

    // ── SECTORS mutation ──────────────────────────────────────────────────────
    const sectorBuf = Buffer.from(subLumps['SECTORS']);
    // Sector offsets:
    //   0: floorh(2) 2: ceilh(2) 4: floortex[8] 12: ceiltex[8] 20: lightlevel(2)
    //   22: special(2) 24: tag(2)
    const VANILLA_SECTOR_SPECIALS = 18;  // 0-17 defined in vanilla p_spec.c
    let sectorMutations = 0;
    for (let i = 0; i < numSectors; i++) {
        if (rng() < 0.35) {
            const off = i * SECTOR_SIZE;
            const field = Math.floor(rng() * 6);
            if (field === 0) {
                // floor height: keep sane (-512..512)
                const newH = Math.floor(rng() * 1024) - 512;
                sectorBuf.writeInt16LE(newH, off);
            } else if (field === 1) {
                // ceiling height: keep sane (-512..512), ensure >= floor
                const floorH = sectorBuf.readInt16LE(off);
                const newH = floorH + Math.floor(rng() * 512);
                sectorBuf.writeInt16LE(Math.min(newH, 32767), off + 2);
            } else if (field === 2) {
                // floor texture
                const flat = FLAT_TEXTURES[Math.floor(rng() * FLAT_TEXTURES.length)];
                encodeName(flat).copy(sectorBuf, off + 4);
            } else if (field === 3) {
                // ceiling texture
                const flat = FLAT_TEXTURES[Math.floor(rng() * FLAT_TEXTURES.length)];
                encodeName(flat).copy(sectorBuf, off + 12);
            } else if (field === 4) {
                // lightlevel: 0-255
                const newLight = Math.floor(rng() * 256);
                sectorBuf.writeUInt16LE(newLight, off + 20);
            } else {
                // special: benign=0-17, adversarial extends past table
                let newSpecial;
                if (adversarial && rng() < 0.4) {
                    newSpecial = VANILLA_SECTOR_SPECIALS + Math.floor(rng() * 200);
                } else {
                    newSpecial = Math.floor(rng() * VANILLA_SECTOR_SPECIALS);
                }
                sectorBuf.writeUInt16LE(newSpecial, off + 22);
                // tag: 0-255
                const newTag = Math.floor(rng() * 256);
                sectorBuf.writeUInt16LE(newTag, off + 24);
            }
            sectorMutations++;
        }
    }
    if (sectorMutations > 0) {
        mutations.push(adversarial
            ? `SECTORS.mixed ×${sectorMutations} (incl. special-OOB)`
            : `SECTORS.mixed ×${sectorMutations}`);
    }

    // ── Build mutated E1M1 lump set ───────────────────────────────────────────
    // Replace mutated copies; leave geometry lumps untouched.
    const mutatedLumps = {
        'E1M1':     Buffer.alloc(0),        // marker lump (zero size)
        'THINGS':   thingBuf,
        'LINEDEFS': linedefBuf,
        'SIDEDEFS': sidedefBuf,
        'VERTEXES': subLumps['VERTEXES'],   // geometry — unchanged
        'SEGS':     subLumps['SEGS'],       // geometry — unchanged
        'SSECTORS': subLumps['SSECTORS'],   // geometry — unchanged
        'NODES':    subLumps['NODES'],      // geometry — unchanged
        'SECTORS':  sectorBuf,
        'REJECT':   subLumps['REJECT'],     // precomputed — unchanged
        'BLOCKMAP': subLumps['BLOCKMAP'],   // geometry — unchanged
    };

    return { pwad: assemblePwad(mutatedLumps), mutations, numSectors };
}

// E1M1 from `mapLumps` (all ten, by name) plus the idle FUZZDEMO, as a PWAD.
function assemblePwad(mutatedLumps) {
    // ── Build idle demo lump ──────────────────────────────────────────────────
    const DEMO_LUMP_NAME = 'FUZZDEMO';
    const DEMO_TICS = 35;
    const demoLump = buildIdleDemo({ tics: DEMO_TICS });

    // ── Assemble PWAD ─────────────────────────────────────────────────────────
    // Lump order: E1M1 marker, then 10 map lumps, then FUZZDEMO.
    const LUMP_ORDER = ['E1M1', ...MAP_SUBLUMPS, DEMO_LUMP_NAME];
    const lumpDatas = LUMP_ORDER.map(n => n === DEMO_LUMP_NAME ? demoLump : mutatedLumps[n]);

    const numlumps = LUMP_ORDER.length;
    // Total lump data size
    const totalLumpSize = lumpDatas.reduce((s, b) => s + b.length, 0);
    // PWAD: 12-byte header + lump data + 16*numlumps directory
    const pwadSize = 12 + totalLumpSize + 16 * numlumps;
    const pwad = Buffer.alloc(pwadSize, 0);

    let q = 0;
    pwad.write('PWAD', q, 'ascii'); q += 4;
    pwad.writeUInt32LE(numlumps, q); q += 4;
    pwad.writeUInt32LE(12 + totalLumpSize, q); q += 4;  // infotableofs

    // Write lump data, tracking positions
    const lumpPositions = [];
    for (const b of lumpDatas) {
        lumpPositions.push({ filepos: q, size: b.length });
        b.copy(pwad, q);
        q += b.length;
    }

    // Write directory
    for (let i = 0; i < numlumps; i++) {
        pwad.writeUInt32LE(lumpPositions[i].filepos, q); q += 4;
        pwad.writeUInt32LE(lumpPositions[i].size, q); q += 4;
        encodeName(LUMP_ORDER[i]).copy(pwad, q); q += 8;
    }

    return pwad;
}

// ── genGeometryMap ────────────────────────────────────────────────────────────
// One impossible value per map, kind chosen by seed.  Every kind but
// reject-short and segs-glass names something past the array it selects (or a
// side, list or size the loader cannot use), so the only safe outcome is a
// refusal at load.
export const GEOMETRY_KINDS = [
    'segs-vertex', 'segs-linedef', 'segs-side', 'segs-missing-side', 'segs-glass',
    'ssectors-firstseg', 'ssectors-numsegs', 'ssectors-none',
    'nodes-child', 'nodes-subsector', 'nodes-cycle',
    'blockmap-dims', 'blockmap-offset', 'blockmap-line', 'blockmap-unterminated',
    'linedefs-vertex', 'linedefs-no-front',
    'reject-short',
];

// Returns { pwad, mutations, expect: 'refuse' | 'load', kind }.
export function genGeometryMap(seed) {
    const m = readE1M1();
    const rng = mulberry32((seed ^ 0x9e0) >>> 0);
    const pick = n => Math.floor(rng() * n);
    const kind = GEOMETRY_KINDS[seed % GEOMETRY_KINDS.length];
    const n = {
        verts: m.VERTEXES.length / 4, lines: m.LINEDEFS.length / LINEDEF_SIZE,
        segs: m.SEGS.length / 12, ss: m.SSECTORS.length / 4, nodes: m.NODES.length / 28,
    };
    // one past the end, far past it, or negative, as the short would read
    const bad = count => [count, count + pick(32768 - count), -1, -32768 + pick(1000)][pick(4)];
    const lineSide = (ld, side) => m.LINEDEFS.readInt16LE(ld * LINEDEF_SIZE + 10 + 2 * side);
    // a seg on side 0 of a one-sided linedef
    const oneSidedSeg = () => {
        for (let tries = 0; ; tries++) {
            const k = pick(n.segs);
            const ld = m.SEGS.readInt16LE(12 * k + 6);
            if (m.SEGS.readInt16LE(12 * k + 8) === 0 && lineSide(ld, 1) === -1) return [k, ld];
            if (tries > 10000) throw new Error('no one-sided seg in E1M1');
        }
    };
    let what;
    switch (kind) {
    case 'segs-vertex': {
        const k = pick(n.segs), v = bad(n.verts), f = pick(2);
        m.SEGS.writeInt16LE(v, 12 * k + 2 * f); what = `seg ${k} v${f + 1} = ${v}`; break;
    }
    case 'segs-linedef': {
        const k = pick(n.segs), v = bad(n.lines);
        m.SEGS.writeInt16LE(v, 12 * k + 6); what = `seg ${k} linedef = ${v}`; break;
    }
    case 'segs-side': {
        const k = pick(n.segs), v = [2, 2 + pick(32000), -1][pick(3)];
        m.SEGS.writeInt16LE(v, 12 * k + 8); what = `seg ${k} side = ${v}`; break;
    }
    case 'segs-missing-side': {
        const [k, ld] = oneSidedSeg();
        m.SEGS.writeInt16LE(1, 12 * k + 8); what = `seg ${k} on the absent back side of linedef ${ld}`; break;
    }
    case 'segs-glass': {
        const [k, ld] = oneSidedSeg();
        const o = ld * LINEDEF_SIZE + 4;
        m.LINEDEFS.writeInt16LE(m.LINEDEFS.readInt16LE(o) | 4, o);
        what = `linedef ${ld} (seg ${k}) two-sided with no back side`; break;
    }
    case 'ssectors-firstseg': {
        const k = pick(n.ss), v = bad(n.segs);
        m.SSECTORS.writeInt16LE(v, 4 * k + 2); what = `subsector ${k} firstseg = ${v}`; break;
    }
    case 'ssectors-numsegs': {
        const k = pick(n.ss), first = m.SSECTORS.readInt16LE(4 * k + 2);
        const v = [n.segs - first + 1, n.segs - first + 1 + pick(30000 - n.segs), -1 - pick(1000)][pick(3)];
        m.SSECTORS.writeInt16LE(v, 4 * k); what = `subsector ${k} numsegs = ${v} from ${first}`; break;
    }
    case 'ssectors-none':
        m.SSECTORS = Buffer.alloc(0); what = 'SSECTORS empty'; break;
    case 'nodes-child': {
        const k = pick(n.nodes), j = pick(2), v = n.nodes + pick(0x8000 - n.nodes);
        m.NODES.writeUInt16LE(v, 28 * k + 24 + 2 * j); what = `node ${k} child ${j} = node ${v}`; break;
    }
    case 'nodes-cycle': {
        // the root is every node's ancestor, so pointing a child at it loops:
        // R_PointInSubsector spins, and R_RenderBSPNode and P_CrossBSPNode
        // recurse until the stack runs out
        const k = pick(n.nodes), j = pick(2);
        m.NODES.writeUInt16LE(n.nodes - 1, 28 * k + 24 + 2 * j); what = `node ${k} child ${j} = the root, node ${n.nodes - 1}`; break;
    }
    case 'nodes-subsector': {
        const k = pick(n.nodes), j = pick(2), v = n.ss + pick(0x8000 - n.ss);
        m.NODES.writeUInt16LE(0x8000 | v, 28 * k + 24 + 2 * j); what = `node ${k} child ${j} = subsector ${v}`; break;
    }
    case 'blockmap-dims': {
        const w = m.BLOCKMAP.readInt16LE(4), h = m.BLOCKMAP.readInt16LE(6);
        const [f, v] = [[2, 0], [2, -w], [2, 32767], [3, h + 1 + pick(32000)]][pick(4)];
        m.BLOCKMAP.writeInt16LE(v, 2 * f); what = `blockmap ${f === 2 ? 'width' : 'height'} = ${v} (was ${w}x${h})`; break;
    }
    case 'blockmap-offset': {
        const w = m.BLOCKMAP.readInt16LE(4), h = m.BLOCKMAP.readInt16LE(6);
        const b = pick(w * h), v = bad(m.BLOCKMAP.length / 2);
        m.BLOCKMAP.writeInt16LE(v, 8 + 2 * b); what = `block ${b} offset = ${v}`; break;
    }
    case 'blockmap-line': {
        const w = m.BLOCKMAP.readInt16LE(4), h = m.BLOCKMAP.readInt16LE(6);
        for (let tries = 0; ; tries++) {
            const b = pick(w * h), at = m.BLOCKMAP.readInt16LE(8 + 2 * b);
            if (m.BLOCKMAP.readInt16LE(2 * at) === -1) { if (tries > 10000) throw new Error('no blockmap list'); continue; }
            const v = [n.lines, n.lines + pick(32768 - n.lines), -2 - pick(1000)][pick(3)];
            m.BLOCKMAP.writeInt16LE(v, 2 * at); what = `block ${b} lists line ${v}`; break;
        }
        break;
    }
    case 'blockmap-unterminated': {
        const last = m.BLOCKMAP.length - 2;
        if (m.BLOCKMAP.readInt16LE(last) !== -1) throw new Error('E1M1 BLOCKMAP does not end in -1');
        m.BLOCKMAP.writeInt16LE(0, last); what = 'the last blockmap list runs off the lump'; break;
    }
    case 'linedefs-vertex': {
        const k = pick(n.lines), v = bad(n.verts), f = pick(2);
        m.LINEDEFS.writeInt16LE(v, k * LINEDEF_SIZE + 2 * f); what = `linedef ${k} v${f + 1} = ${v}`; break;
    }
    case 'linedefs-no-front': {
        const k = pick(n.lines);
        m.LINEDEFS.writeInt16LE(-1, k * LINEDEF_SIZE + 10); what = `linedef ${k} has no front side`; break;
    }
    case 'reject-short': {
        const len = pick(m.REJECT.length);
        what = `REJECT cut to ${len} of ${m.REJECT.length} bytes`;
        m.REJECT = m.REJECT.subarray(0, len); break;
    }
    }
    const mutatedLumps = { E1M1: Buffer.alloc(0), ...m };
    return { pwad: assemblePwad(mutatedLumps), mutations: [`${kind}: ${what}`],
             expect: kind === 'reject-short' || kind === 'segs-glass' ? 'load' : 'refuse', kind };
}

// ── CLI entry point ───────────────────────────────────────────────────────────
if (process.argv[1] && process.argv[1].endsWith('gen-map.mjs')) {
    const args = process.argv.slice(2);
    const adversarial = args.includes('--adversarial');
    const filteredArgs = args.filter(a => a !== '--adversarial');
    const seed = Number(filteredArgs[0] ?? 0);
    const outFile = filteredArgs[1] ?? `mapfuzz${seed}${adversarial ? '_adv' : ''}.wad`;

    const { pwad, mutations, numSectors } = genMutatedMap(seed, { adversarial });
    writeFileSync(outFile, pwad);
    console.log(`wrote ${outFile}: ${pwad.length} bytes (seed ${seed}, adversarial=${adversarial})`);
    console.log(`  mutations: ${mutations.join(', ') || '(none)'}`);
    console.log(`  numSectors: ${numSectors}`);
}
