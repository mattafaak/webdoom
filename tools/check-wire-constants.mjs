#!/usr/bin/env node
// Constants that exist twice, once on each side of the wire.
//
// COLORS, CMD_SIZE, MAXPLAYERS and FRAGMENT_MAX are each written in two files.
// A mirror that is asserted is a mirror; one that is not is two constants that
// happen to agree today -- and the consequences are not cosmetic: CMD_SIZE
// sizes the sealed bundle both sides parse, MAXPLAYERS indexes the tic ring,
// FRAGMENT_MAX decides which demo-share path a link takes.
//
// Sharing a module was the other option and was not taken: server/ is plain
// Node, client/js/ is browser ES modules loaded over HTTP, and a shared file
// would have to be served, precached and kept out of the engine's own scope.
// Asserting the mirror costs five regexes and no runtime coupling.
//
// usage: node tools/check-wire-constants.mjs
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root } from './lib/util.mjs';

const src = f => readFileSync(join(root, f), 'utf8');

// [label, [file, regex], [file, regex]]
const MIRRORS = [
    ['COLORS',
     ['server/game.js',        /const\s+COLORS\s*=\s*(\[[^\]]*\])/],
     ['client/js/lobby.js',    /const\s+COLORS\s*=\s*(\[[^\]]*\])/]],
    ['CMD_SIZE',
     ['server/game.js',        /const\s+CMD_SIZE\s*=\s*(\d+)/],
     ['client/js/net.js',      /const\s+CMD_SIZE\s*=\s*(\d+)/]],
    ['MAXPLAYERS',
     ['server/game.js',        /const\s+MAXPLAYERS\s*=\s*(\d+)/],
     ['client/js/net.js',      /const\s+MAXPLAYERS\s*=\s*(\d+)/]],
    ['FRAGMENT_MAX',
     ['server/demo-store.js',  /FRAGMENT_MAX\s*=\s*([\d_]+)/],
     ['client/js/demo.js',     /FRAGMENT_MAX\s*=\s*([\d_]+)/]],
];

const norm = v => String(v).replace(/[\s_]/g, '');
let bad = 0, checked = 0;
for (const [label, [fa, ra], [fb, rb]] of MIRRORS) {
    const a = (ra.exec(src(fa)) ?? [])[1];
    const b = (rb.exec(src(fb)) ?? [])[1];
    if (a === undefined || b === undefined) {
        // A regex that stops matching is a check that stops checking: it must
        // be a red, not a silent skip.
        console.log(`  FAIL ${label}: not found in ${a === undefined ? fa : fb}`
                  + ' — the constant moved or was renamed, and this check went blind');
        bad++;
        continue;
    }
    checked++;
    if (norm(a) === norm(b)) console.log(`  ok   ${label} = ${a} in both ${fa} and ${fb}`);
    else { console.log(`  FAIL ${label}: ${fa} says ${a}, ${fb} says ${b}`); bad++; }
}

// ── the mirror that was deleted rather than gated ───────────────────────────
//
// KNOWN and MASTER_TITLES were transcribed into BOTH client/js/wad-import.js
// and tools/wad-identify.mjs, each under a comment saying they mirrored the
// other, and nothing compared them.  They drifted: the tool read
// "Mephisto’s Maosoleum" against the client's "Mephisto's Mausoleum", so the
// same WAD showed a different -- and misspelled -- title depending on whether
// it came from the served library or a local import.  The live manifest on
// this box carried the misspelling.
//
// The fix was to delete the copy: wad-identify.mjs imports the tables now.  So
// there is no pair left to compare, and the thing worth asserting is that the
// copy has not come BACK.  A regex mirror here would compare a table to
// itself and pass forever.
{
    const tool = src('tools/wad-identify.mjs');
    const dup = /^\s*const\s+(KNOWN|MASTER_TITLES)\s*=\s*\{/m.exec(tool);
    const imports = /import\s*\{[^}]*\bKNOWN\b[^}]*\}\s*from\s*'\.\.\/client\/js\/wad-import\.js'/.test(tool);
    checked++;
    if (dup) {
        console.log(`  FAIL wad tables: tools/wad-identify.mjs defines its own ${dup[1]} again`
                  + ' — it must import from client/js/wad-import.js, which is the source');
        bad++;
    } else if (!imports) {
        console.log('  FAIL wad tables: tools/wad-identify.mjs no longer imports KNOWN from'
                  + ' client/js/wad-import.js — the link this check exists to hold is gone');
        bad++;
    } else {
        console.log('  ok   wad tables: tools/wad-identify.mjs imports KNOWN/MASTER_TITLES, no second copy');
    }
}

