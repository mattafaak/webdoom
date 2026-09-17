// Drill-down menu in the DOOM idiom: one short list per screen, skull cursor,
// Enter descends, Escape/Backspace ascends; arrows, mouse hover/click, inline
// text entry for names, key capture for rebinds.  Screens are plain data:
//   { id?, title?, header?: [{text, color}], nowrap?, onBack?,
//     items: [{ label, value?, maxValue?, color?, thumb?, action?, cycle?, entry?, capture? }] }
// opts.onTransition(type): 'push' | 'back' | 'reset', fired after the stack
// changes and before render -- cursor moves and refreshes do not fire it.
export function createMenu(font, host, opts = {}) {
    const { onTransition } = opts;
    const root = document.createElement('div');
    root.id = 'dmenu';
    host.appendChild(root);

    const stack = [];               // screen stack; top = visible
    let sel = 0;
    let skullFlip = false;
    let entry = null;               // {item, value} while typing a name
    let capture = null;             // {item, cancel} while waiting for a key
    let hidden = false;

    // Rows are a fixed height (CSS) so the cursor appearing never shifts a
    // row. Text is scaled UP toward the skull's height at clean integer
    // multiples (nearest-neighbour, always crisp) rather than shrinking
    // the skull. Skull ×3 ≈ 57px; body text ×5 ≈ 45px sits just under it.
    const skulls = [font.patch('M_SKULL1', 3), font.patch('M_SKULL2', 3)];
    const logo = font.patch('M_DOOM', 3);
    // the blink follows visibility: browser-teardown fails on a launcher
    // timer that is live during play
    let blink = null;
    const startBlink = () => {
        if (blink !== null) return;
        blink = setInterval(() => {
            skullFlip = !skullFlip;
            const on = root.querySelector('.row.sel .skull');
            if (on && skulls[+skullFlip]) on.replaceChildren(skulls[+skullFlip]);
        }, 250);
    };
    const stopBlink = () => {
        if (blink === null) return;
        clearInterval(blink);
        blink = null;
    };
    startBlink();

    const screen = () => stack[stack.length - 1];

    function render() {
        root.replaceChildren();
        if (hidden || !screen()) return;
        const s = screen();

        // A long list (Doom II's 32 maps, Master Levels) wraps into
        // columns and gets the full viewport width, centred; a normal
        // menu keeps the fixed 1080 block with items left-anchored.
        // `nowrap` opts a screen out: a settings list is read top to bottom
        // and adjusted in place, so splitting it into columns at the 8-item
        // mark makes it read as two unrelated lists.  A MAP PICKER wants the
        // columns; OPTIONS never does, however long it gets.
        const hasThumb = s.items.some(it => it.thumb);
        const hasCycle = s.items.some(it => it.cycle);
        const wrapped = !s.nowrap && !hasThumb && s.items.length > 8;
        root.classList.toggle('wide', wrapped);

        // Pick the scale. Cycleable values always reserve their "< >"
        // width (so scale is stable regardless of selection). For a
        // wrapped list, choose the largest clean scale whose column
        // layout fits both the width and the viewport height. Row heights
        // are skull-driven (fixed), so all scales are nearest-neighbour
        // crisp. Title is one notch larger (heading), header a touch
        // smaller (secondary).
        // width uses maxValue (the item's longest possible value) where
        // given, so cycling a value never re-scales the menu
        const sizingLabel = it => {
            const v = it.maxValue ?? (it.value !== undefined ? String(it.value) : undefined);
            return it.label + (v !== undefined ? (it.cycle ? `< ${v} >` : v) : '');
        };
        const SKULL = 64, GAPH = 56, ROWH = 66;
        const availW = Math.min(window.innerWidth * 0.94, wrapped ? 1800 : 1080);
        const availH = window.innerHeight * 0.72;
        const px = it => font.text(sizingLabel(it) || 'M', { scale: 1 }).width;
        const w1 = Math.max(1, Math.max(0, ...s.items.map(px)));

        let scale = 5;
        if (wrapped) {
            while (scale > 2) {
                const cols = Math.max(1, Math.floor((availW + GAPH) / (SKULL + w1 * scale + GAPH)));
                if (Math.ceil(s.items.length / cols) * ROWH <= availH) break;
                scale--;
            }
        } else {
            // single column: largest scale that fits the block width AND the
            // viewport height.  Height used to be unchecked, because every
            // single-column screen was short; CONTROLS is twelve rows and ran
            // straight off the bottom behind a scrollbar.  Row height is
            // skull-driven, so it has to come down with the scale -- the two
            // custom properties below are what let it.
            while (scale > 2 && (SKULL + w1 * scale > availW
                                 || s.items.length * (ROWH / 5 * scale + 6) > availH)) scale--;
        }
        root.style.setProperty('--rowh', `${Math.round(12 * scale)}px`);
        root.style.setProperty('--skullw', `${Math.round(13 * scale)}px`);
        const titleScale = Math.min(6, scale + 1);
        // The header is one line and was scaled off `scale` alone, so a long
        // one ran off both edges of the viewport and put a horizontal
        // scrollbar under the menu.  Fit it to the width like everything else.
        let headerScale = Math.min(4, scale);
        if (s.header) {
            const hw = s.header.reduce((n, p) => n + font.text(p.text, { scale: 1 }).width, 0);
            while (headerScale > 1 && hw * headerScale > availW) headerScale--;
        }

        if (s.logo !== false && stack.length === 1 && logo)
            root.appendChild(Object.assign(document.createElement('div'), { className: 'logo' })).appendChild(logo);
        if (s.title)
            root.appendChild(Object.assign(document.createElement('div'), { className: 'mtitle' }))
                .appendChild(font.text(s.title, { scale: titleScale }));
        if (s.header) {
            const h = Object.assign(document.createElement('div'), { className: 'mheader' });
            for (const part of s.header) {
                const c = font.text(part.text, { scale: headerScale, color: part.color ?? null });
                c.dataset.pname = part.text.trim();     // tests + a11y
                h.appendChild(c);
            }
            root.appendChild(h);
        }

        // the list is the menu (role=menu), labelled by the screen's title
        const list = Object.assign(document.createElement('div'), { className: 'items' });
        list.setAttribute('role', 'menu');
        if (s.title) list.setAttribute('aria-label', String(s.title));
        if (hasThumb) list.classList.add('noWrap');                       // art rows: one column
        // centre the items under the title/logo, EXCEPT when a value can be
        // cycled — those left-anchor so a changing value never shifts rows
        if (wrapped || !hasCycle) list.style.alignSelf = 'center';
        s.items.forEach((item, i) => {
            const row = document.createElement('div');
            row.className = 'row' + (i === sel ? ' sel' : '');
            const sk = Object.assign(document.createElement('span'), { className: 'skull' });
            if (i === sel && skulls[+skullFlip]) sk.appendChild(skulls[+skullFlip]);
            row.appendChild(sk);
            let label;
            // Matched by LABEL, not by object identity.  refresh() rebuilds
            // every item object from scratch, so after the first roster update
            // `entry.item === item` was never true again: the caret and the
            // characters you had typed vanished, the row reverted to the
            // committed value, and `entry` was still live -- so keystrokes kept
            // accumulating into a buffer nobody could see and Enter committed
            // it.  Typing your name while another player joined did it.
            // `entry.item` is still the original object, because that is what
            // carries the commit callback.
            if (entry && entry.label === item.label)
                label = `${item.label}${entry.value}_`;
            else if (capture && capture.label === item.label)
                label = `${item.label}< PRESS A KEY >`;
            else {
                const val = item.value !== undefined ? String(item.value) : '';
                // cycleable values always show "< value >" — a fixed-width
                // affordance that also signals ←/→ adjustability
                label = (item.cycle && val) ? `${item.label}< ${val} >` : item.label + val;
            }
            row.dataset.label = label.toUpperCase();    // tests + accessibility
            row.setAttribute('role', 'menuitem');
            row.setAttribute('aria-label', label);
            // Roving tabindex: the menu is one tab stop, and the arrow keys
            // move within it (the pattern for role=menu).  Without a tabindex
            // anywhere the whole launcher was unreachable by Tab.
            row.tabIndex = i === sel ? 0 : -1;
            if (i === sel) row.setAttribute('aria-current', 'true');
            // '.sel' has no CSS rule and stays: the blink queries it and the
            // teardown gate counts it
            if (item.thumb) row.appendChild(item.thumb);
            row.appendChild(font.text(label, { scale: item.thumb ? 3 : scale, color: item.color ?? null }));
            row.onmouseenter = () => { if (!entry && !capture && sel !== i) { sel = i; render(); } };
            // a click while typing a name commits it, so a mouse-only player
            // is not held in the entry until they find Enter
            row.onclick = () => {
                if (capture) return;
                if (entry) { commitEntry(); return; }
                sel = i; activate(false);
            };
            list.appendChild(row);
        });
        root.appendChild(list);

        // Wrapped multi-column lists (Doom II's 32 maps, Master Levels):
        // constrain columns to the menu's fixed width so they never run off
        // the screen. Measure the widest row, then cap the height so it
        // wraps into only as many columns as fit.
        if (!hasThumb && list.children.length > 8) {
            const rows = [...list.children];
            const rowH = rows[0].offsetHeight, gapV = 6, gapH = 56;
            const rowW = Math.max(...rows.map(r => r.offsetWidth));
            const avail = root.clientWidth || window.innerWidth;
            const cols = Math.max(1, Math.floor((avail + gapH) / (rowW + gapH)));
            const perCol = Math.ceil(rows.length / cols);
            list.style.maxHeight = (perCol * (rowH + gapV)) + 'px';
        }
    }

    function commitEntry() {
        const { item, value } = entry;
        entry = null;
        item.entry.commit(value);
        render();
    }

    function activate(viaKeydown) {
        const item = screen()?.items[sel];
        if (!item) return;
        if (item.entry) {
            entry = { item, label: item.label, value: item.entry.initial ?? '' };
            render();
            return;
        }
        if (item.capture) { armCapture(item, viaKeydown); return; }
        item.action?.();
    }

    // Two things make this more than a call to captureBind(): Enter is still
    // DOWN when activate() runs, so a capture armed now would bind Enter --
    // arm on the following keyup; and the capture listener is capture-phase
    // with stopPropagation, so the arrows and Escape do not reach this menu
    // while it is armed.
    function armCapture(item, viaKeydown) {
        if (capture) return;
        const arm = () => {
            capture = { item, label: item.label, cancel: item.capture(() => { capture = null; render(); }) };
            render();
        };
        if (viaKeydown) window.addEventListener('keyup', function once() {
            window.removeEventListener('keyup', once, true);
            arm();
        }, true);
        else arm();
        render();
    }

    function back() {
        if (capture) { capture.cancel(); capture = null; render(); return; }
        if (stack.length <= 1) return;
        // a screen with onBack owns its exit (e.g. leaving the lobby
        // resets to root); plain screens just pop one level.
        // onBack handlers (leaveLobby) call menu.reset() themselves,
        // which fires onTransition('reset') — no need to fire here too.
        if (screen().onBack) { screen().onBack(); return; }
        stack.pop();
        sel = screen().sel ?? 0;
        onTransition?.('back');
        render();
    }

    function onKey(e) {
        if (hidden || !screen()) return;
        if (capture) return;        // the capture listener owns the keyboard
        if (entry) {
            e.preventDefault();
            const it = entry.item;
            if (e.key === 'Enter') commitEntry();

            else if (e.key === 'Escape') entry = null;
            else if (e.key === 'Backspace') entry.value = entry.value.slice(0, -1);
            else if (/^[a-zA-Z0-9 _-]$/.test(e.key) && entry.value.length < 10)
                entry.value += e.key.toUpperCase();
            render();
            return;
        }
        const n = screen().items.length;
        // an empty screen: no cursor arithmetic (NaN), but Escape must still leave
        if (n === 0) {
            if (e.code === 'Escape' || e.code === 'Backspace') { e.preventDefault(); back(); }
            return;
        }
        const item = screen().items[sel];
        // rows per column (for column jumps in wrapped multi-column lists)
        const rows = [...root.querySelectorAll('.items .row')];
        const col = rows.length ? rows.filter(r => r.offsetLeft === rows[0].offsetLeft).length : n;
        const multiCol = col < n;   // list actually wrapped into >1 column
        switch (e.code) {
            case 'ArrowUp':   sel = (sel + n - 1) % n; break;
            case 'ArrowDown': sel = (sel + 1) % n; break;
            // left/right adjusts a cycleable value; in a wrapped list it
            // jumps a column; on a plain single-column item it does nothing
            case 'ArrowLeft':  if (item?.cycle) item.cycle(-1); else if (multiCol) sel = Math.max(0, sel - col); break;
            case 'ArrowRight': if (item?.cycle) item.cycle(1);  else if (multiCol) sel = Math.min(n - 1, sel + col); break;
            case 'Enter':     activate(true); break;
            case 'Escape': case 'Backspace': back(); break;
            default: return;
        }
        e.preventDefault();
        render();
    }
    window.addEventListener('keydown', onKey);

    // mouse wheel moves the cursor (and the skull-hover already re-selects)
    root.addEventListener('wheel', e => {
        if (hidden || entry || capture || !screen()) return;
        const n = screen().items.length;
        if (n === 0) return;            // same NaN as onKey, one scroll away
        e.preventDefault();
        sel = (sel + (e.deltaY > 0 ? 1 : n - 1)) % n;
        render();
    }, { passive: false });

    return {
        // replace the whole stack (initial/root screen)
        reset(s) { stack.length = 0; stack.push(s); sel = 0; entry = null; onTransition?.('reset'); render(); },
        // descend into a screen
        push(s) { if (screen()) screen().sel = sel; stack.push(s); sel = 0; entry = null; onTransition?.('push'); render(); },
        pop: back,
        // re-render current screen after data changes (roster updates — NOT a
        // screen transition; no flare, no onTransition)
        // A roster update must not move the cursor onto a different ACTION.
        // This clamped an out-of-range `sel` to 0, and index 0 is the most
        // destructive row on both lobby screens -- START GAME, and DROP IN on
        // the in-progress screen.  The lobby's COLOR row exists only while a
        // slot is free, so the fourth player joining shortened the list and
        // silently moved a cursor parked on COLOR to START GAME; the next
        // Enter launched the game, or joined one you were only browsing.
        // So: keep the row the user was actually on, by label, and fall back
        // to the LAST row rather than the first when it is gone.
        refresh(s) {
            const wasOn = screen()?.items[sel]?.label;
            if (s) stack[stack.length - 1] = s;
            const items = screen().items;
            const again = wasOn === undefined ? -1 : items.findIndex(it => it.label === wasOn);
            if (again >= 0) sel = again;
            else if (sel >= items.length) sel = Math.max(0, items.length - 1);
            render();
        },
        hide() { hidden = true; stopBlink(); render(); },
        show() { hidden = false; startBlink(); render(); },
        // pop n screens without onBack side effects (picker flows)
        unwind(n = 1) {
            let changed = 0;
            while (n-- > 0 && stack.length > 1) { stack.pop(); changed++; }
            sel = screen().sel ?? 0;
            if (changed) onTransition?.('back');
            render();
        },
        depth: () => stack.length,
        current: () => screen(),
    };
}
