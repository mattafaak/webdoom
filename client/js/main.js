// webdoom bootstrap: fetch engine + WAD, boot, drive D_DoomFrame per rAF.
import { createRenderer } from './video.js';
import { attachKeyboard } from './input.js';
import { createAudio } from './audio.js';

const status = msg => { document.getElementById('status').textContent = msg; };
const canvas = document.getElementById('screen');

// The engine identifies Ultimate Doom by filename.
const ENGINE_NAME = { 'doom.wad': 'doomu.wad' };

async function fetchWad(file) {
    const res = await fetch(`/wads/${file}`);
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

async function boot() {
    const params = new URLSearchParams(location.search);
    const wad = params.get('wad') ?? 'doom.wad';

    status('loading engine…');
    const { default: createDoom } = await import('/engine/doom.js');
    const wadBytes = await fetchWad(wad);

    status('booting…');
    const doom = await createDoom({
        print: t => console.log(t),
        printErr: t => console.warn(t),
        onDoomError: msg => status(`engine error: ${msg}`),
        preRun: [mod => {
            mod.ENV.DOOMWADDIR = '/wads';
            mod.ENV.HOME = '/home/web_user';
            mod.FS.mkdir('/wads');
            mod.FS.writeFile(`/wads/${ENGINE_NAME[wad] ?? wad}`, wadBytes);
        }],
    });

    doom.callMain([]);
    window.doomAudio = createAudio(doom);   // debug/test handle

    const renderer = createRenderer(canvas);
    const fb = doom._web_framebuffer();
    const pal = doom._web_palette();
    let palVersion = -1;

    status('');
    canvas.focus();
    attachKeyboard(window, (type, d1, d2, d3) => doom._web_input_event(type, d1, d2, d3));

    const frame = () => {
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
    console.log(`webdoom up — renderer: ${renderer.kind}`);
}

boot().catch(err => { status(String(err)); console.error(err); });
