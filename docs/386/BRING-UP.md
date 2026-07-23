# 386DX-40 Bring-Up — webdoom 20.6a

**Status (2026-07-23)**: harness skeleton committed. 86Box boots headlessly
(SDL_VIDEODRIVER=offscreen confirmed). BIOS ROM fetchable from GitHub.
Full cycles/tic measurement BLOCKED — FreeDOS disk image and DOS DOOM.EXE
not yet available (see §5).

---

## 1. Summary

| Item | Result |
|------|--------|
| 86Box binary present | PASS — `~/toolchains/bin/86Box` (built -DQT=OFF + SDL2) |
| Headless SDL operation | PASS — `SDL_VIDEODRIVER=offscreen` confirmed (no X/Wayland needed) |
| DataExpert 386C ROM fetchable | PASS — 64 KB from `86Box/roms` GitHub, `fetch-roms.sh` works |
| ROM recognized by 86Box | PASS — not in `--missing` list after fetch |
| 86Box BIOS POST (no disk) | RUNS — 86Box runs silently for 120 s; BIOS POST on offscreen SDL |
| Serial FIFO mechanism | DESIGN ONLY — char_pipe_com confirmed in source; untested end-to-end |
| FreeDOS boot disk | BLOCKED — `doom386.img` not created (see §3) |
| DOS DOOM.EXE | BLOCKED — shareware EXE not fetched (see §4) |
| Cycles/tic measurement | BLOCKED — depends on FreeDOS + DOOM (see §5) |
| Drift test Phase 1 (corrupt→FAIL) | PASS — `run-386box.sh --drift-test` exits 1 on corrupt/missing image |
| Drift test Phase 2 (restore→PASS) | BLOCKED — requires `doom386.img` |
| Engine/core 0-diff | PASS — `tools/386/` and `docs/386/` only |

---

## 2. Hardware profile: DataExpert 386C (386DX-40)

Machine chosen: **[OPTi 391] DataExpert 386C** (`internal_name = dataexpert386wb`)

| Parameter | Value |
|-----------|-------|
| CPU package | i386DX |
| Max bus speed | 40,000,000 Hz (40 MHz) |
| BIOS | MR BIOS V1.26 |
| ROM file | `machines/dataexpert386wb/st0386-wb-ver2-0-618f078c738cb397184464.bin` |
| ROM size | 65,536 B (64 KB) |
| RAM configured | 4 MB |
| Video | CGA (headless; no ROM needed) |
| Audio | none |
| Network | none |

86Box machine table entry confirms `max_bus = 40,000,000` for this machine,
making it the correct profile for a 386DX-40 benchmark.

**Budget**: 40,000,000 Hz / 35 Hz = **1,142,857 cycles/tic**  
(see `docs/feasibility-atlas.md` §3.5)

---

## 2.1 ROM fetch (confirmed working, 2026-07-23)

```bash
bash tools/386/fetch-roms.sh        # default: ~/toolchains/emu/86box-roms
bash tools/386/fetch-roms.sh /other/path

# Verification: DataExpert 386C must NOT appear in --missing output
86Box -R ~/toolchains/emu/86box-roms --missing 2>/dev/null | grep "DataExpert 386C"
# Expected: (no output)
```

Fetch result: 65,536 B downloaded, `--missing` output confirmed empty for this machine.

---

## 2.2 Headless operation (confirmed working, 2026-07-23)

```bash
export SDL_VIDEODRIVER=offscreen SDL_AUDIODRIVER=dummy
timeout 8 ~/toolchains/bin/86Box \
    -P /tmp/86box-test \
    -R ~/toolchains/emu/86box-roms \
    -N 86box.cfg 2>&1 | head -5
# Output: "SDL: version 2.32.70"  (runs for 8 s; BIOS POST on offscreen surface)
```

No `DISPLAY` or `WAYLAND_DISPLAY` required. 86Box was built without Qt
(`-DQT=OFF`; second cmake pass in `86box-conf2.log` confirmed "Configuring done").
The OSD backend uses SDL2 directly.

---

## 3. FreeDOS disk image — BLOCKED

The harness requires a bootable raw HDD image (`tools/386/doom386.img`, not in
repo) containing FreeDOS + DOOM.EXE + `timedemo.bat`.

### 3.1 Why it's blocked

