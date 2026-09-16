// webdoom demo bridge: one-click record → share, and demo permalink replay.
//
// Recording (sender):
//   1. bootDoom({ record: true }) passes -record to callMain, so
//      G_RecordDemo runs inside D_DoomMain and G_BeginRecording fires from
//      D_DoomLoop.  (An armRecording(doom) export used to offer a second way
//      in; it had no caller and was removed in round 6.)
//   2. stopAndShare(doom, wadFile) stops recording, uploads to the server,
//      and returns a share URL.  Displays the URL in the share panel.
//
// Replay (receiver):
//   - parseDemoUrl() checks location.search / location.hash for a demo param.
//   - If found, downloadDemo() fetches the bytes.
//   - startReplay(doom, bytes) injects bytes into the engine via
//     web_play_demo_buf and lets the rAF loop drive frames.
//
// Caps (stated, matching server/demo-store.js):
//   PER_DEMO_CAP  1,048,576 bytes — server rejects larger uploads with 413
//   FRAGMENT_MAX  6,000 bytes raw — URL-fragment embed only below this threshold
//   TTL           24 hours from upload
//
// WAD ownership check (receiver):
//   If the share URL carries a wad= param and the receiver does not own the
//   WAD (server manifest or 16.6 local library), lobby.js shows the warning
//   and aborts the replay — the ownership check gates BOTH the server-id and
//   fragment-embed paths.

import { setStatus } from './ui.js';

const FRAGMENT_MAX = 6_000;   // raw bytes; server/demo-store.js carries the same value (wire-constants)

// ── Recording ─────────────────────────────────────────────────────────────────

// Stop recording, collect the .lmp bytes, upload to the server, and return
// the share URL (or null on network error).
// wadFile: e.g. "doom.wad" — passed to the server for the WAD ownership hint.
export async function stopAndShare(doom, wadFile = '') {
    if (typeof doom._web_demo_stop !== 'function') throw new Error('no demo bridge');
    const size = doom._web_demo_stop();
    if (size <= 0) throw new Error('not recording or empty demo');

    const ptr   = doom._web_demo_buf_ptr();
    const bytes = doom.HEAPU8.slice(ptr, ptr + size);

    // Fragment embed: if the raw demo is small enough, encode in the URL hash.
    // This requires no server round-trip and works offline once the page is cached.
    if (size <= FRAGMENT_MAX) {
        const b64 = _toBase64Url(bytes);
        const u   = new URL(location.href);
        u.search  = '';
        u.hash    = `demo=${encodeURIComponent(b64)}&wad=${encodeURIComponent(wadFile)}`;
        return u.toString();
    }

    // Server-stored: upload and get a content-addressed id.
    const res = await fetch(`/api/demos?wad=${encodeURIComponent(wadFile)}`, {
        method: 'POST',
        body: bytes,
        headers: { 'content-type': 'application/octet-stream' },
    });
    if (!res.ok) throw new Error(`upload failed: ${res.status}`);
    const { id } = await res.json();
    const u = new URL(location.href);
    u.search = `?demo=${id}&wad=${encodeURIComponent(wadFile)}`;
    u.hash   = '';
    return u.toString();
}

// ── Replay ────────────────────────────────────────────────────────────────────

