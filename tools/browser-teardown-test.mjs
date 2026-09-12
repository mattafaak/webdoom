#!/usr/bin/env node
// tools/browser-teardown-test.mjs — play -> quit -> play must not accumulate
// (task 23.7b).  MEASURED across cycles, not asserted by inspection.
//
// WHAT WAS WRONG
// --------------
// bootDoom() created input, qol, settings and the WebGL renderer on every boot
// and tore down none of them.  A quit-to-menu left behind:
//   * ~11 window/document/canvas listeners from input.js, so after one replay
//     two keydown handlers ran and the older one called _web_input_event on a
//     wasm instance I_Quit had force-exited
//   * qol.js's rAF loop, which stopTickIfIdle() only stops when BOTH live
//     features are off — with "level stats" on it ran forever, its exceptions
//     swallowed by a bare catch — plus five nodes appended to #stage
//   * a second #settings panel sharing the first one's id
//   * a program, two shaders, a VBO and two textures on the same GL context,
//     since getContext returns the SAME context for the same canvas
//
// AND WHAT THIS FILE GOT WRONG
// ----------------------------
// The GL objects were named above from the day this was written and never
// measured: the shim counted listeners, #settings panels and #stage children
// only.  So when 23.7b's dispose() landed in createRenderer2D -- the canvas2d
// fallback, where gl/prog/quad/_textures are not in scope -- the WebGL2 path
// shipped with no dispose at all and this gate stayed green for it.  A header
// that lists a leak the body cannot see is the same defect as a green with no
// reason.  The GL shim below closes it.
//
// HOW THIS MEASURES IT
// --------------------
// A counting shim replaces EventTarget.prototype.add/removeEventListener before
// the first boot, so every attach and detach is tallied per target.  Then
// boot -> onQuit -> boot -> onQuit, three cycles, comparing each cycle's
// steady-state against the one before it.  Growth that repeats per cycle is a
// leak; a one-off difference is not, which is why three cycles and not one.
//
// usage: node tools/browser-teardown-test.mjs [url]
// Copyright (C) 2026, GPL-2.0-or-later.
import { spawn } from 'node:child_process';
import { chromeBin, chromeProfileArg, reapOnExit } from './chrome-harness.mjs';
const CDP = 9236;
const CHROME = chromeBin();
const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${CDP}`, chromeProfileArg(), '--no-first-run', '--no-sandbox',
    '--use-angle=swiftshader', '--autoplay-policy=no-user-gesture-required', 'about:blank',
], { stdio: 'ignore', detached: true });
reapOnExit(chrome);
const sleep = ms => new Promise(r => setTimeout(r, ms));
await sleep(1500);
const url = process.argv[2] ?? 'http://127.0.0.1:8666/';
const t = await (await fetch(`http://127.0.0.1:${CDP}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0; const pend = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const cdp = (m, p = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async e => (await cdp('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
await cdp('Runtime.enable'); await cdp('Page.enable');
const done = c => { chrome.kill(); process.exit(c); };
const fail = m => { console.error('FAIL:', m); done(1); };

// The shim must be installed before anything attaches.
await ev(`(() => {
    if (window.__lt) return 'already';
    const proto = EventTarget.prototype, add = proto.addEventListener, rem = proto.removeEventListener;
    const tally = new Map();
    const kind = t => t === window ? 'window' : t === document ? 'document'
                    : (t && t.tagName) ? t.tagName.toLowerCase() : 'other';
    proto.addEventListener = function (type, fn, o) {
        const k = kind(this) + ':' + type; tally.set(k, (tally.get(k) ?? 0) + 1);
        return add.call(this, type, fn, o);
    };
    proto.removeEventListener = function (type, fn, o) {
        const k = kind(this) + ':' + type; tally.set(k, (tally.get(k) ?? 0) - 1);
        return rem.call(this, type, fn, o);
    };
    window.__lt = tally;

    // GL objects are not DOM and not EventTargets, so the tally above cannot
    // see them.  Count create/delete per class on the prototype, before any
    // context exists, and read the NET.
    // Two tallies, because they answer different questions.  glt is the NET
    // (created - deleted) and is what must stay flat across cycles.  glc is
    // GROSS creations and only ever rises; it is what says the shim saw any GL
    // at all.  Reading vacuity off the net would be backwards: after a clean
    // quit the net is SUPPOSED to be 0, so "net == 0" is the pass condition and
    // cannot also be the did-not-run condition.
    const glt = new Map(), glc = new Map();
    const wrap = (proto, make, kill, label) => {
        if (!proto) return;
        const c = proto[make], d = proto[kill];
        if (!c || !d) return;
        glt.set(label, 0); glc.set(label, 0);
        proto[make] = function (...a) {
            glt.set(label, glt.get(label) + 1); glc.set(label, glc.get(label) + 1);
            return c.apply(this, a);
        };
        proto[kill] = function (...a) { glt.set(label, glt.get(label) - 1); return d.apply(this, a); };
    };
    for (const P of [window.WebGL2RenderingContext?.prototype, window.WebGLRenderingContext?.prototype]) {
        wrap(P, 'createProgram', 'deleteProgram', 'program');
        wrap(P, 'createShader',  'deleteShader',  'shader');
        wrap(P, 'createBuffer',  'deleteBuffer',  'buffer');
        wrap(P, 'createTexture', 'deleteTexture', 'texture');
    }
    window.__glt = glt;
    window.__glc = glc;

    return 'installed';
})()`);

