#!/usr/bin/env node
// HTTP fuzz + abuse test for the demo store endpoint.
// Verifies: caps enforcement, id path-traversal rejection, malformed inputs.
// usage: node tools/demo-store-fuzz-test.mjs
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Caps stated in server/demo-store.js — import as source-of-truth.
// We read them dynamically so the test stays in sync with the policy file.
const { PER_DEMO_CAP, TOTAL_QUOTA, TTL_MS, FRAGMENT_MAX } =
    await import(join(root, 'server/demo-store.js'));

const sleep = ms => new Promise(r => setTimeout(r, ms));

let PORT_BASE = 8880;
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
    const base = `http://127.0.0.1:${port}`;
    return { srv, port, base, kill: () => srv.kill(), didCrash: () => crashed };
}

async function waitReady(port, tries = 20) {
    for (let i = 0; i < tries; i++) {
        await sleep(100);
        const ok = await new Promise(res => {
            const s = createConnection(port, '127.0.0.1');
            s.on('connect', () => { s.destroy(); res(true); });
            s.on('error', () => res(false));
        });
        if (ok) return;
    }
    throw new Error(`server not ready on port ${port}`);
}

// Minimal fetch-like helper using node:http to avoid external deps.
async function request(method, url, body, headers = {}) {
    const { request: httpRequest } = await import('node:http');
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const opts = {
            method,
            hostname: parsed.hostname,
            port: +parsed.port,
            path: parsed.pathname + parsed.search,
            headers: { ...headers },
        };
        if (body) opts.headers['content-length'] = body.length;
        const req = httpRequest(opts, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers,
                body: Buffer.concat(chunks) }));
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

// Minimal valid 1-byte demo header.  Not a real DOOM demo, but well-formed
// enough for the server (which stores bytes as-is without parsing).
function minimalDemo(size) {
    const b = Buffer.alloc(size, 0x00);
    b[0] = 110;  // version
    b[1] = 1;    // skill
    b[2] = 1;    // episode
    b[3] = 1;    // map
    b[b.length - 1] = 0x80;  // DEMOMARKER
    return b;
}

let failures = 0;
let passes = 0;

function ok(label, cond) {
    if (cond) { passes++; console.log(`  PASS  ${label}`); }
    else       { failures++; console.log(`  FAIL  ${label}`); }
}

// ── Test suite ────────────────────────────────────────────────────────────────

console.log('\n── demo-store-fuzz-test: demo store endpoint ───────────────────────');
console.log(`  caps: per-demo=${PER_DEMO_CAP} bytes, total=${TOTAL_QUOTA} bytes, ttl=${TTL_MS}ms`);
console.log(`  fragment-max: ${FRAGMENT_MAX} bytes\n`);

const { srv, base, kill, didCrash } = spawnServer();
await waitReady(PORT_BASE - 1);

