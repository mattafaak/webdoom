// tools/freestanding/frames_wrap.c — a wipe's own share of a frame, caught at
// the link with no engine/core edit (the wipe probe, tools/floor/wipe-probe.mjs).
//
// fs-doom is linked with --wrap=wipe_StartScreen,wipe_EndScreen,wipe_ScreenWipe
// (Makefile FRAMES_WRAP): d_main.c calls all three across an object boundary,
// so every call is seen.  Around each, i_main.c's -frames mode reads the
// instruction counter (a frame's wipe instructions: the screens captured, the
// column-major transform, the melt steps, the release), and before the start
// screen and after the end screen it walks the zone, so the record says what
// the two captures took from it.  Outside -frames mode the hooks return at
// once; they run only in a level's load tic, which the floor never grades.
// Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
#include "doomtype.h"

void fs_frames_wipe_enter (void); // i_main.c
void fs_frames_wipe_leave (void);
void fs_frames_wipe_zone (int after);

int __real_wipe_StartScreen (int x, int y, int width, int height);
int __wrap_wipe_StartScreen (int x, int y, int width, int height)
{
    int r;
    fs_frames_wipe_zone (0);
    fs_frames_wipe_enter ();
    r = __real_wipe_StartScreen (x, y, width, height);
    fs_frames_wipe_leave ();
    return r;
}

int __real_wipe_EndScreen (int x, int y, int width, int height);
int __wrap_wipe_EndScreen (int x, int y, int width, int height)
{
    int r;
    fs_frames_wipe_enter ();
    r = __real_wipe_EndScreen (x, y, width, height);
    fs_frames_wipe_leave ();
    fs_frames_wipe_zone (1);
    return r;
}

int __real_wipe_ScreenWipe (int wipeno, int x, int y, int width, int height, int ticks);
int __wrap_wipe_ScreenWipe (int wipeno, int x, int y, int width, int height, int ticks)
{
    int r;
    fs_frames_wipe_enter ();
    r = __real_wipe_ScreenWipe (wipeno, x, y, width, height, ticks);
    fs_frames_wipe_leave ();
    return r;
}
