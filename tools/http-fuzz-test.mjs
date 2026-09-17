#!/usr/bin/env node
// Static HTTP path fuzz test (ws-005 companion — exercise the real server).
// Sends malformed / adversarial HTTP paths and verifies:
//   1. No 5xx response (server must not crash on bad input).
//   2. No file outside client/ served (traversal guard holds).
//   3. Server stays up — a subsequent good GET /  returns 200.
//
// All cases derived from ws-005 on-paper analysis in docs/web-scrutiny.md.
// usage: node tools/http-fuzz-test.mjs
// Also the wire: negotiated br/gzip, ETag/304, on the real server (round 10).
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));

let PORT_BASE = 9100;
function spawnServer() {
    const port = PORT_BASE++;
    const srv = spawn('node', [join(root, 'server/serve.js')], {
        env: { ...process.env, DOOM_PORT: port, DOOM_HOST: '127.0.0.1' },
        stdio: ['ignore', 'ignore', 'pipe'],
    });
    let crashed = false;
    srv.stderr.on('data', d => {
        const t = d.toString();
        if (/Error:|at Object\.|at Module\.|UnhandledPromise/.test(t)) crashed = true;
    });
    return { srv, port, host: '127.0.0.1', kill: () => srv.kill(), didCrash: () => crashed };
}

// Send a raw HTTP request over TCP and collect the response.
// Returns { status: number|null, body: string, headers: string }.
function rawHttp(host, port, request) {
    return new Promise(resolve => {
        const chunks = [];
        const sock = createConnection(port, host);
        const timer = setTimeout(() => {
            sock.destroy();
            resolve({ status: null, body: '', headers: '' });
        }, 3000);
        sock.on('connect', () => {
            sock.write(Buffer.from(request, 'binary'));
        });
        sock.on('data', d => chunks.push(d));
        sock.on('end', () => {
            clearTimeout(timer);
            sock.destroy();
            const raw = Buffer.concat(chunks).toString('binary');
            const sep = raw.indexOf('\r\n\r\n');
            const headerPart = sep >= 0 ? raw.slice(0, sep) : raw;
            const body = sep >= 0 ? raw.slice(sep + 4) : '';
            const statusMatch = headerPart.match(/^HTTP\/\d\.\d (\d+)/);
            resolve({ status: statusMatch ? +statusMatch[1] : null, body, headers: headerPart });
        });
        sock.on('error', () => { clearTimeout(timer); resolve({ status: null, body: '', headers: '' }); });
    });
}

// Perform a normal GET / request and verify we get 200.
async function healthCheck(host, port) {
    const r = await rawHttp(host, port,
        `GET / HTTP/1.0\r\nHost: ${host}:${port}\r\n\r\n`);
    return r.status === 200;
}

function makeGet(path, host, port, extraHeaders = '') {
    return `GET ${path} HTTP/1.0\r\nHost: ${host}:${port}\r\n${extraHeaders}\r\n`;
}

