// The OPTIONS screen as a HOSTILE-INPUT surface.
//
// This is the successor to browser-settings-test.mjs, which drove the F8
// overlay (client/js/settings.js).  The overlay is gone: its settings are
// menu screens on the launcher now.  The coverage had to MOVE rather than
// vanish, so every assertion below maps to one the old test made, plus three
// the new UI needs and the old one could not have.
//
// spec.md tenet 4 names "the network, the WAD, or the user".  The network and
// the WAD have gates (net-fuzz, hostile-server, wad-content-fuzz, http-fuzz);
// localStorage IS user input -- editable in devtools, shared by every page on
// the origin, and carried forward across versions of this app.
//
// WHAT CHANGED, AND WHY THE REPLACEMENT IS NOT WEAKER
//
//   * "no NaN/undefined in the rendered panel" got STRONGER by accident of the
//     UI.  An <input type=range value="abc"> renders its midpoint, so the old
//     test had to read localStorage to find the value in force -- the widget
//     laundered it.  A menu row renders the value as TEXT, so the row IS the
//     value in force.  Both are still asserted.
//
//   * "0 engine key events while the dialog is open" cannot be ported: the
//     OPTIONS screen runs on the launcher, where no wasm instance exists at
//     all, so the guarantee is structural rather than an early return.  That
//     is asserted (§5), and the successor assertion -- the binds chosen here
//     are the ones the engine actually receives after booting -- is what
//     replaces it.  Deleting it without a successor would be a gate that
//     verified nothing.
//
//   * NEW, because the menu owns the keyboard: while a rebind capture is
//     armed the arrow keys must not move the skull and Escape must not pop the
//     screen (menu.js registers a bubble-phase keydown on window; the capture
//     listener is capture-phase and stops propagation).  And the Enter that
//     ARMS a capture must not become the binding -- activate() runs on
//     keydown, so a synchronously-armed capture sees that same press.
//
// usage: node tools/browser-options-test.mjs [url]
import { launchChrome } from './lib/cdp.mjs';
import { sleep } from './lib/util.mjs';
const chrome = await launchChrome();
const url = process.argv[2] ?? 'http://127.0.0.1:8666/';
const tab = await chrome.tab(url);
const { cdp, ev, key } = tab;
// first line of each exception, as the assertions below compare them
const excs = tab.errors;
const done = c => { chrome.kill(); process.exit(c); };