FreeDOS is freely licensed but creating a bootable DOS disk image from scratch
requires:
- A DOS-format partition table and FAT filesystem
- FreeDOS kernel (`KERNEL.SYS`) and command interpreter (`COMMAND.COM`)
- DOOM.EXE (see §4) placed in `C:\DOOM\`
- `AUTOEXEC.BAT` that calls `timedemo.bat` and redirects COM1 output

This is automatable with Linux tools (`mtools`, `dosfstools`, `parted`) but
requires root access or loop devices for the partition table step.
An alternative is to use a pre-built FreeDOS floppy image (hard disk size ≥ 50 MB
for DOOM).

### 3.2 How to create doom386.img (manual, once)

```bash
# Prerequisites (system packages):
#   mtools, dosfstools, syslinux-utils (for sys.com equivalent)
#   OR: dosbox-x / bochs to install FreeDOS interactively

# Method A: Use a pre-built FreeDOS 1.3 HDD image template
# Download from https://www.freedos.org/download/ (FD13-FullUSB.zip)
# Resize with: qemu-img resize freedos.img +200M
# Mount, install DOOM (§4), add AUTOEXEC.BAT below, unmount.

# Method B: Create from scratch with mtools (no root needed)
dd if=/dev/zero of=tools/386/doom386.img bs=1M count=250   # 250 MB HDD
mformat -i tools/386/doom386.img -T 512000 ::               # FAT16
mmd    -i tools/386/doom386.img ::DOOM
mcopy  -i tools/386/doom386.img doom.exe ::DOOM/DOOM.EXE
mcopy  -i tools/386/doom386.img doom1.wad ::DOOM/DOOM1.WAD
mcopy  -i tools/386/doom386.img timedemo.bat ::DOOM/TIMEDEMO.BAT
# Method B requires a FreeDOS kernel (KERNEL.SYS) installed via sys.com

# AUTOEXEC.BAT content (write to :: or to the root):
# @ECHO OFF
# CD \DOOM
# DOOM.EXE -timedemo demo1 > C:\TIMING.TXT
# TYPE C:\TIMING.TXT > COM1
# ECHO RUN_DONE > COM1
# HALT or POWER OFF
```

### 3.3 timedemo.bat protocol

The harness reads from the COM1 serial FIFO (`<vmdir>/com1.out`).
The DOS side must write:

```
timed <X> gametics in <Y> realtimes\r\n
RUN_DONE\r\n
```

Where `X` = gametics, `Y` = elapsed realtimes at 35 Hz (DOOM's own timer).

`run-386box.sh` reads the FIFO until it sees `RUN_DONE`, then computes:

```
cycles/tic = (40,000,000 × Y) / (35 × X)
```

---

## 4. DOS DOOM.EXE — BLOCKED

### 4.1 Status

The DOS executable `DOOM.EXE` (shareware v1.9) is not in this repo.
webdoom is a Wasm/native Linux port; DOS DOOM is a separate binary.

### 4.2 Licensing

The DOOM shareware was made freeware by id Software in 2022 (released under
a custom "no commercial use" license for the shareware tier, then later
re-released). The shareware `doom1.zip` (which contains `DOOM.EXE` and
`DOOM1.WAD`) is available on archive.org and id's historic FTP.

`DOOM1.WAD` is already in `wads/lib/` (fetched by `tools/fetch-wads.sh`).
`DOOM.EXE` is NOT in this repo and should NOT be committed (it is a binary
artifact, not source, and falls outside the git scope of webdoom).

### 4.3 How to fetch (once, not committed)

```bash
# Option A: From archive.org (official shareware v1.9)
curl -L "https://archive.org/download/doom-shareware-v1-9/doom1.zip" \
     -o /tmp/doom1.zip
unzip -j /tmp/doom1.zip DOOM.EXE -d /tmp/doom-shareware/
# Then copy to the disk image per §3.2

