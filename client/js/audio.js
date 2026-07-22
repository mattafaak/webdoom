// WebAudio bridge: SFX (DMX PCM lumps → AudioBuffers, per-channel
// vol/sep/pitch as vanilla) and music (wasm OPL sequencer or GM SoundFont).
//
// Music delivery uses one of three sinks:
//   WorkletSink  — AudioWorklet (OPL; requires secure context / HTTPS / localhost)
//   BufferSink   — AudioBufferSourceNode chain (OPL fallback; any origin)
//   GmMainSink   — main-thread SpessaSynth path (GM backend; opt-in)
//
// Default: OPL (WorkletSink or BufferSink depending on origin security).
// GM backend is activated by setGmMode(true, sf2Bytes, spessaSynthUrl) (task 17.2b).
//
// SpessaSynth architecture (task 17.2b):
//   SpessaSynth's Synthetizer is a main-thread AudioNode class that creates
//   its own AudioWorklet chain internally.  It CANNOT be instantiated inside
//   a foreign AudioWorkletProcessor.  The correct wiring is:
//     relayGain = ctx.createGain() → ctx.destination
//     new Synthetizer(relayGain, sf2ArrayBuffer)
//   SpessaSynth manages its own scheduling; audio.js pump() is a no-op for GM.
//   When SpessaSynth is absent (operator not configured), relayGain is connected
//   but has no signal → silence.  "SKIP loudly" contract: console.warn + visible
//   status message.  gmPathBuilt is set to true when the relay node is connected.
//
// Pump routing:
//   OPL mode: pump() calls doom._web_music_render() → PCM → sink.push()
//   GM mode:  pump() is a no-op (SpessaSynth / silence are self-scheduling)

import { musToMidi } from './mus2mid.js';

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
    let queued = 0;
    let _lastChunk = null;   // test hook: captured on every push()
    return {
        kind: 'buffer',
        get queued() { return queued; },
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
            queued = Math.max(0, (schedClock - ctx.currentTime) * sr);
            _lastChunk = chunk;
        },
    };
}

// ── GmMainSink ────────────────────────────────────────────────────────────────
// Sentinel sink for the GM main-thread SpessaSynth path.
// SpessaSynth manages its own AudioWorklet chain and output scheduling;
// push() is never called.  pump() skips this sink entirely.
// queued always returns 0 so the pump deficit check short-circuits cleanly.
function makeGmMainSink() {
    return {
        kind: 'gm-main',
        get queued() { return 0; },
    };
}

// ── setStatus ─────────────────────────────────────────────────────────────────
// Writes a user-visible message to #status (same element main.js uses).
// Called from arm() to report fallback activation or failure.
const setStatus = msg => {
    const el = document.getElementById('status');
    if (el) el.textContent = msg;
};