const snapshot = () => ev(`(() => ({
    listeners: [...window.__lt].reduce((n, [, v]) => n + v, 0),
    settingsPanels: document.querySelectorAll('#settings').length,
    stageKids: document.getElementById('stage')?.childElementCount ?? -1,
    glObjects: [...window.__glt].reduce((n, [, v]) => n + v, 0),
    glCreated: [...window.__glc].reduce((n, [, v]) => n + v, 0),
    glBreakdown: [...window.__glt].map(([k, v]) => k + ' ' + v).join(', '),
    rendererKind: window.webdoom?._renderer?.kind ?? '(none)',
}))()`);

async function bootSP() {
    for (let i = 0; i < 30; i++) {
        await sleep(500);
        if (await ev(`(() => { const r = document.querySelector('#dmenu .row[data-label="SINGLE PLAYER"]');
            if (r) r.click();
            const g = document.querySelector('#dmenu .row[data-label*="ULTIMATE"]') || document.querySelector('#dmenu .row[data-wad]');
            return g ? (g.click(), true) : false; })()`)) break;
    }
    for (let i = 0; i < 40; i++) {
        await sleep(500);
        if (await ev(`!!window.webdoom && document.getElementById('status')?.textContent === ''`)) return true;
    }
    return false;
}

// A run that never booted proves nothing; that must be a failure, not a pass.
const wadCount = await ev(`(async () => { try { return ((await (await fetch('/api/wads')).json()).wads ?? []).length; } catch { return -1; } })()`);
if (wadCount <= 0) fail(`/api/wads returned ${wadCount} — cannot boot, so nothing was measured`);

const marks = [];
for (let cycle = 1; cycle <= 3; cycle++) {
    if (!await bootSP()) fail(`boot timeout on cycle ${cycle}`);
    await sleep(400);
    await ev(`window.webdoom?.doom?.onQuit?.()`);
    await sleep(600);
    const s = await snapshot();
    marks.push(s);
    console.log(`  cycle ${cycle}: net listeners ${s.listeners}, #settings ${s.settingsPanels}, `
              + `#stage children ${s.stageKids}, net GL objects ${s.glObjects} `
              + `(${s.glBreakdown}; ${s.glCreated} created so far, renderer ${s.rendererKind})`);
}

let bad = 0;
const growth = (k) => marks[2][k] - marks[1][k];
// Vacuity is measured on GROSS creations, never on the net: a clean quit is
// SUPPOSED to leave net 0, so grading that as "never moved" would fail exactly
// the runs where the teardown works.  What must not happen is the shim seeing
// no GL at all -- a missed prototype, or a canvas2d fallback, either of which
// would let the GL half pass while measuring nothing.
if (marks[2].glCreated === 0)
    fail('no GL objects were created across three boots — the shim saw no WebGL '
       + `(renderer reported "${marks[2].rendererKind}"), so the GL half measured nothing`);
if (marks[2].rendererKind !== 'webgl2')
    fail(`renderer is "${marks[2].rendererKind}", not webgl2 — this run cannot speak for the WebGL teardown path`);

for (const [k, label] of [['listeners', 'net event listeners'],
                          ['stageKids', '#stage children'],
                          ['glObjects', 'net GL objects']]) {
    const g = growth(k);
    if (g > 0) { console.error(`FAIL: ${label} grew by ${g} between cycle 2 and cycle 3 — accumulating per boot`); bad++; }
    else console.log(`  ok  ${label} stable across cycles (${marks[1][k]} -> ${marks[2][k]})`);
}
if (marks[2].settingsPanels > 1) { console.error(`FAIL: ${marks[2].settingsPanels} #settings panels — duplicate ids`); bad++; }
else console.log(`  ok  #settings panels: ${marks[2].settingsPanels}`);

if (bad) fail(`${bad} teardown leak(s)`);
console.log('PASS — browser-teardown-test: play->quit->play x3, 4 measured dimensions stable '
          + '(event listeners, #stage children, #settings panels, GL objects)');
done(0);
