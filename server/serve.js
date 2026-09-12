#!/usr/bin/env node
// webdoom server: static client + engine + WAD library. Single process,
// single port. The lobby WS and game tic-relay WS mount here next.
import { createServer } from 'node:http';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGame } from './game.js';
import { uiAssets } from './ui-assets.js';
import { putDemo, getDemo, PER_DEMO_CAP, storeStats,
         putAttestation, getAttestation, ATTEST_BODY_CAP } from './demo-store.js';

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

// The manifest, cached against its own mtime.
//
// This was `readFileSync(...)` called straight from the request handler. A
// missing or unreadable wads/manifest.json therefore threw INSIDE a Node
// 'request' listener -- uncaught, process exit -- so one bad file in the data
// directory took the game down for everyone on the LAN. That is the exact
// failure server/ui-assets.js was hardened against in task 23.3 ("One corrupt
// WAD takes the game down for everyone"); the hardening went into lumpsOf() and
// stopped one call short of the read beside it.
//
// It was also a synchronous disk read on every /api/wads request.
let manifestCache = null;   // { mtimeMs, body }
function manifest() {
    const f = join(root, 'wads/manifest.json');
    try {
        const { mtimeMs } = statSync(f);
        if (!manifestCache || manifestCache.mtimeMs !== mtimeMs)
            manifestCache = { mtimeMs, body: readFileSync(f) };
        return manifestCache.body;
    } catch (e) {
        // Decline, do not die. Same shape as ui-assets.js.
        console.error(`webdoom: wads/manifest.json unreadable (${e?.code ?? e?.message}) — serving an empty library`);
        return Buffer.from('{"wads":[]}');
    }
}

// Headers on every response.
//
// The server set none of these. For a LAN game the realistic threat is small,
// but this project treats hostile input as a first-class concern everywhere
// else -- Phase 23 fuzzed the WAD path, the net path and the lump path -- and
// the transport layer was the one place that concern was invisible.
//
// The CSP is written to fit what the client actually does rather than to be
// maximal, because a policy that breaks the app is a policy someone removes:
//   'wasm-unsafe-eval'  the engine is WebAssembly
//   style-src unsafe-inline   five elements are styled by element.style.cssText
//   worker-src blob:    AudioWorklet
//   connect-src ws:     the lobby and tic relay, on a plain-HTTP origin
// script-src has NO 'unsafe-inline': the one inline handler in the codebase
// (index.html's reload button) moved into lobby.js for exactly this reason.
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

function send(res, code, body, headers = {}) {
    // Two paths could each call send() for one request: the verify body timer
    // (408) racing req 'error' (400), and the demo POST's 'error' racing its
    // 'end'. The second call throws ERR_HTTP_HEADERS_SENT, which -- inside an
    // event handler -- is an uncaught exception. The timer path wrapped its own
    // send in try/catch; the error paths did not. One guard for all of them.
    if (res.headersSent || res.writableEnded) return;
    res.writeHead(code, { 'cache-control': 'no-store', ...SECURITY_HEADERS, ...headers });
    res.end(body);
}

// Optional per-request logging for smoke tests: set LOG_REQUESTS=1 in env.
// Logs to stderr so stdout (used by some callers for structured output) is unaffected.
const LOG_REQ = !!process.env.LOG_REQUESTS;

// Rate limit flag for POST /api/demos/:id/verify (task 19.4).
// Only one verify request may be in flight at a time (returns 429 otherwise).
let verifyInFlight = false;
let verifyTimer = null;
// Generous for a <=4 MiB attestation on a LAN; short enough that a silent
// client cannot hold the single verify slot for Node's 300 s requestTimeout.
const VERIFY_BODY_TIMEOUT_MS = 15_000;