const results = [];
const check = (name, ok, detail) => {
    results.push({ name, ok, detail });
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name} — ${detail}`);
};

// ── Main fuzz suite ───────────────────────────────────────────────────────────

async function fuzzStaticHTTP() {
    const s = spawnServer();
    await sleep(600);

    const cases = [
        // Case 1: percent-encoded traversal %2e%2e
        { name: 'encoded traversal %2e%2e', path: '/%2e%2e/%2e%2e/etc/passwd' },
        // Case 2: encoded traversal %2F (slash) variant
        { name: 'encoded traversal %2F variant', path: '/js/%2e%2e%2F%2e%2e%2Fetc%2Fpasswd' },
        // Case 3: double-slash
        { name: 'double-slash path', path: '//etc/passwd' },
        // Case 4: backslash (literal %5c — POSIX treats as filename char)
        { name: 'backslash path', path: '/js%5c..%5c..%5cetc%5cpasswd' },
        // Case 5: absolute path injection
        { name: 'absolute path injection', path: '/etc/passwd' },
        // Case 6: null byte in path (sent literally at TCP level via binary encoding)
        { name: 'null byte in path', path: '/js/lobby.js\x00.evil' },
        // Case 7: overlong path (4 KB)
        { name: 'overlong path (4 KB)', path: '/' + 'a'.repeat(4096) },
        // Case 8: path with ../ after a valid segment
        { name: 'dotdot after valid segment', path: '/js/../../../etc/passwd' },
        // Case 9: URL-encoded slash then dotdot
        { name: 'encoded slash + dotdot', path: '/js%2f..%2f..%2fetc%2fpasswd' },
        // Case 10: triple-encoded traversal
        { name: 'triple-percent-encoded dotdot', path: '/%252e%252e/%252e%252e/etc/passwd' },
    ];

    let traversalLeak = false;

    for (const { name, path } of cases) {
        const req = makeGet(path, s.host, s.port);
        const r = await rawHttp(s.host, s.port, req);
        const is5xx = r.status !== null && r.status >= 500;
        // A traversal leak would serve /etc/passwd content. If body contains
        // "root:" it is a strong signal of file-system escape.
        const looksLikePasswd = r.body.includes('root:') || r.body.includes('/bin/');
        if (looksLikePasswd) traversalLeak = true;
        check(
            `${name}: no 5xx`,
            !is5xx,
            `status=${r.status ?? 'no-response'}`,
        );
    }

    check('no path traversal file served', !traversalLeak,
        traversalLeak ? 'LEAK: response body contained /etc/passwd content' : 'clean');

    // Case 11: Missing Host header (HTTP/1.1 requires Host; HTTP/1.0 does not)
    {
        const r = await rawHttp(s.host, s.port,
            `GET / HTTP/1.1\r\n\r\n`);
        check('missing Host header: no 5xx', !r.status || r.status < 500,
            `status=${r.status ?? 'no-response'}`);
    }

    // Case 12: empty request line
    {
        const r = await rawHttp(s.host, s.port, `\r\n\r\n`);
        check('empty request line: no 5xx', !r.status || r.status < 500,
            `status=${r.status ?? 'no-response'}`);
    }

    // Case 13: request with no path (just method)
    {
        const r = await rawHttp(s.host, s.port,
            `GET  HTTP/1.0\r\nHost: ${s.host}:${s.port}\r\n\r\n`);
        check('no path in request: no 5xx', !r.status || r.status < 500,
            `status=${r.status ?? 'no-response'}`);
    }

    // Server health check: must still accept a good request
    await sleep(200);
    const alive = await healthCheck(s.host, s.port);
    const crashed = s.didCrash();
    check('server still up after all attacks', alive && !crashed,
        `alive=${alive} crashed=${crashed}`);

    s.kill();
}

console.log('http fuzz test — static path attacks against the real server:');
await fuzzStaticHTTP();

// ── a hostile DATA DIRECTORY, not a hostile request ──────────────────────────
//
// `JSON.parse(manifest())` in the /api/ui-assets route was unguarded, and
// manifest() returns bytes without parsing them -- so a wads/manifest.json that
// is PRESENT but not valid JSON threw inside a 'request' listener and ENDED THE
// PROCESS. Measured against the shipped server: the request returns nothing,
// and so does the next one, because there is no longer a server. One malformed
// file in the data directory took the game down for everyone on the LAN.
//
// That is the failure server/ui-assets.js was hardened against in task 23.3 --
// "One corrupt WAD takes the game down for everyone on the LAN" -- and the
// hardening went into lumpsOf() and stopped one call short of its own caller.
//
// This runs against a TEMPORARY tree rather than the repo, because the repo's
// own manifest is the one the rest of the suite needs. Same layout, same
// server, node_modules symlinked.
async function fuzzHostileDataDir() {
    const { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, copyFileSync, rmSync, readdirSync } =
        await import('node:fs');
    const { tmpdir } = await import('node:os');

    const tree = mkdtempSync(join(tmpdir(), 'webdoom-datadir-'));
    try {
        mkdirSync(join(tree, 'server'));
        mkdirSync(join(tree, 'wads/lib'), { recursive: true });
        mkdirSync(join(tree, 'client'));
        mkdirSync(join(tree, 'build'));
        for (const f of readdirSync(join(root, 'server')).filter(f => /\.(js|json)$/.test(f)))
            copyFileSync(join(root, 'server', f), join(tree, 'server', f));
        symlinkSync(join(root, 'server/node_modules'), join(tree, 'server/node_modules'));
        writeFileSync(join(tree, 'client/index.html'), '<!doctype html><title>x</title>');

        const cases = [
            ['manifest is not valid JSON', 'not json {{{',              '/api/ui-assets'],
            ['manifest is absent',          null,                        '/api/ui-assets'],
            ['manifest is absent',          null,                        '/api/wads'],
            ['manifest is empty',           '',                          '/api/wads'],
        ];
        for (const [label, body, path] of cases) {
            const mf = join(tree, 'wads/manifest.json');
            if (body === null) { try { rmSync(mf); } catch { /* already gone */ } }
            else writeFileSync(mf, body);

            const port = PORT_BASE++;
            const srv = spawn('node', [join(tree, 'server/serve.js')], {
                env: { ...process.env, DOOM_PORT: String(port), DOOM_HOST: '127.0.0.1' },
                stdio: ['ignore', 'ignore', 'ignore'],
            });
            let exited = false;
            srv.on('exit', () => { exited = true; });
            for (let i = 0; i < 40 && !exited; i++) {
                await sleep(100);
                if (await healthCheck('127.0.0.1', port)) break;
            }
            // The request itself may legitimately decline (503/404). What must
            // not happen is the server going away.
            try {
                await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(4000) });
            } catch { /* a declined or aborted request is not the thing under test */ }
            await sleep(300);
            const alive = !exited && await healthCheck('127.0.0.1', port);
            check(`${label}: GET ${path} leaves the server up`, alive,
                  `process exited=${exited}, still answering=${alive}`);
            srv.kill();
        }
    } finally {
        rmSync(tree, { recursive: true, force: true });
    }
}

console.log('\nhostile data directory — the server must decline, not die:');
await fuzzHostileDataDir();

// ── security headers ─────────────────────────────────────────────────────────
//
// The server set none. For a LAN game the realistic threat is small, but this
// project treats hostile input as a first-class concern everywhere else -- 23.2
// fuzzed lump content, 23.8 fuzzed the net path -- and the transport layer was
// the one place that concern was invisible. Asserted on BOTH response paths,
// because send() and the static-file branch build their headers separately and
// only one of them would be obvious to check.
async function checkSecurityHeaders() {
    const s = spawnServer();
    for (let i = 0; i < 40; i++) { await sleep(100); if (await healthCheck(s.host, s.port)) break; }
    for (const [label, path] of [['an API response', '/api/wads'], ['a static file', '/']]) {
        const res = await fetch(`http://127.0.0.1:${s.port}${path}`, { signal: AbortSignal.timeout(4000) });
        const csp = res.headers.get('content-security-policy') ?? '';
        check(`${label}: X-Content-Type-Options nosniff`,
              res.headers.get('x-content-type-options') === 'nosniff',
              res.headers.get('x-content-type-options') ?? '(absent)');
        check(`${label}: Referrer-Policy set`,
              res.headers.get('referrer-policy') === 'no-referrer',
              res.headers.get('referrer-policy') ?? '(absent)');
        // The CSP must actually constrain scripts, and must still permit the
        // three things this client genuinely needs.
        check(`${label}: CSP forbids inline script`,
              /script-src [^;]*/.test(csp) && !/script-src [^;]*'unsafe-inline'/.test(csp),
              csp || '(absent)');
        check(`${label}: CSP permits wasm, blob workers and ws:`,
              csp.includes("'wasm-unsafe-eval'") && csp.includes('worker-src') &&
              csp.includes('blob:') && csp.includes('ws:'),
              csp || '(absent)');
    }
    s.kill();
}

