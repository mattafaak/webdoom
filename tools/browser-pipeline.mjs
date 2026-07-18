#!/usr/bin/env node
// tools/browser-pipeline.mjs — per-frame browser pipeline profiler for webdoom
//
// Instruments webdoom with ?perfmarks=1 (client/js/main.js, video.js,
// music-worklet.js), drives ≥100 frames of E1M1 gameplay via CDP, then
// collects per-stage timing distributions from window.__wd_perf and emits
// a structured JSON baseline.
//
// Stages measured:
//   (a) palette  — palette texSubImage2D (WebGL2) or LUT build (Canvas2D);
//                  only when palette changes.  Typically sub-ms.
//   (b) upload   — framebuffer texSubImage2D + drawArrays (WebGL2) or
//                  64K pixel-expand + putImageData (Canvas2D).
//   (c) raf      — frame-to-frame interval (jitter) and total rAF callback
//                  duration.
//   (d) worklet  — AudioWorklet process() wall time posted from the audio
//                  thread.  See note in results: audio context may not arm
//                  in headless Chrome without user gesture.
//   (e) inputLat — keydown event.timeStamp → renderer.draw() returns.
//                  Measures: event firing → GPU upload (compositing not waited).
//
// Usage:
//   node tools/browser-pipeline.mjs [--url <url>] [--json] [--frames <n>]
//
// --url     Running webdoom server URL (default: http://127.0.0.1:8666/).
//           Script auto-spawns a server if the default URL is not reachable.
// --json    Emit compact JSON to stdout; human-readable to stderr otherwise.
// --frames  Minimum rAF frames to collect before computing stats (default: 200).
//
// Env:
//   CHROME_BIN   — Chrome/Chromium binary (default: google-chrome-stable)
//   CDP_PORT     — Chrome DevTools Protocol port (default: 9226)
//
// Reproduce (alder, run twice and compare):
//   node tools/browser-pipeline.mjs --url http://127.0.0.1:8666/ --json
//
// Reproduce (wbox):
//   DOOM_PORT=8671 node ~/.cache/webdoom-pipeline/server/serve.js &
//   node ~/.cache/webdoom-pipeline/tools/browser-pipeline.mjs \
//       --url http://127.0.0.1:8671/ --json

import { spawn, execFileSync } from 'node:child_process';
import { existsSync }          from 'node:fs';
import { join, dirname }       from 'node:path';
import { fileURLToPath }       from 'node:url';
import os                      from 'node:os';

const __dir = dirname(fileURLToPath(import.meta.url));
const root  = join(__dir, '..');

// ── CLI args ───────────────────────────────────────────────────────────────────
const args       = process.argv.slice(2);
const jsonMode   = args.includes('--json');
const urlIdx     = args.indexOf('--url');
const framesIdx  = args.indexOf('--frames');
const EXPLICIT_URL   = urlIdx    >= 0 ? args[urlIdx    + 1] : null;
const MIN_FRAMES     = framesIdx >= 0 ? Number(args[framesIdx + 1]) : 200;

// Reject unknown args: a positional URL or typo'd flag would otherwise be
// silently ignored and the run would hit DEFAULT_URL — where a stale server
// with an uninstrumented client boots fine and fails confusingly later
// (the run-fuzz.mjs lesson: unknown args must fail loudly, not look green).
{
    const known = new Set(['--json', '--url', '--frames']);
    const valueSlots = new Set([urlIdx + 1, framesIdx + 1].filter(i => i > 0));
    const unknown = args.filter((a, i) => !known.has(a) && !valueSlots.has(i));
    if (unknown.length) {
        console.error(`FATAL: unknown argument(s): ${unknown.join(' ')}`);
        console.error('usage: browser-pipeline.mjs [--url URL] [--frames N] [--json]');
        process.exit(2);
    }
}

// ── Config (env overrides) ─────────────────────────────────────────────────────
const CHROME_BIN = process.env.CHROME_BIN ?? 'google-chrome-stable';
const CDP_PORT   = Number(process.env.CDP_PORT ?? 9226);
const DEFAULT_URL  = 'http://127.0.0.1:8666/';
const SPAWN_PORT   = 8671;

