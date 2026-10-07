#!/usr/bin/env python3
# tools/pico/mapsum.py — one tools/pico variant's memory, read from its link:
# the map file's memory regions and input sections, the ELF's output sections
# and symbols.  link-check.sh calls it once per variant; nothing here runs the
# program.
#
# A variant that fit is read from its own ELF and map.  One that did not fit
# has no ELF: its verdict is the linker's own overflow message (from the build
# log), and its sizes come from the "-big" twin, the same objects linked with
# a 64 MiB RAM region.  The two must agree, or this exits 2 rather than report
# either number: for a variant that fit, the twin's RAM, scratch and PSRAM
# extents equal the real link's; for one that did not, the twin's RAM extent
# minus the real region's length is the linker's overflow, byte for byte.
#
# Also exit 2 (the measurement is not trusted) when: the link failed with no
# overflow message; the zone is missing from the map, or is not in the region
# the variant puts it in; screens[0] is not where the variant puts it;
# fs_audio.c's harness buffers are not with the zone; p_maputl.c's own
# .bss.trace (an engine global, not the harness's) left RAM; newlib's heap
# (.heap) is not where the variant puts it, or, in PSRAM, `end`..__HeapLimit
# (what tools/pico/pico_psram_heap.c's _sbrk hands out) is not exactly the
# reservation, or the reservation is outside __psram_end__.
# Copyright (C) 2026, GPL-2.0-or-later.
import argparse
import os
import re
import subprocess
import sys

SRAM = ("RAM", "SCRATCH_X", "SCRATCH_Y")


def fail(msg):
    print("FAIL mapsum: " + msg)
    sys.exit(2)


def read(path):
    with open(path, encoding="utf-8", errors="replace") as f:
        return f.read()


def memory_config(text):
    """The map's Memory Configuration: name -> (origin, length)."""
    regions = {}
    m = re.search(r"Memory Configuration\n\nName[^\n]*\n(.*?)\n\n", text, re.S)
    if not m:
        fail("no Memory Configuration in the map")
    for line in m.group(1).splitlines():
        f = line.split()
        if len(f) >= 3 and f[0] != "*default*":
            regions[f[0]] = (int(f[1], 16), int(f[2], 16))
    return regions


def region_of(addr, regions):
    for name, (org, length) in regions.items():
        if org <= addr < org + length:
            return name
    return None


def map_inputs(text):
    """Input sections from the memory map: (output, name, addr, size, file)."""
    body = text.split("Linker script and memory map", 1)
    if len(body) != 2:
        fail("no memory map in the map file")
    out, pending, rows = None, None, []
    for line in body[1].splitlines():
        if line and not line[0].isspace():
            f = line.split()
            out = f[0]
            continue
        if line.startswith(" ") and len(line) > 1 and not line[1].isspace():
            f = line.split()
            if f[0].startswith("*(") or f[0] == "*fill*":
                pending = None
                continue
            if len(f) == 1:
                pending = f[0]  # a long name: the numbers wrap to the next line
                continue
            name, rest = f[0], f[1:]
        elif pending and line.strip().startswith("0x"):
            name, rest = pending, line.split()
        else:
            pending = None
            continue
        pending = None
        if len(rest) >= 3 and rest[0].startswith("0x") and rest[1].startswith("0x"):
            rows.append((out, name, int(rest[0], 16), int(rest[1], 16), rest[2]))
    return rows


def elf_sections(elf):
    """ALLOC output sections: (name, size, vma, lma, has_contents)."""
    txt = subprocess.run(["arm-none-eabi-objdump", "-h", "-w", elf],
                         check=True, capture_output=True, text=True).stdout
    rows = []
    for line in txt.splitlines():
        f = line.split()
        if len(f) >= 8 and f[0].isdigit():
            flags = " ".join(f[7:])
            if "ALLOC" in flags:
                rows.append((f[1], int(f[2], 16), int(f[3], 16), int(f[4], 16),
                             "CONTENTS" in flags and "LOAD" in flags))
    return rows


