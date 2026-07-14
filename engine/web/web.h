// webdoom platform layer — shared declarations.
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#ifndef __WEB_H__
#define __WEB_H__

#include "doomtype.h"

// d_main.c (webdoom patches)
void D_DoomFrame (void);

// Multiplayer bridge (see d_net.c in this directory). All state flows
// through these before main() runs; single player needs none of them.
void web_net_setup (int consoleplayer, int numplayers);

#endif
