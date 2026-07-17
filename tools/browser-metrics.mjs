#!/usr/bin/env node
// tools/browser-metrics.mjs — CDP Performance.getMetrics aggregate for webdoom
//
// Boots the full webdoom client headlessly, navigates to E1M1, plays for a
// fixed window, and samples Chrome DevTools Protocol Performance.getMetrics
// at the start, periodically, and at the end.  Emits aggregate JSON covering:
// ScriptDuration, TaskDuration, LayoutDuration, RecalcStyleDuration,
// V8CompileDuration, JSHeapUsedSize/TotalSize, and main-thread % of wall-clock.
//
// This is the "cheap pass" described in docs/perf.md §C option 3: two CDP
// calls (before/after) using the cdp() helper pattern from browser-test.mjs.
// It yields aggregate JS scripting time rather than per-frame breakdowns, but
// costs nothing beyond the boot sequence already exercised by browser-test.mjs.
//
// Usage:
//   node tools/browser-metrics.mjs [--url <server-url>] [--json] [--duration <secs>]
//
// --url    Running webdoom server URL (default: http://127.0.0.1:8666/).
//          If the URL is unreachable and --url was not given explicitly,
//          the script attempts to spawn its own server.
// --json   Emit compact JSON to stdout; human-readable otherwise.
// --duration  Gameplay window in seconds (default 60).
//
// Env:
//   CHROME_BIN  — Chrome/Chromium binary (default: google-chrome-stable)
//   CDP_PORT    — Chrome DevTools Protocol port (default: 9224, avoids 9223)

import { spawn, execFileSync } from 'node:child_process';
import { existsSync }          from 'node:fs';
import { join, dirname }       from 'node:path';
import { fileURLToPath }       from 'node:url';
import os                      from 'node:os';

const __dir = dirname(fileURLToPath(import.meta.url));
const root  = join(__dir, '..');

// ── CLI args ───────────────────────────────────────────────────────────────────
const args     = process.argv.slice(2);
const jsonMode = args.includes('--json');
const urlIdx   = args.indexOf('--url');
const durIdx   = args.indexOf('--duration');
const EXPLICIT_URL  = urlIdx >= 0 ? args[urlIdx + 1] : null;
const DURATION_SECS = durIdx >= 0 ? Number(args[durIdx + 1]) : 60;

// ── Config (env overrides) ─────────────────────────────────────────────────────
const CHROME_BIN   = process.env.CHROME_BIN ?? 'google-chrome-stable';
const CDP_PORT     = Number(process.env.CDP_PORT ?? 9224);
const DEFAULT_URL  = 'http://127.0.0.1:8666/';
const SPAWN_PORT   = 8669;   // used only when we spawn our own server

const hostname = os.hostname();
const sleep    = ms => new Promise(r => setTimeout(r, ms));

let chrome   = null;
let ownSrv   = null;  // only set if WE spawned the server

const cleanup = code => {
    try { chrome?.kill('SIGKILL'); }  catch (_) {}
    try { ownSrv?.kill('SIGKILL'); }  catch (_) {}
    process.exit(code);
};
process.on('uncaughtException', e => { console.error('uncaught:', e); cleanup(1); });
process.on('SIGINT',  () => cleanup(1));
process.on('SIGTERM', () => cleanup(1));

const fail = msg => { console.error(`FAIL: ${msg}`); cleanup(1); };

// ── Helper: check if a URL is reachable ───────────────────────────────────────
const urlReachable = async url => {
    try {
        const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
        return r.ok;
    } catch (_) { return false; }
};

// ── 1. Resolve server URL (reuse existing or spawn) ───────────────────────────
let BASE_URL = EXPLICIT_URL ?? DEFAULT_URL;

