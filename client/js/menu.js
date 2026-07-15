// Drill-down menu in the DOOM idiom: one short list per screen, skull
// cursor, Enter descends, Escape/Backspace ascends. Arrow keys, mouse
// hover/click, and inline text entry for names. Screens are plain data:
//   { title?: string|{patch}, header?: [{text, color}] roster line,
//     items: [{ label, color?, action?, entry? }], onBack? }
export function createMenu(font, host) {
    const root = document.createElement('div');
    root.id = 'dmenu';
    host.appendChild(root);

    const stack = [];               // screen stack; top = visible
    let sel = 0;
    let skullFlip = false;
    let entry = null;               // {item, value} while typing a name
    let hidden = false;

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

        if (s.logo !== false && stack.length === 1 && logo)
            root.appendChild(Object.assign(document.createElement('div'), { className: 'logo' })).appendChild(logo);
        if (s.title)
            root.appendChild(Object.assign(document.createElement('div'), { className: 'mtitle' }))
                .appendChild(font.text(s.title, { scale: 3 }));
        if (s.header) {
            const h = Object.assign(document.createElement('div'), { className: 'mheader' });
            for (const part of s.header) {
                const c = font.text(part.text, { scale: 3, color: part.color ?? null });
                c.dataset.pname = part.text.trim();     // tests + a11y
                h.appendChild(c);
            }
            root.appendChild(h);
        }

        // big type by default; drop a notch when this screen has long
        // labels so single-column lists stay onscreen widthwise
        const longest = Math.max(0, ...s.items.map(it =>
            (it.label + (it.value !== undefined ? String(it.value) : '')).length));
        const scale = longest > 24 ? 3 : 4;

        const list = Object.assign(document.createElement('div'), { className: 'items' });
        if (s.items.some(it => it.thumb)) list.classList.add('noWrap');   // art rows: one column
        s.items.forEach((item, i) => {
            const row = document.createElement('div');
            row.className = 'row' + (i === sel ? ' sel' : '');
            const sk = Object.assign(document.createElement('span'), { className: 'skull' });
            if (i === sel && skulls[+skullFlip]) sk.appendChild(skulls[+skullFlip]);
            row.appendChild(sk);
            const label = entry && entry.item === item
                ? `${item.label}${entry.value}_`
                : item.label + (item.value !== undefined ? String(item.value) : '');
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
        // resets to root); plain screens just pop one level
        if (screen().onBack) { screen().onBack(); return; }
        stack.pop();
        sel = screen().sel ?? 0;
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
        // rows per wrapped column, for left/right jumps in long lists
        const rows = [...root.querySelectorAll('.items .row')];
        const col = rows.length ? rows.filter(r => r.offsetLeft === rows[0].offsetLeft).length : n;
        switch (e.code) {
            case 'ArrowUp':   sel = (sel + n - 1) % n; break;
            case 'ArrowDown': sel = (sel + 1) % n; break;
            case 'ArrowLeft':  sel = Math.max(0, sel - col); break;
            case 'ArrowRight': sel = Math.min(n - 1, sel + col); break;
            case 'Enter':     activate(); break;
            case 'Escape': case 'Backspace': back(); break;
            default: return;
        }
        e.preventDefault();
        render();
    }
    window.addEventListener('keydown', onKey);

    return {
        // replace the whole stack (initial/root screen)
        reset(s) { stack.length = 0; stack.push(s); sel = 0; entry = null; render(); },
        // descend into a screen
        push(s) { if (screen()) screen().sel = sel; stack.push(s); sel = 0; entry = null; render(); },
        pop: back,
        // re-render current screen after data changes (roster updates)
        refresh(s) { if (s) stack[stack.length - 1] = s; if (sel >= screen().items.length) sel = 0; render(); },
        hide() { hidden = true; render(); },
        show() { hidden = false; render(); },
        // pop n screens without onBack side effects (picker flows)
        unwind(n = 1) { while (n-- > 0 && stack.length > 1) stack.pop(); sel = screen().sel ?? 0; render(); },
        depth: () => stack.length,
        current: () => screen(),
    };
}
