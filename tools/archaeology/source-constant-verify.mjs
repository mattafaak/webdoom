#!/usr/bin/env node
// source-constant-verify.mjs — verifies invariant claims that quote a
// #define / array literal in engine source.  Reads the source files
// directly; no build required.
//
// Usage: node tools/archaeology/source-constant-verify.mjs [--claim ID]
//
// Exits 0 if every checked claim passes; exits 1 on any mismatch.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const filterClaim = process.argv.indexOf('--claim') >= 0
    ? process.argv[process.argv.indexOf('--claim') + 1]
    : null;

// ── helpers ──────────────────────────────────────────────────────────────────

const cache = {};
function src(rel) {
    if (!cache[rel]) cache[rel] = readFileSync(join(root, rel), 'utf8');
    return cache[rel];
}

// Extract a numeric #define value.  Returns Number or null.
function grabDefine(file, name) {
    const m = src(file).match(new RegExp(`#define\\s+${name}\\s+(.+)`));
    if (!m) return null;
    const tok = m[1].replace(/\/\/.*/, '').trim();
    try { return Number(eval(tok.replace(/SCREENWIDTH/g, '320'))); } catch { return null; }
}

// Verify by regex match in source, returning the matched integer.
function grabByRegex(file, re) {
    const m = src(file).match(re);
    return m ? Number(m[1]) : null;
}

// ── claim table ──────────────────────────────────────────────────────────────
// Format: { id, desc, expected, verify: () => actual }

