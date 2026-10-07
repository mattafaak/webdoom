// tools/freestanding/stub/emscripten.h — the one emscripten symbol the OPL
// synth's sources use, for a native or cross build of them.
//
// engine/web/mus_opl.c and engine/web/synth_main.c include <emscripten.h> only
// to mark their entry points EMSCRIPTEN_KEEPALIVE (keep the export through
// wasm-ld's dead-code elimination).  A native link keeps every extern
// function anyway, so the mark is empty here.  Only the synth's objects are
// compiled with this directory on the include path.
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#ifndef FS_STUB_EMSCRIPTEN_H
#define FS_STUB_EMSCRIPTEN_H
#define EMSCRIPTEN_KEEPALIVE
#endif
