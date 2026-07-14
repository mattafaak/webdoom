// webdoom service worker: WADs are content-hashed (?v=sha8) → cache-first
// forever; everything else network-first with cache fallback, so repeat
// loads are instant and single player works offline once a WAD is cached.
const SHELL = 'webdoom-shell-v1';
const WADS = 'webdoom-wads-v1';

self.addEventListener('install', e => {
    e.waitUntil(caches.open(SHELL).then(c => c.addAll([
        '/', '/css/webdoom.css',
        '/js/lobby.js', '/js/main.js', '/js/video.js', '/js/input.js',
        '/js/audio.js', '/js/settings.js', '/js/net.js', '/js/music-worklet.js',
        '/engine/doom.js', '/engine/doom.wasm',
    ])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
    e.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', e => {
    const url = new URL(e.request.url);
    if (url.origin !== location.origin || e.request.method !== 'GET') return;
    if (url.pathname.startsWith('/ws/')) return;

    if (url.pathname.startsWith('/wads/')) {
        // hash in ?v makes the full URL immutable
        e.respondWith(caches.open(WADS).then(async c => {
            const hit = await c.match(e.request.url);
            if (hit) return hit;
            const res = await fetch(e.request);
            if (res.ok) c.put(e.request.url, res.clone());
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
