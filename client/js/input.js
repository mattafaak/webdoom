// Input: keyboard (rebindable), pointer-lock mouse, gamepad. All paths
// funnel into the engine's event queue / gamepad globals; bindings and
// tuning persist in localStorage ('webdoom.input').

// doomdef.h key codes
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

export const defaultSettings = () => ({
    binds: Object.fromEntries(ACTIONS.map(a => [a.id, a.def])),
    mouseSens: 4,          // multiplier; 4 ≈ vanilla's <<2
    mouseY: 'off',         // 'off' | 'look' (freelook) | 'move' (1993)
    alwaysRun: false,
    smooth: true,          // uncapped-fps render interpolation
    padDeadzone: 0.15,
    padTurnSpeed: 1.0,
});

export function loadSettings() {
    try {
        const s = { ...defaultSettings(), ...JSON.parse(localStorage.getItem('webdoom.input') ?? '{}') };
        if (s.mouseMove === true && !s.mouseY) s.mouseY = 'move';   // pre-freelook migration
        delete s.mouseMove;
        return s;
    } catch { return defaultSettings(); }
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
    const post = (t, a = 0, b = 0, c = 0) => doom._web_input_event(t, a, b, c);
    const tapKey = dk => { post(EV_KEYDOWN, dk); post(EV_KEYUP, dk); };

    let capture = null;             // action id being rebound, or null
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
    const onKey = down => e => {
        if (capture) {
            if (down) {
                settings.binds[capture] = e.code;
                saveSettings(settings);
                capture = null;
                onCapture?.(null);
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
    window.addEventListener('keydown', onKey(true));
    window.addEventListener('keyup', onKey(false));
    // Focus loss (alt-tab, OS menu) drops keyups — release everything so no
    // key latches down while we're not listening.
    window.addEventListener('blur', releaseAll);

    // --- mouse (pointer lock) ---------------------------------------------
    // Esc always exits pointer lock at the browser level and the keydown
    // never reaches the page — so treat lock-loss as "open the menu", and
    // re-lock when the engine menu closes. Esc then feels like one key:
    // menu open + mouse free, menu closed + mouse captured.
    canvas.addEventListener('click', () => {
        if (document.pointerLockElement !== canvas)
            canvas.requestPointerLock();
    });
    document.addEventListener('pointerlockchange', () => {
        const settingsOpen = !document.getElementById('settings')?.hidden;
        if (document.pointerLockElement !== canvas && !settingsOpen
            && !doom._web_ui_mode())
            tapKey(DK.ESCAPE);          // engine opens its menu
    });
    window.addEventListener('mousemove', e => {
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
    window.addEventListener('mousedown', mouseBtn(true));
    window.addEventListener('mouseup', mouseBtn(false));
    window.addEventListener('contextmenu', e => {
        if (document.pointerLockElement === canvas) e.preventDefault();
    });
    window.addEventListener('wheel', e => {
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
    window.addEventListener('gamepaddisconnected', () => { padPrev = 0; });
    const curve = v => {
        const dz = settings.padDeadzone;
        const m = Math.abs(v);
        if (m < dz) return 0;
        const n = (m - dz) / (1 - dz);
        return Math.sign(v) * Math.pow(n, 1.6);
    };

    function pollGamepad() {
        const gp = navigator.getGamepads?.()[0];
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
    return {
        frame,
        settings,
        startCapture(actionId, cb) { capture = actionId; onCapture = cb; },
        cancelCapture() { capture = null; },
    };
}