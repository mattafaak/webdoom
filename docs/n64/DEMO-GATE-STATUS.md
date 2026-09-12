# N64 demo sim-hash gate (task 20.4c) — status

**State: PASSING. 13/13 demos, 44,580 tics, every per-tic simulation hash
bit-identical to the wasm golden. Closed 2026-09-11 (task 25.4b).**

```
PASS: doom-demo1 (1710 tics)       PASS: tnt-demo1 (4531 tics)
PASS: doom-demo2 (2347 tics)       PASS: tnt-demo2 (3653 tics)
PASS: doom-demo3 (3863 tics)       PASS: tnt-demo3 (3433 tics)
PASS: doom-demo4 (818 tics)        PASS: plutonia-demo1 (7403 tics)
PASS: doom2-demo1 (1205 tics)      PASS: plutonia-demo2 (3483 tics)
PASS: doom2-demo2 (2001 tics)      PASS: plutonia-demo3 (5662 tics)
PASS: doom2-demo3 (4471 tics)
PASS — all N64 sim-hash goldens bit-identical (13 demos)
```

44,580 tics is the same total the README cross-validates against an
instrumented Chocolate Doom. The same simulation now reproduces on a 93.75 MHz
big-endian MIPS R4300i with a 12.4 MB IWAD read in place out of cartridge
space, and disagrees with the browser on nothing.

Run it with `bash tools/n64/run-n64-demos.sh` (~8 min wall clock), one demo with
`bash tools/n64/run-n64-demos.sh '^doom-demo1$'`, or as suite leg `n64-demos`.

---

## What the blocker actually was

The previous revision of this document said:

> On N64, `-timedemo` is passed in `myargv` but timingdemo mode does **not**
> engage.

**That was wrong, and it was wrong in the direction that costs the most: it
named a defect in the engine's argument handling when the argument was never
passed.** `tools/n64/Makefile` had

```make
CORE_CFLAGS := $(COMMON_FLAGS) -std=gnu89     # line 107
PLAT_CFLAGS := $(COMMON_FLAGS) -std=gnu11     # line 111
...
ifdef N64_TIMEDEMO                            # line 161, ~50 lines later
COMMON_FLAGS += -DN64_TIMEDEMO=\"$(N64_TIMEDEMO)\"
endif
```