def elf_symbol(elf, name):
    txt = subprocess.run(["arm-none-eabi-nm", elf], check=True,
                         capture_output=True, text=True).stdout
    for line in txt.splitlines():
        f = line.split()
        if len(f) == 3 and f[2] == name:
            return int(f[0], 16)
    fail("no symbol %s in %s" % (name, elf))


def n(v):
    return "{:,}".format(v)


def label(name, path):
    base = os.path.basename(path)
    if name in (".heap", ".stack"):
        return "(%s reservation)" % name[1:]
    for p in (".bss.", ".data.", ".sbss.", ".sdata.", ".time_critical."):
        if name.startswith(p):
            return "%s  (%s)" % (name[len(p):], base)
    return "%s  (%s)" % (name, base)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True, help="the build tree")
    ap.add_argument("--name", required=True, help="the variant's target")
    ap.add_argument("--label", required=True, help="e.g. 'RP2350 sram-sound -O1'")
    ap.add_argument("--rc", type=int, required=True, help="the real link's exit")
    ap.add_argument("--log", required=True, help="the real link's build log")
    ap.add_argument("--zone-region", required=True, choices=("RAM", "PSRAM"))
    ap.add_argument("--screens-region", required=True, choices=("RAM", "PSRAM"))
    ap.add_argument("--heap-region", required=True, choices=("RAM", "PSRAM"))
    ap.add_argument("--iwad", action="append", default=[],
                    help="NAME=BYTES, an IWAD to compare with the WAD's room")
    a = ap.parse_args()

    real_map = os.path.join(a.dir, a.name + ".map")
    real_elf = os.path.join(a.dir, a.name + ".elf")
    big_map = os.path.join(a.dir, a.name + "-big.map")
    big_elf = os.path.join(a.dir, a.name + "-big.elf")
    real_regions = memory_config(read(real_map))
    log = read(a.log)
    # ld says it two ways: "region `RAM' overflowed by N bytes" when a section
    # runs over the region's end, and "address A of ... section `S' is not
    # within region `RAM'" when a section STARTS inside it and the location
    # counter after it lands past the end (then A - end is the overflow)
    over = {}
    for r, b in re.findall(r"region `(\w+)' overflowed by (\d+) bytes", log):
        over[r] = max(over.get(r, 0), int(b))
    for addr, r in re.findall(
            r"address (0x[0-9a-f]+) of \S+ section `[^']+' is not within region `(\w+)'",
            log):
        if r not in real_regions:
            fail("an overflow of an unknown region " + r)
        org, length = real_regions[r]
        over[r] = max(over.get(r, 0), int(addr, 16) - (org + length))
    overflow = sorted(over.items())

    if a.rc == 0:
        if overflow:
            fail("the link succeeded and still reported an overflow")
        if not os.path.exists(real_elf):
            fail("the link succeeded and left no ELF: " + real_elf)
        elf, mp, source = real_elf, real_map, "its own link"
    else:
        if not overflow:
            fail("the link failed without a region overflow (see %s)" % a.log)
        if os.path.exists(real_elf):
            fail("the link failed and left an ELF behind: " + real_elf)
        if not os.path.exists(big_elf):
            fail("no measuring twin: " + big_elf)
        elf, mp, source = big_elf, big_map, "its -big twin (64 MiB RAM region)"
    text = read(mp)
    regions = memory_config(text)  # the twin's own, for classifying its addresses
    sections = elf_sections(elf)
    inputs = map_inputs(text)

    # each region's extent, as the linker measures it
    def extents(secs, regs):
        u = {}
        for name, size, vma, lma, contents in secs:
            r = region_of(vma, regs)
            if r and size:
                u[r] = max(u.get(r, 0), vma + size - regs[r][0])
        return u

    used = extents(sections, regions)
    if a.rc == 0:
        if not os.path.exists(big_elf):
            fail("no measuring twin: " + big_elf)
        twin = extents(elf_sections(big_elf), memory_config(read(big_map)))
        for r in sorted(set(used) | set(twin)):
            if used.get(r, 0) != twin.get(r, 0):
                fail("the real link's %s extent, %s B, is not its twin's, %s B" %
                     (r, n(used.get(r, 0)), n(twin.get(r, 0))))
    for r, over in overflow:
        if r != "RAM":
            continue
        if used.get("RAM", 0) - real_regions["RAM"][1] != over:
            fail("the twin's RAM extent %s B less the region's %s B is not "
                 "the linker's overflow, %s B" %
                 (n(used.get("RAM", 0)), n(real_regions["RAM"][1]), n(over)))

    flash_org = regions["FLASH"][0]
    flash_used = elf_symbol(elf, "__flash_binary_end") - flash_org
    wad_start = elf_symbol(elf, "__wad_start")
    wad_room = elf_symbol(elf, "__wad_end") - wad_start
    sram_cap = sum(real_regions[r][1] for r in SRAM if r in real_regions)
    sram_used = sum(used.get(r, 0) for r in SRAM)
    psram_cap = real_regions.get("PSRAM", (0, 0))[1]
    psram_used = used.get("PSRAM", 0)

    print("== %s  (sizes from %s)" % (a.label, source))
    print("   output sections (B; region by address; load image if any):")
    for name, size, vma, lma, contents in sections:
        if not size:
            continue
        r = region_of(vma, regions) or "?"
        load = ""
        if contents and region_of(lma, regions) != r:
            load = "   image in " + (region_of(lma, regions) or "?")
        print("     %-20s %12s  %-9s%s" % (name, n(size), r, load))

    def find(name, filepart):
        hits = [i for i in inputs if i[1] == name and filepart in i[4] and i[3]]
        return hits

    zone = find(".bss.fs_arena", "/freestanding/i_system.c")
    if len(zone) != 1:
        fail("the zone (.bss.fs_arena) is in the map %d times, not once" % len(zone))
    zone_size, zone_reg = zone[0][3], region_of(zone[0][2], regions)
    if zone_reg != a.zone_region:
        fail("the zone is in %s, not %s" % (zone_reg, a.zone_region))
    scr = find(".bss.fs_screenbufs", "/freestanding/i_system.c")
    if len(scr) != 1 or region_of(scr[0][2], regions) != a.screens_region:
        fail("screens[0] (.bss.fs_screenbufs) is not in %s once" % a.screens_region)
    harness = [i for i in inputs if "/freestanding/fs_audio.c" in i[4] and i[3]
               and i[1] in (".bss.trace", ".bss.st_mus", ".bss.st_sfx",
                            ".bss.st_sum", ".bss.st_live")]
    harness_size = sum(i[3] for i in harness)
    for i in harness:
        if region_of(i[2], regions) != a.zone_region:
            fail("%s (%s) is not in %s with the zone" % (i[1], i[4], a.zone_region))
    engine_trace = find(".bss.trace", "/engine/core/p_maputl.c")
    if len(engine_trace) != 1 or region_of(engine_trace[0][2], regions) != "RAM":
        fail("p_maputl.c's .bss.trace is not in RAM once")
    heap = [s for s in sections if s[0] == ".heap"]
    if len(heap) != 1 or not heap[0][1]:
        fail("no .heap section, or an empty one")
    heap_size, heap_vma = heap[0][1], heap[0][2]
    heap_reg = region_of(heap_vma, regions)
    if heap_reg != a.heap_region:
        fail("the heap is in %s, not %s" % (heap_reg, a.heap_region))
    if heap_reg == "PSRAM":
        lo, hi = elf_symbol(elf, "end"), elf_symbol(elf, "__HeapLimit")
        if lo != heap_vma or hi != heap_vma + heap_size:
            fail("_sbrk's span end..__HeapLimit (0x%08x..0x%08x) is not the "
                 ".heap reservation (0x%08x..0x%08x)" %
                 (lo, hi, heap_vma, heap_vma + heap_size))
        if elf_symbol(elf, "__psram_end__") < hi:
            fail("__psram_end__ stops before the heap's end: hardware_psram "
                 "would not count it")

    print("   zone (fs_arena):      %12s  %s" % (n(zone_size), zone_reg))
    for i in scr:
        print("   screens[0]:           %12s  %s" % (n(i[3]), region_of(i[2], regions)))
    if harness:
        print("   fs_audio.c harness:   %12s  %s  (trace, st_*: WD_AUDIO_TRACE/"
              "WD_AUDIO_STAGES only)" % (n(harness_size),
                                         region_of(harness[0][2], regions)))
    print("   heap (.heap, newlib): %12s  %s%s" % (
        n(heap_size), heap_reg,
        "  (_sbrk: end..__HeapLimit, pico_psram_heap.c)" if heap_reg == "PSRAM" else ""))
    by = {}
    for name, size, vma, lma, contents in sections:
        r = region_of(vma, regions)
        if r in SRAM and size:
            key = {".data": ".data", ".bss": ".bss", ".heap": "heap",
                   ".stack_dummy": "stack"}.get(name, "other")
            by[key] = by.get(key, 0) + size
    print("   SRAM by kind (section sizes): " + ", ".join(
        "%s %s" % (k, n(by[k])) for k in (".data", ".bss", "heap", "stack", "other")
        if k in by))

    print("   biggest SRAM users (input sections, from %s):" % os.path.basename(mp))
    sram_in = sorted((i for i in inputs if region_of(i[2], regions) in SRAM and i[3]),
                     key=lambda i: -i[3])
    for i in sram_in[:10]:
        print("     %12s  %s" % (n(i[3]), label(i[1], i[4])))

    print("   SRAM  %s of %s B (RAM %s + scratch %s)" %
          (n(sram_used), n(sram_cap), n(used.get("RAM", 0)),
           n(used.get("SCRATCH_X", 0) + used.get("SCRATCH_Y", 0))))
    if harness and region_of(harness[0][2], regions) in SRAM:
        rest = sram_used - harness_size
        print("   derived (arithmetic, not a link): without fs_audio.c's harness "
              "buffers, SRAM %s of %s B, %s" %
              (n(rest), n(sram_cap), "%s B to spare" % n(sram_cap - rest)
               if rest <= sram_cap else "short by %s B (%.2fx)" %
               (n(rest - sram_cap), rest / sram_cap)))
    if psram_cap:
        print("   PSRAM %s of %s B" % (n(psram_used), n(psram_cap)))
    print("   flash %s B of code and load images (up to __flash_binary_end); "
          "WAD at 0x%08x, %s B of room" % (n(flash_used), wad_start, n(wad_room)))
    fits = [w.split("=")[0] for w in a.iwad if int(w.split("=")[1]) <= wad_room]
    too = [w.split("=")[0] for w in a.iwad if int(w.split("=")[1]) > wad_room]
    if a.iwad:
        print("   IWADs that fit that room: %s; too long: %s" %
              (", ".join(fits) or "none", ", ".join(too) or "none"))

    if a.rc == 0:
        verdict = "fits (SRAM %s of %s B%s)" % (
            n(sram_used), n(sram_cap),
            ", PSRAM %s of %s B" % (n(psram_used), n(psram_cap)) if psram_used else "")
    else:
        parts = ["%s by %s B" % (r, n(b)) for r, b in overflow]
        ram = dict(overflow).get("RAM")
        mult = " (needs %.2fx its %s B SRAM)" % (sram_used / sram_cap, n(sram_cap)) if ram else ""
        verdict = "does not fit by %s B: region %s%s" % (
            n(ram if ram is not None else overflow[0][1]), ", ".join(parts), mult)
    print("VERDICT %s: %s" % (a.label, verdict))
    print("ROW|%s|%d|%d|%d|%d|%d|%d|%d|%s|%d|%d|%s|%s|%s" % (
        a.label, flash_used, by.get(".data", 0), by.get(".bss", 0), heap_size,
        by.get("stack", 0), zone_size, sram_used, zone_reg, sram_cap, psram_used,
        "fits" if a.rc == 0 else "over", a.screens_region, heap_reg))


if __name__ == "__main__":
    main()