const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let path = normalize(url.pathname);
    if (LOG_REQ) process.stderr.write(`${req.method} ${path} ${req.headers['user-agent'] ?? '-'}\n`);
    if (path.includes('..')) return send(res, 400, 'bad path');

    // Operator configuration.  docs/decision-17.2a Decision 5 deferred the
    // SpessaSynth URL wiring to 17.2b; 17.2b wired the backend picker and the
    // soundfont bytes but never this, so setGmMode's third parameter had no
    // caller and the GM path could never activate — it always logged
    // "no spessaSynthUrl configured" and fell back to OPL (task 25.1).
    //
    // Env-supplied, matching DOOM_PORT/DOOM_HOST/WEBDOOM_MAX_CONNS, and empty
    // by default: SpessaSynth is operator-hosted by decision (never a CDN, not
    // vendored, not a package.json dependency), so only the operator knows the
    // URL.  Read-only, no parameters.
    if (path === '/api/config')
        return send(res, 200, JSON.stringify({
            spessaSynthUrl: process.env.WEBDOOM_SPESSASYNTH_URL || null,
        }), { 'content-type': 'application/json' });

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

    // GET /api/demos/stats — what the store is actually holding.
    //
    // storeStats() was exported and labelled "for tests" and had no caller
    // anywhere: not in server/, not in client/, not in tools/.  So the one
    // instrument built to show the store's footprint was not reachable, and the
    // attestation leak (task A3) grew with nothing able to observe it.  A store
    // with no readout is a store nobody can prove is bounded.
    //
    // Counts and byte totals only — no ids, no content, nothing that would let
    // an unauthenticated LAN caller enumerate what other people have uploaded.
    if (path === '/api/demos/stats') {
        if (req.method !== 'GET') return send(res, 405, 'method not allowed');
        return send(res, 200, JSON.stringify(storeStats()),
                    { 'content-type': 'application/json' });
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
    // ── POST /api/demos/:id/verify — attestation store (task 19.4) ──────────────
    //
    // Design choice (b): the endpoint stores and retrieves per-tic attestations
    // (the full trace hash array produced by tools/demo-verify.mjs running on
    // the client).  The server does NOT replay the demo (no WASM engine).
    // This keeps the endpoint lightweight and avoids blocking the server event
    // loop with a CPU-bound wasm replay.
    //
    // POST /api/demos/:id/verify
    //   Body: JSON { tics: number, trace: number[] }  (max ATTEST_BODY_CAP bytes)
    //   Returns 200 { stored: true, id }
    //   Returns 400 on bad id format, bad JSON body, or trace validation failure
    //   Returns 404 if the demo is not in the store
    //   Returns 413 if body exceeds ATTEST_BODY_CAP
    //   Returns 429 if another verify request is in flight (1-concurrent limit)
    //
    // GET /api/demos/:id/verify
    //   Returns 200 { tics, trace, storedAt } if attestation exists
    //   Returns 404 if no attestation stored for this id
    {
        const vMatch = path.match(/^\/api\/demos\/([0-9a-f]{64})\/verify$/);
        if (vMatch) {
            const vid = vMatch[1];
            if (req.method === 'GET') {
                const attest = getAttestation(vid);
                if (!attest) return send(res, 404, 'no attestation stored for this demo');
                // trace is a Uint32Array (task A3).  JSON.stringify would render
                // a typed array as an OBJECT -- {"0":123,"1":456} -- silently
                // changing this endpoint's contract, so build the array body
                // from join() instead.  tics and storedAt are validated
                // non-negative integers, so interpolating them is safe.
                return send(res, 200,
                    `{"tics":${attest.tics},"trace":[${attest.trace.join(',')}],`
                    + `"storedAt":${attest.storedAt}}`,
                    { 'content-type': 'application/json' });
            }
            if (req.method !== 'POST') return send(res, 405, 'method not allowed');

            // Rate limit: 1 concurrent verify operation.
            if (verifyInFlight) return send(res, 429, 'verify in progress — try again');
            verifyInFlight = true;

            // This flag is a concurrency LOCK, and it was released only from
            // req 'end' and req 'error'.  A client that announces a
            // Content-Length and then simply stops writing -- WITHOUT closing
            // the socket -- fires neither, so the lock was held and every later
            // verify got 429 from one idle connection.  Reproduced 2026-09-11
            // (task 23.6); bounded in practice only by Node's 300 s
            // requestTimeout, so: a five-minute denial for one silent socket.
            //
            // res.on('close') is NOT sufficient and was tried first: with the
            // socket held open the response is never finished and never closes.
            // A lock without a timeout is a wedge waiting for a slow client, so
            // the timer is the fix and 'close' is the fast path beside it.
            const releaseSlot = () => {
                if (verifyTimer) { clearTimeout(verifyTimer); verifyTimer = null; }
                verifyInFlight = false;
            };
            verifyTimer = setTimeout(() => {
                verifyTimer = null;
                verifyInFlight = false;
                try { send(res, 408, 'verify body timed out'); } catch { /* already sent */ }
                req.destroy();
            }, VERIFY_BODY_TIMEOUT_MS);
            res.on('close', releaseSlot);

            let size = 0;
            const chunks = [];
            req.on('data', chunk => {
                size += chunk.length;
                if (size <= ATTEST_BODY_CAP) chunks.push(chunk);
            });
            req.on('error', () => { setImmediate(releaseSlot); send(res, 400, 'read error'); });
            req.on('end', () => {
                // Defer flag clear to next event-loop tick so concurrent requests
                // that arrive while body events fire synchronously still see
                // verifyInFlight=true and receive 429 (rate limit).
                const clearFlag = () => setImmediate(releaseSlot);

                if (size > ATTEST_BODY_CAP) {
                    clearFlag();
                    return send(res, 413, `attestation body exceeds ${ATTEST_BODY_CAP} byte cap`);
                }
                let parsed;
                try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
                catch (e) { clearFlag(); return send(res, 400, 'invalid JSON body'); }
                try { putAttestation(vid, parsed.tics, parsed.trace); }
                catch (e) {
                    clearFlag();
                    return send(res, e.status ?? 400, e.message ?? 'attestation error');
                }
                send(res, 200, JSON.stringify({ stored: true, id: vid }),
                    { 'content-type': 'application/json' });
                clearFlag();
            });
            return;
        }
    }

    // Path with /verify but bad id format → 400
    if (path.match(/^\/api\/demos\/[^/]+\/verify$/))
        return send(res, 400, 'invalid demo id');

    // Bad id format (non-hex or wrong length) → 400 (path traversal guard)
    if (path.startsWith('/api/demos/')) return send(res, 400, 'invalid demo id');

    if (path === '/api/ui-assets') {
        // no-store: a stale hour-long cache kept serving the old logo
        //
        // JSON.parse(manifest()) was unguarded, and manifest() returns bytes
        // without parsing them -- so a wads/manifest.json that is present but
        // not valid JSON threw here, inside a 'request' listener, and ENDED THE
        // PROCESS. Measured against the shipped server: the request returns
        // nothing, and so does the next one, because there is no longer a
        // server. One malformed file in the data directory took the game down
        // for everyone on the LAN, which is the failure ui-assets.js itself was
        // hardened against in task 23.3 -- the hardening went into lumpsOf()
        // and stopped one call short of its own caller.
        //
        // The uncaughtException handler at the bottom would now catch this, but
        // a backstop is not a guard: it cannot answer the request, and the
        // operator would see a stack trace instead of the reason.
        let parsed;
        try { parsed = JSON.parse(manifest()); }
        catch (e) {
            console.error(`webdoom: wads/manifest.json is not valid JSON (${e.message}) — /api/ui-assets declines`);
            return send(res, 503, 'wads/manifest.json is unreadable or not valid JSON — run tools/fetch-wads.sh');
        }
        const assets = uiAssets(join(root, 'wads/lib'), parsed);
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
            ...SECURITY_HEADERS,
            'content-type': MIME[extname(file)] ?? 'application/octet-stream',
            'content-length': st.size,
            'cache-control': prefix === '/wads/' ? 'public, max-age=31536000, immutable' : 'no-store',
        };
        res.writeHead(200, headers);
        // statSync above and the open below are not atomic: a file deleted or
        // truncated in between emits 'error' on the stream, and an unhandled
        // stream 'error' is an uncaught exception -- process exit, for one
        // vanished file. Headers are already sent here, so the only honest
        // recovery is to destroy the response and let the client see a truncated
        // body rather than a dead server.
        const stream = createReadStream(file);
        stream.on('error', err => {
            console.error(`webdoom: read failed for ${file} — ${err?.code ?? err?.message}`);
            res.destroy();
        });
        stream.pipe(res);
        return;
    }
    send(res, 404, 'not found');
});

