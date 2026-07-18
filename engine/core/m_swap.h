// Emacs style mode select   -*- C++ -*- 
//-----------------------------------------------------------------------------
//
// $Id:$
//
// Copyright (C) 1993-1996 by id Software, Inc.
//
// This source is available for distribution and/or modification
// only under the terms of the DOOM Source Code License as
// published by id Software. All rights reserved.
//
// The source is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// FITNESS FOR A PARTICULAR PURPOSE. See the DOOM Source Code License
// for more details.
//
// DESCRIPTION:
//	Endianess handling, swapping 16bit and 32bit.
//
//-----------------------------------------------------------------------------


#ifndef __M_SWAP__
#define __M_SWAP__


#ifdef __GNUG__
#pragma interface
#endif


// Endianess handling.
// WAD files are stored little endian.
#ifdef __BIG_ENDIAN__
short	SwapSHORT(short);
long	SwapLONG(long);
#define SHORT(x)	((short)SwapSHORT((unsigned short) (x)))
#define LONG(x)         ((long)SwapLONG((unsigned long) (x)))
#else
#define SHORT(x)	(x)
#define LONG(x)         (x)
#endif

// Byte-safe LE reads for strict-alignment targets (ARM Cortex-M, MIPS).
// On LE hosts (x86, wasm) the compiler optimises b[0]|(b[1]<<8) back to a
// single 16-bit load — wasm output is byte-identical to a plain dereference.
// On BE hosts these assemble the value from bytes without issuing an unaligned
// multi-byte load, avoiding SIGBUS / alignment abort.
#include <stdint.h>
static inline int16_t read_le16(const void *p)
{
    const uint8_t *b = (const uint8_t *)p;
    return (int16_t)((uint16_t)b[0] | ((uint16_t)b[1] << 8));
}
static inline int32_t read_le32(const void *p)
{
    const uint8_t *b = (const uint8_t *)p;
    return (int32_t)((uint32_t)b[0] | ((uint32_t)b[1] << 8)
                   | ((uint32_t)b[2] << 16) | ((uint32_t)b[3] << 24));
}




#endif
//-----------------------------------------------------------------------------
//
// $Log:$
//
//-----------------------------------------------------------------------------
