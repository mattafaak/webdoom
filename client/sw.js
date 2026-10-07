// webdoom service worker: WADs are content-hashed (?v=sha8) → cache-first
// forever; everything else network-first with cache fallback, so repeat
// loads are instant and single player works offline once a WAD is cached.
const SHELL = 'webdoom-shell-v18'; // bump whenever a shell file changes
const WADS = 'webdoom-wads-v1';
// What the launcher reads before it can show a menu (the game list, the font
// and palette, the box art) lives apart from the shell, because activate drops
// every older shell cache: kept there, an update leaves the next offline visit
// with no game list.  Demos and the live status are not needed to start, and a
// demo is one entry per link, so they stay with the shell and go with it.
const API = 'webdoom-api-v1';
const LAUNCHER_API = /^\/api\/(wads|ui-assets|thumb\/)/;

// The app shell, one entry per file.  tools/check-sw-precache.mjs parses THIS
// array against the real import graph, so it is the list, not a copy of it.
const SHELL_FILES = [
    '/', '/css/webdoom.css',
    '/js/lobby.js', '/js/main.js', '/js/video.js', '/js/input.js',
    '/js/audio.js', '/js/net.js', '/js/music-worklet.js',
    '/js/menu.js', '/js/doomfont.js', '/js/persist.js', '/js/wad-cache.js',
    '/js/fire.js', '/js/countdown.js',
    '/js/wad-import.js', '/js/wad-library.js',
    '/js/demo.js', '/js/scrubber.js', '/js/idb.js', '/js/ui.js', '/js/perf-marks.js',

    '/engine/doom.js', '/engine/doom.wasm',
    '/engine/synth.wasm',
];

self.addEventListener('install', e => {
    // per file, failures named: cache.addAll() is all-or-nothing, and a
    // missing scrubber.js should cost the scrubber offline, not the game
    e.waitUntil((async () => {
        const c = await caches.open(SHELL);
        const settled = await Promise.allSettled(SHELL_FILES.map(p => c.add(p)));
        const failed = SHELL_FILES.filter((_, i) => settled[i].status === 'rejected');
        if (failed.length)
            console.warn(`webdoom sw: ${failed.length} of ${SHELL_FILES.length} shell files not precached`
                       + ` — offline mode is partial: ${failed.join(', ')}`);
        await self.skipWaiting();
    })());
});

self.addEventListener('activate', e => {
    e.waitUntil((async () => {
        for (const k of await caches.keys()) {
            if (!k.startsWith('webdoom-shell-') || k === SHELL) continue;
            // a worker older than the API cache kept the launcher's reads in
            // its shell; carry them over rather than lose them with it, and
            // never let a failed copy keep the old shell alive
            try {
                const old = await caches.open(k), api = await caches.open(API);
                for (const req of await old.keys())
                    if (LAUNCHER_API.test(new URL(req.url).pathname) && !await api.match(req))
                        await api.put(req, await old.match(req));
            } catch (err) {
                console.warn(`webdoom sw: could not carry the launcher's reads out of ${k}: ${err?.message ?? err}`);
            }
            await caches.delete(k);
        }
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', e => {
    const url = new URL(e.request.url);
    if (url.origin !== location.origin || e.request.method !== 'GET') return;
    if (url.pathname.startsWith('/ws/')) return;

    if (url.pathname.startsWith('/wads/')) {
        // The ?v hash makes the full URL immutable: cache-first, forever.  On a
        // miss the network response goes to the page as it arrives, so the
        // loading bar moves; the cache gets a copy built from an ArrayBuffer
        // in the background (putting the network response itself fails in
        // headless Chrome without a sandbox), and a cache write that fails --
        // quota, most likely -- never fails the download.
        e.respondWith(caches.open(WADS).then(async c => {
            const hit = await c.match(e.request.url);
            if (hit) return hit;
            const res = await fetch(e.request);
            if (!res.ok) return res;
            const copy = res.clone();
            e.waitUntil((async () => {
                try {
                    const buf = await copy.arrayBuffer();
                    // a new ?v for the same path means the file was replaced,
                    // and the old entry can never be asked for again
                    for (const k of await c.keys()) {
                        const ku = new URL(k.url);
                        if (ku.pathname === url.pathname && ku.search !== url.search) await c.delete(k);
                    }
                    await c.put(e.request.url, new Response(buf, { status: res.status, statusText: res.statusText, headers: res.headers }));
                } catch (err) {
                    console.warn(`webdoom sw: could not cache ${e.request.url}: ${err?.message ?? err}`);
                }
            })());
            return res;
        }));
        return;
    }

    // shell: network-first (dev-friendly), cache fallback (offline SP)
    const store = LAUNCHER_API.test(url.pathname) ? API : SHELL;
    // doom.js names its module by content (doom.wasm?v=<sha256[:12]>): each
    // module is kept under its own v, an older build's goes, and offline a
    // loader is answered only with the module it names
    const v = url.pathname.startsWith('/engine/') ? url.searchParams.get('v') : null;
    e.respondWith(
        fetch(e.request).then(res => {
            // best-effort: a rejected cache write (quota, opaque response) must
            // not become an unhandled rejection in the worker
            if (res.ok) {
                const copy = res.clone();
                caches.open(store)
                    .then(async c => {
                        if (v !== null)
                            for (const k of await c.keys(e.request, { ignoreSearch: true }))
                                if (k.url !== e.request.url) await c.delete(k);
                        await c.put(e.request, copy);
                    })
                    .catch(err => console.warn(`webdoom sw: could not cache ${e.request.url}: ${err?.message ?? err}`));
            }
            return res;
        }).catch(() => v !== null ? cachedModule(e.request, v) : caches.match(e.request, { ignoreSearch: true })),
    );
});

// The cached module whose sha256 begins with v, or a network error: the cache
// can hold another build's (the one precached at install), and instantiated
// under this loader it would bind exports to the wrong functions.
async function cachedModule(req, v) {
    const c = await caches.open(SHELL);
    for (const res of await c.matchAll(req, { ignoreSearch: true })) {
        const sum = new Uint8Array(await crypto.subtle.digest('SHA-256', await res.clone().arrayBuffer()));
        if ([...sum.slice(0, 6)].map(b => b.toString(16).padStart(2, '0')).join('') === v) return res;
    }
    return Response.error();
}
