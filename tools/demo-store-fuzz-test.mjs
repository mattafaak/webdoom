#!/usr/bin/env node
// HTTP fuzz + abuse test for the demo store endpoint.
// Verifies: caps enforcement, id path-traversal rejection, malformed inputs.
// usage: node tools/demo-store-fuzz-test.mjs
import { startServer } from './lib/server.mjs';
import { createConnection } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Caps stated in server/demo-store.js — import as source-of-truth.
// We read them dynamically so the test stays in sync with the policy file.
const { PER_DEMO_CAP, TOTAL_QUOTA, TTL_MS, FRAGMENT_MAX } =
    await import(join(root, 'server/demo-store.js'));

const sleep = ms => new Promise(r => setTimeout(r, ms));

// a server on a free port, ready when it answers (tools/lib/server.mjs)
async function spawnServer(extraEnv = {}) {
    let crashed = false;
    const s = await startServer({ env: extraEnv, onStderr: t => {
        if (/Error:|at Object\.|at Module\.|UnhandledPromise/.test(t)) crashed = true;
    } });
    return { srv: s.proc, port: s.port, base: `http://127.0.0.1:${s.port}`, kill: s.stop, didCrash: () => crashed };
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

const { srv, base, kill, didCrash } = await spawnServer();

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

// ── 7. Demos are RECLAIMED: eviction and expiry both execute ────────────────
//
// This section was written for task A3, when a second store lived beside
// `store` holding per-tic attestations and all three demo-deletion sites --
// gcExpired(), evictOldest() and getDemo()'s expiry branch -- left the
// attestation behind.  That store is gone (its endpoint had no product caller),
// and with it the four assertions about reclaiming traces.
//
// What must NOT go with it is the half that proves the DEMO store is bounded:
// nothing else in this suite drives eviction or the TTL sweep.  Deleting the
// section wholesale because its headline feature was removed would have taken
// the quota and expiry coverage with it.
//
// Driven against a real server with a small quota and a 1 s TTL, so both the
// eviction path and the expiry path actually execute rather than being
// asserted by inspection.
{
    const QUOTA = 24_000;                 // bytes of demo; ~3 x 8 KB demos
    const s2 = await spawnServer({
        WEBDOOM_DEMO_QUOTA: String(QUOTA),
        WEBDOOM_DEMO_TTL_MS: '1000',
    });
    try {
        const stats = async () => JSON.parse((await request('GET', `${s2.base}/api/demos/stats`)).body);
        const upload = async (n) => {
            const r = await request('POST', `${s2.base}/api/demos?wad=doom.wad`, minimalDemo(n),
                { 'content-type': 'application/octet-stream' });
            return JSON.parse(r.body).id;
        };
        const probe = await stats();
        ok('GET /api/demos/stats reports the demo store', typeof probe.usedBytes === 'number');

        // --- eviction: fill past the demo quota and watch the oldest go
        const first = await upload(8_000);
        const afterFirst = await stats();
        ok('the first demo is accounted (bytes > 0)', afterFirst.usedBytes >= 8_000);

        for (let i = 1; i <= 5; i++) await upload(8_000 + i);
        const afterFill = await stats();
        ok('demo store stayed inside its quota', afterFill.usedBytes <= QUOTA);
        ok('the evicted demo is gone from the API',
           (await request('GET', `${s2.base}/api/demos/${first}`)).status === 404);

        // --- expiry: the TTL path is the other half, and it was equally blind
        await sleep(1200);
        const afterTtl = await stats();
        ok('expired demos are swept', afterTtl.count === 0);
        ok('expired demos free their bytes', afterTtl.usedBytes === 0);
        ok('no crash across the reclamation suite', !s2.didCrash());
    } finally {
        s2.kill();
    }
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n  ${passes} passed, ${failures} failed`);
if (failures) {
    console.log(`demo-store-fuzz-test: ${failures} failure(s)`);
    process.exit(1);
}
console.log(`PASS — demo-store-fuzz-test: ${passes} demo store checks green`);
process.exit(0);
