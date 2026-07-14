// Keyboard → engine events. Modern WASD layout expressed through the
// engine's own default bindings (arrows turn, ',' '.' strafe), so the
// C side needs no config. Full rebinding UI comes with the input phase.

// doomdef.h key codes
const K = {
    RIGHT: 0xae, LEFT: 0xac, UP: 0xad, DOWN: 0xaf,
    ESCAPE: 27, ENTER: 13, TAB: 9, BACKSPACE: 127, PAUSE: 0xff,
    RSHIFT: 0x80+0x36, RCTRL: 0x80+0x1d, RALT: 0x80+0x38,
    F1: 0x80+0x3b,
};

// KeyboardEvent.code → doom key
const CODE_MAP = {
    KeyW: K.UP,        KeyS: K.DOWN,
    KeyA: 44 /* , */,  KeyD: 46 /* . */,
    ArrowUp: K.UP,     ArrowDown: K.DOWN,
    ArrowLeft: K.LEFT, ArrowRight: K.RIGHT,
    Space: 32,         KeyE: 32,          // use
    ControlLeft: K.RCTRL, ControlRight: K.RCTRL,   // fire
    ShiftLeft: K.RSHIFT,  ShiftRight: K.RSHIFT,    // run
    AltLeft: K.RALT,      AltRight: K.RALT,        // strafe modifier
    Escape: K.ESCAPE, Enter: K.ENTER, Tab: K.TAB,
    Backspace: K.BACKSPACE, Pause: K.PAUSE,
    Minus: 0x2d, Equal: 0x3d,
};
// F1..F10 are contiguous; F11/F12 sit apart (doomdef.h)
for (let i = 1; i <= 10; i++) CODE_MAP['F' + i] = K.F1 + (i - 1);
CODE_MAP.F11 = 0x80 + 0x57;
CODE_MAP.F12 = 0x80 + 0x58;
// digits: weapon select + menu
for (let i = 0; i <= 9; i++) CODE_MAP['Digit' + i] = 48 + i;

const EV_KEYDOWN = 0, EV_KEYUP = 1;

export function attachKeyboard(target, postEvent) {
    const translate = e => {
        if (CODE_MAP[e.code] !== undefined) return CODE_MAP[e.code];
        // letters and everything else: engine wants lowercase ASCII
        if (e.key.length === 1) {
            const c = e.key.toLowerCase().charCodeAt(0);
            if (c >= 32 && c < 127) return c;
        }
        return null;
    };
    const handler = down => e => {
        const key = translate(e);
        if (key === null) return;
        e.preventDefault();
        postEvent(down ? EV_KEYDOWN : EV_KEYUP, key, 0, 0);
    };
    target.addEventListener('keydown', handler(true));
    target.addEventListener('keyup', handler(false));
}
