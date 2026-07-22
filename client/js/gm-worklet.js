// gm-worklet.js — GM music silence-only AudioWorkletProcessor (task 17.2b).
//
// SpessaSynth integration runs on the MAIN THREAD in audio.js (not here).
// SpessaSynth's Synthetizer(targetNode, sf2ArrayBuffer) creates its own
// AudioWorklet chain internally — it cannot be instantiated inside a foreign
// AudioWorkletProcessor.  See docs/decision-17.2a-soundfont-gm.md and audio.js.
//
// This processor is kept as a silence-sink fallback only.  It is NOT loaded
// by the default GM path in audio.js (which uses a relay GainNode instead).
// It remains available as a lightweight silence-chunk queue for any future
// use case that needs a worklet-based buffer endpoint.
//
// Port message protocol (main thread → worklet):
//   Uint8Array / Float32Array chunk  → audio data to queue
//   { perfmarks: true }             → enable per-process() timing
//
// Port message protocol (worklet → main thread):
//   { queued: N }               → current queued frame count
//   { queued: N, procMs: T }    → queued + process() wall time (if perfmarks)

class GmSink extends AudioWorkletProcessor {
    constructor() {
        super();
        this._timing  = false;
        this._chunks  = [];
        this._offset  = 0;   // frames consumed of _chunks[0]
        this._queued  = 0;   // total frames queued

        this.port.onmessage = e => {
            const d = e.data;
            if (!d) return;

            // Timing toggle
            if (d.perfmarks) { this._timing = true; return; }

            // Audio chunk (Float32Array or ArrayBuffer): queue for playback.
            const chunk = d instanceof Float32Array ? d
                : (d.buffer ? new Float32Array(d.buffer) : d);
            if (!(chunk instanceof Float32Array) || chunk.length === 0) return;

            this._chunks.push(chunk);
            this._queued += chunk.length / 2;
            this.port.postMessage({ queued: this._queued });
        };
    }

    process(_inputs, outputs) {
        const t0   = this._timing ? performance.now() : 0;
        const [l, r] = outputs[0];

        // Queue-playback path: drain queued chunks into output.
        let i = 0;
        while (i < l.length && this._chunks.length) {
            const c      = this._chunks[0];
            const frames = c.length / 2;
            const n      = Math.min(l.length - i, frames - this._offset);
            for (let k = 0; k < n; k++) {
                l[i + k] = c[(this._offset + k) * 2];
                r[i + k] = c[(this._offset + k) * 2 + 1];
            }
            i            += n;
            this._offset += n;
            this._queued -= n;
            if (this._offset >= frames) { this._chunks.shift(); this._offset = 0; }
        }

        if (this._timing) {
            this.port.postMessage({ queued: this._queued, procMs: performance.now() - t0 });
        }
        return true;
    }
}

registerProcessor('gm-sink', GmSink);
