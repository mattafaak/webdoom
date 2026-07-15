// Countdown overlay in the game's own font: each number melts away in
// the style of the screen wipe (columns fall with staggered speeds)
// revealing the next. GO melts into nothing.

export function createCountdown(font, host) {
    const canvas = document.createElement('canvas');
    canvas.id = 'melt';
    host.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    let current = null;         // offscreen canvas of what's on display
    let raf = 0;

    const draw = c => {
        canvas.width = c?.width ?? 1;
        canvas.height = c?.height ?? 1;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (c) ctx.drawImage(c, 0, 0);
    };

    // classic wipe: per-column randomized delay, then accelerating fall
    function melt(from, behind, onDone) {
        cancelAnimationFrame(raf);
        const w = from.width, h = from.height;
        const COL = 6;                          // column width in px
        const cols = Math.ceil(w / COL);
        const y = [];
        y[0] = -Math.floor(Math.random() * 16);
        for (let i = 1; i < cols; i++) {
            y[i] = y[i - 1] + Math.floor(Math.random() * 7) - 3;
            if (y[i] > 0) y[i] = 0;
            if (y[i] < -15) y[i] = -15;
        }
        canvas.width = Math.max(w, behind?.width ?? 0);
        canvas.height = Math.max(h, behind?.height ?? 0);

        const step = () => {
            let done = true;
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            if (behind) ctx.drawImage(behind, (canvas.width - behind.width) / 2, 0);
            const ox = (canvas.width - w) / 2;
            for (let i = 0; i < cols; i++) {
                y[i] += y[i] < 0 ? 1 : Math.max(3, y[i] >> 2);
                if (y[i] < h) {
                    done = false;
                    const sy = Math.max(0, y[i]);
                    ctx.drawImage(from, i * COL, 0, COL, h - sy,
                                  ox + i * COL, sy, COL, h - sy);
                }
            }
            if (!done) raf = requestAnimationFrame(step);
            else { draw(behind ?? null); current = behind ?? null; onDone?.(); }
        };
        raf = requestAnimationFrame(step);
    }

    return {
        show(text) {
            host.hidden = false;
            const next = font.text(String(text), { scale: 22 });
            if (current) melt(current, next);
            else { draw(next); current = next; }
        },
        dismiss() {
            const finish = () => { host.hidden = true; };
            if (!current) { finish(); return; }
            melt(current, null, finish);
            current = null;
            // background tabs pause rAF — the overlay may never finish
            // melting there, but it must still come down
            setTimeout(finish, 2500);
        },
        reset() {
            cancelAnimationFrame(raf);
            current = null;
            draw(null);
            host.hidden = true;
        },
    };
}
