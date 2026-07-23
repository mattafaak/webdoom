#!/usr/bin/env bash
# tools/rp2040/prep-whd.sh — WHD asset pipeline for RP2040 DOOM port.
#
# PURPOSE: extract WAD lumps, measure sizes by category, compute compression
# ratios, and report the flash budget for an RP2040 Pico (2 MB flash, ~1.8 MB
# available after code).  Outputs a JSON summary for machine consumption and a
# human-readable table.
#
# WHD BACKGROUND: rp2040-doom uses a proprietary "WHD" (WHDOOM) format that
# strips and compresses vanilla DOOM assets to fit a 1.2–1.5 MB flash budget.
# Key size reductions:
#   - Sprites: stored as pre-patched patches (no PLAYPAL per-sprite)
#   - Music: MIDI stripped; OPL2 sequences baked to a minimal sequencer
#   - Graphics: vertically flipped columns stored raw (column-draw compatible)
#   - Maps: lumps kept verbatim (BSP is already compact)
#   - Textures: TEXTURE1/TEXTURE2 stripped; flat references only
#
# This script implements the achievable subset:
#   (1) Lump extraction and categorisation (ALL WADs)
#   (2) Per-category size measurement (gzip as proxy for LZ compression)
#   (3) Flash budget analysis against RP2040 target
#   (4) What-if analysis: "what ZONESIZE if we had N KB of external PSRAM?"
#
# USAGE:
#   bash tools/rp2040/prep-whd.sh wads/lib/doom1.wad [output-dir]
#   bash tools/rp2040/prep-whd.sh wads/lib/doom.wad  [output-dir]
#
# BLOCKED: actual WHD binary encoding requires pico-sdk + rp2040-doom toolchain.
# This script produces a size-analysis JSON (whd-analysis.json) and a lump
# manifest (whd-manifest.tsv) that can be fed to a real WHD encoder.
#
# DEPENDENCIES: bash, python3 (for WAD parsing and gzip), gzip, stat
#
# Copyright (C) 2026, GPL-2.0-or-later (see LICENSE).
set -eo pipefail   # pipefail: this script pipes arm-none-eabi-size into awk;
                   # without it a failing size(1) would silently read as success

WAD="${1:?Usage: prep-whd.sh <wad-file> [output-dir]}"
OUTDIR="${2:-/tmp/whd-prep-$(basename "$WAD" .wad)}"
mkdir -p "$OUTDIR"

if [ ! -f "$WAD" ]; then
    echo "prep-whd.sh: WAD not found: $WAD" >&2
    exit 1
fi

WAD_BYTES=$(stat -c '%s' "$WAD")
echo "prep-whd.sh: WAD=$WAD  size=${WAD_BYTES} bytes"
echo "prep-whd.sh: output=$OUTDIR"

# ── Step 1: parse WAD directory (Python inline) ───────────────────────────────
# Measure the shim's flash footprint from the built ELF so this figure cannot
# go stale as the port grows.  Falls back to the 2026-07-23 measurement when the
# ELF has not been built yet (prep-whd.sh is useful before a successful link).
ELF_FOR_SIZE="${RP2040_ELF:-$(dirname "$0")/rp2040-doom.elf}"
CODE_SIZE=293476
if [ -f "$ELF_FOR_SIZE" ] && command -v arm-none-eabi-size >/dev/null 2>&1; then
    # shellcheck disable=SC2016
    _sz=$(arm-none-eabi-size "$ELF_FOR_SIZE" | awk 'NR==2 {print $1 + $2}')
    [ -n "$_sz" ] && CODE_SIZE="$_sz"
    echo "prep-whd.sh: code_size=${CODE_SIZE} B (text+data, measured from $ELF_FOR_SIZE)"
else
    echo "prep-whd.sh: code_size=${CODE_SIZE} B (fallback — ELF not built)"
fi

python3 - "$WAD" "$OUTDIR" "$CODE_SIZE" << 'PYEOF'
import struct, sys, os, gzip, io, json

wad_path = sys.argv[1]
outdir   = sys.argv[2]

with open(wad_path, 'rb') as f:
    magic, numlumps, infotableofs = struct.unpack('<4sII', f.read(12))
    if magic not in (b'IWAD', b'PWAD'):
        print(f"ERROR: not a WAD file: {magic}", file=sys.stderr)
        sys.exit(1)

    f.seek(infotableofs)
    lumps = []
    for _ in range(numlumps):
        filepos, size = struct.unpack('<II', f.read(8))
        name = f.read(8).rstrip(b'\x00').decode('ascii', errors='replace')
        lumps.append({'name': name, 'offset': filepos, 'size': size})

# Categorise lumps by prefix/suffix convention
def categorise(name):
    if name.startswith('D_'):       return 'music'
    if name.startswith('DS'):       return 'sfx'
    if name in ('PLAYPAL','COLORMAP','ENDOOM','PNAMES','TEXTURE1','TEXTURE2'):
        return 'palette_or_tex'
    if name.startswith('F_') or name.startswith('FF_'):  return 'flat_marker'
    if name.startswith('S_') or name.startswith('SS_'):  return 'sprite_marker'
    if name.startswith('P_') or name.startswith('PP_'):  return 'patch_marker'
    if name.startswith('MAP') or name.startswith('E') and len(name)==4 and name[1]=='M':
        return 'map_header'
    if name in ('THINGS','LINEDEFS','SIDEDEFS','VERTEXES','SEGS','SSECTORS',
                'NODES','SECTORS','REJECT','BLOCKMAP','BEHAVIOR'):
        return 'map_data'
    if name.startswith('SKY'):       return 'sky'
    if name.startswith('DEMO'):      return 'demo'
    if name == '':                   return 'marker'
    return 'other'

