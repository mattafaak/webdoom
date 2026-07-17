#!/usr/bin/env node
// tools/fuzz/gen-demo.mjs — seeded synthetic vanilla DOOM demo generator.
//
// Produces a valid v1.9 demo lump wrapped as a single-lump PWAD.
// Uses mulberry32 (explicit PRNG — no Math.random) so same seed → byte-identical
// output across runs.
//
// Demo lump layout (vanilla g_game.c G_ReadDemoTiccmd / G_RecordDemo):
//   Header  13 bytes: version(1) skill(1) episode(1) map(1) deathmatch(1)
//                     respawn(1) fast(1) nomonsters(1) consoleplayer(1)
//                     playeringame[0..3](4)
//   Per tic  4 bytes: forwardmove(s8) sidemove(s8) angleturn_hibyte(u8) buttons(u8)
//   Terminator 1 byte: 0x80 (DEMOMARKER)
//
// buttons constraints:
//   BT_SPECIAL = 0x80: must NOT be set — it would trigger pause/save special
//   0x80 as forwardmove is also DEMOMARKER and would terminate the demo early,
//   but our forwardmove range (-50..50) never produces 0x80 (signed -128).
//
// PWAD format (12-byte header + lump data + 16-byte directory entry):
//   "PWAD" numlumps(u32le) infotableofs(u32le)
//   <lump bytes>
//   filepos(u32le) size(u32le) name[8]
//
// Usage (CLI):
//   node tools/fuzz/gen-demo.mjs <seed> [<outfile>]
//   — writes the PWAD to outfile (default: fuzz<seed>.wad)
//
// API (import):
//   import { genDemo, mulberry32 } from './gen-demo.mjs';
//   const pwadBytes = genDemo(seed, { tics, skill, episode, map });

// ── mulberry32 PRNG ──────────────────────────────────────────────────────────
// Returns a function () => float in [0, 1).  Period 2^32.  Same seed → same
// sequence deterministically; no global state; no Math.random.
export function mulberry32(seed) {
    let s = seed >>> 0;
    return function () {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = Math.imul(s ^ (s >>> 15), s | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ── genDemo ──────────────────────────────────────────────────────────────────
// Returns a Buffer containing a PWAD with lump "FUZZDEMO".
// skill 0=ITYTD 1=HNTR 2=HMP 3=UV 4=NM.
// episode=1/map=1 → doom2 MAP01 or doom E1M1 depending on IWAD.
export function genDemo(seed, { tics = 700, skill = 2, episode = 1, map = 1 } = {}) {
    const prng = mulberry32(seed >>> 0);

    // ── build demo lump ──────────────────────────────────────────────────────
    const HEADER_SIZE = 13;
    const TERM_SIZE = 1;
    const lumpSize = HEADER_SIZE + tics * 4 + TERM_SIZE;
    const lump = Buffer.alloc(lumpSize, 0);
    let p = 0;

    // Header (13 bytes exactly — see g_game.c G_RecordDemo)
    lump[p++] = 109;       // version: vanilla v1.9 (also accepted by v1.10 engine)
    lump[p++] = skill;     // gameskill
    lump[p++] = episode;   // gameepisode (doom2: 1; doom: 1-3)
    lump[p++] = map;       // gamemap (doom2: MAP01=1; doom: E1M1=1)
    lump[p++] = 0;         // deathmatch
    lump[p++] = 0;         // respawnparm
    lump[p++] = 0;         // fastparm
    lump[p++] = 0;         // nomonsters
    lump[p++] = 0;         // consoleplayer (0 = player 1)
    lump[p++] = 1;         // playeringame[0] = in game
    lump[p++] = 0;         // playeringame[1]
    lump[p++] = 0;         // playeringame[2]
    lump[p++] = 0;         // playeringame[3]

    // Per-tic ticcmds (4 bytes each)
    // forwardmove: signed byte range -50..+50 (forwardmove[1]=0x32=50 max)
    //              Written as raw u8; G_ReadDemoTiccmd casts back to signed char.
    //              Range never reaches 0x80 (=−128 signed) which is DEMOMARKER.
    // sidemove:    signed byte range -40..+40 (sidemove[1]=0x28=40 max)
    // angleturn:   high byte of 16-bit turn value; written as (turn+128)>>8 by
    //              G_WriteDemoTiccmd, read as (u8)<<8 by G_ReadDemoTiccmd.
    //              We store the hi-byte directly (0..255); all values valid.
    // buttons:     0x00..0x7F — bit 7 (BT_SPECIAL=0x80) must stay clear to
    //              avoid triggering pause/save special handling.
    for (let i = 0; i < tics; i++) {
        const fwd = Math.floor(prng() * 101) - 50; // -50..+50
        const side = Math.floor(prng() * 81) - 40; // -40..+40
        const angle = Math.floor(prng() * 256);    // 0..255
        const buttons = Math.floor(prng() * 128);  // 0..127 (no BT_SPECIAL)

        lump[p++] = fwd & 0xff;
        lump[p++] = side & 0xff;
        lump[p++] = angle & 0xff;
        lump[p++] = buttons & 0x7f;
    }

    // Demo terminator
    lump[p++] = 0x80; // DEMOMARKER

    // ── wrap as single-lump PWAD ─────────────────────────────────────────────
    // PWAD layout: 12-byte header, lump data, 16-byte directory entry.
    const LUMP_NAME = 'FUZZDEMO'; // exactly 8 chars
    const nameBytes = Buffer.alloc(8, 0);
    nameBytes.write(LUMP_NAME, 'ascii');

    const pwadSize = 12 + lumpSize + 16;
    const pwad = Buffer.alloc(pwadSize, 0);
    let q = 0;

    // Header
    pwad.write('PWAD', q, 'ascii'); q += 4;
    pwad.writeUInt32LE(1, q); q += 4;            // numlumps = 1
    pwad.writeUInt32LE(12 + lumpSize, q); q += 4; // infotableofs

    // Lump data (immediately after 12-byte header)
    lump.copy(pwad, q); q += lumpSize;

    // Directory entry: filepos=12, size=lumpSize, name="FUZZDEMO"
    pwad.writeUInt32LE(12, q); q += 4;
    pwad.writeUInt32LE(lumpSize, q); q += 4;
    nameBytes.copy(pwad, q); q += 8;

    return pwad;
}

// ── CLI entry point ───────────────────────────────────────────────────────────
if (process.argv[1] && process.argv[1].endsWith('gen-demo.mjs')) {
    const { writeFileSync } = await import('node:fs');
    const seed = Number(process.argv[2] ?? 0);
    const out = process.argv[3] ?? `fuzz${seed}.wad`;
    const pwad = genDemo(seed);
    writeFileSync(out, pwad);
    console.log(`wrote ${out}: ${pwad.length} bytes (seed ${seed})`);
}