const hostname = os.hostname();
const sleep    = ms => new Promise(r => setTimeout(r, ms));

let chrome = null;
let ownSrv = null;

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

// ── 1. Resolve server URL ─────────────────────────────────────────────────────
let BASE_URL = EXPLICIT_URL ?? DEFAULT_URL;

if (!EXPLICIT_URL) {
    const alive = await urlReachable(DEFAULT_URL);
    if (!alive) {
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

// ── 2. Launch Chrome with ?perfmarks=1 ────────────────────────────────────────
// Append the flag to the URL so main.js enables window.__wd_perf.
const PERF_URL = BASE_URL.includes('?')
    ? BASE_URL + '&perfmarks=1'
    : BASE_URL + '?perfmarks=1';

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
    `http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(PERF_URL)}`,
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

// ── 4. Wait for service worker ─────────────────────────────────────────────────
for (let i = 0; i < 40; i++) {
    const controlled = await evaluate(`!!navigator.serviceWorker.controller`);
    if (controlled) break;
    if (i === 39) fail('service worker did not claim page within 20s');
    await sleep(500);
}

// ── 5. Boot: lobby → SP → Ultimate Doom ───────────────────────────────────────
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

// ── 6. Navigate to E1M1 ────────────────────────────────────────────────────────
const key = async (code, wkey, vk, holdMs = 60) => {
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', code, key: wkey, windowsVirtualKeyCode: vk });
    await sleep(holdMs);
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp',   code, key: wkey, windowsVirtualKeyCode: vk });
    await sleep(60);
};

await sleep(1000);
await key('Escape', 'Escape', 27);
await sleep(400);
for (let i = 0; i < 3; i++) { await key('Enter', 'Enter', 13); await sleep(400); }
await sleep(3000);   // level load + melt wipe

// ── 7. Verify __wd_perf was installed ─────────────────────────────────────────
const perfInstalled = await evaluate(`typeof window.__wd_perf === 'object' && window.__wd_perf !== null`);
if (!perfInstalled) fail('window.__wd_perf not found — perfmarks flag may not have reached main.js');

if (!jsonMode) process.stderr.write(`collecting ≥${MIN_FRAMES} rAF frames on ${hostname}...\n`);

// ── 8. Gameplay + input latency samples ───────────────────────────────────────
// Inject CDP key events every tick to both keep the renderer active and
// generate ≥30 input-latency samples.  Movement keys are safe (no menus).
const moveSeq = [
    ['KeyW', 'w', 87], ['KeyA', 'a', 65], ['KeyD', 'd', 68], ['KeyS', 's', 83],
];
let moveIdx = 0;

// Minimum input-latency samples to collect before finishing.
const MIN_INPUT_SAMPLES = 35;

// Wait until we have enough frames AND enough input samples; check every 2 s.
const MAX_WAIT_S = 180;
let waited = 0;
while (waited < MAX_WAIT_S) {
    await sleep(2000);
    waited += 2;

    // Inject movement key every tick — generates input-latency sample AND
    // keeps the renderer busy so frames accumulate.
    const [code, wkey, vk] = moveSeq[moveIdx % moveSeq.length];
    await key(code, wkey, vk, 200);
    moveIdx++;

    const frames      = await evaluate(`window.__wd_perf?.frames ?? 0`);
    const inputSamples = await evaluate(`window.__wd_perf?.inputLat?.length ?? 0`);
    if (!jsonMode) process.stderr.write(`  t=${waited}s frames=${frames} inputSamples=${inputSamples}\n`);
    if (frames >= MIN_FRAMES && inputSamples >= MIN_INPUT_SAMPLES) break;
}

// ── 9. Collect stats ──────────────────────────────────────────────────────────
const perfData = await evaluate(`JSON.stringify(window.__wd_perf)`);
if (!perfData) fail('could not read window.__wd_perf');

const perf = JSON.parse(perfData);

// ── 10. Compute distribution stats ────────────────────────────────────────────
function stats(arr) {
    if (!arr || arr.length === 0) return { n: 0, mean: null, p50: null, p90: null, p99: null, max: null };
    const s = [...arr].sort((a, b) => a - b);
    const n = s.length;
    const mean = s.reduce((a, b) => a + b, 0) / n;
    const p = pct => s[Math.min(n - 1, Math.floor(pct * n / 100))];
    return {
        n,
        mean: +mean.toFixed(4),
        p50:  +p(50).toFixed(4),
        p90:  +p(90).toFixed(4),
        p99:  +p(99).toFixed(4),
        max:  +s[n - 1].toFixed(4),
    };
}

// Jitter: deviation from ideal 16.667 ms (60 Hz target).
// In headless Chrome rAF does not sync to vsync, so ideal interval may differ;
// we report the raw interval distribution.
const rafIntervals  = stats(perf.raf);
const rafDurations  = stats(perf.rafDur);
const paletteStats  = stats(perf.palette);
const uploadStats   = stats(perf.upload);
const inputLatStats = stats(perf.inputLat);
const workletStats  = stats(perf.worklet);

// Chrome version for record
let chromeVer = 'unknown';
try {
    chromeVer = (await cdp('Browser.getVersion')).result?.product ?? 'unknown';
} catch (_) {}

const result = {
    schema:      'browser-pipeline.v1',
    host:         hostname,
    chromeBin:    CHROME_BIN,
    chromeVersion: chromeVer,
    commit:       (() => { try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root }).toString().trim(); } catch { return 'unknown'; } })(),
    timestamp:    new Date().toISOString(),
    minFramesTarget: MIN_FRAMES,
    framesCollected: perf.frames,
    stages: {
        // (a) palette: only when dirty — skip frames where palette unchanged
        palette: { ...paletteStats,
            note: 'WebGL2: 256×1 RGB texSubImage2D when paletteDirty; Canvas2D: 256-entry LUT rebuild. Dirty-only — n << framesCollected.' },
        // (b) upload: every frame
        upload:  { ...uploadStats,
            note: 'WebGL2: 320×200 R8 texSubImage2D + drawArrays. Canvas2D: 64K indexed→RGBA + putImageData.' },
        // (c) rAF
        raf_interval: { ...rafIntervals,
            note: 'Frame-to-frame rAF timestamp delta (ms). Ideal 60 Hz = 16.667 ms. Headless Chrome has no vsync; interval reflects CPU scheduling.' },
        raf_duration:  { ...rafDurations,
            note: 'Total rAF callback wall time: input.frame() + doom._web_frame() + renderer.draw().' },
        // (d) AudioWorklet
        worklet: { ...workletStats,
            note: 'AudioWorklet process() wall time measured inside the audio thread and posted to main thread via port. n=0 means AudioContext did not arm (no user gesture in headless Chrome). Headless limitation: audio worklet may be silent.' },
        // (e) input latency
        input_latency: { ...inputLatStats,
            note: 'Measurement: keydown event.timeStamp → renderer.draw() returns (GPU upload submitted, not compositing). Exact tic-consumption attribution omitted (no engine changes); this is event→next-rAF-draw latency.' },
    },
};

