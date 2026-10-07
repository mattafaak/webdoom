// tools/freestanding/opl3-ref-wrap.c — the reference OPL3 core, linkable
// beside engine/web/opl3.c, for synth-exact (tools/synth-exact-test.mjs).
//
// The reference is tools/floor/opl3-ref/opl3.c and opl3.h: Nuked OPL3 1.8 as
// engine/web/opl3.c was at 4eba931, before the floor's exact savings, byte for
// byte (the test pins both files' sha256).  It is included here, not compiled
// on its own, so its six public functions can be renamed ref_OPL3_* and its
// opl3_chip (the reference's layout, from its own opl3.h, which the include
// finds next to it) stays private to this file.  The harness sees only the
// functions below.
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#define OPL3_Generate ref_OPL3_Generate
#define OPL3_GenerateResampled ref_OPL3_GenerateResampled
#define OPL3_Reset ref_OPL3_Reset
#define OPL3_WriteReg ref_OPL3_WriteReg
#define OPL3_WriteRegBuffered ref_OPL3_WriteRegBuffered
#define OPL3_GenerateStream ref_OPL3_GenerateStream
#include "../floor/opl3-ref/opl3.c"

static opl3_chip ref_chip;

void ref_reset (unsigned rate)
{
    ref_OPL3_Reset (&ref_chip, (Bit32u) rate);
}

void ref_write (unsigned reg, unsigned v)
{
    ref_OPL3_WriteReg (&ref_chip, (Bit16u) reg, (Bit8u) v);
}

void ref_write_buffered (unsigned reg, unsigned v)
{
    ref_OPL3_WriteRegBuffered (&ref_chip, (Bit16u) reg, (Bit8u) v);
}

void ref_generate (short* buf)
{
    ref_OPL3_Generate (&ref_chip, (Bit16s*) buf);
}

void ref_generate_resampled (short* buf)
{
    ref_OPL3_GenerateResampled (&ref_chip, (Bit16s*) buf);
}

// the noise LFSR, the one piece of state the savings moved (synth-exact
// compares it every frame, so a divergence that is silent today is still seen)
unsigned ref_noise (void)
{
    return ref_chip.noise;
}