console.log('\nsecurity headers — on every response path:');
await checkSecurityHeaders();

// ── the UI-asset cache, and the WAD an operator just added ───────────────────
//
// uiAssets() memoised into `let cached = null` and returned it forever.  Adding
// a WAD to wads/lib -- the documented way to add a game -- changed /api/wads
// (serve.js keys that one on the manifest's mtime) while the launcher's box art
// stayed on the old payload until someone restarted the server, with nothing
// saying so.
//
// The CONTROL arm is the point of this section: "the payload changed" is also
// what you get from a cache that was simply removed, and that would be a
// regression -- this route base64s every TITLEPIC in the library on each call.
// So it asserts both halves: unchanged input returns the identical body, and
// changed input does not.
function makeWad(lumps) {
    const { Buffer } = globalThis;
    const datas = lumps.map(([, b]) => b);
    const total = datas.reduce((n, b) => n + b.length, 0);
    const buf = Buffer.alloc(12 + total + 16 * lumps.length);
    buf.write('IWAD', 0, 'ascii');
    buf.writeInt32LE(lumps.length, 4);
    buf.writeInt32LE(12 + total, 8);
    let o = 12;
    const offsets = [];
    for (const b of datas) { offsets.push(o); b.copy(buf, o); o += b.length; }
    lumps.forEach(([name], i) => {
        const d = 12 + total + 16 * i;
        buf.writeInt32LE(offsets[i], d);
        buf.writeInt32LE(datas[i].length, d + 4);
        buf.write(name.padEnd(8, '\0'), d + 8, 8, 'ascii');
    });
    return buf;
}

