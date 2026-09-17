// Per-frame timing under ?perfmarks=1.  window.__wd_perf holds raw duration
// arrays that tools/browser-pipeline.mjs reads over CDP at the end of a run;
// video.js and audio.js push their own stages into the same object.  Without
// the flag the object does not exist and every hook is one null-check.

if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('perfmarks')) {
    window.__wd_perf = {
        frames: 0,          // rAF callbacks counted
        raf: [],            // frame-to-frame interval (ms) — rAF jitter
        rafDur: [],         // rAF callback duration (ms)
        palette: [],        // palette upload duration (ms); only when dirty
        upload: [],         // framebuffer texSubImage2D / putImageData duration (ms)
        inputLat: [],       // keydown.timeStamp → renderer.draw() returns (ms)
        worklet: [],        // AudioWorklet process() duration (ms), posted via port
        opl: [],            // _web_music_render wall time per pump call (ms), main thread
        oplFrames: [],      // frames rendered by that call (sampleRate below)
        sampleRate: 0,      // AudioContext rate once armed; 0 until then
        _lastRafTime: 0,
        _frameCallStart: 0,
        _pendingInputTime: undefined,
    };
    window.addEventListener('keydown', e => {
        const perf = window.__wd_perf;
        if (perf && perf._pendingInputTime === undefined) perf._pendingInputTime = e.timeStamp;
    }, { capture: true });
}

// Bracket one rAF callback.  Read the object each time: a harness may install
// it after this module loads.
export const perfMarks = {
    begin(rafTime) {
        const perf = window.__wd_perf;
        if (!perf) return;
        if (perf.frames > 0) perf.raf.push(rafTime - perf._lastRafTime);
        perf._lastRafTime = rafTime;
        perf._frameCallStart = performance.now();
    },
    end() {
        const perf = window.__wd_perf;
        if (!perf) return;
        perf.rafDur.push(performance.now() - perf._frameCallStart);
        if (perf._pendingInputTime !== undefined) {
            perf.inputLat.push(performance.now() - perf._pendingInputTime);
            perf._pendingInputTime = undefined;
        }
        perf.frames++;
    },
};