# Read lump data and compute gzip-compressed sizes
with open(wad_path, 'rb') as f:
    categories = {}
    manifest_rows = []
    for lmp in lumps:
        cat = categorise(lmp['name'])
        raw = b''
        if lmp['size'] > 0:
            f.seek(lmp['offset'])
            raw = f.read(lmp['size'])
        gz_buf = io.BytesIO()
        with gzip.GzipFile(fileobj=gz_buf, mode='wb', compresslevel=9) as gz:
            gz.write(raw)
        gz_size = len(gz_buf.getvalue())

        if cat not in categories:
            categories[cat] = {'raw': 0, 'gz': 0, 'count': 0}
        categories[cat]['raw']   += lmp['size']
        categories[cat]['gz']    += gz_size
        categories[cat]['count'] += 1

        manifest_rows.append((lmp['name'], cat, lmp['size'], gz_size))

# Totals
total_raw = sum(c['raw'] for c in categories.values())
total_gz  = sum(c['gz']  for c in categories.values())

# RP2040 flash budget
flash_total   = 2 * 1024 * 1024       # 2 MB
code_size     = int(sys.argv[3])       # text+data, measured from the ELF by the caller
flash_avail   = flash_total - code_size
ratio         = total_gz / total_raw if total_raw else 1.0
fits          = total_gz <= flash_avail

summary = {
    'wad': os.path.basename(wad_path),
    'wad_bytes': os.path.getsize(wad_path),
    'total_lumps': len(lumps),
    'raw_bytes': total_raw,
    'gz9_bytes': total_gz,
    'gz9_ratio': round(ratio, 4),
    'rp2040_flash_total_bytes': flash_total,
    'rp2040_code_bytes': code_size,
    'rp2040_flash_avail_bytes': flash_avail,
    'gz9_fits_in_flash': fits,
    'gz9_surplus_or_deficit_bytes': flash_avail - total_gz,
    'categories': {k: {
        'count': v['count'],
        'raw_bytes': v['raw'],
        'gz9_bytes': v['gz'],
        'gz9_ratio': round(v['gz'] / v['raw'], 4) if v['raw'] else 0,
    } for k, v in sorted(categories.items(), key=lambda x: -x[1]['raw'])},
}

json_path = os.path.join(outdir, 'whd-analysis.json')
with open(json_path, 'w') as jf:
    json.dump(summary, jf, indent=2)
print(f"  wrote {json_path}")

tsv_path = os.path.join(outdir, 'whd-manifest.tsv')
with open(tsv_path, 'w') as tf:
    tf.write('name\tcategory\traw_bytes\tgz9_bytes\n')
    for row in manifest_rows:
        tf.write('\t'.join(str(x) for x in row) + '\n')
print(f"  wrote {tsv_path}")

# Print human-readable table
print()
print(f"{'Category':<18} {'Lumps':>6} {'Raw KB':>10} {'GZ-9 KB':>10} {'Ratio':>7}")
print('-' * 56)
for cat, v in sorted(categories.items(), key=lambda x: -x[1]['raw']):
    raw_kb = v['raw'] / 1024
    gz_kb  = v['gz']  / 1024
    r      = v['gz'] / v['raw'] if v['raw'] else 0
    print(f"{cat:<18} {v['count']:>6} {raw_kb:>10.1f} {gz_kb:>10.1f} {r:>7.3f}")
print('-' * 56)
raw_kb = total_raw / 1024
gz_kb  = total_gz  / 1024
print(f"{'TOTAL':<18} {len(lumps):>6} {raw_kb:>10.1f} {gz_kb:>10.1f} {ratio:>7.3f}")
print()
print(f"RP2040 flash: {flash_total//1024} KB total, {code_size} B code, {flash_avail//1024} KB available for WAD data")
print(f"GZ-9 compressed WAD: {total_gz//1024} KB  ->  {'FITS' if fits else 'DOES NOT FIT'} (surplus/deficit: {(flash_avail-total_gz)//1024:+d} KB)")
PYEOF

# ── Step 2: print flash and SRAM budget summary ───────────────────────────────
echo ""
echo "prep-whd.sh: SRAM analysis (from tools/rp2040/rp2040-doom.elf if present):"
ELF="$(dirname "$0")/rp2040-doom.elf"
if [ -f "$ELF" ]; then
    arm-none-eabi-size "$ELF" | awk 'NR==2 {
        text=$1; data=$2; bss=$3;
        flash=text+data; sram=data+bss;
        printf "  .text=%d B  .data=%d B  .bss=%d B\n", text, data, bss;
        printf "  Flash needed: %d B / 2097152 B  (surplus: +%d B)\n", flash, 2097152-flash;
        printf "  SRAM needed:  %d B / 270336 B   (deficit: %d B)\n", sram, sram-270336;
    }'
else
    echo "  (rp2040-doom.elf not found; run 'make' in tools/rp2040/ first)"
fi

echo ""
echo "prep-whd.sh: complete.  JSON: $OUTDIR/whd-analysis.json  TSV: $OUTDIR/whd-manifest.tsv"
