// mus2mid.js — clean-room MUS-to-MIDI-0 converter.
//
// Specification source: doomwiki.org/wiki/MUS (public-domain format description).
// This file does NOT derive from Chocolate Doom's mus2mid.c (GPL-2.0); it is an
// independent implementation written from the published format spec.
//
// Export:
//   musToMidi(mus: Uint8Array) → Uint8Array   (MIDI format-0 file)
//   Throws if the input is not a valid MUS lump.
//
// MUS format summary:
//   Header (16 bytes + instrument list):
//     0-3:    "MUS\x1A" magic
//     4-5:    score length  (uint16 LE)
//     6-7:    score start   (uint16 LE)
//     8-9:    primary channel count
//     10-11:  secondary channel count (unused by us)
//     12-13:  instrument count
//     14-15:  padding / dummy
//     16+:    instrument list (instrCount × uint16 LE)
//
//   Score events (at offset scoreStart):
//     Each event descriptor byte:
//       bits 7-4:  channel (0-15; 15 = percussion → MIDI ch 9)
//       bits 3-0:  event type (0-7)
//     Data bytes per type:
//       0 (release):    1 byte  [last<<7 | note]
//       1 (press):      1-2 bytes; byte1=[vol_flag<<7|note], byte2(if vol_flag)=[last<<7|vol]
//       2 (pitch):      1 byte  [last<<7 | bend_u8]  (0-255; 128=center)
//       3 (system):     1 byte  [last<<7 | system_id]
//       4 (ctrl):       2 bytes [ctrl_id], [last<<7 | value]
//       5 (measure):    0 bytes (no last bit — never followed by delay)
//       6 (score end):  0 bytes (terminates decoding)
//       7 (unused):     0 bytes
//     "last" bit (bit 7 of the FINAL data byte for that event) = 1 ⇒ a
//     variable-length delay (in 1/140-s tics) follows immediately after.
//
//   Variable-length delay encoding (same as MIDI VLQ):
//     While (byte & 0x80): accum = (accum << 7) | (byte & 0x7f)
//     Final:               accum = (accum << 7) | byte
//
// MIDI output (format 0, one track, 70 BPM → 1 tic = 2 MIDI ticks @ 280 PPQN):
//   All channels interleaved on the single track.
//   Channel mapping: MUS ch 15 → MIDI ch 9 (drums); others: 0-8 → 0-8, 9-14 → 10-15.

// ── MUS controller → MIDI CC mapping ─────────────────────────────────────────
const MUS_CTRL_TO_MIDI = [
    0,    // 0 = instrument → handled as Program Change, not CC
    0,    // 1 = bank select (ignored in basic impl)
    1,    // 2 = modulation wheel
    7,    // 3 = volume
    10,   // 4 = pan
    11,   // 5 = expression
    91,   // 6 = reverb depth
    93,   // 7 = chorus depth
    64,   // 8 = sustain pedal
    67,   // 9 = soft pedal
];

// ── MUS system event → MIDI mapping ──────────────────────────────────────────
// System event IDs 10-14 per the MUS spec.
const SYS_ALL_SOUNDS_OFF   = 10;
const SYS_RESET_CTRLS      = 11;
// 12 = local control (skip)
const SYS_ALL_NOTES_OFF    = 13;
// 14 = omni off / on (skip)

// ── Channel mapping ───────────────────────────────────────────────────────────
function midiChannel(musCh) {
    if (musCh === 15) return 9;   // percussion
    if (musCh < 9)   return musCh;
    return musCh + 1;             // 9-14 → 10-15
}

// ── Variable-length quantity helpers ─────────────────────────────────────────
function writeVLQ(out, value) {
    if (value < 0) value = 0;
    const buf = [];
    buf.push(value & 0x7f);
    value >>>= 7;
    while (value > 0) { buf.push(0x80 | (value & 0x7f)); value >>>= 7; }
    for (let i = buf.length - 1; i >= 0; i--) out.push(buf[i]);
}

