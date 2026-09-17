#!/usr/bin/env node
// firefox-frame-test.mjs — Firefox renders an actual DOOM frame (promises rme-002).
//
// README says "Runs in stock Chrome / Edge / Firefox". Chromium is gated by 19
// CDP legs; Firefox was gated only by `firefox-smoke`, which asserts a Firefox
// UA fetched the page and /api/wads was requested -- the HTML parsed and JS ran.
// It asserts NO rendered frame, and spec.md recorded that limit on the grounds
// that "there is no CDP equivalent for Firefox in this repo and geckodriver is
// not present".
//
// geckodriver is still absent, and the CDP half is now WRONG IN THE OTHER
// DIRECTION: Firefox 155 does not speak CDP at all -- `--remote-debugging-port`
// serves WebDriver BiDi ("WebDriver BiDi listening on ws://..."), and /json/list
// 404s. So this drives BiDi directly: session.new, browsingContext.navigate,
// script.evaluate, input.performActions, browsingContext.captureScreenshot.
//
// It runs under Xvfb, NOT --headless, and that is load-bearing: measured on this
// host, headless Firefox reports webgl2:false AND webgl1:false, so the client
// falls back to createRenderer2D (video.js:31) and the gate would prove a render
// path no real user takes. Under `xvfb-run` the same Firefox reports
// webgl2:true, renderer "llvmpipe, or similar". The gate asserts
// window.webdoom._renderer.kind === 'webgl2' so it can never quietly drift onto
// the fallback and keep passing.
//
// The frame assertion is a MEASUREMENT, not "the screenshot changed": a white
// page changes too, and "static is also what an empty canvas looks like"
// (browser-fire arm f). png-stats decodes the capture and counts distinct
// colours, with about:blank kept as a control so the instrument is shown to
// produce a LOW number when there is nothing to see.
//
// usage: node tools/firefox-frame-test.mjs [url] [outdir]
import { spawn } from 'node:child_process';
import { startServer } from './lib/server.mjs';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pngStats } from './png-stats.mjs';
import { root } from './lib/util.mjs';

let   url    = process.argv[2] ?? null;
const outdir = process.argv[3] ?? tmpdir();
const PORT   = 9280;
const FF     = process.env.FIREFOX_BIN ?? '/usr/bin/firefox';
const sleep  = ms => new Promise(r => setTimeout(r, ms));

// Spawn our own server unless a URL was given, so the leg is self-contained.
// tools/lib/server.mjs allocates a free port and POLLS it ready.  This was
// port 8694 after a 1,200 ms sleep, which restates the 12.2b stale-server
// lesson rather than applying it: a fixed port is exactly what an orphan from
// an earlier run is already listening on, and a sleep cannot tell them apart.
let srv = null;
if (!url) {
    srv = await startServer();
    url = srv.url;
}

const profile = mkdtempSync(join(tmpdir(), 'ff-frame-'));
const ff = spawn('xvfb-run', [
    '-a', '--server-args=-screen 0 1280x960x24',
    FF, '--no-remote', '--profile', profile, `--remote-debugging-port=${PORT}`, 'about:blank',
], { stdio: 'ignore', detached: true });

let finished = false;
const cleanup = code => {
    if (finished) return; finished = true;
    try { process.kill(-ff.pid, 'SIGKILL'); } catch { try { ff.kill('SIGKILL'); } catch { /* gone */ } }
    try { srv?.stop(); } catch { /* gone */ }
    rmSync(profile, { recursive: true, force: true });
    process.exit(code);
};
process.on('exit', () => {
    try { process.kill(-ff.pid, 'SIGKILL'); } catch { /* gone */ }
    try { srv?.stop(); } catch { /* gone */ }
});
const fail = msg => { console.error(`FAIL: ${msg}`); cleanup(1); };

// ── BiDi ─────────────────────────────────────────────────────────────────────
let ws = null;
for (let i = 0; i < 40 && !ws; i++) {
    await sleep(500);
    ws = await new Promise(res => {
        const s = new WebSocket(`ws://127.0.0.1:${PORT}/session`);
        s.onopen = () => res(s);
        s.onerror = () => res(null);
    });
}
if (!ws) fail(`Firefox WebDriver BiDi never accepted a socket on ${PORT} within 20 s`);

let id = 0;
const pending = new Map();
ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const bidi = (method, params = {}) => new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, res);
    setTimeout(() => { if (pending.delete(i)) rej(new Error(`${method} timed out`)); }, 45000);
    ws.send(JSON.stringify({ id: i, method, params }));
});
// A BiDi command this Firefox does not implement must FAIL loudly: silently
// ignoring one would leave every assertion below measuring about:blank.
const must = async (method, params) => {
    const r = await bidi(method, params).catch(e => ({ error: e.message }));
    if (r.error) fail(`BiDi ${method} failed: ${JSON.stringify(r).slice(0, 240)}`);
    return r.result;
};

await must('session.new', { capabilities: { alwaysMatch: {} } });
const tree = await must('browsingContext.getTree', {});
const context = tree?.contexts?.[0]?.context;
if (!context) fail('BiDi returned no browsing context');

