// tools/freestanding/fs_mus.c — engine/web/mus_opl.c, the OPL music
// sequencer, compiled UNCHANGED for a native or cross build, plus the two
// things such a build must do: free the voices before the first call, and on
// a big-endian target read GENMIDI's 16-bit fields the right way round.
//
// WHY A WRAPPER AT ALL
// --------------------
// mus_opl.c's voice[] is zero-initialised, so before any note every voice reads
// muschan == 0 ("owned by MUS channel 0") with gv == NULL.  mus_init's
// re-program loop and mus_setvolume walk the voices with muschan >= 0 and
// dereference gv.  In wasm that reads linear memory at address 0..15, which is
// mapped, so doom.wasm and synth.wasm survive it.  Natively it is a NULL read:
// mus_init(44100) as the first call dies with SIGSEGV (measured, gcc -m32 -O1).
// The voices only become free (-1) when something keys them off: mus_play's or
// mus_stop's all_notes_off, and only for v < opl_nvoices(), so in OPL3 mode
// voices 9..17 cannot be freed through the API before web_set_opl_mode(1)'s own
// mus_init reaches them.
//
// fs_mus_preinit() frees all 18 before the first call, which is the state the
// web build reaches anyway once a song has started and the chip has been reset
// after it (synth_boot's last mus_init, client/js/audio.js's arm): every voice
// that path touched has been keyed off by mus_play, and OPL3_Reset has wiped
// whatever was written for the NULL voices.  tools/synth-native-test.mjs proves
// the result byte-identical to build/synth.wasm on all 13 demo songs.  What this
// cannot reproduce is a render BEFORE any song (tools/golden/opl2-ref.f32):
// that output is the chip programmed from whatever bytes sit at wasm address 0.
//
// The include keeps mus_opl.c the one source: nothing here is a copy.  It finds
// "opl3.h" next to itself; <emscripten.h> comes from tools/freestanding/stub.
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#include "../../engine/web/mus_opl.c"

void fs_mus_preinit (void)
{
    int v;
    for (v = 0; v < OPL3_CHANNELS; v++)
        voice[v].muschan = -1;
}

// BIG-ENDIAN TARGETS
// ------------------
// load_bank() memcpy's GENMIDI's little-endian bytes straight into
// genmidi_instr_t, whose flags and the two voices' note offsets are 16-bit:
// right on a little-endian target only.  On big-endian PowerPC (qemu) the
// register stream differs from write 41 at frame 0 (an F-number: 0x98 against
// 0xca) and doom-demo4's music hashes b4087872 against 639b5526 (measured).
// Called once the bank is loaded (after the first mus_init), this swaps those
// fields on a big-endian target and does nothing on a little-endian one.  The
// defect is mus_opl.c's; this is the platform keeping its music right.
static boolean bank_swapped;

void fs_mus_bank_endian (void)
{
    static const unsigned short one = 1;
    int i, k;
    if (*(const unsigned char*) &one == 1 || !bank_loaded || bank_swapped)
        return;
    for (i = 0; i < (int) (sizeof bank / sizeof bank[0]); i++)
    {
        bank[i].flags = (unsigned short) ((bank[i].flags >> 8) | (bank[i].flags << 8));
        for (k = 0; k < 2; k++)
        {
            unsigned short o = (unsigned short) bank[i].voice[k].offset;
            bank[i].voice[k].offset = (short) ((o >> 8) | (o << 8));
        }
    }
    bank_swapped = true;
}
