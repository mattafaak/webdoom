// webdoom boot: fetch engine + WAD stack, boot, drive D_DoomFrame per
// rAF. Called by lobby.js for both single player and netplay.
import { createRenderer } from './video.js';
import { createInput, loadSettings } from './input.js';
import { createAudio } from './audio.js';
import { createSettingsUI } from './settings.js';
import { attachRelay } from './net.js';
import { loadPersisted, startSync } from './persist.js';

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
// onQuit: called when the player quits in-game (Quit Game → Y).
export async function bootDoom({ wads, args = [], net = null, onQuit = null }) {
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
    });

    // no filesystem: WADs live once in the heap, small files in a JS Map
    doom['fileMap'] = persisted;
    wads.forEach((w, i) => {
        const name = i === 0 ? (ENGINE_NAME[w.file] ?? w.file) : w.file;
        const p = doom._malloc(bytes[i].length);
        doom.HEAPU8.set(bytes[i], p);
        doom.ccall('web_register_file', null,
            ['string', 'number', 'number'], [name, p, bytes[i].length]);
    });

    const pwads = wads.slice(1).flatMap(w => ['-file', w.file]);
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

    // Quit Game → Y calls I_Quit → this hook: stop the loop, tear down,
    // and let the front end return to the main menu (a fresh wasm boots
    // on the next PLAY — this instance force-exits).
    let running = true;
    doom.onQuit = () => {
        running = false;
        document.exitPointerLock?.();
        canvas.hidden = true;
        document.getElementById('landing').hidden = false;
        try { window.doomAudio?.stop?.(); } catch { /* dead instance */ }
        onQuit?.();
    };

    const frame = () => {
        if (!running) return;
        try {
            input.frame();
            doom._web_frame();
        } catch { running = false; return; }   // I_Quit/I_Error aborted
        const v = doom._web_palette_version();
        renderer.draw(
            doom.HEAPU8.subarray(fb, fb + 320 * 200),
            doom.HEAPU8.subarray(pal, pal + 768),
            v !== palVersion,
        );
        palVersion = v;
        if (running) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    console.log(`webdoom up — renderer: ${renderer.kind}, ${net ? `netplay slot ${net.slot}/${net.numplayers}` : 'single player'}`);
    return doom;
}
