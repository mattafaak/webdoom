// Run client/js/music-worklet.js in node.
//
// The browser can only take the worklet synth so far under test: headless
// Chrome — and headed Chrome under xvfb — arms the AudioContext and
// instantiates the module, but never calls process(), because there is no
// audio device to pull the graph.  Measured both ways in round 11:
// `{ready:true, playing:1, rendered:0}`.  So the browser leg proves the WIRING
// engages, and the rendering is proved here, against the same file that ships,
// driven through the same message protocol.
//
// This is deliberately a host, not a re-implementation: a second copy of the
// worklet's logic would pass while the shipped one was broken, which is the
// whole failure this project keeps naming.
//
// usage:
//   const w = await loadWorklet();
//   await w.send({ type: 'init', wasm, rate: 44100, genmidi, song, ... });
//   const { l, r } = w.process(128);
//
// Copyright (C) 2026, GPL-2.0-or-later.
import { join } from 'node:path';
import { root } from './util.mjs';

export async function loadWorklet (modulePath = join(root, 'client/js/music-worklet.js')) {
    const inbox = [];                       // messages the processor posted back
    const port = {
        onmessage: null,
        postMessage(data) { inbox.push(data); },   // worklet -> host
    };
    let Processor = null;

    globalThis.AudioWorkletProcessor = class { constructor () { this.port = port; } };
    globalThis.registerProcessor = (_name, cls) => { Processor = cls; };
    globalThis.sampleRate ??= 44100;
    globalThis.currentTime ??= 0;

    await import(modulePath + `?t=${Date.now()}`);   // registerProcessor fires here
    if (!Processor) throw new Error('music-worklet.js registered no processor');
    const node = new Processor();

    const settle = () => new Promise(r => setImmediate(r));
    return {
        node,
        inbox,
        // host -> worklet, then let any promise inside it run
        async send (data, waitFor = null) {
            node.port.onmessage({ data });
            for (let i = 0; i < 200; i++) {
                await settle();
                if (!waitFor) break;
                const hit = inbox.find(waitFor);
                if (hit) return hit;
            }
            return waitFor ? null : undefined;
        },
        // one render quantum; returns the two channel buffers
        process (frames) {
            const l = new Float32Array(frames), r = new Float32Array(frames);
            node.process([], [[l, r]]);
            return { l, r };
        },
    };
}