if (!EXPLICIT_URL) {
    const alive = await urlReachable(DEFAULT_URL);
    if (!alive) {
        // No external server — find serve.js with working node_modules.
        // In a git worktree node_modules may be absent; fall back to main worktree.
        let servePath = join(root, 'server/serve.js');
        if (!existsSync(join(root, 'server/node_modules/ws'))) {
            try {
                const out   = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: root }).toString();
                const first = out.split('\n').find(l => l.startsWith('worktree '));
                if (first) {
                    const mainRoot = first.replace('worktree ', '').trim();
                    if (existsSync(join(mainRoot, 'server/node_modules/ws'))) {
                        servePath = join(mainRoot, 'server/serve.js');
                    }
                }
            } catch (_) {}
        }
        ownSrv = spawn('node', [servePath], {
            env:   { ...process.env, DOOM_PORT: String(SPAWN_PORT), DOOM_HOST: '127.0.0.1' },
            stdio: 'ignore',
        });
        ownSrv.on('error', e => fail(`server spawn: ${e.message}`));
        await sleep(1000);
        BASE_URL = `http://127.0.0.1:${SPAWN_PORT}/`;
    }
}

// ── 2. Launch Chrome headlessly ────────────────────────────────────────────────
chrome = spawn(CHROME_BIN, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    '--no-first-run',
    '--no-sandbox',
    '--disable-gpu-sandbox',
    '--use-angle=swiftshader',
    '--window-size=1280,960',
    '--autoplay-policy=no-user-gesture-required',
    'about:blank',
], { stdio: 'ignore' });
chrome.on('error', e => fail(`chrome spawn: ${e.message}`));
await sleep(1500);

// ── 3. Open CDP target ─────────────────────────────────────────────────────────
const target = await (await fetch(
    `http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(BASE_URL)}`,
    { method: 'PUT' },
)).json();

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let mid       = 0;
const pending = new Map();

ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
    }
};

// cdp() mirrors the helper from browser-test.mjs (line 40)
const cdp = (method, params = {}) => new Promise(res => {
    const i = ++mid;
    pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
});

const evaluate = async expr =>
    (await cdp('Runtime.evaluate', {
        expression: expr, returnByValue: true, awaitPromise: true,
    })).result?.result?.value;

await cdp('Runtime.enable');
await cdp('Page.enable');
// Enable Performance domain before getMetrics calls.
await cdp('Performance.enable', { timeDomain: 'timeTicks' });

// ── 4. Wait for service worker ─────────────────────────────────────────────────
for (let i = 0; i < 40; i++) {
    const controlled = await evaluate(`!!navigator.serviceWorker.controller`);
    if (controlled) break;
    if (i === 39) fail('service worker did not claim page within 20s');
    await sleep(500);
}

// ── 5. Boot: lobby → SP → Ultimate Doom ───────────────────────────────────────
// Mirrors browser-test.mjs: click SINGLE PLAYER then ULTIMATE DOOM in #dmenu.
let booted  = false;
let clicked = false;
for (let i = 0; i < 60; i++) {
    await sleep(500);
    const s = await evaluate(`document.getElementById('status')?.textContent`);
    if (s?.startsWith('engine error') || s?.startsWith('Error') || s?.startsWith('cannot'))
        fail(`engine: ${s}`);
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
    const running = await evaluate(
        `document.getElementById('status')?.textContent === '' &&
         !document.getElementById('screen').hidden`);
    if (running) { booted = true; break; }
}
if (!booted) fail('boot timeout');

// ── 6. Navigate to E1M1 via in-game menu ──────────────────────────────────────
const key = async (code, wkey, vk, holdMs = 60) => {
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', code, key: wkey, windowsVirtualKeyCode: vk });
    await sleep(holdMs);
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp',   code, key: wkey, windowsVirtualKeyCode: vk });
    await sleep(60);
};

await sleep(1000);             // brief title-screen demo
await key('Escape', 'Escape', 27);
await sleep(400);
// New Game → Episode 1 → Hurt Me Plenty → start (3 × Enter)
for (let i = 0; i < 3; i++) { await key('Enter', 'Enter', 13); await sleep(400); }
await sleep(3000);             // level load + melt wipe

// ── 7. Metric sampling loop ────────────────────────────────────────────────────
const getMetrics = async () => {
    const r = await cdp('Performance.getMetrics');
    return Object.fromEntries((r.result?.metrics ?? []).map(m => [m.name, m.value]));
};

const samples = [];

// Baseline sample — taken right after E1M1 is live
const m0 = await getMetrics();
const t0  = Date.now();
samples.push({ elapsedSec: 0, metrics: m0 });

if (!jsonMode) process.stderr.write(`measuring for ${DURATION_SECS}s on ${hostname}...\n`);

