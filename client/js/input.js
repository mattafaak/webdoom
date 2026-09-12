// Input: keyboard (rebindable), pointer-lock mouse, gamepad. All paths
// funnel into the engine's event queue / gamepad globals; bindings and
// tuning persist in localStorage ('webdoom.input').

// doomdef.h key codes
import { teardownLedger } from './ui.js';

export const DK = {
    RIGHT: 0xae, LEFT: 0xac, UP: 0xad, DOWN: 0xaf,
    ESCAPE: 27, ENTER: 13, TAB: 9, BACKSPACE: 127, PAUSE: 0xff,
    RSHIFT: 0x80+0x36, RCTRL: 0x80+0x1d, RALT: 0x80+0x38,
    F1: 0x80+0x3b, F11: 0x80+0x57, F12: 0x80+0x58,
    COMMA: 44, PERIOD: 46, SPACE: 32, MINUS: 0x2d, EQUALS: 0x3d,
};

// Rebindable actions → default browser codes. Each action maps to the
// engine key that drives it (the engine's own config stays stock).
export const ACTIONS = [
    { id: 'forward',     label: 'Move forward',  dk: DK.UP,      def: 'KeyW' },
    { id: 'back',        label: 'Move back',     dk: DK.DOWN,    def: 'KeyS' },
    { id: 'strafeLeft',  label: 'Strafe left',   dk: DK.COMMA,   def: 'KeyA' },
    { id: 'strafeRight', label: 'Strafe right',  dk: DK.PERIOD,  def: 'KeyD' },
    { id: 'turnLeft',    label: 'Turn left',     dk: DK.LEFT,    def: 'ArrowLeft' },
    { id: 'turnRight',   label: 'Turn right',    dk: DK.RIGHT,   def: 'ArrowRight' },
    { id: 'fire',        label: 'Fire',          dk: DK.RCTRL,   def: 'ControlLeft' },
    { id: 'use',         label: 'Use / open',    dk: DK.SPACE,   def: 'KeyE' },
    { id: 'run',         label: 'Run',           dk: DK.RSHIFT,  def: 'ShiftLeft' },
    { id: 'strafeMod',   label: 'Strafe modifier', dk: DK.RALT,  def: 'AltLeft' },
    { id: 'automap',     label: 'Automap',       dk: DK.TAB,     def: 'Tab' },
];

// Fixed (non-rebindable) pass-through keys
const FIXED = {
    Escape: DK.ESCAPE, Enter: DK.ENTER, Backspace: DK.BACKSPACE,
    Space: DK.SPACE, Pause: DK.PAUSE, Minus: DK.MINUS, Equal: DK.EQUALS,
    ArrowUp: DK.UP, ArrowDown: DK.DOWN, ArrowLeft: DK.LEFT, ArrowRight: DK.RIGHT,
    ShiftRight: DK.RSHIFT, ControlRight: DK.RCTRL, AltRight: DK.RALT,
    Tab: DK.TAB,
};
for (let i = 1; i <= 10; i++) FIXED['F' + i] = DK.F1 + (i - 1);
FIXED.F11 = DK.F11; FIXED.F12 = DK.F12;
for (let i = 0; i <= 9; i++) FIXED['Digit' + i] = 48 + i;

const EV_KEYDOWN = 0, EV_KEYUP = 1, EV_MOUSE = 2;

// Long enough to find a key, short enough that a forgotten capture ends.
const CAPTURE_TIMEOUT_MS = 8000;

export const defaultSettings = () => ({
    binds: Object.fromEntries(ACTIONS.map(a => [a.id, a.def])),
    mouseSens: 4,          // multiplier; 4 ≈ vanilla's <<2
    mouseY: 'off',         // 'off' | 'look' (freelook) | 'move' (1993)
    alwaysRun: false,
    smooth: true,          // uncapped-fps render interpolation
    opl3: false,           // task 17.1 legacy: false=OPL2 mono, true=OPL3 stereo
                           // superseded by musicBackend in task 17.2b; kept for compat
    musicBackend: 'opl2',  // task 17.2b: 'opl2' | 'opl3' | 'gm'
    padDeadzone: 0.15,
    padTurnSpeed: 1.0,
    wideMode: false,       // task 18.3: 854-px Hor+ wide render; false = 320 (default)
    panini: false,         // task 18.3: cylindrical remap shader; OFF by default
    showFullscreen: false, // task 19.1: hover fullscreen button; OFF by default
    showCrosshair: false,  // task 19.1: static crosshair overlay; OFF by default
    showStats: false,      // task 19.1: level time/stats widget; OFF by default
    showDemoTimer: false,  // task 19.1: demo timer + progress bar; OFF by default
});

