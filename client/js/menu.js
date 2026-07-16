// Drill-down menu in the DOOM idiom: one short list per screen, skull
// cursor, Enter descends, Escape/Backspace ascends. Arrow keys, mouse
// hover/click, and inline text entry for names. Screens are plain data:
//   { title?: string|{patch}, header?: [{text, color}] roster line,
//     items: [{ label, color?, action?, entry? }], onBack? }
// opts.onTransition(type): optional callback fired on every real screen change.
//   type: 'push' (descending), 'back' (popping/unwinding), 'reset' (full replace).
//   Called AFTER the stack is mutated, BEFORE render(). Cursor-within-screen
//   events (ArrowUp/Down, refresh) do NOT trigger this — only actual screen
//   changes do, so it is safe to call fire.flare() here without over-triggering.
//   fire.flare() while paused (in-game) is harmless: sim is stopped, and
//   pause() clears any pending timers if a flare was in flight.
export function createMenu(font, host, opts = {}) {
    const { onTransition } = opts;
    const root = document.createElement('div');
    root.id = 'dmenu';
    host.appendChild(root);

    const stack = [];               // screen stack; top = visible
    let sel = 0;
    let skullFlip = false;
    let entry = null;               // {item, value} while typing a name
    let hidden = false;

    // Rows are a fixed height (CSS) so the cursor appearing never shifts a
    // row. Text is scaled UP toward the skull's height at clean integer
    // multiples (nearest-neighbour, always crisp) rather than shrinking
    // the skull. Skull ×3 ≈ 57px; body text ×5 ≈ 45px sits just under it.
    const skulls = [font.patch('M_SKULL1', 3), font.patch('M_SKULL2', 3)];
    const logo = font.patch('M_DOOM', 3);
    setInterval(() => {
        skullFlip = !skullFlip;
        const on = root.querySelector('.row.sel .skull');
        if (on && skulls[+skullFlip]) on.replaceChildren(skulls[+skullFlip]);
    }, 250);

    const screen = () => stack[stack.length - 1];

    function render() {
        root.replaceChildren();
        if (hidden || !screen()) return;
        const s = screen();

        // A long list (Doom II's 32 maps, Master Levels) wraps into
        // columns and gets the full viewport width, centred; a normal
        // menu keeps the fixed 1080 block with items left-anchored.
        const wrapped = !s.items.some(it => it.thumb) && s.items.length > 8;
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
            // single column: largest scale that fits the block width
            while (scale > 3 && SKULL + w1 * scale > availW) scale--;
        }
        const titleScale = Math.min(6, scale + 1);
        const headerScale = Math.min(4, scale);

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

        const list = Object.assign(document.createElement('div'), { className: 'items' });
        if (s.items.some(it => it.thumb)) list.classList.add('noWrap');   // art rows: one column
        // centre the items under the title/logo, EXCEPT when a value can be
        // cycled — those left-anchor so a changing value never shifts rows
        if (wrapped || !s.items.some(it => it.cycle)) list.style.alignSelf = 'center';
        s.items.forEach((item, i) => {
            const row = document.createElement('div');
            row.className = 'row' + (i === sel ? ' sel' : '');
            const sk = Object.assign(document.createElement('span'), { className: 'skull' });
            if (i === sel && skulls[+skullFlip]) sk.appendChild(skulls[+skullFlip]);
            row.appendChild(sk);
            let label;
            if (entry && entry.item === item)
                label = `${item.label}${entry.value}_`;
            else {
                const val = item.value !== undefined ? String(item.value) : '';
                // cycleable values always show "< value >" — a fixed-width
                // affordance that also signals ←/→ adjustability
                label = (item.cycle && val) ? `${item.label}< ${val} >` : item.label + val;
            }
            row.dataset.label = label.toUpperCase();    // tests + accessibility
            row.setAttribute('role', 'menuitem');
            row.setAttribute('aria-label', label);
            if (item.thumb) {
                row.classList.add('art');
                row.appendChild(item.thumb);
            }
            row.appendChild(font.text(label, { scale: item.thumb ? 3 : scale, color: item.color ?? null }));
            row.onmouseenter = () => { if (!entry && sel !== i) { sel = i; render(); } };
            row.onclick = () => { if (!entry) { sel = i; activate(); } };
            list.appendChild(row);
        });
        root.appendChild(list);

        // Wrapped multi-column lists (Doom II's 32 maps, Master Levels):
        // constrain columns to the menu's fixed width so they never run off
        // the screen. Measure the widest row, then cap the height so it
        // wraps into only as many columns as fit.
        if (!list.classList.contains('noWrap') && list.children.length > 8) {
            const rows = [...list.children];
            const rowH = rows[0].offsetHeight, gapV = 6, gapH = 56;
            const rowW = Math.max(...rows.map(r => r.offsetWidth));
            const avail = root.clientWidth || window.innerWidth;
            const cols = Math.max(1, Math.floor((avail + gapH) / (rowW + gapH)));
            const perCol = Math.ceil(rows.length / cols);
            list.style.maxHeight = (perCol * (rowH + gapV)) + 'px';
        }
    }

    function activate() {
        const item = screen()?.items[sel];
        if (!item) return;
        if (item.entry) {
            entry = { item, value: item.entry.initial ?? '' };
            render();
            return;
        }
        item.action?.();
    }

    function back() {
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
        if (entry) {
            e.preventDefault();
            const it = entry.item;
            if (e.key === 'Enter') { const v = entry.value; entry = null; it.entry.commit(v); }
            else if (e.key === 'Escape') entry = null;
            else if (e.key === 'Backspace') entry.value = entry.value.slice(0, -1);
            else if (/^[a-zA-Z0-9 _-]$/.test(e.key) && entry.value.length < 10)
                entry.value += e.key.toUpperCase();
            render();
            return;
        }
        const n = screen().items.length;
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
            case 'Enter':     activate(); break;
            case 'Escape': case 'Backspace': back(); break;
            default: return;
        }
        e.preventDefault();
        render();
    }
    window.addEventListener('keydown', onKey);

    // mouse wheel moves the cursor (and the skull-hover already re-selects)
    root.addEventListener('wheel', e => {
        if (hidden || entry || !screen()) return;
        e.preventDefault();
        const n = screen().items.length;
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
        refresh(s) { if (s) stack[stack.length - 1] = s; if (sel >= screen().items.length) sel = 0; render(); },
        hide() { hidden = true; render(); },
        show() { hidden = false; render(); },
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
