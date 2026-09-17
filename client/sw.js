// webdoom service worker: WADs are content-hashed (?v=sha8) → cache-first
// forever; everything else network-first with cache fallback, so repeat
// loads are instant and single player works offline once a WAD is cached.
const SHELL = 'webdoom-shell-v17'; // v17: build/synth.wasm joins the shell (the worklet synth)
const WADS = 'webdoom-wads-v1';

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
        for (const k of await caches.keys())
            if (k.startsWith('webdoom-shell-') && k !== SHELL) await caches.delete(k);
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', e => {
    const url = new URL(e.request.url);
    if (url.origin !== location.origin || e.request.method !== 'GET') return;
    if (url.pathname.startsWith('/ws/')) return;

    if (url.pathname.startsWith('/wads/')) {
        // hash in ?v makes the full URL immutable; read body into ArrayBuffer
        // first, then cache a synthetic Response — direct c.put(networkResponse)
        // fails in headless Chrome without sandbox (NetworkError), but a
        // Response constructed from an ArrayBuffer always succeeds.
        e.respondWith(caches.open(WADS).then(async c => {
            const hit = await c.match(e.request.url);
            if (hit) return hit;
            const res = await fetch(e.request);
            if (res.ok) {
                const buf = await res.arrayBuffer();
                const init = { status: res.status, statusText: res.statusText, headers: res.headers };
                // A WAD is content-hashed, so a new ?v for the same path means
                // the file was REPLACED and the old entry can never be asked
                // for again.  Nothing pruned them: `activate` only deletes
                // `webdoom-shell-` keys, so webdoom-wads-v1 grew without bound
                // at 12-18 MB a copy.  That matters because of the line below.
                try {
                    for (const k of await c.keys()) {
                        const ku = new URL(k.url);
                        if (ku.pathname === url.pathname && ku.search !== url.search)
                            await c.delete(k);
                    }
                } catch { /* best-effort: never fail a download over housekeeping */ }
                // THE CACHE WRITE MUST NOT BE ABLE TO FAIL THE DOWNLOAD.
                // Unguarded, a rejected c.put -- QuotaExceededError being the
                // realistic one, and the pruning above exists because this
                // cache was the thing filling up -- rejected the whole async
                // function, so respondWith got a rejected promise and the
                // page's fetch became a NETWORK ERROR.  main.js then threw
                // `wad fetch failed` and the game would not start, on every
                // retry, even though all 15 MB had arrived intact.  The shell
                // branch below has carried this guard, with a comment saying
                // why, while the branch far likelier to hit quota had none.
                try { await c.put(e.request.url, new Response(buf.slice(0), init)); }
                catch (err) {
                    console.warn(`webdoom sw: could not cache ${e.request.url}: ${err?.message ?? err}`);
                }
                return new Response(buf, init);
            }
            return res;
        }));
        return;
    }

    // shell: network-first (dev-friendly), cache fallback (offline SP)
    e.respondWith(
        fetch(e.request).then(res => {
            // best-effort: a rejected cache write (quota, opaque response) must
            // not become an unhandled rejection in the worker
            if (res.ok)
                caches.open(SHELL)
                    .then(c => c.put(e.request, res.clone()))
                    .catch(err => console.warn(`webdoom sw: could not cache ${e.request.url}: ${err?.message ?? err}`));
            return res.clone();
        }).catch(() => caches.match(e.request, { ignoreSearch: true })),
    );
});
