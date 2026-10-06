#!/usr/bin/env node
// client/js/audio.js's arm() awaits the AudioContext, the worklet module, the
// synth wasm and the worklet's `ready` reply.  A player who quits while it is
// suspended in one of those (endSession runs audio.stop()) must not leave it
// to finish afterwards: it would start the music pump on a dead engine, an
// interval that throws every 100 ms and keeps the engine from being freed.
//
// The browser globals are stand-ins; createAudio is the shipped module's.
import { join } from 'node:path';
import { root, sleep } from './lib/util.mjs';
import { check, summary } from './lib/report.mjs';

const listeners = {};
globalThis.window = { isSecureContext: true, addEventListener: (t, f) => { listeners[t] = f; }, removeEventListener: t => { delete listeners[t]; } };
globalThis.document = { addEventListener() {}, removeEventListener() {}, getElementById: () => null, visibilityState: 'visible' };
globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
let answerReady = null;
class Port { postMessage(m) { if (m?.type === 'init') answerReady = () => this.onmessage({ data: { ready: false, error: 'slow host' } }); } }
globalThis.AudioWorkletNode = class { constructor() { this.port = new Port(); } connect() {} };
globalThis.AudioContext = class {
    constructor() { this.state = 'running'; this.sampleRate = 48000; this.currentTime = 0; this.destination = {};
                    this.audioWorklet = { addModule: async () => {} }; }
    close() { return Promise.resolve(); }
    resume() { return Promise.resolve(); }
};
const started = [];
const realSetInterval = setInterval;
globalThis.setInterval = (f, ms) => { started.push(ms); return realSetInterval(() => {}, 1e9); };

const { createAudio } = await import(join(root, 'client/js/audio.js'));
const heap = new ArrayBuffer(1 << 16);
const doom = { HEAPU8: new Uint8Array(heap), HEAP32: new Int32Array(heap), HEAPF32: new Float32Array(heap),
               _malloc: () => 1024, _free() {}, _web_music_init() {}, _web_set_opl_mode() {}, _web_music_render() {},
               _web_music_state(p) { const v = new Int32Array(heap, p, 7); v[0] = 2048; v[1] = 16; } };

const audio = createAudio(doom);
const arming = listeners.keydown();       // the first gesture starts arm()
await sleep(20);                          // ... which now waits for the worklet's `ready`
check('the race was reached: arm() is waiting on the worklet', typeof answerReady === 'function');
audio.stop();                             // the player quits
answerReady?.();                          // and the worklet answers late
let rejected = null;
await arming.catch(e => { rejected = e; });
await sleep(50);
check('arm() finishes quietly after a stop', !rejected, rejected?.message);
check('no music pump is started after the game has stopped', started.length === 0, `${started.length} interval(s) started`);
summary('audio stopped mid-arm starts nothing afterwards');
process.exit(process.exitCode ?? 0);