# Option B: From the Doomworld idgames archive
# https://www.doomworld.com/idgames/idstuff/doom/win95/doom95  (not the DOS EXE)
# DOS EXE: https://www.doomworld.com/idgames/idstuff/doom/doom19s.zip
```

### 4.4 Alternative: build a minimal DOS cycle counter

If DOS DOOM is unavailable, a 200-byte DOS `.COM` program could:
1. Time a fixed instruction loop using INT 1Ah (BIOS time-of-day, 18.2 Hz)
2. Output cycles/iteration to COM1
3. Exit with `RUN_DONE\r\n`

This does NOT measure DOOM's actual code path but gives a synthetic 386DX-40
throughput number. The feasibility atlas row would need to note "synthetic".

---

## 5. Serial FIFO mechanism — design confirmed, untested end-to-end

### 5.1 86Box char pipe on Linux

86Box v7.0 source (`src/char/char_pipe.c`) creates a UNIX FIFO pair:
- `<path>.in`  — host writes → emulated COM1 receive
- `<path>.out` — emulated COM1 transmit → host reads

Config in `386dx40.cfg`:
```ini
[Ports (COM & LPT)]
serial1_enabled = 1
serial1_device = pipe

[Named Pipe (COM) #1]
path = /tmp/86box-run-XXXXXX/com1
mode = 1        # SERVER (86Box creates the FIFOs)
reconnect = 0
```

### 5.2 Why the mechanism is sound

- Source-confirmed: `mkfifo()` called in `char_pipe.c:249`
- DOOM's `I_Error()` and timedemo output go to VGA screen; DOS batch redirects
  with `>` operator: `DOOM.EXE -timedemo demo1 > C:\T.TXT` captures stdout
- `TYPE C:\T.TXT > COM1` sends to serial; 86Box maps COM1 to the FIFO
- Host reads `.out` FIFO in `run-386box.sh`

### 5.3 What remains untested

1. Whether 86Box's COM1 baud rate (default 115200) is compatible with the
   DOS `MODE COM1:115200,N,8,1` needed before `TYPE > COM1`
2. Whether DOOM's `-timedemo demo1` output line is exactly the expected format
   on the DOS version (historically: "timed X gametics in Y realtimes.")
3. End-to-end FIFO read from run-386box.sh

---

## 6. Drift test (Phase 1 confirmed, 2026-07-23)

```bash
bash tools/386/run-386box.sh --drift-test
```

Phase 1 (corrupt → FAIL): creates a 512-byte zero file as a fake disk image.
`run-386box.sh` rejects it ("HDD image too small") → exits 1 → FAIL confirmed.

Phase 2 (restore → PASS): requires `doom386.img`. Currently SKIP because
`doom386.img` is not present. Once the disk image is created (§3), Phase 2
runs automatically.

---

## 7. Engine/core 0-diff guarantee

This bring-up adds ONLY:

```
tools/386/   (new — fetch-roms.sh, run-386box.sh, 386dx40.cfg)
docs/386/    (new — BRING-UP.md)
```

Verification:
```bash
git diff master --stat -- engine/
# (no output — engine/core is untouched)
```

---

## 8. Path to a complete 386DX-40 cycles/tic measurement

| Step | Status | Command |
|------|--------|---------|
| 86Box binary | DONE | `~/toolchains/bin/86Box --help` |
| BIOS ROM | DONE | `bash tools/386/fetch-roms.sh` |
| Headless SDL | DONE | `SDL_VIDEODRIVER=offscreen` |
| FreeDOS disk image | BLOCKED | See §3 (mtools or qemu-img) |
| DOS DOOM.EXE | BLOCKED | See §4 (shareware download) |
| End-to-end harness run | BLOCKED | `bash tools/386/run-386box.sh -d doom386.img` |
| Drift test Phase 2 | BLOCKED | `bash tools/386/run-386box.sh --drift-test -d doom386.img` |
| 20.6b scoreboard | BLOCKED | Depends on cycles/tic measurement |

Once steps 3–4 are unblocked, the harness runs fully automated:
```bash
bash tools/386/fetch-roms.sh           # once
# (create doom386.img per §3 — one-time manual step)
bash tools/386/run-386box.sh --drift-test   # prove exit-code correctness
bash tools/386/run-386box.sh                # measure cycles/tic
```

Expected output (once DOOM runs):
```
=== 386DX-40 timedemo result ===
gametics    : 1260
realtimes   : 700     (at 35 Hz DOOM timer)
cycles/tic  : 800000
budget      : 1142857  (40 MHz / 35 Hz)
% of budget : 70.0%
================================
```
(Numbers are illustrative; actual measurement depends on the demo sequence.)
