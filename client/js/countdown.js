// Countdown overlay in the game's own font. Each number gets its own
// snappy exit so the sequence never repeats the same trick — a burst, a
// drop, a fade — and the signature screen-wipe MELT is saved for the
// finale, where GO dissolves away to reveal the running level.

export function createCountdown(font, host) {
    const canvas = document.createElement('canvas');
    canvas.id = 'melt';
    host.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;      // keep the pixel font crisp when scaled
    let current = null;         // offscreen canvas of what's on display
    let raf = 0;
    let n = 0;                  // show() call index, picks the exit effect

    const easeOut = t => 1 - (1 - t) * (1 - t);
    const easeBack = t => { const s = 2.2; return 1 + (s + 1) * (t - 1) ** 3 + s * (t - 1) ** 2; };

    const sizeTo = (a, b) => {
        canvas.width = Math.max(a?.width ?? 1, b?.width ?? 1);
        canvas.height = Math.max(a?.height ?? 1, b?.height ?? 1);
    };
    const drawStatic = c => {
        canvas.width = c?.width ?? 1;
        canvas.height = c?.height ?? 1;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (c) ctx.drawImage(c, 0, 0);
    };

    // --- incoming: the next number punches in with a slight overshoot ------
    const popIn = (to, e, W, H) => {
        const s = 0.55 + 0.45 * e;
        const w = to.width * s, h = to.height * s;
        ctx.save();
        ctx.globalAlpha = Math.min(1, e * 1.6);
        ctx.drawImage(to, (W - w) / 2, (H - h) / 2, w, h);
        ctx.restore();
    };

    // --- outgoing exits (old number leaving) -------------------------------
    // rocket-burst: shatter into a tile grid, each fragment flung outward
    const explode = (from, p, W, H) => {
        const e = p * p;
        const COLS = 5, ROWS = 4;
        const tw = from.width / COLS, th = from.height / ROWS;
        const ox = (W - from.width) / 2, oy = (H - from.height) / 2;
        const push = e * Math.max(W, H) * 0.85;
        ctx.save();
        ctx.globalAlpha = Math.max(0, 1 - p);
        for (let r = 0; r < ROWS; r++)
            for (let c = 0; c < COLS; c++) {
                let gx = c - (COLS - 1) / 2, gy = r - (ROWS - 1) / 2;
                if (!gx && !gy) gy = -1;                     // nudge the center tile
                const gd = Math.hypot(gx, gy);
                const px = ox + c * tw + tw / 2 + (gx / gd) * push;
                const py = oy + r * th + th / 2 + (gy / gd) * push;
                ctx.save();
                ctx.translate(px, py);
                ctx.rotate((gx + gy) * e * 0.5);
                ctx.drawImage(from, c * tw, r * th, tw, th, -tw / 2, -th / 2, tw, th);
                ctx.restore();
            }
        ctx.restore();
    };
    // drop-out: fall straight off the bottom, fading
    const dropout = (from, p, W, H) => {
        ctx.save();
        ctx.globalAlpha = Math.max(0, 1 - p * 0.9);
        ctx.drawImage(from, (W - from.width) / 2, p * p * H * 1.35);
        ctx.restore();
    };
    // fade-zoom: swell slightly and dissolve
    const fadezoom = (from, p, W, H) => {
        const s = 1 + p * 0.5;
        const w = from.width * s, h = from.height * s;
        ctx.save();
        ctx.globalAlpha = Math.max(0, 1 - p);
        ctx.drawImage(from, (W - w) / 2, (H - h) / 2, w, h);
        ctx.restore();
    };
    const EXITS = [explode, dropout, fadezoom];

    // generic timed transition: old exits via `exit`, new punches in
    function transition(from, to, exit, dur, onDone) {
        cancelAnimationFrame(raf);
        sizeTo(from, to);
        const W = canvas.width, H = canvas.height, start = performance.now();
        const step = now => {
            const p = Math.min(1, (now - start) / dur);
            ctx.clearRect(0, 0, W, H);
            if (to) popIn(to, easeBack(Math.min(1, p * 1.4)), W, H);
            if (from && exit) exit(from, p, W, H);
            if (p < 1) raf = requestAnimationFrame(step);
            else { drawStatic(to ?? null); current = to ?? null; onDone?.(); }
        };
        raf = requestAnimationFrame(step);
    }

    // --- the classic DOOM wipe, kept for the finale ------------------------
    function melt(from, behind, onDone) {
        cancelAnimationFrame(raf);
        const w = from.width, h = from.height;
        const COL = 6;
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
            else { drawStatic(behind ?? null); current = behind ?? null; onDone?.(); }
        };
        raf = requestAnimationFrame(step);
    }

    return {
        show(text) {
            host.hidden = false;
            const next = font.text(String(text), { scale: 22 });
            if (!current) transition(null, next, null, 280);        // punch-in
            else transition(current, next, EXITS[(n - 1) % EXITS.length], 320);
            n++;
        },
        dismiss() {
            const finish = () => { host.hidden = true; };
            if (!current) { finish(); return; }
            melt(current, null, finish);            // GO dissolves into the level
            current = null;
            // background tabs pause rAF — the overlay may never finish
            // melting there, but it must still come down
            setTimeout(finish, 2500);
        },
        reset() {
            cancelAnimationFrame(raf);
            current = null;
            n = 0;
            drawStatic(null);
            host.hidden = true;
        },
    };
}
