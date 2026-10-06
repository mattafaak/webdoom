#!/usr/bin/env node
// HTTP fuzz + abuse test for the demo store endpoint.
// Verifies: caps enforcement, id path-traversal rejection, malformed inputs.
// usage: node tools/demo-store-fuzz-test.mjs
import { startServer } from './lib/server.mjs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { root } from './lib/util.mjs';

// Caps stated in server/demo-store.js — import as source-of-truth.
// We read them dynamically so the test stays in sync with the policy file.
const { PER_DEMO_CAP, TOTAL_QUOTA, TTL_MS, FRAGMENT_MAX, RECORD_OVERHEAD } =
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

// ── 8. An upload costs the same whether or not the store is full ─────────────
//
// Eviction sorted the whole store by expiry on every upload past the quota,
// and the TTL sweep scanned every record on every upload: O(n log n) per
// upload on the one thread that also runs the tic relay.  Every record gets
// the same TTL, so upload order IS expiry order, and both can take from the
// front.  Driven through the real HTTP route with a quota of 20,000 tiny
// demos: 1,000 uploads timed while the store is filling, 1,000 more timed
// while every one of them evicts.  The bodies are distinct 4-byte counters.
//
// A dedup refresh must move a demo to the back of that order, or the oldest
// position would evict a demo whose TTL was just renewed: X is re-uploaded
// before the store wraps round to it, and must outlive Y, uploaded after it.
{
    const { Agent, request: httpRequest } = await import('node:http');
    const N = 20_000;
    const s3 = await spawnServer({ WEBDOOM_DEMO_QUOTA: String(N * (4 + RECORD_OVERHEAD)) });
    const agent = new Agent({ keepAlive: true, maxSockets: 16 });
    const post = body => new Promise((res, rej) => {
        const r = httpRequest({ agent, method: 'POST', hostname: '127.0.0.1', port: s3.port,
                                path: '/api/demos', headers: { 'content-length': body.length } }, rs => {
            const c = []; rs.on('data', d => c.push(d));
            rs.on('end', () => res({ status: rs.statusCode, id: JSON.parse(Buffer.concat(c) || '{}').id }));
        });
        r.on('error', rej); r.end(body);
    });
    let k = 0;
    const counter = () => { const b = Buffer.alloc(4); b.writeUInt32LE(k++, 0); return b; };
    const upload = async n => {                 // n uploads, 16 in flight; returns ms and the ids
        const ids = [], t0 = performance.now();
        for (let i = 0; i < n; i += 16)
            for (const r of await Promise.all(Array.from({ length: Math.min(16, n - i) }, () => post(counter()))))
                ids.push(r.status === 201 ? r.id : null);
        return { ms: performance.now() - t0, ids };
    };
    const status = async id => (await request('GET', `${s3.base}/api/demos/${id}`)).status;
    try {
        const warm = await upload(1000);
        const filling = await upload(1000);
        const X = (await post(Buffer.from('X'))).id;
        const Y = (await post(Buffer.from('Y'))).id;
        await upload(N - 2002);                 // the store is now full
        await post(Buffer.from('X'));           // refresh X: it moves to the back
        const evicting = await upload(1000);
        const tail = await upload(1500);        // wraps past X's old position
        const st = JSON.parse((await request('GET', `${s3.base}/api/demos/stats`)).body);
        const all201 = [warm, filling, evicting, tail].every(u => u.ids.every(Boolean));
        ok(`every upload answered 201 (${k} uploads)`, all201);
        console.log(`  ${filling.ms.toFixed(0)} ms for 1,000 uploads filling, ` +
                    `${evicting.ms.toFixed(0)} ms for 1,000 that each evict`);
        ok('an upload that evicts costs no more than one that does not (within 3x + 100 ms)',
           evicting.ms < 3 * filling.ms + 100);
        ok(`the store holds its quota of ${N} demos`, st.count === N);
        ok('the oldest demo was evicted first', await status(warm.ids[0]) === 404);
        ok('the newest demo is still served', await status(tail.ids.at(-1)) === 200);
        ok('a refreshed demo outlives the one uploaded after it',
           await status(X) === 200 && await status(Y) === 404);
        ok('no crash across the eviction-cost suite', !s3.didCrash());
    } finally {
        agent.destroy();
        s3.kill();
    }
}

