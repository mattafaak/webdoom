// webdoom service worker: WADs are content-hashed (?v=sha8) → cache-first
// forever; everything else network-first with cache fallback, so repeat
// loads are instant and single player works offline once a WAD is cached.
const SHELL = 'webdoom-shell-v9';  // v9: added demo.js (19.2 demo permalinks)
const WADS = 'webdoom-wads-v1';

self.addEventListener('install', e => {
    e.waitUntil(caches.open(SHELL).then(c => c.addAll([
        '/', '/css/webdoom.css',
        '/js/lobby.js', '/js/main.js', '/js/video.js', '/js/input.js',
        '/js/audio.js', '/js/mus2mid.js', '/js/settings.js', '/js/net.js', '/js/music-worklet.js',
        '/js/menu.js', '/js/doomfont.js', '/js/persist.js', '/js/wad-cache.js',
        '/js/fire.js', '/js/countdown.js',
        '/js/wad-import.js', '/js/wad-library.js', '/js/sf2-library.js',
        '/js/qol.js', '/js/demo.js',
        '/engine/doom.js', '/engine/doom.wasm',
    ])).then(() => self.skipWaiting()));
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
                await c.put(e.request.url, new Response(buf.slice(0), init));
                return new Response(buf, init);
            }
            return res;
        }));
        return;
    }

    // shell: network-first (dev-friendly), cache fallback (offline SP)
    e.respondWith(
        fetch(e.request).then(res => {
            if (res.ok) caches.open(SHELL).then(c => c.put(e.request, res.clone()));
            return res.clone();
        }).catch(() => caches.match(e.request, { ignoreSearch: true })),
    );
});
