#!/usr/bin/env node
// webdoom server: static client + engine + WAD library, the demo store, and
// the lobby / tic-relay / spectate WebSockets.  Single process, single port.
import { createServer } from 'node:http';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { join, normalize, extname } from 'node:path';
import { brotliCompressSync, gzipSync, constants as zc } from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createGame } from './game.js';
import { uiAssets, titleThumb } from './ui-assets.js';
import { putDemo, getDemo, PER_DEMO_CAP, storeStats } from './demo-store.js';

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

// The manifest, cached against its own mtime, bytes and parsed form both.
// A missing or malformed wads/manifest.json is declined, never thrown: a
// throw inside a request listener ends the process for everyone on the LAN.
const EMPTY = { body: Buffer.from('{"wads":[]}'), parsed: null };
let manifestCache = null;   // { mtimeMs, body, parsed }
function manifest() {
    const f = join(root, 'wads/manifest.json');
    try {
        const { mtimeMs } = statSync(f);
        if (!manifestCache || manifestCache.mtimeMs !== mtimeMs) {
            const body = readFileSync(f);
            let parsed = null;
            try { parsed = JSON.parse(body); }
            catch (e) { console.error(`webdoom: wads/manifest.json is not valid JSON (${e.message})`); }
            manifestCache = { mtimeMs, body, parsed };
        }
        return manifestCache;
    } catch (e) {
        console.error(`webdoom: wads/manifest.json unreadable (${e?.code ?? e?.message}) — serving an empty library`);
        return EMPTY;
    }
}

// On every response.  The CSP fits what the client does, not a maximal
// policy someone would remove: 'wasm-unsafe-eval' for the engine,
// style-src 'unsafe-inline' for the few element.style writes, worker-src
// blob: for the AudioWorklet, connect-src ws: for a plain-HTTP origin.
// script-src has no 'unsafe-inline'.
const SECURITY_HEADERS = {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': [
        "default-src 'self'",
        "script-src 'self' 'wasm-unsafe-eval'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "media-src 'self' data: blob:",
        "connect-src 'self' ws: wss:",
        "worker-src 'self' blob:",
        "object-src 'none'",
        "base-uri 'self'",
        "frame-ancestors 'none'",
    ].join('; '),
};

// ── representations: negotiated encoding and ETags ──────────────────────────
// Text, JSON and wasm bodies of 1 KB or more are compressed once per distinct
// body (br > gzip > identity, by Accept-Encoding) and served from memory: the
// shell is a few dozen files and the engine 300 KB, so the cache is bounded by
// the tree, not by traffic.  The ETag is the body's hash, suffixed per
// encoding, and a matching If-None-Match answers 304 with no body.  Hashed
// immutable URLs would do nothing here: the service worker is network-first
// for the shell, so every load revalidates anyway -- revalidation is the lever,
// and a 304 moves headers only.  `key` names the bytes (path + mtime + size
// for a file); a generated body is keyed by its own hash.
const COMPRESSIBLE = /^(text\/|application\/(json|wasm|javascript))/;
const MIN_COMPRESS = 1024;
const REPS_MAX = 64;
const reps = new Map();               // key -> { raw, etag, br?, gz? }

const sha = buf => createHash('sha1').update(buf).digest('base64url').slice(0, 16);
function representation(key, raw) {
    const hash = key ? null : sha(raw);
    const k = key ?? `h:${hash}`;
    let r = reps.get(k);
    if (!r) {
        if (reps.size >= REPS_MAX) reps.delete(reps.keys().next().value);   // oldest
        r = { raw, etag: `"${hash ?? sha(raw)}"` };
        reps.set(k, r);
    }
    return r;
}
const encode = (r, enc) =>
    enc === 'br'   ? (r.br ??= brotliCompressSync(r.raw, { params: {
                          [zc.BROTLI_PARAM_QUALITY]: 6, [zc.BROTLI_PARAM_SIZE_HINT]: r.raw.length } }))
  : enc === 'gzip' ? (r.gz ??= gzipSync(r.raw, { level: 9 }))
  : r.raw;
