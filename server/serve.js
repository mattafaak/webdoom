#!/usr/bin/env node
// webdoom server: static client + engine + WAD library. Single process,
// single port. The lobby WS and game tic-relay WS mount here next.
import { createServer } from 'node:http';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGame } from './game.js';
import { uiAssets } from './ui-assets.js';
import { putDemo, getDemo, PER_DEMO_CAP } from './demo-store.js';

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

    // ── demo store API ────────────────────────────────────────────────────────
    //
    // POST /api/demos
    //   Body: raw .lmp bytes (application/octet-stream), max PER_DEMO_CAP.
    //   Query: ?wad=<wadfilename> (optional; stored alongside, returned on GET)
    //   Returns 201 {"id":"<sha256>","size":<bytes>}
    //   Returns 413 if body > PER_DEMO_CAP; 400 on read error.
    //
    // GET /api/demos/<id>
    //   id must be 64 lowercase hex chars (sha256); anything else → 400.
    //   Returns 200 with x-demo-wad header and raw .lmp body.
    //   Returns 404 if not found or TTL expired.
    //
    if (path === '/api/demos' && req.method === 'POST') {
        const wad = url.searchParams.get('wad') ?? '';
        const chunks = [];
        let size = 0;
        // Drain full request body even if oversized: draining avoids RST and
        // allows a clean 413 response on 'end'.  We stop accumulating chunks
        // once the cap is exceeded but continue reading to drain the socket.
        req.on('data', chunk => {
            size += chunk.length;
            if (size <= PER_DEMO_CAP) chunks.push(chunk);
        });
        req.on('error', () => send(res, 400, 'read error'));
        req.on('end', () => {
            if (size > PER_DEMO_CAP)
                return send(res, 413, `demo exceeds ${PER_DEMO_CAP} byte cap`);
            const bytes = Buffer.concat(chunks);
            let id;
            try { id = putDemo(bytes, wad); }
            catch (e) { return send(res, e.status ?? 500, e.message ?? 'store error'); }
            send(res, 201, JSON.stringify({ id, size: bytes.length }),
                { 'content-type': 'application/json' });
        });
        return;
    }

    const demoMatch = path.match(/^\/api\/demos\/([0-9a-f]{64})$/);
    if (demoMatch) {
        if (req.method !== 'GET') return send(res, 405, 'method not allowed');
        const rec = getDemo(demoMatch[1]);
        if (!rec) return send(res, 404, 'demo not found');
        res.writeHead(200, {
            'content-type': 'application/octet-stream',
            'content-length': rec.bytes.length,
            'cache-control': 'no-store',
            'x-demo-wad': rec.wad || '',
        });
        res.end(rec.bytes);
        return;
    }
    // Bad id format (non-hex or wrong length) → 400 (path traversal guard)
    if (path.startsWith('/api/demos/')) return send(res, 400, 'invalid demo id');

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
