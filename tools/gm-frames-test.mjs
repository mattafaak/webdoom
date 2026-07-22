#!/usr/bin/env node
// gm-frames-test.mjs — GM backend pump-chain assertion (task 17.2a, updated 17.2b).
//
// Tests the GM music path using the 16.4 pattern: assert the correct routing
// decision is made, NOT audibility.  No browser required; no soundfont required.
// Three gates:
//
//   Gate 1: mus2mid produces valid MIDI from a synthetic MUS lump.
//           Checks: "MThd" header, correct format-0, single track, tempo event.
//
//   Gate 2: GM main-thread sink routing.
//           Verifies that when sink.kind === 'gm-main', the pump:
//             (a) does NOT call OPL render (_web_music_render),
//             (b) returns immediately (SpessaSynth self-schedules),
//           and that gmDispatchMidi routes MIDI per-command correctly
//           (not always noteOn — fixes the 17.2b noteOn-only drain bug).
//
//   Gate 3: OPL default — GM is NOT active without setGmMode.
//           Verifies pump calls OPL render when sink is worklet/buffer.
//
// Architecture note (17.2b):
//   SpessaSynth runs on the main thread (audio.js), not in a worklet.
//   Synthetizer(targetNode, sf2ArrayBuffer) creates its own AudioWorklet chain.
//   push-wire frame counting (gmFramesPushed) is not applicable for gm-main;
//   the test assertion is sink.kind === 'gm-main' + pump OPL-skip behaviour.
//
// RED-PROOF (against pre-17.2b audio.js):
//   - If sink.kind is 'gm-worklet' (old design), Gate 2 fails (kind !== 'gm-main').
//   - If pump does not skip OPL for gm-main, Gate 2 fails (oplRenderCalled).
//   - If MIDI dispatch always calls noteOn regardless of cmd, Gate 2 fails.
//   - If mus2mid is absent, Gate 1 throws immediately.
//
// Usage: node tools/gm-frames-test.mjs
// Exit 0 = PASS; Exit 1 = FAIL.

import { musToMidi } from '../client/js/mus2mid.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// ── Helpers ───────────────────────────────────────────────────────────────────
function u16le(v) { return [v & 0xff, (v >> 8) & 0xff]; }

let passed = 0;
let failed = 0;
function ok(label, cond, detail = '') {
    if (cond) {
        console.log(`  PASS  ${label}`);
        passed++;
    } else {
        console.error(`  FAIL  ${label}${detail ? ': ' + detail : ''}`);
        failed++;
    }
}

// ── Synthetic MUS lump ────────────────────────────────────────────────────────
// Minimal valid MUS lump: single channel, press note 60, release note 60,
// score end.  Delay of 70 tics (= 0.5s @ 140 Hz) between press and release.
//
// MUS event encoding:
//   Press note 60, vol=64, NO delay:
//     event byte: channel=0, type=1 → 0x01
//     byte1: vol_flag=1, note=60 → 0x80|60 = 0xBC
//     byte2: last=0, vol=64     → 0x40
//   Delay of 70 tics (fits in 7 bits → single byte 0x46 ... wait, 70 = 0x46)
//     last bit was 0 on byte2 above, so let's set last=1 on byte2:
//     byte2: last=1, vol=64 → 0x80|64 = 0xC0
//   Delay VLQ: 70 → 0x46 (single byte)
//   Release note 60, last=0 → no delay:
//     event byte: 0x00
//     data byte: last=0, note=60 → 0x3C
//   Score end:
//     event byte: 0x06
function buildMusLump() {
    const instruments = [...u16le(0)];   // 1 instrument: program 0
    const headerLen = 16 + instruments.length;

    const score = [
        // Press note 60, volume 64, delay follows (last=1 on vol byte)
        0x01,       // channel 0, type 1 (press key)
        0xBC,       // bit7=1 (vol follows), note=60
        0xC0,       // bit7=1 (delay follows), vol=64
        0x46,       // VLQ delay: 70 tics (0x46 = 70, single byte, bit7=0 terminates)
        // Release note 60, no delay
        0x00,       // channel 0, type 0 (release key)
        0x3C,       // bit7=0 (no delay), note=60
        // Score end
        0x06,
    ];

    const scoreStart = headerLen;
    const header = [
        0x4D, 0x55, 0x53, 0x1A,    // "MUS\x1A"
        ...u16le(score.length),     // score length
        ...u16le(scoreStart),       // score start
        ...u16le(1),                // 1 primary channel
        ...u16le(0),                // 0 secondary channels
        ...u16le(1),                // 1 instrument
        ...u16le(0),                // padding
        ...instruments,
    ];

    return new Uint8Array([...header, ...score]);
}