async function checkUiAssetCache() {
    const { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, copyFileSync, rmSync, readdirSync } =
        await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { Buffer } = globalThis;

    // a valid w x h patch, every pixel `idx`: header, column offsets, one
    // post per column
    const patch = (w, h, idx) => {
        const buf = Buffer.alloc(8 + 4 * w + w * (h + 5));
        buf.writeUInt16LE(w, 0); buf.writeUInt16LE(h, 2);
        for (let x = 0; x < w; x++) {
            const o = 8 + 4 * w + x * (h + 5);
            buf.writeUInt32LE(o, 8 + 4 * x);
            buf[o] = 0; buf[o + 1] = h; buf.fill(idx, o + 3, o + 3 + h); buf[o + 4 + h] = 0xff;
        }
        return buf;
    };
    const wad = (n, tag) => makeWad([
        ['PLAYPAL',  Buffer.alloc(768, tag)],
        ['M_DOOM',   Buffer.alloc(n, tag)],
        ['M_SKULL1', Buffer.alloc(n, tag)],
        ['M_SKULL2', Buffer.alloc(n, tag)],
        ['TITLEPIC', patch(4, 3, tag)],
    ]);

    const tree = mkdtempSync(join(tmpdir(), 'webdoom-uicache-'));
    let srv = null;
    try {
        mkdirSync(join(tree, 'server'));
        mkdirSync(join(tree, 'wads/lib'), { recursive: true });
        mkdirSync(join(tree, 'client'));
        mkdirSync(join(tree, 'build'));
        for (const f of readdirSync(join(root, 'server')).filter(f => /\.(js|json)$/.test(f)))
            copyFileSync(join(root, 'server', f), join(tree, 'server', f));
        symlinkSync(join(root, 'server/node_modules'), join(tree, 'server/node_modules'));
        writeFileSync(join(tree, 'client/index.html'), '<!doctype html><title>x</title>');

        const setLibrary = files => {
            writeFileSync(join(tree, 'wads/manifest.json'),
                JSON.stringify({ wads: files.map(f => ({ file: f, name: f })) }));
        };
        writeFileSync(join(tree, 'wads/lib/doom.wad'), wad(32, 0x11));
        setLibrary(['doom.wad']);

        const port = PORT_BASE++;
        srv = spawn('node', [join(tree, 'server/serve.js')], {
            env: { ...process.env, DOOM_PORT: String(port), DOOM_HOST: '127.0.0.1' },
            stdio: ['ignore', 'ignore', 'ignore'],
        });
        for (let i = 0; i < 40; i++) { await sleep(100); if (await healthCheck('127.0.0.1', port)) break; }
        const get = async () => {
            const r = await fetch(`http://127.0.0.1:${port}/api/ui-assets`, { signal: AbortSignal.timeout(5000) });
            return r.ok ? await r.text() : `HTTP ${r.status}`;
        };

        const a = await get();
        check('ui-assets: the synthetic library is served at all',
              a.includes('doom.wad') && a.includes('PLAYPAL'), `${a.length} bytes`);

        const b = await get();
        check('ui-assets CONTROL: an unchanged library returns the identical body',
              b === a, b === a ? `${b.length} bytes, byte-identical` : 'body changed with no input change');

        // A WAD ADDED to the library.
        writeFileSync(join(tree, 'wads/lib/extra.wad'), wad(48, 0x22));
        setLibrary(['doom.wad', 'extra.wad']);
        const c = await get();
        check('ui-assets: a WAD added to wads/lib appears without a restart',
              c !== a && c.includes('extra.wad'),
              c === a ? 'identical body — still the startup cache' : `${c.length} bytes, extra.wad present`);

        // box art is per file and lazy: 768 bytes of PLAYPAL + 80x60 indices
        const thumb = async f => {
            const r = await fetch(`http://127.0.0.1:${port}/api/thumb/${f}`, { signal: AbortSignal.timeout(5000) });
            return { status: r.status, bytes: Buffer.from(await r.arrayBuffer()), etag: r.headers.get('etag') };
        };
        const t1 = await thumb('doom.wad');
        check('thumb: /api/thumb/doom.wad is PLAYPAL + 80x60 indices',
              t1.status === 200 && t1.bytes.length === 768 + 80 * 60 && t1.bytes[0] === 0x11 && t1.bytes[768] === 0x11,
              `status=${t1.status} ${t1.bytes.length} bytes`);
        check('thumb: it carries an ETag', !!t1.etag, t1.etag ?? '(absent)');
        check('thumb: a name the manifest does not list is 404', (await thumb('nope.wad')).status === 404,
              `status=${(await thumb('nope.wad')).status}`);
        check('thumb: a traversal is refused', (await thumb('..%2Fmanifest.json')).status >= 400,
              `status=${(await thumb('..%2Fmanifest.json')).status}`);
        check('ui-assets: names the games that have art', c.includes('"titles":[') && c.includes('"extra.wad"'),
              'titles array present');

        // A WAD REPLACED IN PLACE: same name, same library, new bytes.  A
        // directory mtime does not move for this; the per-file stamp does.
        writeFileSync(join(tree, 'wads/lib/doom.wad'), wad(64, 0x33));
        const d = await get();
        check('ui-assets: a WAD replaced in place invalidates too',
              d !== c, d === c ? 'identical body — keyed too coarsely' : `${d.length} bytes`);
        const t2 = await thumb('doom.wad');
        check('thumb: a WAD replaced in place invalidates its thumb too',
              t2.status === 200 && t2.bytes[0] === 0x33 && t2.bytes[768] === 0x33 && t2.etag !== t1.etag,
              `palette byte ${t2.bytes[0]?.toString(16)} etag ${t2.etag}`);
    } finally {
        srv?.kill();
        rmSync(tree, { recursive: true, force: true });
    }
}

