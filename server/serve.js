#!/usr/bin/env node
// webdoom server: static client + engine + WAD library. Single process,
// single port. The lobby WS and game tic-relay WS mount here next.
import { createServer } from 'node:http';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGame } from './game.js';
import { uiAssets } from './ui-assets.js';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const HOST = process.env.DOOM_HOST ?? '0.0.0.0';
const PORT = +(process.env.DOOM_PORT ?? 8666);

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'text/javascript; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.json': 'application/json',
    '.wasm': 'application/wasm',
    '.wad':  'application/octet-stream',
};

// route prefix → directory on disk
const MOUNTS = [
    ['/engine/', join(root, 'build')],
    ['/wads/',   join(root, 'wads/lib')],
    ['/',        join(root, 'client')],
];

const manifest = () => readFileSync(join(root, 'wads/manifest.json'));

function send(res, code, body, headers = {}) {
    res.writeHead(code, { 'cache-control': 'no-store', ...headers });
    res.end(body);
}

// Optional per-request logging for smoke tests: set LOG_REQUESTS=1 in env.
// Logs to stderr so stdout (used by some callers for structured output) is unaffected.
const LOG_REQ = !!process.env.LOG_REQUESTS;

const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let path = normalize(url.pathname);
    if (LOG_REQ) process.stderr.write(`${req.method} ${path} ${req.headers['user-agent'] ?? '-'}\n`);
    if (path.includes('..')) return send(res, 400, 'bad path');

    if (path === '/api/wads')
        return send(res, 200, manifest(), { 'content-type': 'application/json' });
    if (path === '/api/ui-assets') {
        // no-store: a stale hour-long cache kept serving the old logo
        const assets = uiAssets(join(root, 'wads/lib'), JSON.parse(manifest()));
        return assets
            ? send(res, 200, assets, { 'content-type': 'application/json' })
            : send(res, 404, 'no IWAD available');
    }
    if (path === '/') path = '/index.html';

    for (const [prefix, dir] of MOUNTS) {
        if (!path.startsWith(prefix)) continue;
        const file = join(dir, path.slice(prefix.length));
        let st;
        try { st = statSync(file); } catch { continue; }
        if (!st.isFile()) continue;

        // WADs are immutable by content; the client caches by manifest hash.
        const headers = {
            'content-type': MIME[extname(file)] ?? 'application/octet-stream',
            'content-length': st.size,
            'cache-control': prefix === '/wads/' ? 'public, max-age=31536000, immutable' : 'no-store',
        };
        res.writeHead(200, headers);
        createReadStream(file).pipe(res);
        return;
    }
    send(res, 404, 'not found');
});

const game = createGame();
server.on('upgrade', (req, socket, head) => game.upgrade(req, socket, head));
server.listen(PORT, HOST, async () => {
    // one lobby, any route in: LAN and tailnet clients land in the same
    // game because everything relays through this server
    const { networkInterfaces } = await import('node:os');
    const urls = [];
    for (const addrs of Object.values(networkInterfaces()))
        for (const a of addrs ?? [])
            if (a.family === 'IPv4' && !a.internal) {
                const kind = a.address.startsWith('100.') ? 'tailnet' : 'LAN';
                urls.push(`  ${kind}: http://${a.address}:${PORT}/`);
            }
    console.log(`webdoom up — share whichever URL the player can reach:`);
    console.log(urls.join('\n') || `  http://${HOST}:${PORT}/`);
});
