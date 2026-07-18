#!/usr/bin/env node
// Static HTTP path fuzz test (ws-005 companion — exercise the real server).
// Sends malformed / adversarial HTTP paths and verifies:
//   1. No 5xx response (server must not crash on bad input).
//   2. No file outside client/ served (traversal guard holds).
//   3. Server stays up — a subsequent good GET /  returns 200.
//
// All cases derived from ws-005 on-paper analysis in docs/web-scrutiny.md.
// usage: node tools/http-fuzz-test.mjs
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

const failed = results.filter(r => !r.ok);
const total = results.length;
console.log(`\n${failed.length
    ? `HTTP FUZZ FAILURES: ${failed.length}/${total}`
    : `PASS — all ${total} http fuzz cases passed`}`);
process.exit(failed.length ? 1 : 0);
