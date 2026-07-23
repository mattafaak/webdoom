// Settings overlay: key rebinding, mouse/gamepad tuning, music backend.
// Toggled with F8 (or the gear button); state persists via input.js's localStorage.
//
// Music backend picker (task 17.2b):
//   OPL2 — default, works offline; mono synthesis.
//   OPL3 — stereo 18-voice synthesis (task 17.1).
//   GM   — GM SoundFont via SpessaSynth + a user-dropped .sf2 file.
//          Requires an .sf2 in IDB and SpessaSynth configured on the operator
//          server.  Without both, GM mode produces silence (frames still flow;
//          loud status notice is shown).
import { ACTIONS, saveSettings, defaultSettings } from './input.js';
import { sf2GetCurrentMeta } from './sf2-library.js';

// Compute Panini/cylindrical remap strength (matches main.js paniniStrength()).
// 0.0 at 4:3 or narrower; 0.4 at 21:9+.  Returns 0 when disabled.
function computePaniniStrength(w, enabled) {
    if (!enabled) return 0.0;
    const aspect = w / 200;
    return Math.min(0.4, Math.max(0, (aspect - 4/3) / (21/9 - 4/3)) * 0.4);
}

export function createSettingsUI(input, doom, renderer, qol) {
    const s = input.settings;
    const panel = document.createElement('div');
    panel.id = 'settings';
    panel.hidden = true;
    document.getElementById('stage').appendChild(panel);

    // Escape HTML special characters before injecting into innerHTML.
    // Applied to every user-derived or localStorage-derived value in the template.
    const esc = v => String(v)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

    const keyName = code => String(code)
        .replace(/[^a-zA-Z0-9]/g, '')   // codes are alphanumeric; localStorage isn't trusted
        .replace(/^Key|^Digit/, '')
        .replace(/^Arrow/, '')
        .replace(/(Left|Right)$/, ' $1');

    function render() {
        // Determine current backend; fall back gracefully from legacy opl3 bool.
        const backend = s.musicBackend ?? (s.opl3 ? 'opl3' : 'opl2');
        panel.innerHTML = `
        <h2>webdoom settings</h2>
        <table>
          ${ACTIONS.map(a => `
            <tr><td>${esc(a.label)}</td>
                <td><button class="bind" data-id="${esc(a.id)}">${esc(keyName(s.binds[a.id]))}</button></td></tr>
          `).join('')}
        </table>
        <label>Mouse sensitivity <input type="range" id="sens" min="1" max="12" step="1" value="${esc(s.mouseSens)}"></label>
        <label><input type="checkbox" id="mmove" ${s.mouseY === 'move' ? 'checked' : ''}> Mouse Y moves player (1993 style)</label>
        <label><input type="checkbox" id="arun" ${s.alwaysRun ? 'checked' : ''}> Always run</label>
        <label><input type="checkbox" id="smooth" ${s.smooth ? 'checked' : ''}> Smooth rendering (uncapped fps)</label>
        <label><input type="checkbox" id="wideMode" ${s.wideMode ? 'checked' : ''}> Wide mode (854-px Hor+) — reload persists</label>
        <label><input type="checkbox" id="panini" ${s.panini ? 'checked' : ''}> Cylindrical remap (Panini) — wide-angle only, OFF by default</label>
        <hr style="border-color:#400;margin:.5rem 0">
        <label><input type="checkbox" id="showFullscreen" ${s.showFullscreen ? 'checked' : ''}> Fullscreen button (hover top edge) — OFF by default</label>
        <label><input type="checkbox" id="showCrosshair" ${s.showCrosshair ? 'checked' : ''}> Crosshair overlay — OFF by default</label>
        <label><input type="checkbox" id="showStats" ${s.showStats ? 'checked' : ''}> Level stats widget (K/I/S + time) — OFF by default</label>
        <label><input type="checkbox" id="showDemoTimer" ${s.showDemoTimer ? 'checked' : ''}> Demo timer + progress bar — OFF by default</label>
        <label>Music backend
          <select id="musicBackend">
            <option value="opl2"${backend === 'opl2' ? ' selected' : ''}>OPL2 (mono, default, offline-safe)</option>
            <option value="opl3"${backend === 'opl3' ? ' selected' : ''}>OPL3 stereo (18-voice)</option>
            <option value="gm"${backend === 'gm' ? ' selected' : ''}>GM SoundFont (.sf2)</option>
          </select>
        </label>
        <div id="sf2-status" style="font-size:0.85em;margin:4px 0 8px 0;color:#aaa"></div>
        <label>Gamepad turn speed <input type="range" id="pturn" min="0.4" max="2" step="0.1" value="${esc(s.padTurnSpeed)}"></label>
        <div class="row">
          <button id="reset">Reset defaults</button>
          <button id="close">Close (F8)</button>
        </div>`;

        // Show GM-specific status / sf2 info when GM is the current selection.
        if (backend === 'gm') {
            const sf2El = panel.querySelector('#sf2-status');
            sf2GetCurrentMeta().then(meta => {
                if (!sf2El || sf2El.parentElement !== panel) return; // stale
                if (meta) {
                    sf2El.textContent =
                        `SF2 loaded: ${meta.name} (${(meta.size / 1024 / 1024).toFixed(1)} MB)`;
                    sf2El.style.color = '#8f8';
                } else {
                    // 16.4-style loud degradation notice
                    sf2El.textContent =
                        'GM: no soundfont loaded — drag an .sf2 file onto the screen (OPL fallback until loaded)';
                    sf2El.style.color = '#fa8';
                }
            }).catch(() => {
                if (!sf2El || sf2El.parentElement !== panel) return;
                sf2El.textContent = 'GM: soundfont status unknown';
            });
        }

        panel.querySelectorAll('.bind').forEach(btn => {
            btn.onclick = () => {
                btn.textContent = 'press a key…';
                input.startCapture(btn.dataset.id, () => render());
            };
        });
        panel.querySelector('#sens').oninput = e => { s.mouseSens = +e.target.value; saveSettings(s); };
        panel.querySelector('#mmove').onchange = e => { s.mouseY = e.target.checked ? 'move' : 'off'; saveSettings(s); };
        panel.querySelector('#arun').onchange = e => { s.alwaysRun = e.target.checked; saveSettings(s); };
        panel.querySelector('#smooth').onchange = e => {
            s.smooth = e.target.checked;
            saveSettings(s);
            doom?._web_set_smooth(s.smooth ? 1 : 0);
        };
        // task 18.3: wide mode — calls web_set_wide() for deferred resize on next frame.
        panel.querySelector('#wideMode').onchange = e => {
            s.wideMode = e.target.checked;
            saveSettings(s);
            doom?._web_set_wide(s.wideMode ? 854 : 320);
            // The frame loop in main.js detects web_screenwidth() change and
            // calls renderer.resize() + toggles the .wide CSS class.
        };
        // task 18.3: Panini/cylindrical remap — updates shader uniform immediately.
        panel.querySelector('#panini').onchange = e => {
            s.panini = e.target.checked;
            saveSettings(s);
            if (renderer) {
                const w = doom?._web_screenwidth?.() ?? 320;
                renderer.setPaniniStrength(computePaniniStrength(w, s.panini));
            }
        };
        panel.querySelector('#musicBackend').onchange = e => {
            s.musicBackend = e.target.value;
            // Keep legacy opl3 bool in sync for backward compatibility.
            s.opl3 = (s.musicBackend === 'opl3');
            saveSettings(s);
            if (s.musicBackend === 'gm') {
                // GM: sink cannot be changed live after arm() — save for next session.
                // window.doomAudio.setGmMode marks intent; takes effect on next boot.
                window.doomAudio?.setGmMode?.(true, null);
                document.getElementById('status').textContent =
                    'music: GM mode saved — takes effect on next game session';
            } else {
                // OPL2/OPL3 can be changed live via _web_set_opl_mode.
                doom?._web_set_opl_mode(s.opl3 ? 1 : 0);
                window.doomAudio?.setGmMode?.(false, null);
            }
            // Re-render to show updated sf2-status panel.
            render();
        };
        panel.querySelector('#pturn').oninput = e => { s.padTurnSpeed = +e.target.value; saveSettings(s); };
        // task 19.1: QoL feature toggles — delegate to qol API so overlays update live.
        panel.querySelector('#showFullscreen').onchange = e => {
            qol?.setShowFullscreen(e.target.checked);
        };
        panel.querySelector('#showCrosshair').onchange = e => {
            qol?.setShowCrosshair(e.target.checked);
        };
        panel.querySelector('#showStats').onchange = e => {
            qol?.setShowStats(e.target.checked);
        };
        panel.querySelector('#showDemoTimer').onchange = e => {
            qol?.setShowDemoTimer(e.target.checked);
        };
        panel.querySelector('#reset').onclick = () => {
            Object.assign(s, defaultSettings());
            saveSettings(s);
            render();
        };
        panel.querySelector('#close').onclick = toggle;
    }

    function toggle() {
        panel.hidden = !panel.hidden;
        if (!panel.hidden) {
            document.exitPointerLock?.();
            render();
        } else {
            input.cancelCapture();
        }
    }

    window.addEventListener('keydown', e => {
        if (e.code === 'F8') { e.preventDefault(); toggle(); }
    }, true);

    return { toggle };
}
