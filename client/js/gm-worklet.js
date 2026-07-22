// gm-worklet.js — GM music sink AudioWorkletProcessor.
//
// Wire: receives pre-rendered interleaved stereo Float32Array chunks via port,
// exactly like music-worklet.js (MusicSink).  The main thread may also send
// MIDI init messages for future SpessaSynth integration; those are accepted but
// not yet forwarded (SpessaSynth loading is operator-triggered, task 17.2b+).
//
// Port message protocol (from main thread → worklet):
//   Uint8Array / Float32Array chunk  → audio data to queue (same as MusicSink)
//   { type: 'init', spessaSynthUrl, soundfontUrl } → reserved for 17.2b wiring
//   { perfmarks: true } → enable per-process() timing
//
// Port message protocol (worklet → main thread):
//   { queued: N }                  → current queued frame count
//   { queued: N, procMs: T }       → queued + process() wall time (if perfmarks)

class GmSink extends AudioWorkletProcessor {
    constructor() {
        super();
        this._timing = false;
        this._chunks = [];
        this._offset = 0;   // frames consumed of _chunks[0]
        this._queued = 0;   // total frames queued

        this.port.onmessage = e => {
            const d = e.data;
            if (!d) return;

            // Timing toggle
            if (d.perfmarks) { this._timing = true; return; }

            // Reserved: init message for SpessaSynth (17.2b)
            if (d.type === 'init') {
                // No-op until 17.2b wires SpessaSynth loading.
                this.port.postMessage({ queued: this._queued, initAck: true });
                return;
            }

            // Audio chunk (Float32Array or ArrayBuffer): same as MusicSink
            const chunk = d instanceof Float32Array ? d
                : d.buffer ? new Float32Array(d.buffer) : d;
            if (!(chunk instanceof Float32Array) || chunk.length === 0) return;

            this._chunks.push(chunk);
            this._queued += chunk.length / 2;
            this.port.postMessage({ queued: this._queued });
        };
    }

    process(_inputs, outputs) {
        const t0 = this._timing ? performance.now() : 0;
        const [l, r] = outputs[0];
        let i = 0;

        while (i < l.length && this._chunks.length) {
            const c = this._chunks[0];
            const frames = c.length / 2;
            const n = Math.min(l.length - i, frames - this._offset);
            for (let k = 0; k < n; k++) {
                l[i + k] = c[(this._offset + k) * 2];
                r[i + k] = c[(this._offset + k) * 2 + 1];
            }
            i += n;
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
