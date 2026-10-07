// The song each of the 13 IWAD demos plays: the lump fs-doom's I_RegisterSong
// is handed, at gametic 0, looping, and the only one in the demo (measured with
// fs-doom's I_RegisterSong/I_PlaySong instrumented, 2026-10-06; doom-demo4 is
// E4M2, whose music is E3M2's, s_sound.c's spmus[]).  A wrong entry cannot pass
// floor-x86, whose synthhash is checked against tools/floor/synth-ref.json.
// Copyright (C) 2026, GPL-2.0-or-later.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

export const DEMO_SONGS = [
    ['doom-demo1', 'doom.wad', 'D_E1M5'], ['doom-demo2', 'doom.wad', 'D_E2M2'],
    ['doom-demo3', 'doom.wad', 'D_E3M5'], ['doom-demo4', 'doom.wad', 'D_E3M2'],
    ['doom2-demo1', 'doom2.wad', 'D_STLKS2'], ['doom2-demo2', 'doom2.wad', 'D_DOOM'],
    ['doom2-demo3', 'doom2.wad', 'D_MESSG2'],
    ['tnt-demo1', 'tnt.wad', 'D_RUNNIN'], ['tnt-demo2', 'tnt.wad', 'D_THEDA2'],
    ['tnt-demo3', 'tnt.wad', 'D_DOOM2'],
    ['plutonia-demo1', 'plutonia.wad', 'D_STLKS3'], ['plutonia-demo2', 'plutonia.wad', 'D_DEAD'],
    ['plutonia-demo3', 'plutonia.wad', 'D_THEDA2'],
];

// A demo's length in tics: its sim golden's trace, one hash per tic.
export function demoTics(demo) {
    const t = JSON.parse(readFileSync(join(root, 'tools/golden', `${demo}.json`), 'utf8')).trace;
    return typeof t === 'string' ? t.length / 8 : t.length;
}
