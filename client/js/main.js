// webdoom boot: fetch engine + WAD stack, boot, drive D_DoomFrame per
// rAF. Called by lobby.js for both single player and netplay.
import { createRenderer } from './video.js';
import { createInput, loadSettings } from './input.js';
import { createAudio } from './audio.js';
import { createSettingsUI } from './settings.js';
import { attachRelay } from './net.js';
import { loadPersisted, restoreFiles, startSync } from './persist.js';

const status = msg => { document.getElementById('status').textContent = msg; };

// The engine identifies games by 1993 filenames. Ultimate Doom must be
// doomu.wad (retail detection); the standalone TCs get the filename of
// the game mode they are shaped like, or IdentifyVersion finds nothing
// and the engine aborts with an empty WAD list.
const ENGINE_NAME = {
    'doom.wad': 'doomu.wad',
    'chex.wad': 'doomu.wad',    // 4-episode doom-shaped TC (has DEMO4)
};

async function fetchWad(file, sha) {
    const res = await fetch(`/wads/${file}?v=${(sha ?? '').slice(0, 8)}`);
    if (!res.ok) throw new Error(`wad fetch failed: ${file} (${res.status})`);
    const total = +res.headers.get('content-length') || 0;
    const parts = [];
    let got = 0;
    const reader = res.body.getReader();
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        got += value.length;
        if (total) status(`fetching ${file} — ${(got/1048576).toFixed(1)} / ${(total/1048576).toFixed(1)} MB`);
    }
    const buf = new Uint8Array(got);
    let o = 0;
    for (const p of parts) { buf.set(p, o); o += p.length; }
    return buf;
}

// wads: [{file, sha}] — first entry is the IWAD, the rest are PWADs.
// net: {slot, numplayers, rttMs} or null for single player.
export async function bootDoom({ wads, args = [], net = null }) {
    const canvas = document.getElementById('screen');
    document.getElementById('landing').hidden = true;
    canvas.hidden = false;

    status('loading engine…');
    const { default: createDoom } = await import('/engine/doom.js');
    const bytes = [];
    for (const w of wads) bytes.push(await fetchWad(w.file, w.sha));
    const persisted = await loadPersisted(wads[0].file);

    status('booting…');
    const doom = await createDoom({
        print: t => console.log(t),
        printErr: t => console.warn(t),
        onDoomError: msg => status(`engine error: ${msg}`),
        preRun: [mod => {
            mod.ENV.DOOMWADDIR = '/wads';
            mod.ENV.HOME = '/home/web_user';
            mod.FS.mkdir('/wads');
            wads.forEach((w, i) => {
                const name = i === 0 ? (ENGINE_NAME[w.file] ?? w.file) : w.file;
                mod.FS.writeFile(`/wads/${name}`, bytes[i]);
            });
            restoreFiles(mod.FS, persisted);   // savegames + .doomrc
        }],
    });

    const pwads = wads.slice(1).flatMap(w => ['-file', `/wads/${w.file}`]);
    const relay = net
        ? attachRelay(doom, `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`, net)
        : null;

    doom.callMain([...pwads, ...args]);
    relay?.go();
    window.doomAudio = createAudio(doom);
    window.webdoom = { doom };              // debug/test handle
    startSync(doom, wads[0].file);

    const renderer = createRenderer(canvas);
    const fb = doom._web_framebuffer();
    const pal = doom._web_palette();
    let palVersion = -1;

    status('');
    canvas.focus();
    const input = createInput(doom, canvas, loadSettings());
    createSettingsUI(input, doom);
    doom._web_set_smooth(input.settings.smooth ? 1 : 0);

    const frame = () => {
        input.frame();
        doom._web_frame();
        const v = doom._web_palette_version();
        renderer.draw(
            doom.HEAPU8.subarray(fb, fb + 320 * 200),
            doom.HEAPU8.subarray(pal, pal + 768),
            v !== palVersion,
        );
        palVersion = v;
        requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    console.log(`webdoom up — renderer: ${renderer.kind}, ${net ? `netplay slot ${net.slot}/${net.numplayers}` : 'single player'}`);
    return doom;
}
