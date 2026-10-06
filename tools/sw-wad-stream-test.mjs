#!/usr/bin/env node
// client/sw.js's handlers, run as written.  For a WAD it has not cached:
//
//   1. the page gets its response while the download is still arriving, so
//      the loading bar can move (it used to wait for the last byte of a
//      12-18 MB file before answering);
//   2. once the download completes, the WAD is in the cache and a second
//      request is served from it;
//   3. a cache write that fails does not fail the download.
//
// And across an update (the same file with its SHELL constant one version
// lower, then as shipped):
//
//   4. what the launcher reads to start (/api/wads) survives the new worker's
//      activate, so the next offline visit still has a game list;
//   5. a worker from before the API cache kept those reads in its shell cache,
//      and the update carries them over rather than deleting them with it.
//
// The worker's globals (self, caches, fetch) are stand-ins; the handlers are
// the shipped file's.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, sleep } from './lib/util.mjs';
import { check, summary, fatal } from './lib/report.mjs';

const source = readFileSync(join(root, 'client/sw.js'), 'utf8');
const ORIGIN = 'http://127.0.0.1:8666';

// Named caches shared by every worker built on them, as the browser's are
// across an update.  match() honours ignoreSearch, which the shell's offline
// fallback uses.
function cacheStorage({ putFails = false } = {}) {
    const named = new Map();
    const url = r => typeof r === 'string' ? r : r.url;
    const bare = u => { const x = new URL(u); x.search = ''; return x.href; };
    const find = (store, r, o) => o?.ignoreSearch
        ? [...store].find(([k]) => bare(k) === bare(url(r)))?.[1]
        : store.get(url(r));
    const open = async name => {
        if (!named.has(name)) {
            const store = new Map();
            named.set(name, {
                store,
                match: async (r, o) => find(store, r, o)?.clone(),
                keys: async () => [...store.keys()].map(u => new Request(u)),
                delete: async r => store.delete(url(r)),
                put: async (r, res) => {
                    if (putFails) throw new DOMException('quota', 'QuotaExceededError');
                    store.set(url(r), res);
                },
                add: async () => {},
            });
        }
        return named.get(name);
    };
    return {
        named,
        open,
        keys: async () => [...named.keys()],
        delete: async name => named.delete(name),
        match: async (r, o) => {
            for (const c of named.values()) { const hit = find(c.store, r, o); if (hit) return hit.clone(); }
            return undefined;
        },
    };
}

// The shipped file with its SHELL constant set to `version` (the shipped one
// when omitted), on `caches`, answering from `network`.
const SHELL_RE = /const SHELL = 'webdoom-shell-v(\d+)';/;
const SHIPPED = +(SHELL_RE.exec(source)?.[1] ?? fatal('sw.js carries no `const SHELL = \'webdoom-shell-vN\'`'));
function worker({ caches = cacheStorage(), network, version = SHIPPED } = {}) {
    const src = source.replace(SHELL_RE, `const SHELL = 'webdoom-shell-v${version}';`);
    const handlers = {};
    const self = { addEventListener: (t, f) => { handlers[t] = f; }, skipWaiting: async () => {}, clients: { claim: async () => {} } };
    const env = { self, caches, fetch: network, location: new URL(ORIGIN), console: { warn() {} } };
    new Function(...Object.keys(env), src)(...Object.values(env));
    const request = url => {
        let responded, waits = [];
        handlers.fetch({ request: new Request(ORIGIN + url), respondWith: p => { responded = p; }, waitUntil: p => waits.push(p) });
        return { responded, waits };
    };
    const activate = async () => {
        let done;
        handlers.activate({ waitUntil: p => { done = p; } });
        await done;
    };
    return { request, activate, caches };
}

// every download sends its first chunk at once and the rest when the test
// opens the gate
function gatedNetwork() {
    let release;
    const gate = new Promise(r => { release = r; });
    const network = async () => new Response(new ReadableStream({
        async start(ctl) { ctl.enqueue(new Uint8Array(1024)); await gate; ctl.enqueue(new Uint8Array(1024)); ctl.close(); },
    }), { status: 200, headers: { 'content-length': '2048' } });
    return { network, release };
}

