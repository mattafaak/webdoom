// Music sink: consumes interleaved stereo f32 chunks pushed from the
// main thread (rendered by the wasm OPL sequencer) and reports its
// backlog so the pump can keep ~250ms buffered — no SharedArrayBuffer,
// no COOP/COEP requirements.
//
// Per-frame timing: when the main thread sends {perfmarks: true} via the
// port, process() measures its own wall time and posts it back alongside
// the queued count.  tools/browser-pipeline.mjs collects this via audio.js.
class MusicSink extends AudioWorkletProcessor {
    constructor() {
        super();
        this._timing = false;
        this.chunks = [];
        this.offset = 0;        // frames consumed of chunks[0]
        this.queued = 0;        // total frames queued
        this.port.onmessage = e => {
            if (e.data && e.data.perfmarks) { this._timing = true; return; }
            this.chunks.push(e.data);
            this.queued += e.data.length / 2;
            this.port.postMessage({ queued: this.queued });
        };
    }

    process(inputs, outputs) {
        const t0 = this._timing ? performance.now() : 0;
        const [l, r] = outputs[0];
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
        if (this._timing) {
            // (d) post process() wall time back to main thread alongside backlog
            this.port.postMessage({ queued: this.queued, procMs: performance.now() - t0 });
        }
        return true;
    }
}
registerProcessor('music-sink', MusicSink);