export function createAudio(doom) {
    let ctx = null;
    const buffers = new Map();          // sfx id → AudioBuffer
    const active = new Map();           // handle → {src, gain, pan}
    let sink = null, musicScratch = 0, pumpTimer = 0;

    // GM mode state (inactive by default; activated by setGmMode).
    let gmEnabled = false;
    // gmSf2Bytes: Uint8Array from IDB; passed to SpessaSynth Synthetizer.
    let gmSf2Bytes = null;
    // gmSpessaSynthUrl: operator-hosted SpessaSynth URL (null = not configured).
    // Always null in test/CI; real playback requires operator to host the lib.
    let gmSpessaSynthUrl = null;
    // gmSynth: SpessaSynth Synthetizer instance (null until loaded).
    let gmSynth = null;
    // gmMidiQueue: MIDI byte arrays queued before synth is ready to receive events.
    let gmMidiQueue = [];
    // gmPathBuilt: true when the relay GainNode has been connected to ctx.destination.
    // Used by tests to assert the GM path was constructed (even when SpessaSynth absent).
    let gmPathBuilt = false;

    // ── gmDispatchMidi ────────────────────────────────────────────────────────
    // Dispatch a raw MIDI byte array to SpessaSynth using the correct per-command
    // Synthetizer API.  Shared by live routing and pre-init queue drain.
    function gmDispatchMidi(bytes) {
        if (!gmSynth) return;
        const cmd = bytes[0] >> 4;
        const ch  = bytes[0] & 0xf;
        if      (cmd === 0x9) gmSynth.noteOn?.(ch, bytes[1], bytes[2] ?? 64);
        else if (cmd === 0x8) gmSynth.noteOff?.(ch, bytes[1]);
        else if (cmd === 0xb) gmSynth.controllerChange?.(ch, bytes[1], bytes[2]);
        else if (cmd === 0xc) gmSynth.programChange?.(ch, bytes[1]);
    }

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

        // Detect insecure origin before attempting addModule so we can give an
        // accurate status message: on http://<LAN-IP> ctx.audioWorklet is
        // undefined; on secure origins it exists but may still throw (CSP,
        // broken worklet file, etc.).
        const insecure = !ctx.audioWorklet;

        if (gmEnabled) {
            // GM path: SpessaSynth runs on the main thread and manages its own
            // AudioWorklet chain internally.
            // Synthetizer(targetNode, sf2ArrayBuffer) — SpessaSynth API (v3+).
            // targetNode is a relay GainNode → ctx.destination; SpessaSynth
            // connects its output chain to it.  Absence of any signal = silence.
            try {
                const relayNode = ctx.createGain();
                relayNode.connect(ctx.destination);
                sink = makeGmMainSink();
                gmPathBuilt = true;

                if (gmSpessaSynthUrl && gmSf2Bytes?.byteLength > 0) {
                    // Lazy-load SpessaSynth from operator server.
                    // Always fails in test/CI (URL null or SpessaSynth not served).
                    setStatus('music: GM SoundFont mode (loading…)');
                    import(gmSpessaSynthUrl)
                        .then(ss => {
                            const SoundFont2  = ss.SoundFont2  ?? ss.default?.SoundFont2;
                            const Synthetizer = ss.Synthetizer ?? ss.default?.Synthetizer;
                            if (!SoundFont2 || !Synthetizer) {
                                throw new Error(
                                    'SpessaSynth module does not export SoundFont2/Synthetizer',
                                );
                            }
                            // Transfer a copy so the main thread retains the original Uint8Array.
                            const sf2Buf = gmSf2Bytes.buffer.slice(
                                gmSf2Bytes.byteOffset,
                                gmSf2Bytes.byteOffset + gmSf2Bytes.byteLength,
                            );
                            // Synthetizer(targetNode, sf2ArrayBuffer) — correct SpessaSynth API.
                            // SpessaSynth creates its own internal AudioWorkletNode connected to
                            // relayNode.  It is NOT instantiated inside a foreign worklet.
                            gmSynth = new Synthetizer(relayNode, sf2Buf);
                            // Drain MIDI events queued before synth was ready.
                            for (const bytes of gmMidiQueue) gmDispatchMidi(bytes);
                            gmMidiQueue = [];
                            setStatus('music: GM SoundFont mode');
                        })
                        .catch(err => {
                            // Loud skip: SpessaSynth absent or failed to fetch → silence.
                            const reason = err?.message ?? String(err);
                            console.warn(
                                '[audio] SpessaSynth unavailable — silence.',
                                'Reason:', reason,
                            );
                            setStatus(
                                'music: GM SoundFont mode (SpessaSynth unavailable — silence)',
                            );
                        });
                } else {
                    // No URL or no sf2: SKIP loudly, relay stays silent.
                    const reason = !gmSpessaSynthUrl
                        ? 'no spessaSynthUrl configured'
                        : 'no sf2 loaded';
                    console.warn('[audio] SpessaSynth SKIP loudly:', reason);
                    setStatus(
                        'music: GM SoundFont mode (SpessaSynth unavailable — silence)',
                    );
                }
            } catch (err) {
                console.warn('[audio] GM path setup failed, falling back to OPL:', err);
                gmEnabled = false;
                gmPathBuilt = false;
                sink = null;  // fall through to OPL path below
            }
        }

        if (!sink) {
            // OPL path (default)
            try {
                await ctx.audioWorklet.addModule('js/music-worklet.js');
                const node = new AudioWorkletNode(ctx, 'music-sink', {
                    outputChannelCount: [2],
                });
                node.connect(ctx.destination);
                // window.__wd_perf captured at WorkletSink construction time;
                // browser-pipeline.mjs always sets it before the first user
                // gesture, so this is equivalent to a dynamic read in practice.
                sink = makeWorkletSink(node, window.__wd_perf ?? null);
            } catch (err) {
                console.warn('music worklet unavailable:', err);
                // Fall back to the AudioBufferSourceNode chain which works on any
                // origin (no AudioWorklet required).
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
        // GM main-thread path: SpessaSynth self-schedules (or silence via undriven
        // relay node).  Nothing for the pump to push.
        if (sink.kind === 'gm-main') return;

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
        // Returns the active sink kind: 'worklet' | 'buffer' | 'gm-main' | null.
        // Used by tests to verify fallback path activation and GM path construction.
        sinkKind: () => sink?.kind ?? null,
        // Returns the most recently pushed audio chunk (Float32Array).
        // Used by tests to verify the OPL pump produced non-zero frames.
        // Returns null for gm-main (SpessaSynth self-schedules; no push-wire).
        lastChunk: () => sink?._lastChunk ?? null,
        // Returns true when the GM relay GainNode was connected to ctx.destination.
        // True even when SpessaSynth is absent (SKIP loudly path).
        // Used by tests instead of gmFramesPushed (push-wire metric is N/A for gm-main).
        gmPathBuilt: () => gmPathBuilt,

        // Enable/disable the GM SoundFont backend.
        // Must be called BEFORE the first user gesture (before arm() runs) for
        // the sink selection to take effect.  If called after arm(), the
        // setting is saved for the next game session.
        // sf2Bytes: Uint8Array from IDB (task 17.2b); null = no soundfont loaded.
        // spessaSynthUrl: operator-hosted SpessaSynth URL; null = not configured.
        setGmMode(enabled, sf2Bytes = null, spessaSynthUrl = null) {
            gmEnabled = !!enabled;
            gmSf2Bytes = (sf2Bytes instanceof Uint8Array) ? sf2Bytes : null;
            if (spessaSynthUrl) gmSpessaSynthUrl = String(spessaSynthUrl);
        },

        // Route raw MIDI bytes to SpessaSynth (live or queued pre-init).
        // cmd dispatch is shared with gmDispatchMidi for consistency.
        sendMidi(bytes) {
            if (gmSynth) {
                gmDispatchMidi(bytes);
            } else if (gmEnabled) {
                gmMidiQueue.push(bytes instanceof Uint8Array ? bytes.slice() : Uint8Array.from(bytes));
            }
        },

        // Expose mus2mid for engine integration (future: MUS data from WAD).
        musToMidi,

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