try {

// ── 1. Happy-path upload + download ──────────────────────────────────────────

{
    const body = minimalDemo(100);
    const r = await request('POST', `${base}/api/demos?wad=doom.wad`, body,
        { 'content-type': 'application/octet-stream' });
    ok('POST /api/demos 100-byte demo → 201', r.status === 201);
    const j = JSON.parse(r.body);
    ok('response has id (64-char hex)', /^[0-9a-f]{64}$/.test(j.id));
    ok('response size matches', j.size === 100);

    // Download it back
    const g = await request('GET', `${base}/api/demos/${j.id}`);
    ok('GET /api/demos/:id → 200', g.status === 200);
    ok('body round-trips exactly', g.body.equals(body));
    ok('x-demo-wad header present', g.headers['x-demo-wad'] === 'doom.wad');

    // Dedup: uploading same bytes again → same id, 201
    const r2 = await request('POST', `${base}/api/demos`, body,
        { 'content-type': 'application/octet-stream' });
    ok('dedup: same content → same id', JSON.parse(r2.body).id === j.id);
}

// ── 2. Per-demo byte cap (red proof) ─────────────────────────────────────────
//
// The cap is PER_DEMO_CAP bytes.  cap+1 must be rejected with 413.

{
    const oversize = Buffer.alloc(PER_DEMO_CAP + 1, 0xab);
    const r = await request('POST', `${base}/api/demos`, oversize,
        { 'content-type': 'application/octet-stream' });
    ok(`cap+1 byte (${PER_DEMO_CAP + 1} B) → 413`, r.status === 413);
}

{
    // Exactly PER_DEMO_CAP bytes must be accepted.
    const atCap = minimalDemo(PER_DEMO_CAP);
    const r = await request('POST', `${base}/api/demos`, atCap,
        { 'content-type': 'application/octet-stream' });
    ok(`exactly cap (${PER_DEMO_CAP} B) → 201`, r.status === 201);
}

// ── 3. Path traversal in GET id ──────────────────────────────────────────────

const traversalCases = [
    '/api/demos/../../../etc/passwd',
    '/api/demos/..%2F..%2Fetc%2Fpasswd',
    '/api/demos/not-a-hex-id',
    '/api/demos/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',  // uppercase
    '/api/demos/' + 'a'.repeat(63),  // 63 chars (too short)
    '/api/demos/' + 'a'.repeat(65),  // 65 chars (too long)
];
for (const p of traversalCases) {
    const r = await request('GET', `${base}${p}`);
    ok(`path traversal / bad id "${p.slice(0, 30)}…" → 400 or 404`,
        r.status === 400 || r.status === 404);
}

// ── 4. Malformed upload body ──────────────────────────────────────────────────

{
    const empty = Buffer.alloc(0);
    const r = await request('POST', `${base}/api/demos`, empty,
        { 'content-type': 'application/octet-stream' });
    // Empty body (0 bytes) is technically valid and should be accepted.
    ok('empty body (0 bytes) → 201', r.status === 201);
}

{
    // Random garbage bytes — server stores as-is (no content validation).
    const garbage = Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x02, 0xcc]);
    const r = await request('POST', `${base}/api/demos`, garbage,
        { 'content-type': 'application/octet-stream' });
    ok('garbage bytes → 201 (server stores as-is)', r.status === 201);
}

// ── 5. Wrong method on demo id endpoint ──────────────────────────────────────

{
    const valid64 = '0'.repeat(64);
    const r = await request('POST', `${base}/api/demos/${valid64}`, Buffer.alloc(1));
    ok('POST /api/demos/:id → 405', r.status === 405);
}

// ── 6. Verify endpoint: happy path + fuzz (task 19.4) ────────────────────────
//
// POST /api/demos/:id/verify accepts a JSON attestation {tics, trace}.
// GET  /api/demos/:id/verify returns the stored attestation.
// The tests cover: happy path, bad id format/traversal, oversized body (413),
// rate limit under concurrency (429), and wrong method (405).

let verifyId;
{
    // Upload a valid demo to get an id for the verify endpoint tests.
    const body = minimalDemo(100);
    const r = await request('POST', `${base}/api/demos?wad=doom.wad`, body,
        { 'content-type': 'application/octet-stream' });
    verifyId = JSON.parse(r.body).id;
}

{
    // Happy path: POST valid attestation → 200.
    const attest = JSON.stringify({ tics: 5, trace: [1, 2, 3, 4, 5] });
    const r = await request('POST', `${base}/api/demos/${verifyId}/verify`,
        Buffer.from(attest), { 'content-type': 'application/json' });
    ok('POST /api/demos/:id/verify (valid) → 200', r.status === 200);
    const j = JSON.parse(r.body);
    ok('verify response has stored: true', j.stored === true);
    ok('verify response has id', j.id === verifyId);
}

{
    // GET stored attestation → 200 with trace.
    const r = await request('GET', `${base}/api/demos/${verifyId}/verify`);
    ok('GET /api/demos/:id/verify → 200', r.status === 200);
    const j = JSON.parse(r.body);
    ok('GET verify returns tics', j.tics === 5);
    ok('GET verify returns trace array', Array.isArray(j.trace) && j.trace.length === 5);
}

{
    // Non-existent demo id → 404.
    const fakeId = 'a'.repeat(64);
    const attest = JSON.stringify({ tics: 1, trace: [42] });
    const r = await request('POST', `${base}/api/demos/${fakeId}/verify`,
        Buffer.from(attest), { 'content-type': 'application/json' });
    ok('POST verify for unknown demo → 404', r.status === 404);
}