`:=` expands immediately. By line 161 both recipe variables held their final
values, so the append modified a variable nothing read again and
`make N64_TIMEDEMO=demo1` emitted **zero** occurrences of `-DN64_TIMEDEMO`.
`n64_argv` therefore compiled to its `#else` form, `{"n64-doom", NULL}`, and the
ROM ran the ordinary attract loop — which is exactly the observed symptom
(trace length 4026 against demo1's 1710) that got attributed to the engine.

Nothing in the build said so. `make` reported success, the ROM booted, the
trace filled, and every visible signal was consistent with "timedemo does not
engage on this target". This is the box's second-most-repeated failure shape —
**a value that reports itself is not the value in force** — and the fix is not
just the reordering but the assertion that now sits under it:

```make
ifdef N64_TIMEDEMO
  ifeq (,$(findstring -DN64_TIMEDEMO,$(PLAT_CFLAGS)))
    $(error ... the ROM would silently build in attract-loop mode ...)
```

Red-proof: move the `ifdef` block back below the `:=` lines and
`make N64_TIMEDEMO=demo1` stops with that error instead of building the wrong
ROM.

## The second engine-side fix: argv symmetry

The golden is recorded by `tools/demo-test.mjs` as

```js
doom.callMain(['-timedemo', demo, '-nodraw'])
```

and the N64 argv omitted `-nodraw`. A differential is only a differential if
both sides run the same command line, so `-nodraw` is now in `n64_argv`. It also
happens to make the run finish in minutes rather than hours (`D_Display` returns
at `d_main.c:234` and the software rasteriser never runs), but that is a side
benefit, not the reason.

Verified by reading the linked image rather than trusting the flag:

```
argv[0] = 0x80059540 -> 'n64-doom'
argv[1] = 0x80053030 -> '-timedemo'
argv[2] = 0x80052be8 -> 'demo1'
argv[3] = 0x80055c98 -> '-nodraw'
argv[4] = 0x00000000 -> NULL
```

## How the trace leaves the machine

It is **printed**, not read out by a debugger. `n64_dump_trace()` emits the whole
trace between `N64_TRACE_BEGIN <n>` and `N64_TRACE_END <n>` markers over
libdragon's debug log channel; the harness waits for the END marker in ares's
captured stdout and parses the hex. Eight hashes per line, assembled in a buffer
so one `debugf` emits one whole line.

The gate used to extract via the ares GDB stub, and three of that path's four
moving parts failed in one sitting:

- **The port probe used `nc`, which is not installed here.** `nc -z ... 2>/dev/null`
  exited 127 on every attempt, so the loop reported "ares GDB stub did not open
  :9123" for 120 s while ares's own log said `Opening TCP-server on
  127.0.0.1:9123`. A missing *local* tool was reported as a fault in someone
  else's component. It uses bash's `/dev/tcp` now — a builtin, nothing to
  install, nothing that can go missing.
- **The GDB stub halts the CPU on attach.** The script's comment asserted the
  opposite ("ares's GDB stub keeps the CPU running after connection"). Measured:
  after `target remote` the target sits at `0xa400113c in ?? ()` and nothing
  resumes it, so `trace_len` stayed at 0 for the full 600 s budget on a ROM that
  completes in about a minute. Use the stub for a backtrace after a trap; it is
  not an instrument for sampling a running program.
- **`$!` was xvfb-run's pid, not ares's.** Killing it left ares alive and still
  holding a socket after the script exited. ares now starts under `setsid` and
  is reaped by process group, with an `EXIT` trap so an abort leaves nothing
  running.

A printed trace has none of that, and the evidence is plain text a human can
read.

## The third fix: a stale object with a plausible constant

The first 13-demo fan-out passed all four Doom 1 demos and then died on
`doom2-demo1` with `W_GetNumForName: E1M9 not found!` — the engine had decided
it was running Doom 1.

`N64_WAD_NAME` is baked into `files_n64.c`. `run-n64-demos.sh` force-removed
`n64_main.o` on every demo and `n64_hash.o` on every IWAD change — but
`n64_hash.c` does not use any of these macros, and `files_n64.c`, which uses this
one, was never removed. `make` cannot see a changed `-D` flag: the source had not
changed, so the object was "up to date" and got reused. Every doom2, tnt and
plutonia ROM registered its WAD under the **first** IWAD's name; `IdentifyVersion()`
matched `doomu.wad` and set `gamemode` to retail.

Choosing which objects to invalidate by hand is the bug, so the harness now
removes all nine shim objects each iteration. And because a wrong identity can
still produce a full, plausible trace — tnt registered as doom2 is commercial
either way, and the mismatch would have been reported as a *simulation
divergence* — `n64_register_wad()` now prints the name compiled into it and the
harness asserts that before looking at a single hash.

Red-proof, restoring the targeted rebuild:

```
FAIL: doom-demo1 - ROM registered the wrong IWAD identity:
      expected 'doomu.wad', log says registry name 'doom2.wad'
```

Note the direction: this is the *Doom 1* ROM claiming to be Doom II, from a
stale object left by the previous demo. The guard names both the expectation and
the value in force.

## Drift-proof

Perturbing one hash mid-trace in `tools/golden/doom-demo1.json`
(`g['trace'][500] ^= 1`) gives:

```
FAIL: doom-demo1 — FAIL:hash_mismatch:first_at_tic=500,
      n64=0x2660317c,golden=0x2660317d,mismatches=1/1710
```

Restored byte-identically afterwards (same md5, empty `git diff`).

The comparator also fails by name, never by silence, on: no markers in the log
(`no_markers`), a body that disagrees with the length the ROM declared
(`truncated_log`), an unparseable hex line, and a length mismatch against the
golden — so a truncated or interleaved log cannot be reported as a simulation
divergence.

## What is still open

- **20.4d** — real hardware (SummerCart64). Unchanged; this is emulation.
- **20.5** — the RDP renderer. `i_video_n64.c` is still a headless stub, which is
  why `-nodraw` costs nothing here. The *simulation* is proven; nothing is
  displayed.
- Controller input via libdragon `joypad.h`.