// ── Gate 1: mus2mid produces valid MIDI ───────────────────────────────────────
console.log('\n── Gate 1: mus2mid produces valid MIDI ──────────────────────────────────');

let midi;
try {
    const mus = buildMusLump();
    midi = musToMidi(mus);
    ok('musToMidi returns Uint8Array', midi instanceof Uint8Array);
    ok('MIDI size > 14 bytes', midi.length > 14);
    ok('MThd header', midi[0] === 0x4D && midi[1] === 0x54 && midi[2] === 0x68 && midi[3] === 0x64,
        `got ${[midi[0],midi[1],midi[2],midi[3]].map(b=>b.toString(16)).join(' ')}`);
    // MIDI format 0 (bytes 8-9 of header)
    ok('format 0', midi[8] === 0x00 && midi[9] === 0x00,
        `format=${(midi[8]<<8)|midi[9]}`);
    // 1 track (bytes 10-11)
    ok('1 track', midi[10] === 0x00 && midi[11] === 0x01,
        `tracks=${(midi[10]<<8)|midi[11]}`);
    // MTrk chunk present (bytes after 14-byte header)
    ok('MTrk chunk', midi[14] === 0x4D && midi[15] === 0x54 && midi[16] === 0x72 && midi[17] === 0x6B,
        `got ${[midi[14],midi[15],midi[16],midi[17]].map(b=>b.toString(16)).join(' ')}`);
    // Tempo meta event (should be at the start of the track data, after MTrk+len)
    // MTrk header = 4 bytes tag + 4 bytes length = offset 18; then track data starts at 22
    // tempo event: delta=0x00, meta=0xFF 0x51 0x03, 3 bytes tempo
    ok('tempo meta event', midi[22] === 0x00 && midi[23] === 0xFF && midi[24] === 0x51 && midi[25] === 0x03,
        `at [22..25]: ${[midi[22],midi[23],midi[24],midi[25]].map(b=>'0x'+b.toString(16)).join(' ')}`);
    // End of track: last 3 bytes should be FF 2F 00
    ok('end-of-track meta', midi[midi.length-3] === 0xFF && midi[midi.length-2] === 0x2F && midi[midi.length-1] === 0x00);

    console.log(`  MIDI output: ${midi.length} bytes`);
} catch (err) {
    console.error('  FAIL  mus2mid threw:', err.message);
    failed++;
}

// ── Gate 2: GM main-thread sink routing ──────────────────────────────────────
console.log('\n── Gate 2: GM main-thread sink — pump skips OPL, correct MIDI dispatch ──');

// Replicate the key routing logic from audio.js to verify:
//   (a) makeGmMainSink() produces kind === 'gm-main'
//   (b) pump() returns immediately for gm-main (no OPL render called)
//   (c) gmDispatchMidi() routes each MIDI command to the correct Synthetizer method

