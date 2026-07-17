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
// Geometry (VERTEXES/SEGS/SSECTORS/NODES/BLOCKMAP) is NEVER mutated.
// No node rebuild is needed; the map stays loadable with original BSP data.
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
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mulberry32 } from './gen-demo.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
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

// ── genMutatedMap ─────────────────────────────────────────────────────────────
// Returns { pwad: Buffer, mutations: string[], numSectors: number }.
export function genMutatedMap(seed, { adversarial = false } = {}) {
    const wadBuf = readFileSync(DOOM_WAD);
    const lumps = parseWadDir(wadBuf);

    // Find E1M1 marker
    const e1m1Idx = lumps.findIndex(l => l.name === 'E1M1');
    if (e1m1Idx < 0) throw new Error('E1M1 not found in doom.wad');

    // The 10 map sub-lumps follow the marker
    const MAP_SUBLUMPS = ['THINGS','LINEDEFS','SIDEDEFS','VERTEXES','SEGS',
                          'SSECTORS','NODES','SECTORS','REJECT','BLOCKMAP'];
    const subLumps = {};
    for (let i = 0; i < MAP_SUBLUMPS.length; i++) {
        const l = lumps[e1m1Idx + 1 + i];
        if (!l || l.name !== MAP_SUBLUMPS[i]) {
            throw new Error(`Expected ${MAP_SUBLUMPS[i]} at index ${e1m1Idx + 1 + i}, got ${l?.name}`);
        }
        subLumps[l.name] = readLump(wadBuf, l);
    }

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

    return { pwad, mutations, numSectors };
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
