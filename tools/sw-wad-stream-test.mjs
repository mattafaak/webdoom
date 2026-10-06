#!/usr/bin/env node
// client/sw.js's fetch handler, run as written, for a WAD it has not cached:
//
//   1. the page gets its response while the download is still arriving, so
//      the loading bar can move (it used to wait for the last byte of a
//      12-18 MB file before answering);
//   2. once the download completes, the WAD is in the cache and a second
//      request is served from it;
//   3. a cache write that fails does not fail the download.
//
// The worker's globals (self, caches, fetch) are stand-ins; the handler is the
// shipped file's.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, sleep } from './lib/util.mjs';
import { check, summary } from './lib/report.mjs';

const source = readFileSync(join(root, 'client/sw.js'), 'utf8');
const ORIGIN = 'http://127.0.0.1:8666';

function worker({ putFails = false } = {}) {
    const handlers = {};
    const store = new Map();
    const cache = {
        match: async url => store.get(String(url))?.clone() ?? undefined,
        keys: async () => [...store.keys()].map(u => ({ url: u })),
        delete: async u => store.delete(String(u)),
        put: async (u, r) => { if (putFails) throw new DOMException('quota', 'QuotaExceededError'); store.set(String(u), r); },
    };
    // every download sends its first chunk at once and the rest when the
    // test opens the gate
    let release;
    const gate = new Promise(r => { release = r; });
    const network = async () => new Response(new ReadableStream({
        async start(ctl) { ctl.enqueue(new Uint8Array(1024)); await gate; ctl.enqueue(new Uint8Array(1024)); ctl.close(); },
    }), { status: 200, headers: { 'content-length': '2048' } });
    const self = { addEventListener: (t, f) => { handlers[t] = f; }, skipWaiting: async () => {}, clients: { claim: async () => {} } };
    const env = { self, caches: { open: async () => cache, keys: async () => [], match: async () => undefined, delete: async () => true },
                  fetch: network, location: new URL(ORIGIN), console: { warn() {} } };
    new Function(...Object.keys(env), source)(...Object.values(env));
    const request = url => {
        let responded, waits = [];
        handlers.fetch({ request: new Request(ORIGIN + url), respondWith: p => { responded = p; }, waitUntil: p => waits.push(p) });
        return { responded, waits };
    };
    return { request, store, release };
}

const timeout = (p, ms) => Promise.race([p, sleep(ms).then(() => 'timeout')]);

{
    const w = worker();
    const { responded, waits } = w.request('/wads/doom.wad?v=abc12345');
    const res = await timeout(responded, 500);
    check('the page gets the WAD response before the download completes', res instanceof Response);
    w.release();
    const late = res instanceof Response ? res : await responded;     // the old handler answers only now
    const body = await late.arrayBuffer();
    check('and reads the whole file from it', body?.byteLength === 2048, `${body?.byteLength} bytes`);
    await Promise.all(waits);
    check('the completed download is cached', w.store.has(ORIGIN + '/wads/doom.wad?v=abc12345'));
    const again = await w.request('/wads/doom.wad?v=abc12345').responded;
    check('a second request is served from the cache', (await again.arrayBuffer()).byteLength === 2048);
}
{
    const w = worker({ putFails: true });
    const { responded, waits } = w.request('/wads/doom.wad?v=abc12345');
    w.release();
    const body = await (await responded).arrayBuffer();
    await Promise.allSettled(waits);
    check('a cache write that fails does not fail the download', body?.byteLength === 2048);
}
summary('the service worker streams a WAD to the page and caches it behind');