// The shape localStorage is ALLOWED to have.  spec.md tenet 4 names "the
// network, the WAD, or the user"; localStorage is the third -- editable in
// devtools, shared by every page on the origin, and carried across versions of
// this app -- and `{ ...defaultSettings(), ...stored }` validated none of it.
// A stored mouseSens of "abc" reached the input path as a string and every
// mouse delta became NaN; the settings panel showed "7", because an
// <input type=range> with an invalid value renders its midpoint.  The widget
// is not the value in force.
//
// Bounds match the panel's own controls (settings.js: sens 1-12, pturn
// 0.4-2), so a hand-edited value cannot reach somewhere the UI cannot.
const SCHEMA = {
    mouseSens:      { num: [1, 12] },
    padDeadzone:    { num: [0, 0.9] },
    padTurnSpeed:   { num: [0.4, 2] },
    mouseY:         { oneOf: ['off', 'look', 'move'] },
    musicBackend:   { oneOf: ['opl2', 'opl3', 'gm'] },
    alwaysRun:      { bool: true },
    smooth:         { bool: true },
    opl3:           { bool: true },
    wideMode:       { bool: true },
    panini:         { bool: true },
    showFullscreen: { bool: true },
    showCrosshair:  { bool: true },
    showStats:      { bool: true },
    showDemoTimer:  { bool: true },
};

// KeyboardEvent.code is alphanumeric; anything else was not written by us.
const CODE_RE = /^[A-Za-z][A-Za-z0-9]{0,31}$/;

function sanitizeSettings(stored) {
    const out = defaultSettings();
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return out;
    for (const [k, rule] of Object.entries(SCHEMA)) {
        if (!(k in stored)) continue;
        const v = stored[k];
        if (rule.bool) { if (typeof v === 'boolean') out[k] = v; }
        else if (rule.oneOf) { if (rule.oneOf.includes(v)) out[k] = v; }
        else if (rule.num && typeof v === 'number' && Number.isFinite(v))
            out[k] = Math.min(rule.num[1], Math.max(rule.num[0], v));
    }
    // binds PER ACTION, never wholesale.  ACTIONS grows between releases, and
    // the spread replaced the whole object -- so an action added after a user's
    // last save had no key, and settings.js rendered keyName(undefined) as the
    // literal string "undefined" on a button with no way back to its default.
    const b = stored.binds;
    if (b && typeof b === 'object' && !Array.isArray(b))
        for (const a of ACTIONS)
            if (typeof b[a.id] === 'string' && CODE_RE.test(b[a.id])) out.binds[a.id] = b[a.id];
    return out;
}

export function loadSettings() {
    let stored;
    try { stored = JSON.parse(localStorage.getItem('webdoom.input') ?? '{}'); }
    catch { return defaultSettings(); }
    const s = sanitizeSettings(stored);
    // Migrations read the RAW stored object, because they are statements about
    // what was SAVED.  The pre-freelook one used to test `!s.mouseY` on the
    // merged object, where mouseY is always 'off' from the defaults -- so it
    // was dead from the day mouseY gained a default, and a legacy 1993-style
    // preference silently became 'off'.
    if (stored.mouseMove === true && stored.mouseY === undefined) s.mouseY = 'move';
    // task 17.2b: opl3:true with no musicBackend promotes to the 3-way picker.
    if (stored.opl3 === true && stored.musicBackend === undefined) s.musicBackend = 'opl3';
    return s;
}

export function saveSettings(s) {
    try {
        localStorage.setItem('webdoom.input', JSON.stringify(s));
    } catch { /* quota exceeded or storage disabled — continue in-memory */ }
}

