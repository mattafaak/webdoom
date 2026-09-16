// WebAudio bridge: SFX (DMX PCM lumps → AudioBuffers, per-channel vol/sep/
// pitch as vanilla) and music from the wasm OPL sequencer, pulled by a pump.
//
// Music sinks:
//   WorkletSink  — AudioWorklet (secure context only)
//   BufferSink   — AudioBufferSourceNode chain (any origin)

import { setStatus } from './ui.js';

const TARGET_BACKLOG = 0.25;    // seconds of music buffered ahead
const PUMP_MS = 100;
const BUFFER_LEAD_S = 0.05;     // scheduling lead for BufferSink (50 ms)

// ── WorkletSink ───────────────────────────────────────────────────────────────
// Wraps an AudioWorkletNode (music-worklet.js / MusicSink).
// push() transfers Float32Array chunks via postMessage; queued count is
// maintained optimistically and corrected by replies from the worklet.
function makeWorkletSink(node, perf) {
    let queued = 0;
    if (perf) node.port.postMessage({ perfmarks: true });
    node.port.onmessage = e => {
        queued = e.data.queued;
        if (e.data.procMs !== undefined && perf)
            perf.worklet.push(e.data.procMs);
    };
    return {
        kind: 'worklet',
        get queued() { return queued; },
        push(chunk) {
            queued += chunk.length / 2;   // optimistic; corrected by replies
            node.port.postMessage(chunk, [chunk.buffer]);
        },
    };
}

// ── BufferSink ────────────────────────────────────────────────────────────────
// Converts interleaved stereo Float32Array chunks to AudioBuffers and schedules
// them as a back-to-back chain on ctx.destination.  Works on any origin.
//
// Schedule clock: each push advances schedClock by frames/sampleRate.
// Underrun recovery: if schedClock falls behind ctx.currentTime the clock is
// re-anchored to currentTime + BUFFER_LEAD_S so audio resumes gap-free.
// queued: estimated frames still ahead of the playhead (≥ 0).
function makeBufferSink(ctx) {
    let schedClock = ctx.currentTime + BUFFER_LEAD_S;
    let _lastChunk = null;   // test hook: captured on every push()
    return {
        kind: 'buffer',
        // computed live: a cached value never decayed as playback drained and
        // the pump deadlocked once the backlog crossed TARGET_BACKLOG
        get queued() {
            return Math.max(0, (schedClock - ctx.currentTime) * ctx.sampleRate);
        },
        get _lastChunk() { return _lastChunk; },
        // Called by onVisible to force underrun recovery after a long-hidden tab
        // so the resumed context drains at the natural LEAD instead of 0.25s burst.
        _resetClock() { schedClock = 0; },
        push(chunk) {
            const frames = chunk.length / 2;
            const sr = ctx.sampleRate;

            // Underrun: re-anchor schedule clock
            if (schedClock < ctx.currentTime) {
                schedClock = ctx.currentTime + BUFFER_LEAD_S;
            }

            const buf = ctx.createBuffer(2, frames, sr);
            const l = buf.getChannelData(0);
            const r = buf.getChannelData(1);
            for (let i = 0; i < frames; i++) {
                l[i] = chunk[i * 2];
                r[i] = chunk[i * 2 + 1];
            }
            const src = ctx.createBufferSource();
            src.buffer = buf;
            src.connect(ctx.destination);
            src.start(schedClock);
            schedClock += frames / sr;
            _lastChunk = chunk;
        },
    };
}