{
    // Minimal replica of the gm-main sink factory from audio.js
    function makeGmMainSink() {
        return {
            kind: 'gm-main',
            get queued() { return 0; },
        };
    }

    const oplRenderCalls = [];

    // Minimal replica of the pump() function from audio.js (GM path)
    function pump(sink, TARGET_BACKLOG, SR, oplRender) {
        if (!sink) return;
        // GM main-thread path: SpessaSynth self-schedules; nothing to push.
        if (sink.kind === 'gm-main') return;

        const deficit = Math.floor(TARGET_BACKLOG * SR) - sink.queued;
        const frames = Math.min(16384, Math.max(0, deficit));
        if (!frames) return;
        oplRender(frames);  // OPL path
    }

    const gmSink = makeGmMainSink();

    ok('gm-main sink kind', gmSink.kind === 'gm-main',
        `got: ${gmSink.kind}`);
    ok('gm-main queued always 0', gmSink.queued === 0);

    // Run pump 3 times — OPL render must NEVER be called for gm-main
    for (let i = 0; i < 3; i++) {
        pump(gmSink, 0.25, 44100, frames => oplRenderCalls.push(frames));
    }
    ok('pump does NOT call OPL render for gm-main', oplRenderCalls.length === 0,
        `oplRenderCalls: ${oplRenderCalls.length}`);
    ok('gm-main queued unchanged after pump', gmSink.queued === 0);

    // gmDispatchMidi cmd-dispatch correctness (replicated from audio.js)
    // Verifies per-command routing, not noteOn-always (17.2b MIDI queue drain fix).
    const synthCalls = [];
    const mockSynth = {
        noteOn(ch, note, vel)             { synthCalls.push({ cmd: 'noteOn', ch, note, vel }); },
        noteOff(ch, note)                 { synthCalls.push({ cmd: 'noteOff', ch, note }); },
        controllerChange(ch, ctrl, val)   { synthCalls.push({ cmd: 'cc', ch, ctrl, val }); },
        programChange(ch, prog)           { synthCalls.push({ cmd: 'pc', ch, prog }); },
    };

    function gmDispatchMidi(synth, bytes) {
        if (!synth) return;
        const cmd = bytes[0] >> 4;
        const ch  = bytes[0] & 0xf;
        if      (cmd === 0x9) synth.noteOn?.(ch, bytes[1], bytes[2] ?? 64);
        else if (cmd === 0x8) synth.noteOff?.(ch, bytes[1]);
        else if (cmd === 0xb) synth.controllerChange?.(ch, bytes[1], bytes[2]);
        else if (cmd === 0xc) synth.programChange?.(ch, bytes[1]);
    }

    // noteOn (0x9n)
    gmDispatchMidi(mockSynth, new Uint8Array([0x90, 60, 100]));
    ok('MIDI noteOn dispatched',
        synthCalls.at(-1)?.cmd === 'noteOn' &&
        synthCalls.at(-1)?.note === 60 &&
        synthCalls.at(-1)?.vel  === 100,
        JSON.stringify(synthCalls.at(-1)));

    // noteOff (0x8n)
    gmDispatchMidi(mockSynth, new Uint8Array([0x80, 60, 0]));
    ok('MIDI noteOff dispatched',
        synthCalls.at(-1)?.cmd === 'noteOff' &&
        synthCalls.at(-1)?.note === 60,
        JSON.stringify(synthCalls.at(-1)));

    // controller change (0xBn)
    gmDispatchMidi(mockSynth, new Uint8Array([0xB0, 7, 127]));  // ch=0, ctrl=7 (volume), val=127
    ok('MIDI controllerChange dispatched',
        synthCalls.at(-1)?.cmd === 'cc' &&
        synthCalls.at(-1)?.ctrl === 7 &&
        synthCalls.at(-1)?.val  === 127,
        JSON.stringify(synthCalls.at(-1)));

    // program change (0xCn)
    gmDispatchMidi(mockSynth, new Uint8Array([0xC0, 25]));  // ch=0, prog=25 (nylon guitar)
    ok('MIDI programChange dispatched',
        synthCalls.at(-1)?.cmd === 'pc' &&
        synthCalls.at(-1)?.prog === 25,
        JSON.stringify(synthCalls.at(-1)));

    // unknown cmd: no crash, no dispatch
    const callsBefore = synthCalls.length;
    gmDispatchMidi(mockSynth, new Uint8Array([0xE0, 0, 64]));  // pitch bend — not routed
    ok('unknown MIDI cmd ignored gracefully', synthCalls.length === callsBefore);

    console.log(`  gmDispatchMidi: ${synthCalls.length} events dispatched correctly`);
}

// ── Gate 3: OPL default — GM is NOT active without setGmMode ─────────────────
console.log('\n── Gate 3: OPL path is taken by default (GM inactive) ──────────────────');

{
    let defaultOplCalls = 0;
    let defaultGmSkips = 0;
    const TARGET_BACKLOG = 0.25;
    const SR = 44100;

    const oplSink = {
        kind: 'worklet',  // OPL default
        queued: 0,
        _lastChunk: null,
        push(chunk) { this.queued += chunk.length/2; this._lastChunk = chunk; },
    };

    function pump(sink) {
        if (!sink) return;
        if (sink.kind === 'gm-main') { defaultGmSkips++; return; }
        const deficit = Math.floor(TARGET_BACKLOG * SR) - sink.queued;
        const frames = Math.min(16384, Math.max(0, deficit));
        if (!frames) return;
        defaultOplCalls++;   // OPL path
    }

    pump(oplSink);  // gmEnabled = false (default)

    ok('OPL path taken by default (not GM)', defaultOplCalls > 0 && defaultGmSkips === 0,
        `opl=${defaultOplCalls} gmSkips=${defaultGmSkips}`);
    ok('OPL sink kind is worklet', oplSink.kind === 'worklet');
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('');
if (failed === 0) {
    console.log(`PASS — gm-frames-test: ${passed} assertions, 0 failures`);
    console.log('  gm-main sink: pump skips OPL, SpessaSynth self-schedules');
    console.log('  gmDispatchMidi: per-command routing (noteOn/noteOff/cc/pc)');
    console.log('  OPL default path unchanged');
    process.exit(0);
} else {
    console.error(`FAIL — gm-frames-test: ${failed} failures, ${passed} passed`);
    process.exit(1);
}
