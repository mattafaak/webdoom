// Music on the audio thread.
//
// TWO MODES, and which one is in force depends on what the main thread sent:
//
//   SYNTH  — {type:'init', wasm} arrived: this processor instantiates
//            build/synth.wasm (the engine's own mus_opl.c + opl3.c, linked as
//            a reactor) and RENDERS the music itself, one call per 128-frame
//            quantum.  Nothing crosses the thread boundary per frame.
//   SINK   — no wasm: interleaved stereo chunks are pushed from the main
//            thread's 100 ms pump and drained here, which is what this file
//            did before round 11.  Kept as the tier for a secure origin where
//            the fetch of synth.wasm failed.
//
// Why the synth moved here (ledger NC6): `web_music_render` ran on the MAIN
// thread from a 100 ms timer, measured at 1.84 ms p99 per call on alder, 4.09
// on tank and 19.7 on wbox — against a 16.7 ms frame budget.  On wbox that is
// a dropped frame every sixth frame, in a burst rAF cannot absorb.
//
// AudioWorkletGlobalScope has no fetch and no import.meta, so the module
// arrives as BYTES over the port and is instantiated here.  synth.wasm imports
// nothing (tools/opl-mode-test.mjs gate 4 holds it to that), so the import
// object is empty.
class MusicSink extends AudioWorkletProcessor {
    constructor() {
        super();
        this._timing = false;
        // SINK mode state
        this.chunks = [];
        this.offset = 0;        // frames consumed of chunks[0]
        this.queued = 0;        // total frames queued
        // SYNTH mode state
        this.synth = null;      // wasm exports once ready
        this.heapf = null;      // Float32Array over the module's memory
        this.scratch = 0;       // interleaved render buffer inside that memory
        this.scratchFrames = 0;
        this.rendered = 0;      // frames rendered, for the gate
        this.sumsq = 0;         // running power, for the gate
        this.port.onmessage = e => this._onMessage(e.data);
    }

    _onMessage(m) {
        if (m && m.perfmarks) { this._timing = true; return; }
        if (m instanceof Float32Array) {          // SINK mode push
            this.chunks.push(m);
            this.queued += m.length / 2;
            this.port.postMessage({ queued: this.queued });
            return;
        }
        if (!m || !m.type) return;
        if (m.type === 'init') { this._init(m); return; }
        if (m.type === 'stats') {
            this.port.postMessage({ stats: {
                ready: !!this.synth, rendered: this.rendered,
                rms: this.rendered ? Math.sqrt(this.sumsq / (this.rendered * 2)) : 0,
                playing: this.synth ? this.synth.web_music_debug(0) : 0,
                noteons: this.synth ? this.synth.web_music_debug(2) : 0,
            } });
            return;
        }
        if (!this.synth) return;                  // control messages need the synth
        const s = this.synth;
        switch (m.type) {
        case 'play':    s.synth_play(this._put(m.song), m.song.length, m.looping ? 1 : 0); break;
        case 'stop':    s.synth_stop(); break;
        case 'pause':   s.synth_pause(1); break;
        case 'resume':  s.synth_pause(0); break;
        case 'volume':  s.synth_volume(m.volume | 0); break;
        case 'oplmode': s.web_set_opl_mode(m.mode | 0); break;
        }
    }

    // Copy bytes into the module's own heap through its malloc.  Ownership
    // passes to the module (engine/web/web.h states the contract).
    _put(bytes) {
        const ptr = this.synth.malloc(bytes.length);
        if (!ptr) throw new Error(`synth.wasm malloc(${bytes.length}) failed`);
        new Uint8Array(this.synth.memory.buffer).set(bytes, ptr);
        return ptr;
    }

    async _init(m) {
        try {
            const { instance } = await WebAssembly.instantiate(m.wasm, {});
            this.synth = instance.exports;
            this.synth._initialize();
            const gm = this._put(m.genmidi);
            const song = m.song && m.song.length ? this._put(m.song) : 0;
            this.synth.synth_boot(m.rate | 0, gm, m.genmidi.length, song, m.song ? m.song.length : 0,
                                  m.looping ? 1 : 0, m.paused ? 1 : 0, m.volume | 0, m.oplMode | 0);
            // One scratch buffer, big enough for any quantum a UA might use.
            this.scratchFrames = 1024;
            this.scratch = this.synth.malloc(this.scratchFrames * 2 * 4);
            if (!this.scratch) throw new Error('synth.wasm scratch malloc failed');
            // Growth is off in this module, so the view never goes stale.
            this.heapf = new Float32Array(this.synth.memory.buffer);
            this.port.postMessage({ ready: true, bytes: m.wasm.byteLength });
        } catch (err) {
            this.synth = null;
            this.port.postMessage({ ready: false, error: String(err && err.message || err) });
        }
    }

    process(inputs, outputs) {
        const t0 = this._timing ? performance.now() : 0;
        const [l, r] = outputs[0];

        if (this.synth) {
            // SYNTH: render this quantum straight out of the module.  The
            // sequencer is per-frame stateful with no per-call setup, so a
            // 128-frame call produces the same samples as one long call.
            let i = 0;
            while (i < l.length) {
                const n = Math.min(l.length - i, this.scratchFrames);
                this.synth.web_music_render(this.scratch, n);
                const base = this.scratch >> 2;
                for (let k = 0; k < n; k++) {
                    const a = this.heapf[base + k * 2], b = this.heapf[base + k * 2 + 1];
                    l[i + k] = a; r[i + k] = b;
                    this.sumsq += a * a + b * b;
                }
                i += n;
                this.rendered += n;
            }
        } else {
            // SINK: drain what the main thread pushed.
            let i = 0;
            while (i < l.length && this.chunks.length) {
                const c = this.chunks[0];
                const frames = c.length / 2;
                const n = Math.min(l.length - i, frames - this.offset);
                for (let k = 0; k < n; k++) {
                    l[i + k] = c[(this.offset + k) * 2];
                    r[i + k] = c[(this.offset + k) * 2 + 1];
                }
                i += n;
                this.offset += n;
                this.queued -= n;
                if (this.offset >= frames) { this.chunks.shift(); this.offset = 0; }
            }
        }

        if (this._timing) {
            // (d) post process() wall time back to the main thread.  NOT
            // `currentTime`: that is the context clock and does not advance
            // within a quantum, so it would report 0.000 forever.
            this.port.postMessage({ queued: this.queued, procMs: performance.now() - t0 });
        }
        return true;
    }
}
registerProcessor('music-sink', MusicSink);
