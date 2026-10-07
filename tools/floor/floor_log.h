// tools/floor/floor_log.h — the floor gate's log format, one emitter for
// every port (host, qemu, N64, boards).
//
// A port measures tics into its own arrays and calls these AFTER a demo ends,
// never inside a timed tic.  Output is plain text through a byte callback, so
// it works over stdout, a UART, semihosting or a USB debug channel alike:
//
// clang-format off
//   FLOOR 1 target=.. source=hardware|emulator|host unit=.. unit_hz=N
//           build=.. view=10 detail=0 zone=B precache=0 mode=A|B
//   DEMO doom-demo1 tics=N
//   T <i> <gametic> <elapsed> <flags> [<simhash> <renderhash>]
//   AUDIO samples=N underruns=N music_events=N sfx_starts=N synthhash=H mixhash=H frames=N
//   END doom-demo1 final=<simhash>:<renderhash>
// clang-format on
//
// <flags> is "-" or a comma list of: L (a level load, intermission or finale
// started in this tic: not graded) and M:<bytes> (bytes copied out of the WAD
// in this tic).  Hashes are 8 lower-case hex digits. tools/floor/floor-gate.mjs
// reads it.  C89, no libc: the only output is the callback.
// Copyright (C) 2026, GPL-2.0-or-later.
#ifndef FLOOR_LOG_H
#define FLOOR_LOG_H

#define FLOOR_TIC_LOAD 1u /* P_SetupLevel / WI_Start / F_StartFinale ran */

typedef struct
{
    const char* target;         /* e.g. "x86-fs-doom", "n64-ares", "rp2350" */
    const char* source;         /* "hardware", "emulator" or "host" */
    const char* unit;           /* e.g. "instructions", "count", "cycles" */
    unsigned long long unit_hz; /* units per second; 0 when not a time */
    const char* build;          /* git sha or build id */
    int view;                   /* screenblocks */
    int detail;                 /* 0 = high, 1 = low */
    unsigned zone;              /* zone bytes */
    int precache;               /* 1 if level graphics are preloaded */
    char mode;                  /* 'A' (correctness) or 'B' (timing) */
} floor_header_t;

typedef struct
{
    unsigned long long samples;
    unsigned underruns;
    unsigned music_events;
    unsigned sfx_starts;
    unsigned synthhash;
    unsigned mixhash;
    unsigned frames;
} floor_audio_t;

void floor_log_init (void (*putc_fn) (int c));
void floor_header (const floor_header_t* h);
void floor_demo_begin (const char* name, unsigned tics);
// have_hash: 1 to print simhash and renderhash (mode A), 0 to omit (mode B)
void floor_tic (unsigned i, unsigned gametic, unsigned long long elapsed,
                unsigned flags, unsigned mbytes, int have_hash,
                unsigned simhash, unsigned renderhash);
void floor_audio (const floor_audio_t* a);
void floor_demo_end (const char* name, unsigned final_sim,
                     unsigned final_render);

#endif