function readVLQ(data, pos) {
    let value = 0;
    let b;
    do {
        if (pos >= data.length) throw new Error('MUS: unexpected end in delay VLQ');
        b = data[pos++];
        value = (value << 7) | (b & 0x7f);
    } while (b & 0x80);
    return { value, pos };
}

// ── MIDI helpers ─────────────────────────────────────────────────────────────
function uint32BE(v) {
    return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
}
function uint16BE(v) {
    return [(v >>> 8) & 0xff, v & 0xff];
}

// ── Main converter ────────────────────────────────────────────────────────────
// dmxgusMap (optional): Uint8Array[175] from the DMXGUS WAD lump.
//   When provided, MUS instrument-change values are remapped through it:
//   the MIDI program number becomes dmxgusMap[musProg] & 0x7f instead of
//   musProg directly.  This produces GUS-flavored instrument selection
//   without requiring any GUS .pat files (audio comes from the SF2 stack).
//   The DMXGUS lump is WAD-owned data; see docs/decision-17.3-gus-flavor.md.
export function musToMidi(mus, dmxgusMap = null) {
    if (!(mus instanceof Uint8Array)) mus = new Uint8Array(mus);

    // Validate magic
    if (mus.length < 16 ||
        mus[0] !== 0x4D || mus[1] !== 0x55 ||
        mus[2] !== 0x53 || mus[3] !== 0x1A) {
        throw new Error('MUS: invalid magic bytes');
    }

    const scoreLen   = mus[4] | (mus[5] << 8);
    const scoreStart = mus[6] | (mus[7] << 8);
    const instrCount = mus[12] | (mus[13] << 8);

    if (scoreStart + scoreLen > mus.length) {
        throw new Error('MUS: score data extends beyond buffer');
    }

    // MIDI PPQ and tempo: 280 PPQN @ 70 BPM gives 1 tic = 2 MIDI ticks.
    // 70 BPM = 857143 µs/beat.  140 tics/s = 2 tics/beat at 70 BPM.
    const PPQN  = 280;
    const TEMPO = 857143;  // µs per quarter note

    // Per-channel last-used volume (default 127 so notes before first CC sound)
    const lastVol = new Uint8Array(16).fill(127);

    // Accumulate MIDI track events: { delta, bytes[] }
    const events = [];
    let currentTick = 0;

    let pos = scoreStart;
    const end = scoreStart + scoreLen;

    outer: while (pos < end) {
        const evByte  = mus[pos++];
        const musCh   = (evByte >> 4) & 0x0f;
        const evType  = evByte & 0x0f;
        const midCh   = midiChannel(musCh);

        let last = false;

        switch (evType) {
            case 0: {  // release key
                if (pos >= end) throw new Error('MUS: truncated release-key event');
                const b = mus[pos++];
                last = !!(b & 0x80);
                const note = b & 0x7f;
                events.push({ tick: currentTick, bytes: [0x80 | midCh, note, 0] });
                break;
            }
            case 1: {  // press key
                if (pos >= end) throw new Error('MUS: truncated press-key event');
                const b1 = mus[pos++];
                const hasVol = !!(b1 & 0x80);
                const note   = b1 & 0x7f;
                let vol;
                if (hasVol) {
                    if (pos >= end) throw new Error('MUS: truncated press-key volume');
                    const b2 = mus[pos++];
                    last = !!(b2 & 0x80);
                    vol  = b2 & 0x7f;
                    lastVol[midCh] = vol;
                } else {
                    // No new volume byte; no delay bit either (last = false)
                    vol = lastVol[midCh];
                }
                events.push({ tick: currentTick, bytes: [0x90 | midCh, note, vol] });
                break;
            }
            case 2: {  // pitch wheel
                if (pos >= end) throw new Error('MUS: truncated pitch event');
                const b = mus[pos++];
                last = !!(b & 0x80);
                // MUS: 0-255 → MIDI: 0-16383 (14-bit).  MUS center=128 → MIDI center=8192.
                const bend = Math.min(((b & 0x7f) / 128) * 16384, 16383) | 0;
                const lsb  = bend & 0x7f;
                const msb  = (bend >> 7) & 0x7f;
                events.push({ tick: currentTick, bytes: [0xe0 | midCh, lsb, msb] });
                break;
            }
            case 3: {  // system event
                if (pos >= end) throw new Error('MUS: truncated system event');
                const b = mus[pos++];
                last = !!(b & 0x80);
                const sysId = b & 0x7f;
                if (sysId === SYS_ALL_SOUNDS_OFF) {
                    events.push({ tick: currentTick, bytes: [0xb0 | midCh, 120, 0] });
                } else if (sysId === SYS_RESET_CTRLS) {
                    events.push({ tick: currentTick, bytes: [0xb0 | midCh, 121, 0] });
                } else if (sysId === SYS_ALL_NOTES_OFF) {
                    events.push({ tick: currentTick, bytes: [0xb0 | midCh, 123, 0] });
                }
                break;
            }
            case 4: {  // change controller
                if (pos + 1 >= end) throw new Error('MUS: truncated controller event');
                const ctrl  = mus[pos++];
                const b2    = mus[pos++];
                last = !!(b2 & 0x80);
                const value = b2 & 0x7f;
                if (ctrl === 0) {
                    // Instrument → MIDI program change.
                    // If a DMXGUS map is present, remap the MUS instrument
                    // number to the GUS patch number (≈ GM program number)
                    // that the WAD author intended for GUS playback.
                    let prog = value;
                    if (dmxgusMap !== null && prog < dmxgusMap.length)
                        prog = dmxgusMap[prog] & 0x7f;
                    events.push({ tick: currentTick, bytes: [0xc0 | midCh, prog] });
                } else if (ctrl < MUS_CTRL_TO_MIDI.length && MUS_CTRL_TO_MIDI[ctrl] !== 0) {
                    events.push({ tick: currentTick,
                        bytes: [0xb0 | midCh, MUS_CTRL_TO_MIDI[ctrl], value] });
                }
                break;
            }
            case 5:   // end-of-measure (informational, no data, no delay)
                break;
            case 6:   // score end
                break outer;
            default:  // type 7 unused — skip with no data
                break;
        }

        // If "last" bit was set, read a variable-length delay
        if (last) {
            const { value: tics, pos: newPos } = readVLQ(mus, pos);
            pos = newPos;
            // 1 MUS tic = 2 MIDI ticks (280 PPQN @ 70 BPM)
            currentTick += tics * 2;
        }
    }

    // End-of-track meta event
    events.push({ tick: currentTick, bytes: [0xff, 0x2f, 0x00] });

    // ── Build MIDI track bytes ────────────────────────────────────────────────
    const trackBytes = [];
    let prevTick = 0;
    for (const ev of events) {
        const delta = ev.tick - prevTick;
        prevTick = ev.tick;
        writeVLQ(trackBytes, delta);
        for (const b of ev.bytes) trackBytes.push(b);
    }

    // ── Assemble MIDI file ────────────────────────────────────────────────────
    const header = [
        0x4d, 0x54, 0x68, 0x64,  // "MThd"
        ...uint32BE(6),           // chunk length
        ...uint16BE(0),           // format 0
        ...uint16BE(1),           // 1 track
        ...uint16BE(PPQN),        // ticks per quarter note
    ];

    const tempoEvent = [
        0x00,                     // delta = 0
        0xff, 0x51, 0x03,         // set tempo meta
        (TEMPO >>> 16) & 0xff, (TEMPO >>> 8) & 0xff, TEMPO & 0xff,
    ];

    const trackData = [...tempoEvent, ...trackBytes];
    const track = [
        0x4d, 0x54, 0x72, 0x6b,  // "MTrk"
        ...uint32BE(trackData.length),
        ...trackData,
    ];

    return new Uint8Array([...header, ...track]);
}
