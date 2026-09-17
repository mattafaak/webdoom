// WebAudio bridge: SFX (DMX PCM lumps → AudioBuffers, per-channel vol/sep/
// pitch as vanilla) and music from the OPL sequencer.
//
// Three music tiers, best first (ledger NC6):
//   WORKLET SYNTH — the worklet runs build/synth.wasm and renders the music
//                   itself.  No pump, no per-frame thread crossing, and
//                   web_music_render never touches the main thread.
//   WorkletSink   — AudioWorklet without the module (its fetch failed): the
//                   100 ms pump renders on the main thread and pushes chunks.
//   BufferSink    — no AudioWorklet at all (insecure origin, spec.md §203):
//                   the same pump into an AudioBufferSourceNode chain.
//
// The engine's own mus_opl keeps running in tier 1 -- mus_play/mus_stop only
// store pointers and queue a few register writes -- but nothing pulls samples
// from it, so it costs nothing per frame.

import { setStatus } from './ui.js';

const TARGET_BACKLOG = 0.25;    // seconds of music buffered ahead
const PUMP_MS = 100;
const BUFFER_LEAD_S = 0.05;     // scheduling lead for BufferSink (50 ms)
const SYNTH_READY_MS = 2000;    // how long to wait for the worklet to instantiate

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
    let workletNode = null;             // set on any worklet tier
    let oplMode = 0;                    // mirrored into both synths
    let synthLive = false;              // tier 1: the worklet owns the synth
    let lastStats = null;

    // The module the worklet renders with, fetched once.  Insecure origins
    // never ask for it: they have no AudioWorklet to give it to.
    const synthWasm = (typeof window !== 'undefined' && window.isSecureContext)
        ? fetch('engine/synth.wasm')
            .then(r => (r.ok ? r.arrayBuffer() : null))
            .catch(() => null)
        : Promise.resolve(null);

    // What the engine's synth is doing right now: genmidi, song, looping,
    // paused, volume.  createAudio runs AFTER callMain, so the boot-time
    // I_PlaySong and I_SetMusicVolume already happened and JS never saw them --
    // this reads the state instead of replaying events it missed.
    const musicState = () => {
        const p = doom._malloc(7 * 4);
        if (!p) return null;
        doom._web_music_state(p);
        const v = new Int32Array(doom.HEAP32.buffer, p, 7);
        const out = {
            genmidi: v[0] ? doom.HEAPU8.slice(v[0], v[0] + v[1]) : null,
            song:    v[2] ? doom.HEAPU8.slice(v[2], v[2] + v[3]) : null,
            looping: v[4], paused: v[5], volume: v[6],
        };
        doom._free(p);
        return out;
    };

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
        if (window.__wd_perf) window.__wd_perf.sampleRate = ctx.sampleRate;

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
            workletNode = node;
            // captured at construction; the harness installs it before the
            // first gesture
            sink = makeWorkletSink(node, window.__wd_perf ?? null);
            // One handler for the port, installed over the sink's: `ready` and
            // `stats` are answers to questions this module asks, everything
            // else is the sink's backlog accounting.  The first cut left the
            // sink's handler in place after init and every stats reply was
            // dropped on the floor.
            const sinkOnMessage = node.port.onmessage;
            let onReady = null;
            node.port.onmessage = e => {
                const d = e.data;
                if (d && d.ready !== undefined) { onReady?.(d); return; }
                if (d && d.stats) { lastStats = d.stats; return; }
                sinkOnMessage?.(e);
            };

            // Tier 1: hand the worklet the module and the engine's music state.
            // Anything short of a `ready` reply leaves the pump in charge, so a
            // failure here costs the thread move and nothing else.
            const wasm = await synthWasm;
            const st = wasm && musicState();
            if (st && st.genmidi) {
                synthLive = await new Promise(resolve => {
                    const t = setTimeout(() => resolve(false), SYNTH_READY_MS);
                    onReady = d => {
                        clearTimeout(t);
                        onReady = null;
                        if (d.ready === false) console.warn('worklet synth unavailable:', d.error);
                        resolve(d.ready === true);
                    };
                    node.port.postMessage({
                        type: 'init', wasm, rate: ctx.sampleRate,
                        genmidi: st.genmidi, song: st.song, looping: st.looping,
                        paused: st.paused, volume: st.volume,
                        oplMode,
                    }, [wasm, st.genmidi.buffer, ...(st.song ? [st.song.buffer] : [])]);
                });
            }
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

        // Tier 1 needs no pump at all: the worklet renders its own samples.
        if (synthLive) {
            doom._free(musicScratch);
            musicScratch = 0;
            return;
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

        // the synth runs here, on the main thread, ~10 times a second; the
        // pipeline profiler reads how long that takes (stage (f) opl)
        const perf = window.__wd_perf;
        const t0 = perf ? performance.now() : 0;
        doom._web_music_render(musicScratch, frames);
        if (perf) { perf.opl.push(performance.now() - t0); perf.oplFrames.push(frames); }
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
    // In tiers 2 and 3 the pump renders whatever the engine's synth is doing,
    // so these events need no relaying.  In tier 1 they ARE the relay: the
    // worklet has its own copy of the synth and learns about a song change,
    // a pause or a volume move only through here.
    //   what: 0 stop, 1 play(ptr,len,looping), 2 pause, 3 resume, 4 volume(arg)
    doom.musicEvent = (what, ptr, len, arg) => {
        if (!synthLive || !workletNode) return;
        const port = workletNode.port;
        switch (what) {
        case 0: port.postMessage({ type: 'stop' }); break;
        case 1: {
            if (!ptr || !len) return;
            const song = doom.HEAPU8.slice(ptr, ptr + len);
            port.postMessage({ type: 'play', song, looping: arg }, [song.buffer]);
            break;
        }
        case 2: port.postMessage({ type: 'pause' }); break;
        case 3: port.postMessage({ type: 'resume' }); break;
        case 4: port.postMessage({ type: 'volume', volume: arg }); break;
        }
    };

    return {
        armed: () => !!ctx,
        // The OPL flavour reaches BOTH synths: the engine's (which tiers 2 and
        // 3 pull from) and the worklet's own copy.
        setOplMode(mode) {
            oplMode = mode ? 1 : 0;
            doom._web_set_opl_mode(oplMode);
            if (synthLive && workletNode) workletNode.port.postMessage({ type: 'oplmode', mode: oplMode });
        },
        // Whether the worklet is rendering, and what it has produced.  The
        // browser-music-worklet leg reads this; a resolved `null` means the
        // worklet never answered.
        synthLive: () => synthLive,
        musicStats() {
            if (!synthLive || !workletNode) return Promise.resolve(null);
            lastStats = null;
            workletNode.port.postMessage({ type: 'stats' });
            return new Promise(resolve => {
                const deadline = Date.now() + 1000;
                const tick = () => {
                    if (lastStats || Date.now() > deadline) { resolve(lastStats); return; }
                    setTimeout(tick, 20);
                };
                tick();
            });
        },
        // the active sink kind, 'worklet' | 'buffer' | null, and the last
        // chunk pushed -- the fallback tests read both
        sinkKind: () => sink?.kind ?? null,
        lastChunk: () => sink?._lastChunk ?? null,

        // called on quit: stop the render pump and release the context so
        // the interval doesn't poke a force-exited wasm instance
        stop() {
            if (pumpTimer) clearInterval(pumpTimer);
            synthLive = false;
            workletNode = null;
            for (const evt of ['keydown', 'mousedown', 'touchstart'])
                window.removeEventListener(evt, arm, { capture: true });
            document.removeEventListener('visibilitychange', onVisible);
            try { ctx?.close(); } catch { /* already closed */ }
            ctx = null;
        },
    };
}