// ── 9. The WAD hint, and the bytes held by uploads still arriving ───────────
//
// `?wad=` is stored beside the demo and returned in the x-demo-wad header, so
// a value writeHead rejects -- CR/LF, a character above U+00FF -- was accepted
// with 201 and then threw on every GET, which never answered.  Every id the
// POST hands out must be fetchable.  Latin-1 is a header's own charset: a
// local WAD imported as "café.wad" round-trips today and must keep doing so.
//
// Bodies are buffered whole, so uploads still arriving hold memory: with a
// 1 KiB per-demo cap the in-flight budget is 16 KiB, and twenty uploads that
// each send 1,000 of their 1,024 bytes and stall must not all be held.
{
    const s4 = await spawnServer({ WEBDOOM_DEMO_CAP: '1024' });
    const getWithin = (id, ms) => Promise.race([
        request('GET', `${s4.base}/api/demos/${id}`),
        sleep(ms).then(() => ({ status: 'no answer' })),
    ]);
    try {
        const HOSTILE = [['CJK name (above U+00FF)', '%E6%97%A5%E6%9C%AC.wad'], ['CR/LF', 'a%0D%0Ax-evil:%201'],
                         ['a control character', 'a%07b.wad'], ['65 characters', 'a'.repeat(61) + '.wad']];
        for (const [label, q] of HOSTILE) {
            const up = await request('POST', `${s4.base}/api/demos?wad=${q}`, minimalDemo(20 + label.length));
            const got = up.status === 201 ? await getWithin(JSON.parse(up.body).id, 1000) : null;
            ok(`wad hint with ${label}: refused at upload, not stored to hang its GET ` +
               `(POST ${up.status}${got ? `, GET ${got.status}` : ''})`, up.status === 400);
        }
        const latin1 = await request('POST', `${s4.base}/api/demos?wad=caf%C3%A9.wad`, minimalDemo(40));
        const back = latin1.status === 201 ? await getWithin(JSON.parse(latin1.body).id, 1000) : { status: 'none' };
        ok(`CONTROL: a Latin-1 WAD name is stored and round-trips (POST ${latin1.status}, GET ${back.status}, ` +
           `x-demo-wad ${JSON.stringify(back.headers?.['x-demo-wad'])})`,
           back.status === 200 && back.headers['x-demo-wad'] === 'café.wad');

        const stalled = [];
        let refusedNow = 0;
        for (let i = 0; i < 20; i++) {
            const sock = createConnection(s4.port, '127.0.0.1');
            sock.on('error', () => {});
            sock.on('data', d => { if (/^HTTP\/1\.1 503/.test(String(d))) refusedNow++; });
            await new Promise(r => sock.once('connect', r));
            sock.write(`POST /api/demos HTTP/1.1\r\nHost: x\r\nContent-Length: 1024\r\n\r\n`);
            sock.write(Buffer.alloc(1000, i));
            stalled.push(sock);
        }
        await sleep(500);
        ok(`uploads in flight are capped: ${refusedNow} of 20 stalled uploads refused at once (want 4)`,
           refusedNow === 4);
        for (const sock of stalled) sock.destroy();
        await sleep(200);
        const after = await request('POST', `${s4.base}/api/demos`, minimalDemo(900));
        ok(`the budget comes back when stalled uploads go away (POST ${after.status})`, after.status === 201);
        ok('no crash across the wad-hint and in-flight suite', !s4.didCrash());
    } finally {
        s4.kill();
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
