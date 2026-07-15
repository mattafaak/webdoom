// WebAudio bridge: SFX (DMX PCM lumps → AudioBuffers, per-channel
// vol/sep/pitch as vanilla) and music (wasm OPL sequencer pulled into an
// AudioWorklet). Installs the Module.* hooks the engine's EM_JS calls.

const TARGET_BACKLOG = 0.25;    // seconds of music buffered ahead
const PUMP_MS = 100;

export function createAudio(doom) {
    let ctx = null;
    const buffers = new Map();          // sfx id → AudioBuffer
    const active = new Map();           // handle → {src, gain, pan}
    let musicNode = null, musicQueued = 0, musicScratch = 0, pumpTimer = 0;

    // Browsers gate audio behind a user gesture; arm on the first one.
    // Later gestures re-resume a context the browser suspended.
    const arm = async () => {
        if (ctx) {
            if (ctx.state === 'suspended') ctx.resume().catch(() => {});
            return;
        }
        ctx = new AudioContext();
        if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
        doom._web_music_init(ctx.sampleRate);
        try {
            await ctx.audioWorklet.addModule('js/music-worklet.js');
            musicNode = new AudioWorkletNode(ctx, 'music-sink', {
                outputChannelCount: [2],
            });
            musicNode.port.onmessage = e => { musicQueued = e.data.queued; };
            musicNode.connect(ctx.destination);
            musicScratch = doom._malloc(4 * 2 * 16384);
            pumpTimer = setInterval(pump, PUMP_MS);
            pump();
        } catch (err) {
            console.warn('music worklet unavailable:', err);
        }
    };
    for (const evt of ['keydown', 'mousedown', 'touchstart'])
        window.addEventListener(evt, arm, { once: false, capture: true });

    function pump() {
        const deficit = Math.floor(TARGET_BACKLOG * ctx.sampleRate) - musicQueued;
        const frames = Math.min(16384, Math.max(0, deficit));
        if (!frames) return;
        doom._web_music_render(musicScratch, frames);
        const view = doom.HEAPF32 ??
            new Float32Array(doom.HEAPU8.buffer);
        const chunk = view.slice(musicScratch / 4, musicScratch / 4 + frames * 2);
        musicQueued += frames;          // optimistic; corrected by replies
        musicNode.port.postMessage(chunk, [chunk.buffer]);
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
        // called on quit: stop the render pump and release the context so
        // the interval doesn't poke a force-exited wasm instance
        stop() {
            if (pumpTimer) clearInterval(pumpTimer);
            for (const evt of ['keydown', 'mousedown', 'touchstart'])
                window.removeEventListener(evt, arm, { capture: true });
            try { ctx?.close(); } catch { /* already closed */ }
            ctx = null;
        },
    };
}