const results = [];
const check = (name, ok, detail) => {
    results.push({ name, ok, detail });
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name} — ${detail}`);
};
const hardFail = m => { console.error('FAIL:', m); done(1); };

// ── menu helpers ─────────────────────────────────────────────────────────────
// Rows carry data-label = the rendered text, uppercased (menu.js), so a row is
// addressed the way a player reads it.
const rows = () => ev(`[...document.querySelectorAll('#dmenu .row')].map(r => r.dataset.label)`);
const rowText = async pfx => ev(`document.querySelector('#dmenu .row[data-label^=${JSON.stringify(pfx)}]')?.dataset.label ?? null`);
const clickRow = async pfx => ev(`(() => { const r = document.querySelector('#dmenu .row[data-label^=${JSON.stringify(pfx)}]');
    if (!r) return false; r.click(); return true; })()`);
const hoverRow = async pfx => ev(`(() => { const r = document.querySelector('#dmenu .row[data-label^=${JSON.stringify(pfx)}]');
    if (!r) return false; r.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false })); return true; })()`);
const stored = async () => (await ev(`(() => { try { return JSON.parse(localStorage.getItem('webdoom.input') || '{}'); }
                                               catch { return null; } })()`)) ?? {};

// Seed localStorage, reload, and land on the launcher root.
async function bootLauncher(seed) {
    if (seed !== undefined)
        await ev(`(() => { try { localStorage.setItem('webdoom.input', ${JSON.stringify(JSON.stringify(seed))}); return 1; } catch { return 0; } })()`);
    await cdp('Page.reload');
    for (let i = 0; i < 40; i++) {
        await sleep(400);
        if (await ev(`!!document.querySelector('#dmenu .row[data-label="SINGLE PLAYER"]')`)) return true;
    }
    return false;
}
// State-machine edges (docs/state-machine.md): this file is the mapped test
// for T26 (LANDING -> OPTIONS), T27 (OPTIONS -> LANDING), T28 (OPTIONS ->
// OPTIONS-KEYS) and T29 (OPTIONS-KEYS -> OPTIONS, which ESC during a rebind
// capture must NOT take -- see §4c).
async function openOptions() {
    if (!await clickRow('OPTIONS')) return false;
    await sleep(250);
    return !!(await rowText('MOUSE SENSITIVITY'));
}
async function openControls() {
    if (!await clickRow('CONTROLS')) return false;
    await sleep(250);
    return !!(await rowText('MOVE FORWARD'));
}

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
    binds: 'not an object',
};
if (!await bootLauncher(HOSTILE)) hardFail('launcher never came up with hostile settings — nothing was measured');
if (!await openOptions()) hardFail('OPTIONS screen would not open — nothing below could be read');

{
    // Any row change calls saveSettings() on the live object, so a toggle and a
    // read-back of localStorage IS the settings object.  ALWAYS RUN is the
    // cheapest one to poke.
    await clickRow('ALWAYS RUN');
    await sleep(200);
    const live = await stored();
    const num = (k, lo, hi) => typeof live[k] === 'number' && Number.isFinite(live[k]) && live[k] >= lo && live[k] <= hi;
    check('IN FORCE: corrupt mouseSens is not the live value',
        num('mouseSens', 1, 12), `settings.mouseSens = ${JSON.stringify(live.mouseSens)}`);
    check('IN FORCE: corrupt padTurnSpeed is not the live value',
        num('padTurnSpeed', 0.4, 2), `settings.padTurnSpeed = ${JSON.stringify(live.padTurnSpeed)}`);
    check('IN FORCE: out-of-range padDeadzone is clamped',
        num('padDeadzone', 0, 0.9), `settings.padDeadzone = ${JSON.stringify(live.padDeadzone)}`);
    check('IN FORCE: an unknown musicBackend is not the live value',
        ['opl2', 'opl3'].includes(live.musicBackend), `settings.musicBackend = ${JSON.stringify(live.musicBackend)}`);
    check('IN FORCE: an unknown mouseY is not the live value',
        ['off', 'look', 'move'].includes(live.mouseY), `settings.mouseY = ${JSON.stringify(live.mouseY)}`);
    check('IN FORCE: non-boolean flags are booleans',
        typeof live.smooth === 'boolean' && typeof live.alwaysRun === 'boolean',
        `smooth=${JSON.stringify(live.smooth)} alwaysRun=${JSON.stringify(live.alwaysRun)}`);
    check('IN FORCE: binds is a complete map of action -> key string',
        live.binds && typeof live.binds === 'object' && !Array.isArray(live.binds)
        && Object.keys(live.binds).length >= 11
        && Object.values(live.binds).every(v => typeof v === 'string' && v.length > 0),
        `binds = ${JSON.stringify(live.binds).slice(0, 90)}`);

    // The rendered row is the value in force here, not a widget that launders
    // it -- so this reads the screen and it means something.
    const labels = await rows();
    check('no NaN/undefined/null reaches the rendered OPTIONS screen',
        Array.isArray(labels) && labels.length > 0 && !labels.some(l => /NaN|UNDEFINED|NULL/.test(l)),
        (labels ?? []).filter(l => /NaN|UNDEFINED|NULL/.test(l)).join(',') || `none, ${labels?.length} rows`);
    check('every OPTIONS row shows a value, not an empty one',
        (labels ?? []).filter(l => /: <?\s*>?$/.test(l)).length === 0,
        `${labels?.length ?? 0} rows: ${(labels ?? []).slice(0, 3).join(' | ')}…`);
}

// ── 2. a bind the stored settings have never heard of ────────────────────────
//
// ACTIONS grows between releases.  A wholesale spread replaced `binds`, so an
// action added after a user's last save had no key at all -- and the UI
// rendered keyName(undefined), the literal string "undefined", on a control
// that cannot be read and has no way back to its default.
{
    const partial = { binds: { forward: 'KeyW', back: 'KeyS' } };   // the other nine are missing
    if (!await bootLauncher(partial)) hardFail('launcher never came up with a partial bind map');
    if (!await openOptions()) hardFail('OPTIONS would not open (partial binds)');
    if (!await openControls()) hardFail('CONTROLS would not open (partial binds)');
    const labels = (await rows()) ?? [];
    const binds = labels.filter(l => l.includes(':'));
    const bad = binds.filter(l => /UNDEFINED/.test(l) || /:\s*$/.test(l));
    check('an action missing from stored binds falls back to its default key',
        binds.length >= 11 && bad.length === 0,
        `${bad.length} of ${binds.length} unreadable: ${bad.join(',') || 'none'}`);
    const fwd = await rowText('MOVE FORWARD');
    check('CONTROL: a bind that WAS stored is still honoured',
        /:\s*W$/.test(String(fwd ?? '')), `row reads ${JSON.stringify(fwd)}`);
}

// ── 3. Reset defaults has to reset what the player can see ───────────────────
{
    if (!await bootLauncher({})) hardFail('launcher never came up for the reset case');
    if (!await openOptions()) hardFail('OPTIONS would not open (reset case)');

    await clickRow('ALWAYS RUN');       // OFF -> ON
    await sleep(150);
    await clickRow('MOUSE SENSITIVITY');// 4 -> 5
    await sleep(150);
    const changed = await stored();
    check('CONTROL: changing rows changes the stored settings',
        changed.alwaysRun === true && changed.mouseSens === 5,
        `alwaysRun=${changed.alwaysRun} mouseSens=${changed.mouseSens}`);

    await clickRow('RESET DEFAULTS');
    await sleep(250);
    const after = await stored();
    const run = await rowText('ALWAYS RUN');
    const sens = await rowText('MOUSE SENSITIVITY');
    check('Reset defaults restores the stored settings',
        after.alwaysRun === false && after.mouseSens === 4,
        `alwaysRun=${after.alwaysRun} mouseSens=${after.mouseSens}`);
    check('Reset defaults is visible on the screen, not just in storage',
        /OFF/.test(String(run ?? '')) && /<\s*4\s*>/.test(String(sens ?? '')),
        `${JSON.stringify(run)} / ${JSON.stringify(sens)}`);
}

// ── 4. rebinding ─────────────────────────────────────────────────────────────
{
    if (!await bootLauncher({})) hardFail('launcher never came up for the rebind case');
    if (!await openOptions()) hardFail('OPTIONS would not open (rebind case)');
    if (!await openControls()) hardFail('CONTROLS would not open (rebind case)');

    // (a) THE ENTER THAT ARMS THE CAPTURE MUST NOT BECOME THE BINDING.
    // activate() runs on the Enter keydown, so a capture armed synchronously is
    // listening while that same key is still down.  Same shape as "Escape
    // became the binding".
    //
    // HELD, not tapped, and that distinction is the whole assertion.  A single
    // tap cannot fail even with synchronous arming: a listener added during
    // dispatch does not receive the event being dispatched, so the DOM's own
    // snapshot rule hides the defect.  The AUTO-REPEAT keydown is a second
    // event and it does reach the capture -- measured: a held Enter bound
    // Enter, row read "AUTOMAP: ENTER".  Arming on the following keyup is what
    // makes that impossible.
    await hoverRow('AUTOMAP');
    await sleep(100);
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await sleep(120);
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, autoRepeat: true });
    await sleep(120);
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await sleep(250);
    const armed = await rowText('AUTOMAP');
    check('CONTROL: Enter on a bind row enters capture',
        /PRESS A KEY/.test(String(armed ?? '')), `row reads ${JSON.stringify(armed)}`);
    let binds = (await stored()).binds ?? {};
    check('a HELD Enter that armed the capture does not become the binding',
        binds.automap !== 'Enter', `automap = ${JSON.stringify(binds.automap)}`);

    // (b) WHILE ARMED, THE MENU MUST NOT ACT ON THE KEY.
    // Exactly ONE press: the capture consumes the first key and disarms, so a
    // second ArrowDown would legitimately move the cursor and the assertion
    // would be measuring the wrong thing.  ArrowDown is a fine binding; what
    // must not happen is the menu ALSO acting on it.
    const selBefore = await ev(`document.querySelector('#dmenu .row.sel')?.dataset.label ?? null`);
    const idxBefore = await ev(`[...document.querySelectorAll('#dmenu .row')].findIndex(r => r.classList.contains('sel'))`);
    await key('ArrowDown', 40);
    await sleep(200);
    const idxAfter = await ev(`[...document.querySelectorAll('#dmenu .row')].findIndex(r => r.classList.contains('sel'))`);
    binds = (await stored()).binds ?? {};
    check('the menu does not move the cursor on a key the capture consumed',
        idxBefore >= 0 && idxBefore === idxAfter,
        `row index ${idxBefore} -> ${idxAfter} (was ${JSON.stringify(selBefore)})`);
    check('CONTROL: that key did reach the capture and became the binding',
        binds.automap === 'ArrowDown', `automap = ${JSON.stringify(binds.automap)}`);

    // (c) Escape cancels a FRESH capture and does NOT pop the screen.
    await clickRow('AUTOMAP');
    await sleep(200);
    await key('Escape', 27);
    await sleep(250);
    const afterEsc = await rowText('AUTOMAP');
    const stillHere = await ev(`!!document.querySelector('#dmenu .row[data-label^="MOVE FORWARD"]')`);
    binds = (await stored()).binds ?? {};
    check('Escape does not become the binding',
        binds.automap !== 'Escape', `stored bind = ${JSON.stringify(binds.automap)}`);
    check('Escape leaves capture, so the row is readable again',
        !/PRESS A KEY/.test(String(afterEsc ?? '')) && String(afterEsc ?? '').trim().length > 0,
        `row reads ${JSON.stringify(afterEsc)}`);
    check('Escape cancels the capture WITHOUT leaving the CONTROLS screen',
        stillHere === true, `CONTROLS still shown = ${stillHere}`);

    // (d) a key another action holds SWAPS, losing neither.
    const before = ((await stored()).binds ?? {}).automap ?? 'Tab';
    await clickRow('AUTOMAP');
    await sleep(200);
    await key('w', 87);
    await sleep(250);
    binds = (await stored()).binds ?? {};
    check('binding a key another action holds swaps the two, losing neither',
        binds.automap === 'KeyW' && binds.forward === before,
        `automap=${JSON.stringify(binds.automap)} forward=${JSON.stringify(binds.forward)} (forward should be the old automap key ${JSON.stringify(before)})`);
}

// ── 5. there is no engine behind this screen, and the binds reach it ─────────
//
// The old test counted engine input events while the dialog was open and
// required 0.  On the launcher that is structural -- there is no wasm
// instance -- so the assertion below states the structure, and the one after
// it is the real successor: what was chosen here is what the engine receives.
{
    if (!await bootLauncher({})) hardFail('launcher never came up for the boot case');
    if (!await openOptions()) hardFail('OPTIONS would not open (boot case)');
    const noEngine = await ev(`!window.webdoom?.doom`);
    const canvasHidden = await ev(`document.getElementById('screen')?.hidden !== false`);
    check('no engine instance exists while OPTIONS is open',
        noEngine === true && canvasHidden === true,
        `doom=${!noEngine} canvasVisible=${!canvasHidden}`);

    // Rebind forward to K, then boot and read what the engine got.
    if (!await openControls()) hardFail('CONTROLS would not open (boot case)');
    await clickRow('MOVE FORWARD');
    await sleep(200);
    await key('k', 75);
    await sleep(250);
    const chosen = ((await stored()).binds ?? {}).forward;
    check('CONTROL: the rebind was stored', chosen === 'KeyK', `forward = ${JSON.stringify(chosen)}`);

    await key('Escape', 27); await sleep(200);   // CONTROLS -> OPTIONS
    await key('Escape', 27); await sleep(200);   // OPTIONS  -> root
    let booted = false;
    for (let i = 0; i < 40 && !booted; i++) {
        await sleep(400);
        booted = await ev(`(() => { const r = document.querySelector('#dmenu .row[data-label="SINGLE PLAYER"]');
            if (!r) return false; r.click();
            const g = document.querySelector('#dmenu .row[data-label*="ULTIMATE"]') || document.querySelector('#dmenu .row[data-wad]');
            return g ? (g.click(), true) : false; })()`);
    }
    if (!booted) hardFail('never reached a game — the successor assertion measured nothing');
    for (let i = 0; i < 40; i++) { await sleep(500); if (await ev(`!!window.webdoom?.doom`)) break; }

    // Get OUT of the engine's own menu and into a level.  codeToDk() passes a
    // printable key through as a CHARACTER while web_ui_mode() is true (so
    // savegame names can contain W/A/S/D), which means a bind is not consulted
    // at the title screen at all -- the first cut of this assertion measured
    // that and read 0.  Escape opens the menu, three Enters take
    // New Game -> episode -> skill.
    await key('Escape', 27);
    for (let i = 0; i < 3; i++) { await key('Enter', 13); await sleep(400); }
    let inLevel = false;
    for (let i = 0; i < 30 && !inLevel; i++) {
        await sleep(400);
        inLevel = (await ev(`window.webdoom?.doom?._web_ui_mode?.() ?? 1`)) === 0;
    }
    if (!inLevel) hardFail('never reached a level — a bind is not consulted in ui mode, so this would measure 0');

    // Not "the JS object still holds KeyK" -- that only proves an assignment.
    // Wrap the engine's own input entry point and press the rebound key: the
    // engine must receive DK.UP (0xad), which is what `forward` drives.  That
    // is the end of the path the OPTIONS screen exists to configure.
    const wrapped = await ev(`(() => {
        const d = window.webdoom?.doom;
        if (!d) return 'no-engine';
        const orig = d._web_input_event;
        window.__fwdKeydowns = 0;
        d._web_input_event = function (t, a, b, c) {
            if (t === 0 && a === 0xad) window.__fwdKeydowns++;
            return orig.call(this, t, a, b, c);
        };
        return 'wrapped';
    })()`);
    if (wrapped !== 'wrapped') hardFail(`could not wrap the engine input path (${wrapped})`);
    await key('k', 75);
    const sawForward = await ev(`window.__fwdKeydowns`);
    check('the key bound on OPTIONS drives forward in the running engine',
        sawForward > 0, `engine saw ${sawForward} forward keydown(s) for K`);
}

// ── 6. the accessibility surface of the new screens ─────────────────────────
{
    if (!await bootLauncher({})) hardFail('launcher never came up for the a11y case');
    if (!await openOptions()) hardFail('OPTIONS would not open (a11y case)');
    const a11y = await ev(`(() => {
        const st = document.getElementById('status');
        const bar = document.getElementById('loading-bar');
        const menu = document.querySelector('#dmenu .items');
        const rows = menu ? [...menu.querySelectorAll('.row')] : [];
        return {
            statusRole: st?.getAttribute('role'),
            statusLive: st?.getAttribute('aria-live'),
            barRole: bar?.getAttribute('role'),
            menuRole: menu?.getAttribute('role'),
            menuLabel: menu?.getAttribute('aria-label'),
            rows: rows.length,
            tabbable: rows.filter(r => r.tabIndex === 0).length,
            labelled: rows.filter(r => (r.getAttribute('aria-label') || '').trim().length > 0).length,
            orphanItems: [...document.querySelectorAll('[role=menuitem]')]
                .filter(r => !r.closest('[role=menu]')).length,
        };
    })()`);
    check('#status is a polite live region',
        a11y?.statusRole === 'status' && a11y.statusLive === 'polite',
        `role=${a11y?.statusRole} aria-live=${a11y?.statusLive}`);
    check('#loading-bar is a progressbar', a11y?.barRole === 'progressbar', `role=${a11y?.barRole}`);
    check('OPTIONS is a labelled menu with rows in it',
        a11y?.menuRole === 'menu' && a11y.menuLabel === 'OPTIONS' && a11y.rows > 1,
        `role=${a11y?.menuRole} label=${JSON.stringify(a11y?.menuLabel)}, ${a11y?.rows} rows`);
    check('every OPTIONS row carries an accessible name',
        a11y?.labelled === a11y?.rows, `${a11y?.labelled} of ${a11y?.rows} rows`);
    check('exactly one OPTIONS row is in the tab order (roving tabindex)',
        a11y?.tabbable === 1, `${a11y?.tabbable} of ${a11y?.rows} rows have tabindex 0`);
    check('no role="menuitem" is orphaned outside a role="menu"',
        a11y?.orphanItems === 0, `${a11y?.orphanItems} orphaned`);
}

// ── 7. the MUSIC row cycles the two OPL flavours and nothing else ──────────
{
    if (!await bootLauncher({ musicBackend: 'opl2' })) hardFail('launcher never came up for the music case');
    if (!await openOptions()) hardFail('OPTIONS would not open (music case)');
    await sleep(300);
    const m0 = await rowText('MUSIC');
    check('the MUSIC row reads the stored backend', /OPL2/.test(String(m0 ?? '')), `row reads ${JSON.stringify(m0)}`);
    await clickRow('MUSIC'); await sleep(300);
    const m1 = await rowText('MUSIC');
    check('a click steps MUSIC to OPL3', /OPL3/.test(String(m1 ?? '')), `row reads ${JSON.stringify(m1)}`);
    await clickRow('MUSIC'); await sleep(300);
    const m2 = await rowText('MUSIC');
    check('and back to OPL2 -- there is no third backend', /OPL2/.test(String(m2 ?? '')), `row reads ${JSON.stringify(m2)}`);
}

// ── CONTROLS must stay one column on a short viewport ────────────────────────
//
// render() decided columns TWICE: once for the scale, with
// `!s.nowrap && !hasThumb && items.length > 8`, and once again for maxHeight
// with the same shape MINUS the `!s.nowrap` term.  So the two disagreed for
// exactly the screens that opt out of columns.  CONTROLS is twelve rows with
// nowrap: true, and on a short viewport the scale loop drops to 2, the measured
// row width shrinks, cols comes out 2 or 3, and CONTROLS wrapped against its
// own contract.
//
// This suite never saw it because it drives Chrome at 1280x960, where the
// scale never drops far enough.  So the assertion has to resize.
{
    await cdp('Page.reload');
    await sleep(1800);
    await cdp('Emulation.setDeviceMetricsOverride',
              { width: 900, height: 540, deviceScaleFactor: 1, mobile: false });
    await sleep(400);
    if (!await openOptions())  hardFail('OPTIONS would not open at 900x540');
    if (!await openControls()) hardFail('CONTROLS would not open at 900x540');
    const geom = await ev(`(() => {
        const list = document.querySelector('#dmenu .items');
        const rs = [...list.children];
        return { n: rs.length,
                 cols: [...new Set(rs.map(r => Math.round(r.offsetLeft)))].length,
                 maxHeight: list.style.maxHeight || '' };
    })()`);
    check('CONTROLS stays ONE column at 900x540 (nowrap honoured by both decisions)',
          geom.n > 8 && geom.cols === 1 && geom.maxHeight === '',
          `${geom.n} rows in ${geom.cols} column(s), maxHeight="${geom.maxHeight}"`);
    await cdp('Emulation.clearDeviceMetricsOverride');
    await sleep(200);
}

// A run that asserted nothing must not pass.  The old F8 test held 28; this
// screen has more surface, so the floor goes up rather than down.
if (results.length < 30) hardFail(`only ${results.length} assertions ran — the suite did not complete`);
const uncaught = excs.filter(e => !/ResizeObserver/.test(e));
check('no uncaught exception while abusing the OPTIONS surface',
    uncaught.length === 0, uncaught.slice(0, 3).join(' | ') || 'none');

const bad = results.filter(r => !r.ok);
console.log(bad.length
    ? `FAIL — browser-options: ${bad.length} of ${results.length} assertions failed`
    : `PASS — browser-options: all ${results.length} assertions (hostile localStorage, partial binds, reset defaults, rebind capture, boot round trip, a11y, the MUSIC row)`);
done(bad.length ? 1 : 0);