// ── the relay's view of a ticcmd ────────────────────────────────────────────────
//
// server/game.js reads two bytes of the cmd it repeats for a silent player
// (sealTic): chatchar and buttons, and buttons' BT_SPECIAL bit.  The offsets
// are ticcmd_t's layout (engine/core/d_ticcmd.h), which net.js sends byte for
// byte, and the bit is d_event.h's.  The layout is computed from the header
// here, so a reordered or retyped field moves the expected offset.
const TICCMD_MIRRORS = 3;
{
    const SIZE = { char: 1, byte: 1, short: 2 };
    const body = /typedef\s+struct\s*\{([^}]*)\}\s*ticcmd_t\s*;/.exec(src('engine/core/d_ticcmd.h'))?.[1] ?? '';
    const off = {};
    let at = 0, aligned = true;
    for (const [, type, name] of body.matchAll(/^\s*(char|byte|short)\s+(\w+)\s*;/gm)) {
        if (at % SIZE[type]) aligned = false;           // padding would move every later field
        off[name] = at;
        at += SIZE[type];
    }
    const game = src('server/game.js');
    const num = re => { const m = re.exec(game); return m ? Number(m[1]) : undefined; };
    const bt = /BT_SPECIAL\s*=\s*(\d+)/.exec(src('engine/core/d_event.h'))?.[1];
    const pairs = [
        ['CMD_CHATCHAR', off.chatchar, num(/CMD_CHATCHAR\s*=\s*(\w+)/)],
        ['CMD_BUTTONS',  off.buttons,  num(/CMD_BUTTONS\s*=\s*(\w+)/)],
        ['BT_SPECIAL',   bt === undefined ? undefined : Number(bt), num(/BT_SPECIAL\s*=\s*(\w+)/)],
    ];
    if (!aligned || at !== 8)
        { console.log(`  FAIL ticcmd_t: ${at} bytes${aligned ? '' : ', with padding'} -- not the 8-byte cmd the wire carries`); bad++; }
    for (const [label, engine, relay] of pairs) {
        if (engine === undefined || relay === undefined) {
            console.log(`  FAIL ${label}: not found in ${engine === undefined ? 'the engine headers' : 'server/game.js'}`
                      + ' -- the constant moved or was renamed, and this check went blind');
            bad++;
            continue;
        }
        checked++;
        if (engine === relay) console.log(`  ok   ${label} = ${relay} in server/game.js, as engine/core says`);
        else { console.log(`  FAIL ${label}: server/game.js says ${relay}, engine/core says ${engine}`); bad++; }
    }
}

if (checked === 0) {
    console.log('FAIL wire-constants: nothing was compared');
    process.exit(1);
}
const total = MIRRORS.length + 1 + TICCMD_MIRRORS;
console.log(bad
    ? `FAIL wire-constants: ${bad} of ${total} mirrors disagree or could not be read`
    : `PASS wire-constants: ${checked} of ${total} cross-wire mirrors agree (4 constants, the relay's 3 ticcmd constants against the engine's headers, and the WAD title tables, which are imported rather than copied)`);
process.exit(bad ? 1 : 0);