const evaluate = async expression => {
    const r = await must('script.evaluate',
        { expression, target: { context }, awaitPromise: true });
    if (r?.type === 'exception') fail(`page threw: ${r.exceptionDetails?.text ?? '?'}`);
    return r?.result?.value;
};
const shot = async name => {
    const r = await must('browsingContext.captureScreenshot', { context });
    if (!r?.data) fail('captureScreenshot returned no data');
    const buf = Buffer.from(r.data, 'base64');
    writeFileSync(join(outdir, name), buf);
    return { b64: r.data, stats: pngStats(buf) };
};
// BiDi key actions: WebDriver key codepoints for the non-printing keys.
// WebDriver key codepoints. Written as escapes on purpose: the literal
// characters are private-use and invisible in an editor and a diff.
const KEY = { Escape: '\uE00C', Enter: '\uE007' };
const key = async (value, holdMs = 60) => {
    await must('input.performActions', { context, actions: [{
        type: 'key', id: 'kb',
        actions: [{ type: 'keyDown', value }, { type: 'pause', duration: holdMs }, { type: 'keyUp', value }],
    }] });
    await sleep(80);
};

// ── control: a genuinely blank page, through the same instrument ─────────────
await must('browsingContext.navigate', { context, url: 'about:blank', wait: 'complete' });
await sleep(800);
const blank = await shot('firefox-blank.png');
console.log(`control (about:blank): ${blank.stats.colours} colour(s), ${blank.stats.variedPct}% varied`);
if (blank.stats.colours > 4 || blank.stats.variedPct > 5)
    fail(`the control is not blank (${blank.stats.colours} colours, ${blank.stats.variedPct}% varied) — ` +
         `the instrument cannot tell a picture from an empty page, so nothing below would mean anything`);

// ── boot ─────────────────────────────────────────────────────────────────────
// The engine does not start on load: the landing page is a DOOM-idiom launcher
// menu and something must pick a game. browser-test.mjs drills SINGLE PLAYER ->
// THE ULTIMATE DOOM; the same drill is what this needs, and without it the boot
// predicate simply never becomes true (status is '' from the first paint, so
// waiting on status alone waits forever).
await must('browsingContext.navigate', { context, url, wait: 'complete' });
let booted = false, clicked = false;
for (let i = 0; i < 80; i++) {
    await sleep(500);
    const st = await evaluate(`document.getElementById('status')?.textContent`);
    if (st && /^(engine error|Error|cannot)/.test(st)) fail(`page reported: ${st}`);
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
    booted = await evaluate(
        `document.getElementById('status')?.textContent === '' &&
         !document.getElementById('screen')?.hidden`);
    if (booted) break;
}
if (!booted) fail(`webdoom did not boot in Firefox within 30 s ` +
                  `(status: ${await evaluate(`document.getElementById('status')?.textContent`)})`);

const kind = await evaluate(`window.webdoom?._renderer?.kind ?? null`);
await sleep(1500);

// After the launcher drill the engine is running its attract demo, so the
// picture MOVES on its own. That is a better liveness probe than a keypress:
// the first cut sent Escape + 3x Enter and asserted "the frame changes when the
// player moves", but the screenshot showed DOOM's own menu still open over a
// demo -- the blinking skull cursor would have satisfied that assertion whether
// or not any input reached the engine.
const frameA = await shot('firefox-frame-a.png');
// POLL, do not guess an interval. DOOM holds a STATIC title screen for ~170
// tics (~5 s) before the attract demo starts, so two captures 1.5 s apart are
// legitimately identical and a fixed sleep made this read as a dead engine.
let frameB = frameA, movedAfterMs = -1;
for (let t = 0; t < 20; t++) {
    await sleep(1000);
    frameB = await shot('firefox-frame-b.png');
    if (frameB.b64 !== frameA.b64) { movedAfterMs = (t + 1) * 1000; break; }
}
console.log(`renderer: ${kind}; frame: ${frameA.stats.colours} colour(s), ${frameA.stats.variedPct}% varied`);

// Input is asserted separately and on its own terms: Escape opens DOOM's menu,
// which is a large, unmistakable change to the picture.
await key(KEY.Escape);
await sleep(900);
const menu = await shot('firefox-menu.png');

// ── assertions ───────────────────────────────────────────────────────────────
let bad = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${msg}`); if (!ok) bad++; };

// Headless Firefox has no WebGL at all on this host, so the client would fall
// back to canvas2D and this gate would silently prove the wrong path.
check(kind === 'webgl2', `render path is WebGL2, not the canvas2D fallback (kind=${kind})`);
// The committed README screenshot measures 181 distinct colours over 70k samples.
check(frameA.stats.colours >= 40,
      `the frame is a picture: ${frameA.stats.colours} distinct colours (need 40)`);
check(frameA.stats.variedPct >= 50,
      `the frame is not a flat fill: ${frameA.stats.variedPct}% of pixels differ from the dominant colour (need 50%)`);
check(frameA.b64 !== blank.b64, 'the frame differs from about:blank');
check(frameA.b64 !== frameB.b64,
      `the picture moves on its own after ${movedAfterMs} ms (the engine is running, not a stuck first paint)`);
check(menu.b64 !== frameB.b64, 'Escape reached the engine and changed the screen (input works)');

if (bad) { console.log(`firefox-frame: ${bad} of 6 assertions failed`); cleanup(1); }
console.log(`PASS — firefox-frame: Firefox rendered a real frame via ${kind} ` +
            `(${frameA.stats.colours} colours, ${frameA.stats.variedPct}% varied, 6 assertions); ` +
            `screenshots in ${outdir}`);
cleanup(0);