// weapon digit groups for cycle buttons (digit key → doom behavior)
const WEAPON_DIGITS = [
    { digit: 49, weapons: [0, 7] },     // 1: fist / chainsaw
    { digit: 50, weapons: [1] },        // 2: pistol
    { digit: 51, weapons: [2, 8] },     // 3: shotgun / super shotgun
    { digit: 52, weapons: [3] },        // 4: chaingun
    { digit: 53, weapons: [4] },        // 5: rocket launcher
    { digit: 54, weapons: [5] },        // 6: plasma
    { digit: 55, weapons: [6] },        // 7: BFG
];

export function createInput(doom, canvas, settings) {
    // Teardown ledger (task 23.7b).  Every listener this module attaches is
    // recorded here so quit-to-menu can remove it.  Without this each boot
    // added another live handler on `window`, and after a quit they kept firing
    // into a wasm instance I_Quit had force-exited.
    const { on, off: _teardownAll } = teardownLedger();

    const post = (t, a = 0, b = 0, c = 0) => doom._web_input_event(t, a, b, c);
    const tapKey = dk => { post(EV_KEYDOWN, dk); post(EV_KEYUP, dk); };

    let capture = null;             // action id being rebound, or null
    let captureTimer = 0;           // capture cannot wait forever with no way out
    let mouseAccX = 0, mouseAccY = 0, mouseButtons = 0, mouseDirty = false;
    let pitch = 0, sentPitch = 0;   // freelook shear, screen pixels
    const heldKeys = new Set();     // game keys currently down (for release-all)

    // Release every held key + mouse button. A keyup can be lost whenever
    // focus or pointer-lock changes mid-press — most infamously ALT (the
    // strafe modifier), which the OS/browser steals to reach a menu bar,
    // leaving the engine stuck in strafe-lock. Flush on menu-open and blur
    // so no modifier can latch on.
    const releaseAll = () => {
        for (const dk of heldKeys) post(EV_KEYUP, dk);
        heldKeys.clear();
        if (mouseButtons) { post(EV_MOUSE, 0, 0, 0); mouseButtons = 0; }
        runHeld = false;            // let always-run re-assert next frame
    };

    const codeToDk = (code, key) => {
        // in menus, typed characters beat game bindings (savegame names
        // must accept W/A/S/D); navigation keys stay in FIXED
        if (doom._web_ui_mode() && key?.length === 1) {
            const c = key.toLowerCase().charCodeAt(0);
            if (c >= 32 && c < 127) return c;
        }
        for (const a of ACTIONS)
            if (settings.binds[a.id] === code) return a.dk;
        return FIXED[code] ?? null;
    };

    // --- keyboard --------------------------------------------------------
    // The settings panel is a modal dialog, and its own controls are sliders,
    // checkboxes and a key-capture button.  Only the POINTERLOCK handler
    // consulted it, so while the panel was open every keystroke also reached
    // the engine: arrow keys moved the player behind the panel, and a key
    // pressed on a slider raced the slider's own handler.
    const panelOpen = () => document.getElementById('settings')?.hidden === false;

    const onKey = down => e => {
        // capture is checked first: rebinding happens WITH the panel open, and
        // it is the one thing that must still see the key.
        if (!capture && panelOpen()) return;
        if (capture) {
            if (down) {
                // Escape is how a person says "no".  It used to BECOME the
                // binding, and then the action could only be reached by the
                // key that also opens the engine menu.
                if (e.code === 'Escape') { endCapture(); e.preventDefault(); return; }
                // A key already bound elsewhere SWAPS rather than duplicating:
                // two actions on one key is unreachable for one of them, and
                // silently unbinding the other leaves a button no one can read.
                const taken = ACTIONS.find(a => a.id !== capture && settings.binds[a.id] === e.code);
                if (taken) settings.binds[taken.id] = settings.binds[capture];
                settings.binds[capture] = e.code;
                saveSettings(settings);
                endCapture();
            }
            e.preventDefault();
            return;
        }
        let dk = codeToDk(e.code, e.key);
        if (dk === null && e.key.length === 1) {
            const c = e.key.toLowerCase().charCodeAt(0);
            if (c >= 32 && c < 127) dk = c;
        }
        if (dk === null) return;
        e.preventDefault();
        if (settings.alwaysRun && dk === DK.RSHIFT) return;   // run held below
        if (down) heldKeys.add(dk); else heldKeys.delete(dk);
        post(down ? EV_KEYDOWN : EV_KEYUP, dk);
    };
    on(window, 'keydown', onKey(true));
    on(window, 'keyup', onKey(false));
    // Focus loss (alt-tab, OS menu) drops keyups — release everything so no
    // key latches down while we're not listening.
    on(window, 'blur', releaseAll);

    // --- mouse (pointer lock) ---------------------------------------------
    // Esc always exits pointer lock at the browser level and the keydown
    // never reaches the page — so treat lock-loss as "open the menu", and
    // re-lock when the engine menu closes. Esc then feels like one key:
    // menu open + mouse free, menu closed + mouse captured.
    on(canvas, 'click', () => {
        if (document.pointerLockElement !== canvas)
            canvas.requestPointerLock();
    });
    on(document, 'pointerlockchange', () => {
        if (document.pointerLockElement !== canvas && !panelOpen()
            && !doom._web_ui_mode())
            tapKey(DK.ESCAPE);          // engine opens its menu
    });
    on(window, 'mousemove', e => {
        if (document.pointerLockElement !== canvas) return;
        mouseAccX += e.movementX;
        mouseAccY += e.movementY;
    });
    const mouseBtn = down => e => {
        if (document.pointerLockElement !== canvas) return;
        e.preventDefault();
        // engine defaults: bit0 fire, bit1 strafe, bit2 forward.
        // Mask flushes with motion in frame() — the engine accumulates.
        const bit = e.button === 0 ? 1 : e.button === 2 ? 2 : 4;
        mouseButtons = down ? (mouseButtons | bit) : (mouseButtons & ~bit);
        mouseDirty = true;
    };
    on(window, 'mousedown', mouseBtn(true));
    on(window, 'mouseup', mouseBtn(false));
    on(window, 'contextmenu', e => {
        if (document.pointerLockElement === canvas) e.preventDefault();
    });
    on(window, 'wheel', e => {
        if (document.pointerLockElement !== canvas) return;
        cycleWeapon(e.deltaY > 0 ? 1 : -1);
    }, { passive: true });

    // --- weapon cycling ----------------------------------------------------
    function cycleWeapon(dir) {
        const st = doom._web_weapon_state();
        const ready = st & 15, owned = st >> 8;
        let gi = WEAPON_DIGITS.findIndex(g => g.weapons.includes(ready));
        if (gi < 0) gi = 1;
        for (let step = 1; step <= WEAPON_DIGITS.length; step++) {
            const g = WEAPON_DIGITS[(gi + dir * step + 7 * step) % 7];
            if (g.weapons.some(w => owned & (1 << w))) { tapKey(g.digit); return; }
        }
    }

    // --- gamepad ------------------------------------------------------------
    let padPrev = 0;
    // Reset edge-detection state when the gamepad is disconnected so that
    // held buttons re-trigger correctly on reconnect.
    on(window, 'gamepaddisconnected', () => { padPrev = 0; });
    const curve = v => {
        const dz = settings.padDeadzone;
        const m = Math.abs(v);
        if (m < dz) return 0;
        const n = (m - dz) / (1 - dz);
        return Math.sign(v) * Math.pow(n, 1.6);
    };

    function pollGamepad() {
        const gpads = navigator.getGamepads?.();
        const gp = gpads?.[0];
        if (!gp) return;
        const b = i => gp.buttons[i]?.pressed ?? false;
        const uiMode = doom._web_ui_mode();

        // edge-triggered buttons
        const edges = [
            [9, () => tapKey(DK.ESCAPE)],                        // start
            [8, () => tapKey(DK.TAB)],                           // select: automap
            [4, () => uiMode || cycleWeapon(-1)],                // LB
            [5, () => uiMode || cycleWeapon(1)],                 // RB
        ];
        if (uiMode) {
            edges.push(
                [12, () => tapKey(DK.UP)], [13, () => tapKey(DK.DOWN)],
                [14, () => tapKey(DK.LEFT)], [15, () => tapKey(DK.RIGHT)],
                [0, () => tapKey(DK.ENTER)], [1, () => tapKey(DK.BACKSPACE)],
                [2, () => tapKey(DK.ENTER)],
            );
        }
        let now = 0;
        for (const [i] of edges) now |= b(i) << i;
        for (const [i, fn] of edges)
            if (b(i) && !(padPrev & (1 << i))) fn();
        padPrev = now;

        if (uiMode) { doom._web_gamepad(0, 0, 0, 0); return; }

        // held buttons: bit0 fire (RT/X), bit2 speed (LT/LS click), bit3 use (A)
        const held =
            ((b(7) || b(2)) ? 1 : 0) |
            ((b(6) || b(10) || settings.alwaysRun) ? 4 : 0) |
            (b(0) ? 8 : 0);
        const turn = Math.round(curve(gp.axes[2] ?? 0) * 100 * settings.padTurnSpeed);
        const fwd  = Math.round(curve(gp.axes[1] ?? 0) * 100);
        const strafe = Math.round(curve(gp.axes[0] ?? 0) * 100);
        doom._web_gamepad(held, turn, fwd, strafe);
        if (settings.mouseY === 'look')
            pitch -= curve(gp.axes[3] ?? 0) * 4;    // RS vertical
        else if (b(11)) pitch = 0;                  // RS click centers
    }

    // --- per-frame flush -----------------------------------------------------
    let runHeld = false;
    let wasUiMode = false;
    function frame() {
        // engine menu just closed → recapture the mouse (the closing
        // keypress counts as user activation; if not, the next canvas
        // click re-locks)
        const uiMode = !!doom._web_ui_mode();
        if (!wasUiMode && uiMode) releaseAll();   // menu opened → drop held keys
        if (wasUiMode && !uiMode && document.pointerLockElement !== canvas)
            canvas.requestPointerLock()?.catch?.(() => {});
        wasUiMode = uiMode;
        if (mouseAccX || mouseAccY || mouseDirty) {
            const dx = Math.round(mouseAccX * settings.mouseSens);
            const dy = settings.mouseY === 'move' ? Math.round(-mouseAccY * settings.mouseSens) : 0;
            if (settings.mouseY === 'look')
                pitch -= mouseAccY * settings.mouseSens / 16;
            post(EV_MOUSE, mouseButtons, dx, dy);
            mouseAccX = mouseAccY = 0;
            mouseDirty = false;
        }
        if (settings.mouseY !== 'look' && pitch) pitch = 0;
        pitch = Math.max(-90, Math.min(90, pitch));
        if (Math.round(pitch) !== sentPitch) {
            sentPitch = Math.round(pitch);
            doom._web_set_pitch(sentPitch);
        }
        if (settings.alwaysRun !== runHeld) {
            runHeld = settings.alwaysRun;
            post(runHeld ? EV_KEYDOWN : EV_KEYUP, DK.RSHIFT);
        }
        pollGamepad();
    }

    let onCapture = null;
    // One exit from capture, so no path can leave the timer armed or the
    // button stuck on "press a key…".
    const endCapture = () => {
        clearTimeout(captureTimer);
        captureTimer = 0;
        capture = null;
        onCapture?.(null);
        onCapture = null;
    };
    return {
        frame,
        settings,
        startCapture(actionId, cb) {
            clearTimeout(captureTimer);
            capture = actionId;
            onCapture = cb;
            // Without this the panel waits forever, showing "press a key…" on a
            // button whose real binding can no longer be read, and every key
            // the player presses is swallowed by the capture.
            captureTimer = setTimeout(() => { if (capture) endCapture(); }, CAPTURE_TIMEOUT_MS);
        },
        cancelCapture() { endCapture(); },
        // settings.js asks before treating Escape as "close the dialog": while
        // a capture is armed, Escape means "cancel the capture" and onKey owns
        // it.  Two handlers on the same key need one of them to be able to
        // tell whose key it is.
        capturing: () => capture !== null,
        destroy() { _teardownAll(); },
    };
}