const timeout = (p, ms) => Promise.race([p, sleep(ms).then(() => 'timeout')]);

{
    const { network, release } = gatedNetwork();
    const w = worker({ network });
    const { responded, waits } = w.request('/wads/doom.wad?v=abc12345');
    const res = await timeout(responded, 500);
    check('the page gets the WAD response before the download completes', res instanceof Response);
    release();
    const late = res instanceof Response ? res : await responded;     // the old handler answers only now
    const body = await late.arrayBuffer();
    check('and reads the whole file from it', body?.byteLength === 2048, `${body?.byteLength} bytes`);
    await Promise.all(waits);
    check('the completed download is cached', w.caches.named.get('webdoom-wads-v1')?.store.has(ORIGIN + '/wads/doom.wad?v=abc12345'));
    const again = await w.request('/wads/doom.wad?v=abc12345').responded;
    check('a second request is served from the cache', (await again.arrayBuffer()).byteLength === 2048);
}
{
    const { network, release } = gatedNetwork();
    const w = worker({ network, caches: cacheStorage({ putFails: true }) });
    const { responded, waits } = w.request('/wads/doom.wad?v=abc12345');
    release();
    const body = await (await responded).arrayBuffer();
    await Promise.allSettled(waits);
    check('a cache write that fails does not fail the download', body?.byteLength === 2048);
}

// ── an update, then an offline visit ─────────────────────────────────────────
const WADS_JSON = JSON.stringify({ wads: [{ file: 'doom.wad', sha256: 'f'.repeat(64) }] });
const online = async () => new Response(WADS_JSON, { status: 200, headers: { 'content-type': 'application/json' } });
const offline = async () => { throw new TypeError('Failed to fetch'); };
// what an offline visit gets for /api/wads: the body, or why there is none
const offlineGameList = async w => {
    const r = await w.request('/api/wads').responded.catch(e => e);
    if (!(r instanceof Response)) return `no response (${r?.message ?? r})`;
    return await r.text();
};
{
    const caches = cacheStorage();
    const before = worker({ caches, network: online, version: SHIPPED - 1 });
    await before.activate();
    const first = await before.request('/api/wads').responded;
    check('CONTROL: online, the old worker answers /api/wads from the network', (await first.text()) === WADS_JSON);
    await sleep(50);            // the cache write is not awaited by the handler
    const offlineBefore = await offlineGameList(worker({ caches, network: offline, version: SHIPPED - 1 }));
    check('CONTROL: offline before the update, /api/wads comes from the cache', offlineBefore === WADS_JSON,
          `got ${offlineBefore.slice(0, 60)}`);

    const after = worker({ caches, network: offline });
    await after.activate();
    const left = [...caches.named.keys()];
    check(`the update drops the old shell cache (${left.join(', ')})`, !left.includes(`webdoom-shell-v${SHIPPED - 1}`));
    const got = await offlineGameList(after);
    check(`offline after the v${SHIPPED - 1} -> v${SHIPPED} update, /api/wads still answers`, got === WADS_JSON,
          `got ${got.slice(0, 60)}: the launcher would fail with "cannot reach server"`);
}
{
    // a worker from before the API cache: the game list sits in its shell cache
    const caches = cacheStorage();
    const oldShell = await caches.open(`webdoom-shell-v${SHIPPED - 1}`);
    await oldShell.put(new Request(ORIGIN + '/api/wads'), await online());
    await oldShell.put(new Request(ORIGIN + '/js/main.js'), new Response('// old'));
    const after = worker({ caches, network: offline });
    await after.activate();
    const got = await offlineGameList(after);
    check('an update from a worker that kept /api/wads in its shell carries it over', got === WADS_JSON,
          `got ${got.slice(0, 60)}`);
    const api = caches.named.get('webdoom-api-v1');
    check('and carries over only the launcher\'s reads, not the old shell files',
          !!api && [...api.store.keys()].every(u => new URL(u).pathname.startsWith('/api/')),
          `api cache holds ${api ? [...api.store.keys()].join(', ') : 'nothing'}`);
}
summary('the service worker streams a WAD to the page and caches it behind, and an update keeps the launcher\'s API reads',
        { min: 11 });
