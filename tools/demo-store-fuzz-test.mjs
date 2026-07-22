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

// ── 6. Server stays healthy after all attacks ─────────────────────────────────

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