console.log('\nui-asset cache — an operator adds a WAD, with no restart:');
await checkUiAssetCache();

// ── the wire: negotiated encoding, ETags, 304 ────────────────────────────────
//
// Every shell file, the engine and the UI-asset payload went out uncompressed
// and no-store on every load: ~1.3 MB per cold launcher against ~0.4 MB
// negotiated.  The cases below drive the real server over raw sockets so the
// content-length is the ENCODED length actually on the wire, and decode the
// body themselves -- fetch() would decompress and hide both.
async function checkWire() {
    const { brotliDecompressSync, gunzipSync } = await import('node:zlib');
    const { Buffer } = globalThis;
    const s = spawnServer();
    for (let i = 0; i < 40; i++) { await sleep(100); if (await healthCheck(s.host, s.port)) break; }
    const get = (path, extra = '') => rawHttp(s.host, s.port,
        `GET ${path} HTTP/1.1\r\nHost: ${s.host}:${s.port}\r\nConnection: close\r\n${extra}\r\n`);
    const hdr = (r, name) => (r.headers.match(new RegExp(`^${name}: (.*)$`, 'mi')) ?? [])[1]?.trim() ?? null;
    const bodyBuf = r => Buffer.from(r.body, 'binary');

    // identity, HTTP/1.0 with no Accept-Encoding (the thirteen cases above)
    const plain = await rawHttp(s.host, s.port, makeGet('/', s.host, s.port));
    check('wire: no Accept-Encoding gets identity', plain.status === 200 && !hdr(plain, 'content-encoding')
          && /<!doctype/i.test(plain.body), `status=${plain.status} enc=${hdr(plain, 'content-encoding') ?? 'none'}`);
    check('wire: identity content-length is the body length',
          +hdr(plain, 'content-length') === bodyBuf(plain).length, `${hdr(plain, 'content-length')} vs ${bodyBuf(plain).length}`);

    // br, then gzip, each with the content-length of the ENCODED body
    const br = await get('/', 'Accept-Encoding: br, gzip\r\n');
    let brOk = false;
    try { brOk = brotliDecompressSync(bodyBuf(br)).equals(bodyBuf(plain)); } catch { /* not brotli */ }
    check('wire: br negotiated for /', br.status === 200 && hdr(br, 'content-encoding') === 'br' && brOk,
          `status=${br.status} enc=${hdr(br, 'content-encoding')} decodes-to-identity=${brOk}`);
    check('wire: br content-length is the encoded length',
          +hdr(br, 'content-length') === bodyBuf(br).length && bodyBuf(br).length < bodyBuf(plain).length,
          `${hdr(br, 'content-length')} on the wire vs ${bodyBuf(plain).length} identity`);
    check('wire: Vary: Accept-Encoding on a negotiated response',
          /accept-encoding/i.test(hdr(br, 'vary') ?? ''), hdr(br, 'vary') ?? '(absent)');

    const gz = await get('/js/lobby.js', 'Accept-Encoding: gzip\r\n');
    let gzOk = false;
    try { gzOk = /export|import/.test(gunzipSync(bodyBuf(gz)).toString()); } catch { /* not gzip */ }
    check('wire: gzip negotiated for a script', gz.status === 200 && hdr(gz, 'content-encoding') === 'gzip' && gzOk
          && +hdr(gz, 'content-length') === bodyBuf(gz).length,
          `status=${gz.status} enc=${hdr(gz, 'content-encoding')} len=${hdr(gz, 'content-length')}/${bodyBuf(gz).length}`);

    // the big one: the UI-asset payload
    const ui = await get('/api/ui-assets', 'Accept-Encoding: br\r\n');
    if (ui.status === 200) {
        let parsed = false;
        try { parsed = !!JSON.parse(brotliDecompressSync(bodyBuf(ui)).toString()).lumps; } catch { /* no */ }
        check('wire: /api/ui-assets goes out br and parses back', hdr(ui, 'content-encoding') === 'br' && parsed,
              `${bodyBuf(ui).length} B on the wire, enc=${hdr(ui, 'content-encoding')}`);
    } else {
        check('wire: /api/ui-assets declined (no IWAD here), which is not the thing under test', true, `status=${ui.status}`);
    }

    // ETag: a 304 with no body, per representation
    const etag = hdr(plain, 'etag');
    const rev = await get('/', `If-None-Match: ${etag}\r\n`);
    check('wire: ETag revalidation answers 304 with no body', !!etag && rev.status === 304 && rev.body.length === 0
          && hdr(rev, 'etag') === etag, `etag=${etag} status=${rev.status} body=${rev.body.length}`);
    const cross = await get('/', `If-None-Match: ${etag}\r\nAccept-Encoding: br\r\n`);
    check('wire: the identity ETag does not validate the br representation', cross.status === 200
          && hdr(cross, 'etag') !== etag, `status=${cross.status} etag=${hdr(cross, 'etag')}`);
    const revBr = await get('/', `If-None-Match: ${hdr(br, 'etag')}\r\nAccept-Encoding: br\r\n`);
    check('wire: the br ETag validates the br representation', revBr.status === 304, `status=${revBr.status}`);
    check('wire: shell is no-cache, not no-store, so the 304 can be used',
          /no-cache/.test(hdr(plain, 'cache-control') ?? '') && !/no-store/.test(hdr(plain, 'cache-control') ?? ''),
          hdr(plain, 'cache-control') ?? '(absent)');
    // security headers survive the negotiated path too (they are asserted on the
    // identity path above)
    check('wire: security headers on a negotiated response',
          hdr(br, 'x-content-type-options') === 'nosniff' && !!hdr(br, 'content-security-policy'),
          hdr(br, 'x-content-type-options') ?? '(absent)');
    const alive = await healthCheck(s.host, s.port);
    check('wire: server still up', alive && !s.didCrash(), `alive=${alive}`);
    s.kill();
}

console.log('\nthe wire — negotiated encoding and revalidation:');
await checkWire();

const failed = results.filter(r => !r.ok);
const total = results.length;
console.log(`\n${failed.length
    ? `HTTP FUZZ FAILURES: ${failed.length}/${total}`
    : `PASS — all ${total} http fuzz cases passed`}`);
process.exit(failed.length ? 1 : 0);
