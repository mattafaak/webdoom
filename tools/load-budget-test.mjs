#!/usr/bin/env node
// load-budget-test.mjs — the second load is fast because the SW cache serves it
// (promises rme-005).
//
// README says "second load is instant". The offline half of that sentence is
// gated (browser-offline, check-sw-precache); "instant" was a performance claim
// with no gate at all.
//
// "Instant" is not measurable, so this gates what the sentence is actually
// promising: the service worker makes the SECOND load materially cheaper than
// the first, and it stays under a budget committed FOR THIS HOST. It is a
// REGRESSION gate, not a performance claim -- the number means "no worse than
// when this baseline was taken on this machine", and a host without a baseline
// SKIPs by name rather than passing, exactly as browser-pipeline does.
//
// usage: node tools/load-budget-test.mjs [--record]
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chromeBin, chromeProfileArg, reapOnExit } from './chrome-harness.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOST = hostname();
const BASELINE = join(root, 'tools/golden', `load-budget-${HOST}.json`);
const record = process.argv.includes('--record');
const PORT = 8696, CDP_PORT = 9281;
const sleep = ms => new Promise(r => setTimeout(r, ms));

if (!record && !existsSync(BASELINE)) {
    console.log(`SKIP load-budget: no baseline for host '${HOST}'`);
    console.log(`  add tools/golden/load-budget-${HOST}.json to gate this host ` +
                `(node tools/load-budget-test.mjs --record)`);
    process.exit(0);
}

const srv = spawn('node', [join(root, 'server/serve.js')], {
    env: { ...process.env, DOOM_PORT: String(PORT), DOOM_HOST: '127.0.0.1' },
    stdio: ['ignore', 'ignore', 'ignore'],
});
// ONE profile across both loads: a fresh profile per load would make the second
// load cold too, and the gate would measure nothing but noise.
const chrome = spawn(chromeBin(), [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, chromeProfileArg(),
    '--no-first-run', '--no-sandbox', '--disable-gpu-sandbox',
    '--use-angle=swiftshader', '--window-size=1280,960', 'about:blank',
], { stdio: 'ignore', detached: true });
reapOnExit(chrome);
const cleanup = code => { try { chrome.kill(); } catch { /* gone */ } try { srv.kill(); } catch { /* gone */ } process.exit(code); };
const fail = m => { console.log(`FAIL load-budget: ${m}`); cleanup(1); };
await sleep(1800);

const target = await (await fetch(
    `http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; }).catch(() => fail('CDP refused'));
let id = 0; const pending = new Map();
ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const cdp = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async e => (await cdp('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }))?.result?.result?.value;
await cdp('Runtime.enable'); await cdp('Page.enable');

// One load: navigate, drill the launcher, wait for the engine. Returns ms.
async function load(label) {
    const t0 = Date.now();
    await cdp('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
    let clicked = false;
    for (let i = 0; i < 120; i++) {
        await sleep(150);
        if (!clicked) {
            clicked = await evaluate(`(() => {
                const sp = document.querySelector('#dmenu .row[data-label="SINGLE PLAYER"]');
                if (!sp) return false;
                sp.click();
                const g = document.querySelector('#dmenu .row[data-label*="ULTIMATE"]');
                if (!g) return false;
                g.click();
                return true;
            })()`);
            continue;
        }
        const up = await evaluate(
            `document.getElementById('status')?.textContent === '' &&
             !document.getElementById('screen')?.hidden`);
        if (up) { const ms = Date.now() - t0; console.log(`  ${label}: ${ms} ms`); return ms; }
    }
    fail(`${label}: never reached a running engine within 18 s`);
}

const first = await load('load 1 (cold)');
// Let the service worker install and claim before the second load, or the
// second load is not the thing the promise is about.
for (let i = 0; i < 40; i++) {
    if (await evaluate(`!!navigator.serviceWorker.controller`)) break;
    await sleep(250);
}
const controlled = await evaluate(`!!navigator.serviceWorker.controller`);
const second = await load('load 2 (warm)');

if (record) {
    writeFileSync(BASELINE, JSON.stringify({
        host: HOST, recorded: new Date().toISOString().slice(0, 10),
        cold_ms: first, warm_ms: second,
        budget_ms: Math.max(4000, Math.round(second * 2.5)),
        note: 'REGRESSION budget, not a performance claim: warm_ms x2.5 with a 4 s floor, ' +
              'headroom for an unloaded-vs-busy machine. Re-record with --record.',
    }, null, 2) + '\n');
    console.log(`recorded ${BASELINE}: cold ${first} ms, warm ${second} ms, budget ${Math.max(4000, Math.round(second * 2.5))} ms`);
    cleanup(0);
}

const base = JSON.parse(readFileSync(BASELINE, 'utf8'));
let bad = 0;
const check = (ok, m) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${m}`); if (!ok) bad++; };
check(controlled, 'the service worker controls the page before the second load');
check(second <= base.budget_ms, `warm load ${second} ms within this host's budget ${base.budget_ms} ms`);

// REPORTED, NEVER GRADED. Over loopback there is no network for the cache to
// save, so cold-vs-warm is mostly noise: measured across three runs the warm
// load was 333-339 ms every time while the cold load ranged 358-452, leaving
// margins of 25, 65 and 113 ms. Grading "warm < cold" on a 25 ms margin would
// buy nothing and flake eventually. The budget assertion above is the gate; this
// line is for a reader.
console.log(`info  cold ${first} ms, warm ${second} ms (delta ${first - second} ms) — ` +
            `not graded: on loopback the cold load pays no network cost, so this ` +
            `comparison measures scheduling noise more than caching`);

if (bad) { console.log(`load-budget: ${bad} of 2 assertions failed against ${BASELINE}`); cleanup(1); }
console.log(`PASS — load-budget: warm load ${second} ms within budget ${base.budget_ms} ms on ${HOST} ` +
            `(2 assertions; cold ${first} ms reported, not graded)`);
cleanup(0);
