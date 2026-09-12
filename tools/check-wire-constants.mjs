#!/usr/bin/env node
// Constants that exist twice, once on each side of the wire.
//
// COLORS, CMD_SIZE, MAXPLAYERS, FRAGMENT_MAX and MAXWEBFILES are each written
// in two files, and two of them say so in a comment ("mirror of server value").
// Nothing compared them.  A mirror that is asserted is a mirror; one that is
// not is two constants that happen to agree today — and the consequences are
// not cosmetic: CMD_SIZE sizes the sealed bundle both sides parse, MAXPLAYERS
// indexes the tic ring, FRAGMENT_MAX decides which demo-share path a link
// takes, MAXWEBFILES is the cap the client enforces on the engine's behalf.
//
// Sharing a module was the other option and was not taken: server/ is plain
// Node, client/js/ is browser ES modules loaded over HTTP, and a shared file
// would have to be served, precached and kept out of the engine's own scope.
// Asserting the mirror costs five regexes and no runtime coupling.
//
// usage: node tools/check-wire-constants.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
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
    ['MAXWEBFILES',
     ['engine/web/files.c',    /#define\s+MAXWEBFILES\s+(\d+)/],
     ['client/js/lobby.js',    /const\s+MAXWEBFILES\s*=\s*(\d+)/]],
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

if (checked === 0) {
    console.log('FAIL wire-constants: nothing was compared');
    process.exit(1);
}
console.log(bad
    ? `FAIL wire-constants: ${bad} of ${MIRRORS.length} mirrors disagree or could not be read`
    : `PASS wire-constants: ${checked} of ${MIRRORS.length} cross-wire constants agree on both sides`);
process.exit(bad ? 1 : 0);
