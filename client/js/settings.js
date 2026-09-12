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
import { setStatus, teardownLedger } from './ui.js';

export function createSettingsUI(input, doom) {
    // Teardown ledger (task 23.7b) — see input.js for why.
    const { on, off: _teardownAll } = teardownLedger();

    const s = input.settings;
    const panel = document.createElement('div');
    panel.id = 'settings';
    panel.hidden = true;
    // A bare <div> with a heading in it is not a dialog to anything but a
    // sighted mouse user: no role, no modality, no label, no focus handling,
    // and Escape did not close it.  The <h2> the template already renders is
    // the label; render() gives it the id this points at.
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 'settings-title');
    document.getElementById('stage').appendChild(panel);

    // Where focus came from, so closing can put it back.  Losing focus to
    // <body> after closing a dialog strands a keyboard user at the top of the
    // document with no way back to what they were doing.
    let returnFocus = null;

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
        <h2 id="settings-title">webdoom settings</h2>
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
        panel.querySelector('#musicBackend').onchange = e => {
            s.musicBackend = e.target.value;
            // Keep legacy opl3 bool in sync for backward compatibility.
            s.opl3 = (s.musicBackend === 'opl3');
            saveSettings(s);
            if (s.musicBackend === 'gm') {
                // GM: sink cannot be changed live after arm() — save for next session.
                // window.doomAudio.setGmMode marks intent; takes effect on next boot.
                window.doomAudio?.setGmMode?.(true, null);
                setStatus('music: GM mode saved — takes effect on next game session');
            } else {
                // OPL2/OPL3 can be changed live via _web_set_opl_mode.
                doom?._web_set_opl_mode(s.opl3 ? 1 : 0);
                window.doomAudio?.setGmMode?.(false, null);
            }
            // Re-render to show updated sf2-status panel.
            render();
        };
        panel.querySelector('#pturn').oninput = e => { s.padTurnSpeed = +e.target.value; saveSettings(s); };
        panel.querySelector('#reset').onclick = () => {
            Object.assign(s, defaultSettings());
            saveSettings(s);
            // Assigning and re-rendering was the whole of it, so every applier
            // the onchange handlers call was skipped: the crosshair, stats and
            // demo-timer overlays stayed on screen and wide mode stayed on,
            // each with its checkbox now reading off.  The panel said one thing
            // and the game did another, with no way back but a reload.
            applyAll();
            render();
        };
        panel.querySelector('#close').onclick = toggle;
    }

    // Push the whole settings object at everything that holds a copy of part of
    // it.  The per-control onchange handlers each do their own slice of this;
    // this is the same set, applied at once, for the paths that change many
    // settings in one go (Reset defaults).
    function applyAll() {
        doom?._web_set_smooth?.(s.smooth ? 1 : 0);
        if (s.musicBackend === 'gm') {
            window.doomAudio?.setGmMode?.(true, null);
        } else {
            doom?._web_set_opl_mode?.(s.opl3 ? 1 : 0);
            window.doomAudio?.setGmMode?.(false, null);
        }
    }

    function toggle() {
        panel.hidden = !panel.hidden;
        if (!panel.hidden) {
            returnFocus = document.activeElement;
            document.exitPointerLock?.();
            render();
            // Into the dialog, not merely visible on top of it.
            panel.querySelector('button, input, select')?.focus();
        } else {
            input.cancelCapture();
            try { returnFocus?.focus?.(); } catch { /* element is gone */ }
            returnFocus = null;
        }
    }

    on(window, 'keydown', e => {
        if (e.code === 'F8') { e.preventDefault(); toggle(); }
        // Escape closes it, which is what every dialog does and what a player
        // who has just opened one by accident will press.  Not while a rebind
        // capture is armed: there Escape means "cancel the capture", and
        // input.js handles it.
        if (e.code === 'Escape' && !panel.hidden && !input.capturing?.()) {
            e.preventDefault();
            e.stopPropagation();
            toggle();
        }
        // Keep focus inside the dialog.  Without this, Tab walks out of a
        // modal into the page behind it -- which here is a game canvas.
        if (e.code === 'Tab' && !panel.hidden) {
            const f = [...panel.querySelectorAll('button, input, select')]
                .filter(el => !el.disabled && el.offsetParent !== null);
            if (!f.length) return;
            const first = f[0], last = f[f.length - 1];
            if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
            else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        }
    }, true);

    return {
        toggle,
        destroy() {
            _teardownAll();
            // The panel is appended per boot; a second one would share the
            // #settings id with the first.
            panel?.remove?.();
        },
    };
}