// The lobby's `wad` param is cast to every client in the `launch` frame, so the
// server has to know what it serves.  Read per call, not once: manifest() is
// already mtime-keyed, so an operator adding a WAD needs no restart here either.
const servedWads = () => {
    try { return (JSON.parse(manifest()).wads ?? []).map(w => w.file).filter(Boolean); }
    catch (e) {
        console.error(`webdoom: wads/manifest.json unreadable (${e?.message ?? e}) — the lobby will refuse every wad change`);
        return [];
    }
};
const game = createGame(console.log, servedWads);
server.on('upgrade', (req, socket, head) => game.upgrade(req, socket, head));

// LAST RESORT, not a substitute for the guards above.
//
// There was no uncaughtException or unhandledRejection handler anywhere in
// server/, so any throw reaching the top of a request listener ended the
// process -- and with it everyone's game. The specific paths that could do it
// are fixed above; this is here because the next one has not been found yet,
// and a DOOM night should not end because of it.
//
// It deliberately does NOT swallow silently: the error is printed in full, and
// a fatal one during startup still exits, because a server that cannot bind or
// cannot read its own tree should fail loudly rather than limp.
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

// Without this, a listen failure is an unhandled 'error' event: the process dies
// with a stack trace, and any harness that spawned it and then slept for a fixed
// interval carries on talking to WHATEVER ELSE holds that port — a stale server
// from an earlier run, serving a different build.  That is the 12.2b failure
// ("port 8666 once served an uninstrumented client to the collector") and the
// orphaned-server hangs on the 867x range.  Fail loudly and name the port.
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