{
    // Bad id format (traversal attempt) → 400.
    const r = await request('POST', `${base}/api/demos/../../../etc/passwd/verify`,
        Buffer.from('{}'), { 'content-type': 'application/json' });
    ok('path traversal /verify → 400 or 404', r.status === 400 || r.status === 404);
}

{
    // Oversized attestation body → 413.
    // ATTEST_BODY_CAP is 4 MiB; send 4 MiB + 1 byte.
    const oversized = Buffer.alloc(4_194_305, 0x20);  // spaces (invalid JSON)
    const r = await request('POST', `${base}/api/demos/${verifyId}/verify`,
        oversized, { 'content-type': 'application/json' });
    ok('oversized attestation body → 413', r.status === 413);
}

{
    // Invalid JSON body → 400.
    const r = await request('POST', `${base}/api/demos/${verifyId}/verify`,
        Buffer.from('not json'), { 'content-type': 'application/json' });
    ok('invalid JSON attestation → 400', r.status === 400);
}

{
    // Attestation with u32-out-of-range value → 400.
    const bad = JSON.stringify({ tics: 1, trace: [-1] });
    const r = await request('POST', `${base}/api/demos/${verifyId}/verify`,
        Buffer.from(bad), { 'content-type': 'application/json' });
    ok('out-of-range trace value → 400', r.status === 400);
}

{
    // Rate limit: use a raw TCP connection to hold the server's verifyInFlight
    // flag open.  Send only the HTTP request line + headers on the first
    // connection (no body, so 'end' never fires and the flag stays true), then
    // send a second complete request and verify it gets 429.  Finally close the
    // first socket to release the server.
    //
    // Content-Length is set to a non-zero value so the server knows the request
    // has a body (and waits for it), keeping verifyInFlight=true.
    const { createConnection } = await import('node:net');
    const got429 = await new Promise((resolve) => {
        // Connection 1: send headers only — body never arrives, flag stays open.
        const sock1 = createConnection(PORT_BASE - 1, '127.0.0.1');
        sock1.once('connect', async () => {
            const fakeBody = '{"tics":1,"trace":[1]}';
            sock1.write(
                `POST /api/demos/${verifyId}/verify HTTP/1.1\r\n` +
                `Host: 127.0.0.1\r\n` +
                `Content-Type: application/json\r\n` +
                `Content-Length: ${fakeBody.length}\r\n` +
                `Connection: close\r\n` +
                `\r\n`
                // intentionally NOT sending the body
            );
            // Give the server one tick to process the headers + set verifyInFlight.
            await sleep(10);

            // Connection 2: full request — must get 429 (flag still set).
            const body2 = Buffer.from('{"tics":1,"trace":[42]}');
            const r2 = await request('POST',
                `http://127.0.0.1:${PORT_BASE - 1}/api/demos/${verifyId}/verify`,
                body2, { 'content-type': 'application/json' });
            sock1.destroy();
            resolve(r2.status === 429);
        });
        sock1.once('error', () => resolve(false));
    });
    ok('concurrent verify → 429 when verifyInFlight (rate limit)', got429);
}

{
    // Wrong method (DELETE) → 405.
    const r = await request('DELETE', `${base}/api/demos/${verifyId}/verify`, Buffer.alloc(0));
    ok('DELETE /api/demos/:id/verify → 405', r.status === 405);
}

// ── 7. Server stays healthy after all attacks ─────────────────────────────────

{
    const probe = minimalDemo(50);
    const r = await request('POST', `${base}/api/demos`, probe,
        { 'content-type': 'application/octet-stream' });
    ok('server healthy after attacks: 201', r.status === 201);
}

ok('server did not crash', !didCrash());

} finally {
    kill();
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n  ${passes} passed, ${failures} failed`);
if (failures) {
    console.log(`demo-store-fuzz-test: ${failures} failure(s)`);
    process.exit(1);
}
console.log('PASS — demo-store-fuzz-test: all demo store checks green');
process.exit(0);
