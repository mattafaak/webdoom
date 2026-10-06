#!/usr/bin/env node
// Browser test: the analog twin-stick path reaches the engine (promise
// rme-004's second half).
//
// A headless runner has no stick, so the pad is synthetic: `navigator.
// getGamepads` is replaced BEFORE any page script runs and a `gamepadconnected`
// event is fired, which is exactly what input.js waits for.
//
// WHAT THIS GATES AND WHAT IT DOES NOT, because the promises index carried a
// standing objection that a synthetic pad "gates the shim rather than the
// path".  It gates everything between the Gamepad API and the engine: the
// connect/disconnect gating, the deadzone curve, the per-axis mapping, the
// turn-speed setting, and the arguments the engine's own `web_gamepad` entry
// point receives.  That is the same boundary `browser-options` uses to prove a
// rebound KEY drives the engine (it wraps `_web_input_event` and counts what
// arrives).  What it cannot gate is the browser's own Gamepad API delivering a
// real device -- no headless runner can -- so that remains untested, and the
// index says so rather than implying otherwise.
//
// Asserts:
//   (i)   a centred stick sends zeros (the deadzone holds)
//   (ii)  the left stick forward sends a negative `fwd` and no turn
//   (iii) the left stick right sends a positive `strafe`
//   (iv)  the right stick sends `turn`, scaled by settings.padTurnSpeed
//   (v)   a value inside the deadzone still sends zero
//   (vi)  after `gamepaddisconnected` the poll stops reading the pad
//
// RED-PROOF: drop the deadzone curve (return v) and (i)/(v) fail; swap axes 0
// and 1 and (ii)/(iii) fail.
//
// usage: node tools/browser-gamepad-test.mjs [url]
import { launchChrome } from './lib/cdp.mjs';
import { sleep } from './lib/util.mjs';
import { startServer } from './lib/server.mjs';
import { check, summary, fatal } from './lib/report.mjs';

const url = process.argv[2] ?? (await startServer()).url;
const chrome = await launchChrome({ gpu: 'none' });
const tab = await chrome.tab('about:blank');
const { cdp, ev } = tab;

// The pad has to exist before the page's scripts run.
await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__pad = { id: 'synthetic', index: 0, connected: true, mapping: 'standard',
                     axes: [0, 0, 0, 0],
                     buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) };
    navigator.getGamepads = () => [window.__pad];
` });
await cdp('Page.navigate', { url });

// the detail is part of the label: what the engine received is the evidence
const checkWith = (name, ok, detail) => check(`${name} — ${detail}`, ok);

if (!await tab.waitForSW(15)) fatal('service worker did not take control within 15s');

// The pad announces itself on the launcher, before any game exists -- the way
// a player pressing a button to navigate the menu does.  Browsers announce a
// pad once per page, so the game that boots afterwards must not wait for it.
await ev(`window.dispatchEvent(new Event('gamepadconnected'))`);

// Into a level: a bind is not consulted in UI mode, and neither is a stick.
const booted = await tab.bootSP(30).catch(e => fatal(e.message))
    && await tab.waitFor(async () => (await ev(`window.webdoom?.doom?._web_ui_mode?.() ?? 1`)) === 0,
                         { timeout: 30000, every: 500 });
if (!booted) fatal('never reached a level — a stick is not read in ui mode');

// Wrap the engine's own analog entry point and record what arrives, exactly as
// browser-options does for keys.
const wrapped = await ev(`(() => {
    const d = window.webdoom?.doom;
    if (!d) return 'no-engine';
    const orig = d._web_gamepad;
    window.__pad_calls = [];
    d._web_gamepad = function (buttons, turn, fwd, strafe) {
        window.__pad_calls.push({ buttons, turn, fwd, strafe });
        return orig.call(this, buttons, turn, fwd, strafe);
    };
    return 'wrapped';
})()`);
if (wrapped !== 'wrapped') fatal(`could not wrap the engine gamepad path (${wrapped})`);

// Drive one axis at a time and read the last call the engine received.
const push = async (axes, ms = 700) => {
    await ev(`(() => { window.__pad.axes = ${JSON.stringify(axes)}; window.__pad_calls = []; })()`);
    await sleep(ms);
    return ev(`(() => { const c = window.__pad_calls; return c.length ? c[c.length - 1] : null; })()`);
};

const centred = await push([0, 0, 0, 0]);
checkWith('a centred stick sends zeros', !!centred && centred.fwd === 0 && centred.turn === 0 && centred.strafe === 0,
      centred ? JSON.stringify(centred) : 'the engine received no gamepad call at all');

const fwd = await push([0, -1, 0, 0]);       // left stick fully forward
checkWith('left stick forward drives fwd, and only fwd',
      !!fwd && fwd.fwd < -50 && fwd.turn === 0 && fwd.strafe === 0, JSON.stringify(fwd));

const strafe = await push([1, 0, 0, 0]);     // left stick fully right
checkWith('left stick right drives strafe', !!strafe && strafe.strafe > 50 && strafe.fwd === 0, JSON.stringify(strafe));

const turn = await push([0, 0, 1, 0]);       // right stick fully right
checkWith('right stick drives turn', !!turn && turn.turn > 50 && turn.fwd === 0, JSON.stringify(turn));

// Inside the deadzone (default 0.15) the curve must return exactly 0 — this is
// the half a raw pass-through would break while every other assertion still
// passed.
const dead = await push([0.1, 0.1, 0.1, 0]);
checkWith('a stick inside the deadzone sends zero',
      !!dead && dead.fwd === 0 && dead.strafe === 0 && dead.turn === 0, JSON.stringify(dead));

// Disconnect: input.js stops polling, so nothing further arrives.
await ev(`(() => { window.__pad.axes = [0, -1, 0, 0]; window.dispatchEvent(new Event('gamepaddisconnected')); window.__pad_calls = []; })()`);
await sleep(700);
const after = await ev(`window.__pad_calls.length`);
checkWith('after gamepaddisconnected the pad is not read', after === 0, `${after} call(s) after the disconnect`);

// and a pad that connects while the game runs is read from then on
await ev(`window.dispatchEvent(new Event('gamepadconnected'))`);
const back = await push([0, -1, 0, 0]);
checkWith('a pad connected during the game is read', !!back && back.fwd < -50, back ? JSON.stringify(back) : 'no call');

summary('browser-gamepad: the analog path reaches the engine '
      + '(the Gamepad API itself is not exercised — no headless runner has a stick)');
process.exit();
