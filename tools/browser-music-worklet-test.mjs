#!/usr/bin/env node
// Browser test: on a secure origin the AudioWorklet owns the music synth
// (ledger NC6).
//
// Asserts, after a trusted arm gesture in a running level:
//   (i)   doomAudio.sinkKind() === 'worklet'
//   (ii)  doomAudio.synthLive() === true   — the worklet answered `ready`, so
//         build/synth.wasm was fetched, transferred and instantiated INSIDE
//         the worklet; anything less leaves the main-thread pump in charge
//   (iii) musicStats() reports ready with the sequencer armed (playing=1)
//   (iv)  window.__wd_perf.opl is EMPTY — the main thread rendered no music at
//         all, which is the entire point of the change
//   (v)   the pump timer is gone: a second sample of (iv) is still empty
//
// WHAT THIS LEG CANNOT DO, said out loud rather than skipped: assert that
// audio was RENDERED.  Headless Chrome, and headed Chrome under xvfb, both arm
// the context and instantiate the module and then never call process(),
// because no audio device pulls the graph — measured both ways, both reporting
// {ready:true, playing:1, rendered:0}.  The samples are proved instead by
// `opl-mode` gate 7, which drives the SHIPPED client/js/music-worklet.js in
// node, 128 frames at a time, and requires byte-identity with the engine.
//
// RED-PROOF: point the fetch at a missing file (or break synth_boot) and
// synthLive() is false — audio.js falls back to the pump — so (ii) fails and
// (iv) fills up.
//
// usage: node tools/browser-music-worklet-test.mjs [url]
import { launchChrome } from './lib/cdp.mjs';
import { sleep } from './lib/util.mjs';
import { startServer } from './lib/server.mjs';
import { check, summary, fatal } from './lib/report.mjs';

const url = process.argv[2] ?? (await startServer()).url;
const chrome = await launchChrome({ gpu: 'none' });
// ?perfmarks=1 installs window.__wd_perf, which is what (iv) reads.
const tab = await chrome.tab(url + (url.includes('?') ? '&' : '?') + 'perfmarks=1');
const { ev: evaluate } = tab;

// the detail is part of the label: the value read is the evidence
const checkWith = (name, ok, detail) => check(`${name} — ${detail}`, ok);

if (!await tab.waitForSW(15)) fatal('service worker did not take control within 15s');

// Boot into single player.
if (!await tab.bootSP(30).catch(e => fatal(e.message))) fatal('never reached a running level — nothing was measured');

// A trusted key event: arm() only runs on a real user gesture.
await sleep(1500);
await tab.key('w', 87);

// Two waits with deadlines, not one fixed sleep.  armed() is the AudioContext
// existing, which arm() creates before its first await (client/js/audio.js),
// so it answers at once; the sink and synthLive() are decided later in arm(),
// after the worklet module loads, synth.wasm is transferred and the worklet
// answers `ready` or the client's SYNTH_READY_MS (2 s) runs out.  arm() has
// finished when the worklet owns the synth (synthLive), or when it fell back:
// a BufferSink, or the main-thread pump rendering (__wd_perf.opl filling).
// A settle that never comes falls through to the checks, which say which part
// is missing.
const t0 = Date.now();
if (!await tab.waitFor(() => evaluate(`window.doomAudio?.armed?.() ?? false`), { timeout: 20000, every: 100 }))
    fatal('the AudioContext never armed within 20 s — nothing below would mean anything');
const settled = await tab.waitFor(() => evaluate(`(() => { const a = window.doomAudio;
        return !!a && (a.synthLive() || a.sinkKind() === 'buffer' || (window.__wd_perf?.opl?.length ?? 0) > 0); })()`),
    { timeout: 20000, every: 100 });
console.log(settled ? `arm() settled ${Date.now() - t0} ms after the key` : 'arm() had not settled after 20 s');

console.log('secure origin: the worklet owns the synth');
checkWith('sink is the worklet', (await evaluate(`window.doomAudio.sinkKind()`)) === 'worklet',
      `sinkKind=${await evaluate(`window.doomAudio.sinkKind()`)}`);

const live = await evaluate(`window.doomAudio.synthLive()`);
checkWith('the worklet instantiated build/synth.wasm', live === true, `synthLive=${live}`);

const stats = await evaluate(`window.doomAudio.musicStats()`, { awaitPromise: true });
checkWith('the worklet reports a ready synth with the sequencer armed',
      !!stats && stats.ready === true && stats.playing === 1,
      stats ? JSON.stringify(stats) : 'no stats (the worklet did not answer)');

const oplN = await evaluate(`window.__wd_perf?.opl?.length ?? -1`);
checkWith('the main thread rendered no music', oplN === 0,
      oplN < 0 ? 'no __wd_perf — the perfmarks flag did not reach main.js' : `__wd_perf.opl has ${oplN} sample(s)`);

// And stays that way: a surviving pump would fill it within a second.
await sleep(1500);
const oplN2 = await evaluate(`window.__wd_perf?.opl?.length ?? -1`);
checkWith('and still none a second later (no pump is running)', oplN2 === 0, `__wd_perf.opl has ${oplN2} sample(s)`);

summary('browser-music-worklet: worklet synth live, main thread renders no music');
process.exit();