function pickEncoding(req) {
    const ae = String(req.headers['accept-encoding'] ?? '');
    if (/(^|,)\s*br\s*(;\s*q=(?!0(\.0*)?\s*(,|$)))?\s*(,|$)/.test(ae)) return 'br';
    if (/(^|,)\s*gzip\s*(;\s*q=(?!0(\.0*)?\s*(,|$)))?\s*(,|$)/.test(ae)) return 'gzip';
    return null;
}
const etagMatches = (inm, etag) =>
    !!inm && inm.split(',').some(t => t.trim().replace(/^W\//, '') === etag);

// one guard for every path that could answer a request twice (a body timer
// racing 'error', 'error' racing 'end'): a second writeHead would throw
function send(req, res, code, body, headers = {}, key = null) {
    if (res.headersSent || res.writableEnded) return;
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''));
    const type = headers['content-type'] ?? 'text/plain; charset=utf-8';
    const base = { 'cache-control': 'no-cache', ...SECURITY_HEADERS, 'content-type': type, ...headers };
    // a keyed body always gets its ETag; only text, JSON and wasm are encoded
    if (code !== 200 || (!key && (buf.length < MIN_COMPRESS || !COMPRESSIBLE.test(type)))) {
        res.writeHead(code, { ...base, 'content-length': buf.length });
        return res.end(buf);
    }
    const r = representation(key, buf);
    const enc = COMPRESSIBLE.test(type) && buf.length >= MIN_COMPRESS ? pickEncoding(req) : null;
    const etag = enc ? r.etag.replace(/"$/, `-${enc}"`) : r.etag;
    const out = { ...base, etag, vary: 'accept-encoding' };
    if (etagMatches(req.headers['if-none-match'], etag)) {
        res.writeHead(304, out);
        return res.end();
    }
    const data = encode(r, enc);
    if (enc) out['content-encoding'] = enc;
    out['content-length'] = data.length;
    res.writeHead(code, out);
    res.end(data);
}

const LOG_REQ = !!process.env.LOG_REQUESTS;   // per-request log to stderr, for smoke tests

const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let path = normalize(url.pathname);
    if (LOG_REQ) process.stderr.write(`${req.method} ${path} ${req.headers['user-agent'] ?? '-'}\n`);
    if (path.includes('..')) return send(req, res, 400, 'bad path');

    if (path === '/api/wads') {
        const m = manifest();
        return send(req, res, 200, m.body, { 'content-type': 'application/json' },
                    m.mtimeMs ? `wads:${m.mtimeMs}:${m.body.length}` : null);
    }

    // ── demo store ────────────────────────────────────────────────────────────
    // POST /api/demos?wad=<file>   raw .lmp body up to PER_DEMO_CAP → 201 {id, size}
    // GET  /api/demos/<sha256>     raw .lmp, x-demo-wad header; 404 if expired
    // GET  /api/demos/stats        counts and bytes only, never ids or content
    if (path === '/api/demos' && req.method === 'POST') {
        const wad = url.searchParams.get('wad') ?? '';
        const chunks = [];
        let size = 0;
        // drain an oversized body so the 413 goes out cleanly, without a RST
        req.on('data', chunk => {
            size += chunk.length;
            if (size <= PER_DEMO_CAP) chunks.push(chunk);
        });
        req.on('error', () => send(req, res, 400, 'read error'));
        req.on('end', () => {
            if (size > PER_DEMO_CAP)
                return send(req, res, 413, `demo exceeds ${PER_DEMO_CAP} byte cap`);
            const bytes = Buffer.concat(chunks);
            let id;
            try { id = putDemo(bytes, wad); }
            catch (e) { return send(req, res, e.status ?? 500, e.message ?? 'store error'); }
            send(req, res, 201, JSON.stringify({ id, size: bytes.length }),
                { 'content-type': 'application/json' });
        });
        return;
    }
    if (path === '/api/demos/stats') {
        if (req.method !== 'GET') return send(req, res, 405, 'method not allowed');
        return send(req, res, 200, JSON.stringify(storeStats()), { 'content-type': 'application/json' });
    }
    const demoMatch = path.match(/^\/api\/demos\/([0-9a-f]{64})$/);
    if (demoMatch) {
        if (req.method !== 'GET') return send(req, res, 405, 'method not allowed');
        const rec = getDemo(demoMatch[1]);
        if (!rec) return send(req, res, 404, 'demo not found');
        res.writeHead(200, {
            'content-type': 'application/octet-stream',
            'content-length': rec.bytes.length,
            'cache-control': 'no-store',
            'x-demo-wad': rec.wad || '',
        });
        res.end(rec.bytes);
        return;
    }
    if (path.startsWith('/api/demos/')) return send(req, res, 400, 'invalid demo id');

    // GET /api/status — counts only: is a game live, how many are in it.
    // No names, no slots, no addresses; an operator needs to know whether a
    // restart would drop anyone, and nothing more.
    if (path === '/api/status') {
        if (req.method !== 'GET') return send(req, res, 405, 'method not allowed');
        return send(req, res, 200, JSON.stringify(game.status()), { 'content-type': 'application/json' });
    }

    if (path === '/api/ui-assets') {
        const { parsed } = manifest();
        if (!parsed) return send(req, res, 503, 'wads/manifest.json is unreadable or not valid JSON — run tools/fetch-wads.sh');
        const assets = uiAssets(join(root, 'wads/lib'), parsed);
        return assets
            ? send(req, res, 200, assets, { 'content-type': 'application/json' })
            : send(req, res, 404, 'no IWAD available');
    }
    // GET /api/thumb/<file>: 768-byte PLAYPAL + 80x60 indices, 404 if the
    // manifest does not name it or its art does not decode
    const thumbMatch = path.match(/^\/api\/thumb\/([A-Za-z0-9._-]+)$/);
    if (thumbMatch) {
        if (req.method !== 'GET') return send(req, res, 405, 'method not allowed');
        const { parsed } = manifest();
        const body = parsed && titleThumb(join(root, 'wads/lib'), parsed, thumbMatch[1]);
        return body
            ? send(req, res, 200, body, { 'content-type': 'application/octet-stream' }, `thumb:${thumbMatch[1]}:${sha(body)}`)
            : send(req, res, 404, 'no art for that game');
    }
    if (path.startsWith('/api/thumb/')) return send(req, res, 400, 'invalid thumb name');
    if (path === '/') path = '/index.html';

    for (const [prefix, dir] of MOUNTS) {
        if (!path.startsWith(prefix)) continue;
        const file = join(dir, path.slice(prefix.length));
        let st;
        try { st = statSync(file); } catch { continue; }
        if (!st.isFile()) continue;
        const type = MIME[extname(file)] ?? 'application/octet-stream';

        // the shell and the engine: negotiated, ETagged, revalidated
        if (prefix !== '/wads/' && COMPRESSIBLE.test(type)) {
            let bytes;
            try { bytes = readFileSync(file); }
            catch (err) {
                console.error(`webdoom: read failed for ${file} — ${err?.code ?? err?.message}`);
                return send(req, res, 404, 'not found');
            }
            return send(req, res, 200, bytes, { 'content-type': type },
                        `${file}:${st.mtimeMs}:${st.size}`);
        }

        // WADs are immutable by content; the client caches by manifest hash
        res.writeHead(200, {
            ...SECURITY_HEADERS,
            'content-type': type,
            'content-length': st.size,
            'cache-control': prefix === '/wads/' ? 'public, max-age=31536000, immutable' : 'no-cache',
        });
        // a file that vanishes between stat and open errors the stream;
        // headers are out, so the honest recovery is a truncated body
        const stream = createReadStream(file);
        stream.on('error', err => {
            console.error(`webdoom: read failed for ${file} — ${err?.code ?? err?.message}`);
            res.destroy();
        });
        stream.pipe(res);
        return;
    }
    send(req, res, 404, 'not found');
});

// the lobby's `wad` is cast to every client, so the server names what it
// serves; read per call, so an added WAD needs no restart
const servedWads = () => (manifest().parsed?.wads ?? []).map(w => w.file).filter(Boolean);
const game = createGame(console.log, servedWads);
server.on('upgrade', (req, socket, head) => game.upgrade(req, socket, head));

// Last resort, not a substitute for the guards above: a throw that reaches
// the top of a listener is printed in full and the server survives, except
// before listen, where a server that cannot start should say so and exit.
let started = false;
const survive = (kind) => (err) => {
    console.error(`webdoom: ${kind} — the request that caused this is lost, the server is not:`);
    console.error(err?.stack ?? err);
    if (!started) {
        console.error('webdoom: ...but this happened before the server was listening, so exiting');
        process.exit(1);
    }
};
process.on('uncaughtException', survive('uncaught exception'));
process.on('unhandledRejection', survive('unhandled rejection'));

// a listen failure names the port: a harness that sleeps and then talks to
// whatever else holds it would be testing a stale server
server.on('error', err => {
    if (err && err.code === 'EADDRINUSE') {
        console.error(`webdoom: port ${PORT} is already in use on ${HOST} — refusing to start.`);
        console.error('webdoom: another server (likely orphaned by an earlier test run) owns it.');
        console.error(`webdoom: find it with:  ss -tlnp 'sport = :${PORT}'`);
    } else {
        console.error(`webdoom: listen failed on ${HOST}:${PORT} — ${err?.code ?? ''} ${err?.message ?? err}`);
    }
    process.exit(1);
});

server.listen(PORT, HOST, async () => {
    started = true;
    // one lobby, any route in: LAN and tailnet clients land in the same game
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