// Parse the current URL for a demo share param.
// Returns { bytes: Uint8Array, wad: string } or null.
export async function parseDemoUrl() {
    // Fragment embed takes precedence (no server round-trip).
    const hash = location.hash.slice(1);
    if (hash) {
        const p = new URLSearchParams(hash);
        const b64 = p.get('demo');
        const wad = p.get('wad') ?? '';
        if (b64) {
            try {
                const bytes = _fromBase64Url(b64);
                // FRAGMENT_MAX was enforced only when WRITING a share link, so
                // a hand-made URL could put any amount of base64 through this
                // path.  Enforce it on the way in as well (task 23.4).
                if (bytes.length > FRAGMENT_MAX) {
                    console.warn(`demo: fragment is ${bytes.length} bytes, over the ` +
                                 `${FRAGMENT_MAX}-byte limit — ignoring`);
                } else {
                    return { bytes, wad };
                }
            } catch { /* malformed — fall through to server param */ }
        }
    }

    // Server-stored id from query string.
    const params = new URLSearchParams(location.search);
    const id  = params.get('demo');
    const wad = params.get('wad') ?? '';
    if (!id) return null;

    if (!/^[0-9a-f]{64}$/.test(id)) {
        console.warn('demo: invalid id in URL');
        return null;
    }

    const res = await fetch(`/api/demos/${id}`);
    if (!res.ok) return null;
    const buf  = await res.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const demoWad = res.headers.get('x-demo-wad') || wad;
    return { bytes, wad: demoWad };
}

// Start demo playback in an already-booted doom instance.
// bytes: Uint8Array of raw .lmp data.
// Returns 0 on success, -1 on version error.
//
// singletics (1 tic per rAF) is enabled before web_play_demo_buf so that
// the first requestAnimationFrame callback does not burst-process all
// pending wall-clock tics in one call.  Without this, a browser that spent
// ~3 s loading the WAD would accumulate ~105 wall-clock tics and consume the
// entire 50-tic demo in a single frame — making per-tic hash collection and
// test-harness hook injection impossible.  In normal (non-test) replay the
// 1-tic-per-frame rate is also the correct playback speed.
export function startReplay(doom, bytes) {
    if (typeof doom._web_play_demo_buf !== 'function')
        throw new Error('web_play_demo_buf not available — rebuild engine');
    // Arm singletics BEFORE the first rAF so TryRunTics cannot burst.
    if (typeof doom._web_set_singletics === 'function')
        doom._web_set_singletics(1);
    const ptr = doom._malloc(bytes.length);
    if (!ptr) throw new Error(`out of memory for a ${bytes.length}-byte demo`);
    doom.HEAPU8.set(bytes, ptr);
    const rc = doom._web_play_demo_buf(ptr, bytes.length);
    // Note: ptr is intentionally NOT freed — the zone copy in web_play_demo_buf
    // owns the data; the malloc'd raw copy can be freed but the zone buffer
    // outlives playback.  Both are reclaimed when the wasm instance exits.
    return rc;
}


// ── Share panel helpers ───────────────────────────────────────────────────────

// The share panel: the link, COPY, and a close.  Built with properties, never
// innerHTML -- the URL carries a base64 demo.  Styled under #demo-share-panel.
export function showSharePanel(shareUrl) {
    const el = (tag, props) => Object.assign(document.createElement(tag), props);
    const panel = document.getElementById('demo-share-panel') ??
        document.body.appendChild(el('div', { id: 'demo-share-panel' }));
    panel.replaceChildren(
        el('span', { textContent: 'DEMO LINK: ' }),
        el('a', { href: shareUrl, textContent: shareUrl.length > 60 ? shareUrl.slice(0, 57) + '…' : shareUrl }),
        el('button', { textContent: 'COPY', onclick: () => navigator.clipboard?.writeText(shareUrl).catch(() => {}) }),
        el('button', { textContent: 'X', onclick: () => panel.remove() }),
    );
}

// The receiver does not own the WAD the demo needs.
export function showWadWarning(wadFile) {
    setStatus(`DEMO requires ${wadFile || 'unknown WAD'} — you must own this WAD to replay. Add it to the library (IMPORT WAD).`);
}

// ── base64url helpers ─────────────────────────────────────────────────────────

function _toBase64Url(bytes) {
    let b = '';
    for (let i = 0; i < bytes.length; i++) b += String.fromCharCode(bytes[i]);
    return btoa(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function _fromBase64Url(s) {
    const std = s.replace(/-/g, '+').replace(/_/g, '/');
    const pad = (4 - (std.length % 4)) % 4;
    const b64 = std + '='.repeat(pad);
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}