// Walk through DURATION_SECS in 1-second ticks.
// Periodic movement keeps the renderer busy (not stuck on a static frame).
const moveSeq = [
    ['KeyW', 'w', 87],
    ['KeyA', 'a', 65],
    ['KeyD', 'd', 68],
    ['KeyS', 's', 83],
];
let moveIdx = 0;

for (let tick = 1; tick <= DURATION_SECS; tick++) {
    await sleep(1000);

    // Movement input every 7 s (offset avoids colliding with 10 s samples)
    if (tick % 7 === 0) {
        const [code, wkey, vk] = moveSeq[moveIdx % moveSeq.length];
        await key(code, wkey, vk, 300);
        moveIdx++;
    }

    // Periodic metric snapshots every 10 s
    if (tick % 10 === 0) {
        const m = await getMetrics();
        const elapsedSec = (Date.now() - t0) / 1000;
        samples.push({ elapsedSec, metrics: m });
        if (!jsonMode) {
            const sc = ((m.ScriptDuration ?? 0) - (m0.ScriptDuration ?? 0)).toFixed(3);
            const hp = ((m.JSHeapUsedSize ?? 0) / 1024 / 1024).toFixed(1);
            process.stderr.write(`  t=${tick}s ScriptDelta=${sc}s heap=${hp}MB\n`);
        }
    }
}

// Final sample
const mN         = await getMetrics();
const tN         = (Date.now() - t0) / 1000;
samples.push({ elapsedSec: tN, metrics: mN });

// ── 8. Compute aggregate deltas ────────────────────────────────────────────────
// *Duration fields are cumulative CPU seconds — delta = during-window usage.
// JSHeap*Size are instantaneous bytes — report the final-sample value.
const delta = k => (mN[k] ?? 0) - (m0[k] ?? 0);

const scriptSec   = delta('ScriptDuration');
const taskSec     = delta('TaskDuration');
const layoutSec   = delta('LayoutDuration');
const recalcSec   = delta('RecalcStyleDuration');
const v8compSec   = delta('V8CompileDuration');
const heapUsedMB  = (mN['JSHeapUsedSize']  ?? 0) / (1024 * 1024);
const heapTotalMB = (mN['JSHeapTotalSize'] ?? 0) / (1024 * 1024);

// main-thread % = (script + layout + recalc) / wall × 100
// TaskDuration is reported separately (includes V8 + GC overhead).
const mainThreadPct   = (scriptSec + layoutSec + recalcSec) / tN * 100;
const scriptPctOfWall = scriptSec / tN * 100;
const taskPctOfWall   = taskSec   / tN * 100;

const result = {
    schema:       'browser-metrics.v1',
    host:         hostname,
    chromeBin:    CHROME_BIN,
    timestamp:    new Date().toISOString(),
    durationSecs: DURATION_SECS,
    wallSec:      tN,
    aggregate: {
        scriptSec,
        taskSec,
        layoutSec,
        recalcSec,
        v8compSec,
        heapUsedMB,
        heapTotalMB,
        mainThreadPct,
        scriptPctOfWall,
        taskPctOfWall,
    },
    samples,
};

if (jsonMode) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} else {
    console.log('');
    console.log(`host:              ${hostname}`);
    console.log(`chrome:            ${CHROME_BIN}`);
    console.log(`wall time:         ${tN.toFixed(1)}s`);
    console.log(`ScriptDuration:    ${scriptSec.toFixed(3)}s  (${scriptPctOfWall.toFixed(1)}% of wall)`);
    console.log(`TaskDuration:      ${taskSec.toFixed(3)}s  (${taskPctOfWall.toFixed(1)}% of wall)`);
    console.log(`LayoutDuration:    ${layoutSec.toFixed(6)}s`);
    console.log(`RecalcStyle:       ${recalcSec.toFixed(6)}s`);
    console.log(`V8Compile:         ${v8compSec.toFixed(6)}s`);
    console.log(`heap used (final): ${heapUsedMB.toFixed(1)} MB`);
    console.log(`heap total:        ${heapTotalMB.toFixed(1)} MB`);
    console.log(`main-thread %:     ${mainThreadPct.toFixed(1)}%  (script+layout+recalc / wall)`);
    console.log('PASS');
}

cleanup(0);