if (jsonMode) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} else {
    console.log('');
    console.log(`host:           ${hostname}`);
    console.log(`frames:         ${perf.frames}`);
    console.log(`(a) palette     p50=${paletteStats.p50} p90=${paletteStats.p90} p99=${paletteStats.p99} max=${paletteStats.max} n=${paletteStats.n} ms`);
    console.log(`(b) upload      p50=${uploadStats.p50}  p90=${uploadStats.p90}  p99=${uploadStats.p99}  max=${uploadStats.max}  n=${uploadStats.n} ms`);
    console.log(`(c) rAF-interval p50=${rafIntervals.p50}  p90=${rafIntervals.p90}  p99=${rafIntervals.p99}  max=${rafIntervals.max}  ms`);
    console.log(`(c) rAF-duration p50=${rafDurations.p50}  p90=${rafDurations.p90}  p99=${rafDurations.p99}  max=${rafDurations.max}  ms`);
    console.log(`(d) worklet     p50=${workletStats.p50}  n=${workletStats.n}  ms  (0 = not armed in headless)`);
    console.log(`(e) input-lat   p50=${inputLatStats.p50}  p90=${inputLatStats.p90}  p99=${inputLatStats.p99}  n=${inputLatStats.n} ms`);
    console.log('PASS');
}

cleanup(0);