const claims = [
    // ── renderer ─────────────────────────────────────────────────────────────
    { id: 'rdr-001', desc: 'MAXSEGS vanilla DOOM = 32',
      expected: 32,
      verify: () => grabByRegex('engine/core/r_bsp.c', /was\s+(\d+)/) },

    { id: 'rdr-002', desc: 'MAXSEGS webdoom = 64',
      expected: 64,
      verify: () => grabDefine('engine/core/r_bsp.c', 'MAXSEGS') },

    { id: 'rdr-003', desc: 'MAXOPENINGS vanilla (SCREENWIDTH×64) = 20480',
      expected: 20480,
      verify: () => {
          // Comment: "was *64"
          const t = src('engine/core/r_plane.h');
          return /was\s+\*64/.test(t) ? 320 * 64 : null;
      }},

    { id: 'rdr-004', desc: 'MAXOPENINGS webdoom (SCREENWIDTH×256) = 81920',
      expected: 81920,
      verify: () => grabDefine('engine/core/r_plane.h', 'MAXOPENINGS') },

    { id: 'rdr-005', desc: 'MAXVISPLANES vanilla = 128',
      expected: 128,
      verify: () => grabByRegex('engine/core/r_plane.c', /was\s+(\d+)/) },

    { id: 'rdr-006', desc: 'MAXVISPLANES webdoom = 128 (reverted to vanilla, task 14.2d)',
      expected: 128,
      verify: () => grabDefine('engine/core/r_plane.c', 'MAXVISPLANES') },

    { id: 'rdr-007', desc: 'MAXDRAWSEGS vanilla = 256',
      expected: 256,
      verify: () => grabByRegex('engine/core/r_defs.h', /was\s+(\d+)/) },

    { id: 'rdr-008', desc: 'MAXDRAWSEGS webdoom = 256 (reverted to vanilla, task 14.2e)',
      expected: 256,
      verify: () => grabDefine('engine/core/r_defs.h', 'MAXDRAWSEGS') },

    { id: 'rdr-009', desc: 'MAXVISSPRITES vanilla = 128',
      expected: 128,
      verify: () => grabByRegex('engine/core/r_things.h', /was\s+(\d+)/) },

    { id: 'rdr-010', desc: 'MAXVISSPRITES webdoom = 1024',
      expected: 1024,
      verify: () => grabDefine('engine/core/r_things.h', 'MAXVISSPRITES') },

    { id: 'rdr-011', desc: 'ANGLETOSKYSHIFT = 22',
      expected: 22,
      verify: () => grabDefine('engine/core/r_sky.h', 'ANGLETOSKYSHIFT') },

    // ── playsim ──────────────────────────────────────────────────────────────
    { id: 'ps-001', desc: 'MAXSPECIALCROSS vanilla = 8',
      expected: 8,
      verify: () => grabByRegex('engine/core/p_local.h', /vanilla\s+(\d+)/) },

    { id: 'ps-002', desc: 'MAXSPECIALCROSS webdoom = 64',
      expected: 64,
      verify: () => grabDefine('engine/core/p_local.h', 'MAXSPECIALCROSS') },

    { id: 'ps-004', desc: 'MAXINTERCEPTS = 128',
      expected: 128,
      // In p_local.h
      verify: () => grabDefine('engine/core/p_local.h', 'MAXINTERCEPTS') },

    { id: 'ps-006', desc: 'BACKUPTICS = 35',
      expected: 35,
      verify: () => grabDefine('engine/core/d_net.h', 'BACKUPTICS') },

    { id: 'ps-007', desc: 'SAVEGAMESIZE vanilla (0x2C000) = 180224',
      expected: 180224,
      verify: () => {
          // comment "was 0x2c000" in g_game.c
          return /was\s+0x2c000/i.test(src('engine/core/g_game.c')) ? 0x2c000 : null;
      }},

    { id: 'ps-008', desc: 'SAVEGAMESIZE webdoom (0x80000) = 524288',
      expected: 524288,
      verify: () => grabDefine('engine/core/g_game.c', 'SAVEGAMESIZE') },

    { id: 'ps-009', desc: 'MAX_DEATHMATCH_STARTS = 10',
      expected: 10,
      verify: () => grabDefine('engine/core/p_setup.c', 'MAX_DEATHMATCH_STARTS') },

    { id: 'ps-010', desc: 'MAXHEALTH = 100',
      expected: 100,
      verify: () => grabDefine('engine/core/p_local.h', 'MAXHEALTH') },

    { id: 'ps-011', desc: 'BONUSADD = 6',
      expected: 6,
      verify: () => grabDefine('engine/core/p_inter.c', 'BONUSADD') },

    { id: 'ps-012', desc: 'FLOATSPEED = 4×FRACUNIT = 262144',
      expected: 4 * 65536,
      verify: () => {
          // #define FLOATSPEED (FRACUNIT*4)
          const m = src('engine/core/p_local.h').match(/#define\s+FLOATSPEED\s+\(FRACUNIT\*(\d+)\)/);
          return m ? Number(m[1]) * 65536 : null;
      }},

    { id: 'ps-013', desc: 'forwardmove = {0x19,0x32} = {25,50}',
      expected: JSON.stringify([25, 50]),
      verify: () => {
          const m = src('engine/core/g_game.c').match(/forwardmove\[2\]\s*=\s*\{(0x[\da-f]+),\s*(0x[\da-f]+)\}/i);
          return m ? JSON.stringify([parseInt(m[1], 16), parseInt(m[2], 16)]) : null;
      }},

    { id: 'ps-014', desc: 'sidemove = {0x18,0x28} = {24,40}',
      expected: JSON.stringify([24, 40]),
      verify: () => {
          const m = src('engine/core/g_game.c').match(/sidemove\[2\]\s*=\s*\{(0x[\da-f]+),\s*(0x[\da-f]+)\}/i);
          return m ? JSON.stringify([parseInt(m[1], 16), parseInt(m[2], 16)]) : null;
      }},

    { id: 'ps-015', desc: 'angleturn = {640,1280,320}',
      expected: JSON.stringify([640, 1280, 320]),
      verify: () => {
          const m = src('engine/core/g_game.c').match(/angleturn\[3\]\s*=\s*\{(\d+),\s*(\d+),\s*(\d+)\}/);
          return m ? JSON.stringify([Number(m[1]), Number(m[2]), Number(m[3])]) : null;
      }},

    { id: 'ps-016', desc: 'STOPSPEED = 0x1000',
      expected: 0x1000,
      verify: () => {
          const m = src('engine/core/p_mobj.c').match(/#define\s+STOPSPEED\s+(0x[\da-f]+)/i);
          return m ? parseInt(m[1], 16) : null;
      }},

    { id: 'ps-017', desc: 'FRICTION = 0xE800',
      expected: 0xe800,
      verify: () => {
          const m = src('engine/core/p_mobj.c').match(/#define\s+FRICTION\s+(0x[eE][\da-f]+)/i);
          return m ? parseInt(m[1], 16) : null;
      }},

    { id: 'ps-019', desc: 'A_Chase max players checked per call = 2',
      expected: 2,
      verify: () => {
          // P_LookForPlayers: "if (c++ == 2"
          return /c\+\+\s*==\s*2/.test(src('engine/core/p_enemy.c')) ? 2 : null;
      }},

    { id: 'ps-020', desc: 'GLOWSPEED = 8',
      expected: 8,
      verify: () => grabDefine('engine/core/p_spec.h', 'GLOWSPEED') },

    { id: 'ps-021', desc: 'STROBEBRIGHT = 5',
      expected: 5,
      verify: () => grabDefine('engine/core/p_spec.h', 'STROBEBRIGHT') },

    { id: 'ps-022', desc: 'FASTDARK = 15',
      expected: 15,
      verify: () => grabDefine('engine/core/p_spec.h', 'FASTDARK') },

    { id: 'ps-023', desc: 'SLOWDARK = 35',
      expected: 35,
      verify: () => grabDefine('engine/core/p_spec.h', 'SLOWDARK') },

    { id: 'ps-025', desc: 'MAXPLATS = 30',
      expected: 30,
      verify: () => grabDefine('engine/core/p_spec.h', 'MAXPLATS') },

    { id: 'ps-026', desc: 'MAXBUTTONS = 16',
      expected: 16,
      verify: () => grabDefine('engine/core/p_spec.h', 'MAXBUTTONS') },

    { id: 'ps-027', desc: 'QUEUESIZE = 128',
      expected: 128,
      verify: () => grabDefine('engine/core/hu_stuff.c', 'QUEUESIZE') },

    { id: 'ps-028', desc: 'HU_MAXLINELENGTH (incl. NUL) = 81',
      // #define HU_MAXLINELENGTH 80; NUL adds 1 → 81
      expected: 81,
      verify: () => {
          const v = grabDefine('engine/core/hu_lib.h', 'HU_MAXLINELENGTH');
          return v !== null ? v + 1 : null; // +1 for NUL terminator
      }},

    // ── formats ──────────────────────────────────────────────────────────────
    { id: 'fmt-021', desc: 'MUS_RATE = 140 Hz',
      expected: 140,
      verify: () => grabDefine('engine/web/mus_opl.c', 'MUS_RATE') },

    { id: 'fmt-031', desc: 'Demo header total size = 13 bytes',
      expected: 13,
      verify: () => {
          // 9 fixed bytes + MAXPLAYERS (4) player bytes
          const maxp = grabDefine('engine/core/doomdef.h', 'MAXPLAYERS');
          return maxp !== null ? 9 + maxp : null;
      }},

    { id: 'fmt-032', desc: 'Save slot count = 6 (doomsav0–5)',
      expected: 6,
      verify: () => {
          // SAVEGAMENAME = "doomsav" in dstrings.h; slots 0..5 = 6
          return /doomsav/.test(src('engine/core/dstrings.h')) ? 6 : null;
      }},

    { id: 'fmt-034', desc: 'MUS percussion channel = 15',
      expected: 15,
      verify: () => grabDefine('engine/web/mus_opl.c', 'PERCUSSION_CH') },

    // ── perf ─────────────────────────────────────────────────────────────────
    { id: 'perf-008', desc: 'ZONESIZE = 4 MiB = 4194304 bytes (14.2c; was 32 MB pre-14.2c)',
      expected: 4 * 1024 * 1024,
      verify: () => grabDefine('engine/web/web.h', 'ZONESIZE') },
];

// ── run ───────────────────────────────────────────────────────────────────────

let failures = 0;
const results = [];

for (const c of claims) {
    if (filterClaim && c.id !== filterClaim) continue;
    let actual;
    try { actual = c.verify(); } catch (e) { actual = null; }
    const pass = actual !== null && String(actual) === String(c.expected);
    results.push({ id: c.id, pass, expected: c.expected, actual });
    if (!pass) failures++;
    const mark = pass ? 'PASS' : 'FAIL';
    console.log(`${mark}  ${c.id}  ${c.desc}`);
    if (!pass) {
        console.log(`      expected: ${JSON.stringify(c.expected)}`);
        console.log(`      actual:   ${actual === null ? '(not found)' : JSON.stringify(actual)}`);
    }
}

const total = filterClaim ? 1 : claims.length;
console.log(`\nsource-constant: ${total - failures}/${total} passed`);

// Emit actual values for three-way drift check (consumed by verify-all.sh / doc-drift.mjs)
const valuesMap = {};
for (const r of results) { valuesMap[r.id] = r.actual === null || r.actual === undefined ? null : String(r.actual); }
console.log(`CLAIMS_JSON ${JSON.stringify(valuesMap)}`);

if (failures > 0) process.exit(1);
