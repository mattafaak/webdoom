// qol.js — task 19.1 QoL DOM overlays.
//
// Features (ALL off by default, persisted via localStorage via input.js/settings.js):
//   1. showFullscreen  — hover fullscreen button near top edge (Fullscreen API).
//   2. showCrosshair   — static crosshair at screen centre.
//   3. showStats       — level time / kills / items / secrets widget.
//   4. showDemoTimer   — demo progress timer + bar (visible only during demo playback).
//
// Design: all overlays are DOM elements inside #stage.  They do NOT write to the
// engine framebuffer, so render goldens are structurally unchanged regardless of
// feature state.  TDD red-proof is performed on the DOM assertion side.
//
// Engine read: web_level_state() (task 19.1 read-only export) supplies stats/demo
// state.  No writes to sim state — determinism safe.

import { saveSettings } from './input.js';

export function createQolUI(doom, input) {
    const s = input.settings;
    const stage = document.getElementById('stage');

    // ── Shared HEAP buffer for web_level_state (9 ints × 4 bytes) ────────────
    // Allocated once; freed on page unload (in practice the page is short-lived).
    const LS_INTS = 9;
    const lsBuf = doom._malloc ? doom._malloc(LS_INTS * 4) : 0;
    const lsBase = lsBuf >> 2;  // HEAP32 index base

    function readLevelState() {
        if (!lsBuf || !doom._web_level_state) return null;
        try {
            doom._web_level_state(lsBuf);
            const h = doom.HEAP32;
            return {
                kills:     h[lsBase + 0],
                items:     h[lsBase + 1],
                secrets:   h[lsBase + 2],
                maxKills:  h[lsBase + 3],
                maxItems:  h[lsBase + 4],
                maxSecrets:h[lsBase + 5],
                leveltime: h[lsBase + 6],
                isDemo:    h[lsBase + 7] !== 0,
                demoProg:  h[lsBase + 8],  // 0..1000
            };
        } catch { return null; }
    }

    // ── 1. Fullscreen button ──────────────────────────────────────────────────
    // Positioned at top-centre to align with Chrome's exit-fullscreen pill.
    // Hidden by default; shown/hidden via the setting.  When visible, the
    // button itself is always present in DOM but the CSS class 'visible'
    // controls whether it is opaque (added on hover, removed after 2 s idle).
    const fsBtn = document.createElement('button');
    fsBtn.id = 'qol-fullscreen';
    fsBtn.setAttribute('aria-label', 'Fullscreen');
    stage.appendChild(fsBtn);

    let fsHideTimer = null;

    function updateFsBtnIcon() {
        fsBtn.textContent = document.fullscreenElement ? '✕' : '⛶';
        fsBtn.title = document.fullscreenElement
            ? 'Exit fullscreen' : 'Enter fullscreen';
    }
    updateFsBtnIcon();

    function showFsBtn() {
        if (!s.showFullscreen) return;
        fsBtn.classList.add('visible');
        clearTimeout(fsHideTimer);
        fsHideTimer = setTimeout(() => fsBtn.classList.remove('visible'), 2000);
    }

    stage.addEventListener('mousemove', showFsBtn);

    fsBtn.addEventListener('click', () => {
        if (!document.fullscreenElement) {
            stage.requestFullscreen().catch(() => {});
        } else {
            document.exitFullscreen().catch(() => {});
        }
        updateFsBtnIcon();
    });
    document.addEventListener('fullscreenchange', updateFsBtnIcon);

    fsBtn.hidden = !s.showFullscreen;

    // ── 2. Crosshair ─────────────────────────────────────────────────────────
    // Simple '+' centred over the screen.  Pure CSS positioning.
    const crosshair = document.createElement('div');
    crosshair.id = 'qol-crosshair';
    crosshair.textContent = '+';
    stage.appendChild(crosshair);
    crosshair.hidden = !s.showCrosshair;

    // ── 3. Level stats widget ─────────────────────────────────────────────────
    // Shows: K:0/0  I:0/0  S:0/0  0:00
    // Updated each rAF from engine state.
    const statsEl = document.createElement('div');
    statsEl.id = 'qol-stats';
    stage.appendChild(statsEl);
    statsEl.hidden = !s.showStats;

    function updateStats(ls) {
        if (!ls) return;
        const secs = Math.floor(ls.leveltime / 35);
        const m    = Math.floor(secs / 60);
        const sec  = String(secs % 60).padStart(2, '0');
        statsEl.textContent =
            `K:${ls.kills}/${ls.maxKills}  I:${ls.items}/${ls.maxItems}  S:${ls.secrets}/${ls.maxSecrets}  ${m}:${sec}`;
    }

    // ── 4. Demo timer + progress bar ──────────────────────────────────────────
    // Visible only while demoplayback=1 (engine sets this during demos).
    // Shows elapsed gametic time + a progress bar filled from demo_p offset.
    const demoTimerEl = document.createElement('div');
    demoTimerEl.id = 'qol-demo-timer';
    stage.appendChild(demoTimerEl);
    demoTimerEl.hidden = true;  // shown dynamically when isDemo && showDemoTimer

    const demoBarEl = document.createElement('div');
    demoBarEl.id = 'qol-demo-bar';
    const demoFill = document.createElement('div');
    demoFill.className = 'fill';
    demoBarEl.appendChild(demoFill);
    stage.appendChild(demoBarEl);
    demoBarEl.hidden = true;

    function updateDemoTimer(ls) {
        const show = s.showDemoTimer && ls?.isDemo;
        demoTimerEl.hidden = !show;
        demoBarEl.hidden   = !show;
        if (!show || !ls) return;

        // Use gametic for elapsed time (web_gametic() proxied via leveltime here;
        // leveltime resets each level while gametic is cumulative — but for a
        // visual timer the level-relative time is more useful).
        const secs = Math.floor(ls.leveltime / 35);
        const m    = Math.floor(secs / 60);
        const sec  = String(secs % 60).padStart(2, '0');
        demoTimerEl.textContent = `DEMO ${m}:${sec}`;
        demoFill.style.width = (ls.demoProg / 10) + '%';  // 0..100%
    }

    // ── Per-frame update loop ─────────────────────────────────────────────────
    // Runs independently of main.js's rAF to avoid coupling.
    // Overhead: one HEAP32 read per frame — negligible.
    let rafHandle = null;

    function tick() {
        if (s.showStats || s.showDemoTimer) {
            const ls = readLevelState();
            if (s.showStats)     updateStats(ls);
            updateDemoTimer(ls);
        }
        rafHandle = requestAnimationFrame(tick);
    }

    function startTick() {
        if (!rafHandle) rafHandle = requestAnimationFrame(tick);
    }

    // Start tick loop if either live feature is on.
    if (s.showStats || s.showDemoTimer) startTick();

    // ── Public update API (called by settings.js checkboxes) ─────────────────
    return {
        setShowFullscreen(v) {
            s.showFullscreen = v;
            saveSettings(s);
            fsBtn.hidden = !v;
            if (v) updateFsBtnIcon();
        },
        setShowCrosshair(v) {
            s.showCrosshair = v;
            saveSettings(s);
            crosshair.hidden = !v;
        },
        setShowStats(v) {
            s.showStats = v;
            saveSettings(s);
            statsEl.hidden = !v;
            if (v) startTick();
        },
        setShowDemoTimer(v) {
            s.showDemoTimer = v;
            saveSettings(s);
            if (v) startTick();
            else { demoTimerEl.hidden = true; demoBarEl.hidden = true; }
        },
    };
}
