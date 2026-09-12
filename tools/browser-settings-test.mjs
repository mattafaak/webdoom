// Settings and input as a HOSTILE-INPUT surface.
//
// spec.md tenet 4 names "the network, the WAD, or the user".  The network and
// the WAD have gates (net-fuzz, hostile-server, wad-content-fuzz, http-fuzz);
// the third had none, and localStorage IS user input -- editable in devtools,
// shared by every page on the origin, and carried forward across versions of
// this app by a spread with two hand-written migrations in front of it.
//
// This also closes promises-index rme-004, "the rebind UI ... has no
// automated test".
//
// Everything here is asserted through what a PLAYER can see -- the rendered
// panel, the overlays, localStorage -- not through module internals, because
// the defect in every one of these cases is what reaches the screen.
// usage: node tools/browser-settings-test.mjs [url]
import { spawn } from 'node:child_process';
import { chromeBin, chromeProfileArg, reapOnExit } from './chrome-harness.mjs';

const CDP = 9247;
const chrome = spawn(chromeBin(), [
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
const excs = [];
ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown')
        excs.push(String(m.params.exceptionDetails?.exception?.description ?? '').split('\n')[0]);
};
const cdp = (m, p = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async e => (await cdp('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
const key = async (k, vk, code) => {
    code ??= k.length === 1 ? `Key${k.toUpperCase()}` : k;
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, text: k.length === 1 ? k : undefined });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk });
    await sleep(120);
};
await cdp('Runtime.enable'); await cdp('Page.enable');
const done = c => { chrome.kill(); process.exit(c); };