export function createAudio(doom) {
    let ctx = null;
    const buffers = new Map();          // sfx id → AudioBuffer
    const active = new Map();           // handle → {src, gain, pan}
    let sink = null, musicScratch = 0, pumpTimer = 0;

    // Browsers gate audio behind a user gesture; arm on the first one.
    // Later gestures re-resume a context the browser suspended.
    const arm = async () => {
        if (ctx) {
            if (ctx.state === 'suspended') ctx.resume().catch(() => {});
            return;
        }
        try {
            ctx = new AudioContext();
        } catch (err) {
            console.warn('AudioContext creation failed:', err);
            setStatus('music unavailable: ' + (err.message ?? String(err)));
            return;
        }
        if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
        doom._web_music_init(ctx.sampleRate);

        musicScratch = doom._malloc(4 * 2 * 16384);
        // 0 means the allocation failed; web_music_render would then write its
        // frames over address 0.  Music is optional -- degrade, do not corrupt.
        if (!musicScratch) { console.warn('webdoom: no memory for the music buffer; music disabled'); return null; }

        // Detect insecure origin before attempting addModule so we can give an
        // accurate status message: on http://<LAN-IP> ctx.audioWorklet is
        // undefined; on secure origins it exists but may still throw (CSP,
        // broken worklet file, etc.).
        const insecure = !ctx.audioWorklet;

        // WorkletSink on a secure origin, BufferSink anywhere else
        try {
            await ctx.audioWorklet.addModule('js/music-worklet.js');
            const node = new AudioWorkletNode(ctx, 'music-sink', { outputChannelCount: [2] });
            node.connect(ctx.destination);
            // captured at construction; the harness installs it before the
            // first gesture
            sink = makeWorkletSink(node, window.__wd_perf ?? null);
        } catch (err) {
            console.warn('music worklet unavailable:', err);
            const reason = insecure ? 'insecure origin' : 'worklet unavailable';
            try {
                sink = makeBufferSink(ctx);
                setStatus(`music: compatibility mode (${reason})`);
            } catch (fallbackErr) {
                console.warn('music fallback sink failed:', fallbackErr);
                setStatus('music unavailable: ' + (fallbackErr.message ?? String(fallbackErr)));
                return;
            }
        }

        pumpTimer = setInterval(pump, PUMP_MS);
        pump();
    };
    for (const evt of ['keydown', 'mousedown', 'touchstart'])
        window.addEventListener(evt, arm, { once: false, capture: true });
    // Browsers suspend AudioContexts when a tab is hidden. Resume on reveal
    // so audio is live again the moment the player returns without needing
    // a fresh user gesture. Named ref so stop() can remove it (ws-007).
    // For BufferSink: re-anchor schedClock so a long-hidden tab doesn't
    // fire its accumulated backlog in one burst when the context resumes.
    const onVisible = () => {
        if (document.visibilityState === 'visible' && ctx && ctx.state === 'suspended') {
            ctx.resume().catch(() => {});
            if (sink?.kind === 'buffer' && ctx.currentTime !== undefined) {
                // Force underrun recovery path on next push() by backdating the
                // clock; makeBufferSink.push() will re-anchor to currentTime+LEAD.
                sink._resetClock?.();
            }
        }
    };
    document.addEventListener('visibilitychange', onVisible);

    function pump() {
        if (!sink) return;
        const deficit = Math.floor(TARGET_BACKLOG * ctx.sampleRate) - sink.queued;
        const frames = Math.min(16384, Math.max(0, deficit));
        if (!frames) return;

        // OPL path (default)
        doom._web_music_render(musicScratch, frames);
        const view = doom.HEAPF32 ??
            new Float32Array(doom.HEAPU8.buffer);
        const chunk = view.slice(musicScratch / 4, musicScratch / 4 + frames * 2);
        sink.push(chunk);
    }

    function decode(id, ptr, len) {
        let buf = buffers.get(id);
        if (buf) return buf;
        const bytes = doom.HEAPU8.subarray(ptr, ptr + len);
        // DMX: u16 format(=3), u16 rate, u32 length, 16 pad, samples, 16 pad
        if (len < 40 || bytes[0] !== 3) return null;
        const rate = bytes[2] | (bytes[3] << 8);
        const n = ((bytes[4] | (bytes[5] << 8) | (bytes[6] << 16) | (bytes[7] << 24)) >>> 0) - 32;
        if (n <= 0 || 24 + n > len || rate < 3000) return null;   // WebAudio min rate
        buf = ctx.createBuffer(1, n, rate);
        const ch = buf.getChannelData(0);
        for (let i = 0; i < n; i++) ch[i] = (bytes[24 + i] - 128) / 128;
        buffers.set(id, buf);
        return buf;
    }

    const pitchRate = p => Math.pow(2, (p - 128) / 64);

    doom.sfxStart = (handle, id, ptr, len, vol, sep, pitch) => {
        if (!ctx || ctx.state !== 'running') return;
        const buf = decode(id, ptr, len);
        if (!buf) return;
        const src = ctx.createBufferSource();
        const gain = ctx.createGain();
        const pan = ctx.createStereoPanner();
        src.buffer = buf;
        src.playbackRate.value = pitchRate(pitch);
        gain.gain.value = vol / 127;
        pan.pan.value = Math.max(-1, Math.min(1, (sep - 128) / 128));
        src.connect(gain).connect(pan).connect(ctx.destination);
        src.onended = () => active.delete(handle);
        active.set(handle, { src, gain, pan });
        src.start();
    };
    doom.sfxStop = handle => {
        active.get(handle)?.src.stop();
        active.delete(handle);
    };
    doom.sfxPlaying = handle => active.has(handle) ? 1 : 0;
    doom.sfxUpdate = (handle, vol, sep, pitch) => {
        const a = active.get(handle);
        if (!a) return;
        a.gain.gain.value = vol / 127;
        a.pan.pan.value = Math.max(-1, Math.min(1, (sep - 128) / 128));
        a.src.playbackRate.value = pitchRate(pitch);
    };
    doom.musicEvent = () => {};         // pump runs continuously once armed

    return {
        armed: () => !!ctx,
        // the active sink kind, 'worklet' | 'buffer' | null, and the last
        // chunk pushed -- the fallback tests read both
        sinkKind: () => sink?.kind ?? null,
        lastChunk: () => sink?._lastChunk ?? null,

        // called on quit: stop the render pump and release the context so
        // the interval doesn't poke a force-exited wasm instance
        stop() {
            if (pumpTimer) clearInterval(pumpTimer);
            for (const evt of ['keydown', 'mousedown', 'touchstart'])
                window.removeEventListener(evt, arm, { capture: true });
            document.removeEventListener('visibilitychange', onVisible);
            try { ctx?.close(); } catch { /* already closed */ }
            ctx = null;
        },
    };
}