const results = [];
const check = (name, ok, detail) => {
    results.push({ name, ok, detail });
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name} — ${detail}`);
};
const hardFail = m => { console.error('FAIL:', m); done(1); };

// Seed localStorage, then reload so loadSettings() reads it at module scope.
async function bootWith(stored) {
    await ev(`(() => { try { localStorage.setItem('webdoom.input', ${JSON.stringify(JSON.stringify(stored))}); return 1; } catch { return 0; } })()`);
    await cdp('Page.reload');
    await sleep(1200);
    for (let i = 0; i < 40; i++) {
        await sleep(500);
        const got = await ev(`(() => { const r = document.querySelector('#dmenu .row[data-label="SINGLE PLAYER"]');
            if (!r) return false; r.click();
            const g = document.querySelector('#dmenu .row[data-label*="ULTIMATE"]') || document.querySelector('#dmenu .row[data-wad]');
            return g ? (g.click(), true) : false; })()`);
        if (got) break;
    }
    for (let i = 0; i < 40; i++) {
        await sleep(500);
        if (await ev(`!!window.webdoom && !!document.getElementById('settings')`)) return true;
    }
    return false;
}
const openPanel = async () => {
    if (!await ev(`document.getElementById('settings')?.hidden === false`)) await key('F8', 0x77);
    await sleep(250);
    return ev(`document.getElementById('settings')?.hidden === false`);
};

// ── 1. localStorage that is not what the app wrote ───────────────────────────
//
// Not a plausible corruption: a deliberate one, because the shape of the fix
// has to be "validate", not "handle the two cases someone thought of".
const HOSTILE = {
    mouseSens: 'abc',
    padTurnSpeed: null,
    padDeadzone: 99,
    mouseY: 'weird',
    musicBackend: 'evil',
    alwaysRun: 'yes',
    smooth: 0,
    wideMode: [],
    binds: 'not an object',
};
if (!await bootWith(HOSTILE)) hardFail('boot timeout with hostile settings — nothing was measured');
if (!await openPanel()) hardFail('settings panel would not open — nothing below could be read');

const panel = async () => ev(`document.getElementById('settings')?.innerHTML ?? ''`);
const val = sel => ev(`document.querySelector('#settings ${sel}')?.value ?? null`);

{
    // READ THE VALUE IN FORCE, NOT THE WIDGET.  The first cut of this test
    // asserted on #sens/#pturn/#musicBackend and PASSED against the unfixed
    // tree -- because an <input type=range value="abc"> renders the midpoint
    // and a <select> with no matching option renders its first one.  The form
    // controls launder the display while `settings.mouseSens` is still the
    // string 'abc' and that is what the input path multiplies by.
    //
    // Any panel change calls saveSettings(s) on the live object, so a toggle
    // and a read-back of localStorage is the settings object itself.
    await ev(`(() => { const c = document.querySelector('#settings #arun');
        c.checked = !c.checked; c.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`);
    await sleep(200);
    const live = await ev(`(() => { try { return JSON.parse(localStorage.getItem('webdoom.input') || '{}'); }
                                    catch { return null; } })()`) ?? {};
    const num = (k, lo, hi) => typeof live[k] === 'number' && Number.isFinite(live[k]) && live[k] >= lo && live[k] <= hi;
    check('IN FORCE: corrupt mouseSens is not the live value',
        num('mouseSens', 1, 12), `settings.mouseSens = ${JSON.stringify(live.mouseSens)}`);
    check('IN FORCE: corrupt padTurnSpeed is not the live value',
        num('padTurnSpeed', 0.4, 2), `settings.padTurnSpeed = ${JSON.stringify(live.padTurnSpeed)}`);
    check('IN FORCE: out-of-range padDeadzone is clamped',
        num('padDeadzone', 0, 0.9), `settings.padDeadzone = ${JSON.stringify(live.padDeadzone)}`);
    check('IN FORCE: an unknown musicBackend is not the live value',
        ['opl2', 'opl3', 'gm'].includes(live.musicBackend), `settings.musicBackend = ${JSON.stringify(live.musicBackend)}`);
    check('IN FORCE: an unknown mouseY is not the live value',
        ['off', 'look', 'move'].includes(live.mouseY), `settings.mouseY = ${JSON.stringify(live.mouseY)}`);
    check('IN FORCE: non-boolean flags are booleans',
        typeof live.smooth === 'boolean' && typeof live.wideMode === 'boolean',
        `smooth=${JSON.stringify(live.smooth)} wideMode=${JSON.stringify(live.wideMode)}`);
    check('IN FORCE: binds is a complete map of action -> key string',
        live.binds && typeof live.binds === 'object' && !Array.isArray(live.binds)
        && Object.keys(live.binds).length >= 11
        && Object.values(live.binds).every(v => typeof v === 'string' && v.length > 0),
        `binds = ${JSON.stringify(live.binds).slice(0, 90)}`);

    const html = await panel();
    check('no NaN/undefined/null reaches the rendered panel',
        !/NaN|undefined|"null"|>null</.test(html),
        (html.match(/NaN|undefined|null/g) ?? []).join(',') || 'none');

    // binds as a STRING: 'not an object'[a.id] is undefined for every action.
    const labels = await ev(`[...document.querySelectorAll('#settings .bind')].map(b => b.textContent)`);
    check('every keybind button shows a key, not a blank or "undefined"',
        Array.isArray(labels) && labels.length > 0 && labels.every(l => l && l.trim() && !/undefined/i.test(l)),
        `${labels?.length ?? 0} buttons: ${(labels ?? []).join(' ')}`);
}

// ── 2. a bind the stored settings have never heard of ────────────────────────
//
// ACTIONS grows between releases.  The spread replaced `binds` WHOLESALE, so
// an action added after a user's last save had no key at all -- and the panel
// rendered keyName(undefined), which is the literal string "undefined" on a
// button that cannot be read and has no way back to its default.
{
    const partial = { binds: { forward: 'KeyW', back: 'KeyS' } };   // the other nine are missing
    if (!await bootWith(partial)) hardFail('boot timeout with a partial bind map');
    if (!await openPanel()) hardFail('settings panel would not open (partial binds)');
    const labels = await ev(`[...document.querySelectorAll('#settings .bind')].map(b => b.textContent)`);
    const bad = (labels ?? []).filter(l => !l || !l.trim() || /undefined/i.test(l));
    check('an action missing from stored binds falls back to its default key',
        bad.length === 0, `${bad.length} of ${labels?.length ?? 0} unreadable: ${bad.join(',') || 'none'}`);
    const kept = await ev(`(() => { const b = [...document.querySelectorAll('#settings .bind')]
        .find(x => x.dataset.id === 'forward'); return b?.textContent ?? null; })()`);
    check('CONTROL: a bind that WAS stored is still honoured',
        /^W$/i.test(String(kept ?? '')), `forward = ${JSON.stringify(kept)}`);
}

// ── 3. Reset defaults has to reset what the player can see ───────────────────
//
// It assigned defaults and re-rendered, calling none of the appliers -- so the
// crosshair, stats and demo-timer overlays stayed on screen, and wide mode
// stayed on with its checkbox reading off.  The panel said one thing and the
// game did another.
{
    if (!await bootWith({})) hardFail('boot timeout with default settings');
    if (!await openPanel()) hardFail('settings panel would not open (reset case)');

    await ev(`(() => { const c = document.querySelector('#settings #showCrosshair');
        c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`);
    await sleep(200);
    const onNow = await ev(`document.getElementById('qol-crosshair')?.hidden === false`);
    check('CONTROL: ticking the crosshair box shows the crosshair',
        onNow === true, `#qol-crosshair hidden=${!onNow}`);

    await ev(`document.querySelector('#settings #reset').click()`);
    await sleep(300);
    const boxAfter = await ev(`document.querySelector('#settings #showCrosshair')?.checked`);
    const overlayAfter = await ev(`document.getElementById('qol-crosshair')?.hidden`);
    check('Reset defaults clears the checkbox', boxAfter === false, `checked=${boxAfter}`);
    check('Reset defaults also takes the overlay off the screen',
        overlayAfter === true, `#qol-crosshair hidden=${overlayAfter}`);
}

// ── 4. rebinding: Escape must cancel, not become the binding ─────────────────
//
// The capture took the next keydown of ANY kind.  Pressing Escape -- the one
// key a person presses to mean "no" -- bound Escape to that action, and there
// was no cancel, no timeout and no way to tell from the button that the panel
// was still waiting.
{
    if (!await bootWith({})) hardFail('boot timeout for the rebind case');
    if (!await openPanel()) hardFail('settings panel would not open (rebind case)');

    const beforeLabel = await ev(`(() => { const b = [...document.querySelectorAll('#settings .bind')]
        .find(x => x.dataset.id === 'automap'); return b?.textContent ?? null; })()`);
    // The swap check compares CODES, which is what is stored; the label is the
    // prettified form ("Tab" for 'Tab', " Left" for 'ArrowLeft').
    const before = await ev(`(() => { try { return JSON.parse(localStorage.getItem('webdoom.input') || '{}').binds?.automap ?? 'Tab'; } catch { return 'Tab'; } })()`);
    await ev(`[...document.querySelectorAll('#settings .bind')].find(x => x.dataset.id === 'automap').click()`);
    await sleep(150);
    const waiting = await ev(`(() => { const b = [...document.querySelectorAll('#settings .bind')]
        .find(x => x.dataset.id === 'automap'); return b?.textContent ?? null; })()`);
    check('CONTROL: clicking a bind button enters capture',
        /press a key/i.test(String(waiting ?? '')), `button reads ${JSON.stringify(waiting)}`);

    await key('Escape', 27);
    await sleep(250);
    const stored = await ev(`(() => { try { return JSON.parse(localStorage.getItem('webdoom.input') || '{}').binds?.automap ?? null; } catch { return 'unreadable'; } })()`);
    const after = await ev(`(() => { const b = [...document.querySelectorAll('#settings .bind')]
        .find(x => x.dataset.id === 'automap'); return b?.textContent ?? null; })()`);
    check('Escape does not become the binding',
        stored !== 'Escape', `stored bind = ${JSON.stringify(stored)}`);
    check('Escape leaves capture, so the button is readable again',
        !/press a key/i.test(String(after ?? '')) && String(after ?? '').trim().length > 0,
        `button reads ${JSON.stringify(after)} (was ${JSON.stringify(beforeLabel)})`);

    // A key already bound elsewhere: two actions on one key makes one of them
    // unreachable, and silently unbinding the other leaves an unreadable
    // button.  They swap.
    await ev(`[...document.querySelectorAll('#settings .bind')].find(x => x.dataset.id === 'automap').click()`);
    await sleep(150);
    await key('w', 87);
    await sleep(250);
    const binds = await ev(`(() => { try { return JSON.parse(localStorage.getItem('webdoom.input') || '{}').binds ?? null; } catch { return null; } })()`);
    check('binding a key another action holds swaps the two, losing neither',
        binds?.automap === 'KeyW' && binds?.forward === before,
        `automap=${JSON.stringify(binds?.automap)} forward=${JSON.stringify(binds?.forward)} (forward should be the old automap key ${JSON.stringify(before)})`);
}

// A run that asserted nothing must not pass.
if (results.length < 18) hardFail(`only ${results.length} assertions ran — the suite did not complete`);
const uncaught = excs.filter(e => !/ResizeObserver/.test(e));
check('no uncaught exception while abusing the settings surface',
    uncaught.length === 0, uncaught.slice(0, 3).join(' | ') || 'none');

const bad = results.filter(r => !r.ok);
console.log(bad.length
    ? `FAIL — browser-settings: ${bad.length} of ${results.length} assertions failed`
    : `PASS — browser-settings: all ${results.length} assertions (hostile localStorage, partial binds, reset-defaults, rebind cancel)`);
done(bad.length ? 1 : 0);
