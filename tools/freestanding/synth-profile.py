#!/usr/bin/env python3
# tools/freestanding/synth-profile.py — name a synth-bench --profile dump.
#
# synth-bench samples the instruction pointer every 100,003 user-space
# instructions; this maps each sampled address to its function with addr2line
# (-i: an inlined function is charged to itself, and also listed under the
# function it was inlined into) and prints each function's share of all
# samples, so the share is a share of instructions executed.
#
# usage: python3 tools/freestanding/synth-profile.py BINARY PROFILE [--lines N]
#   --lines N   also list the N hottest source lines
# Copyright (C) 2026, GPL-2.0-or-later.
import collections
import subprocess
import sys


def main():
    if len(sys.argv) < 3:
        sys.exit('usage: synth-profile.py BINARY PROFILE [--lines N]')
    binary, prof = sys.argv[1], sys.argv[2]
    nlines = int(sys.argv[sys.argv.index('--lines') + 1]) if '--lines' in sys.argv else 0
    counts = {}
    header = ''
    for line in open(prof):
        if line.startswith('#'):
            header = line.strip()
            continue
        ip, n = line.split()
        counts[int(ip, 16)] = int(n)
    total = sum(counts.values())
    if not total:
        sys.exit('FAIL synth-profile: no samples')
    ips = sorted(counts)
    out = subprocess.run(['addr2line', '-a', '-f', '-i', '-e', binary],
                         input='\n'.join('%x' % i for i in ips) + '\n',
                         capture_output=True, text=True, check=True).stdout.splitlines()
    # -a prints the address, then (function, file:line) pairs, innermost first
    inner = collections.Counter()
    outer = collections.Counter()
    lines = collections.Counter()
    k = 0
    for ip in ips:
        assert out[k].startswith('0x'), out[k]
        k += 1
        chain = []
        while k < len(out) and not out[k].startswith('0x'):
            chain.append((out[k], out[k + 1].split(' (')[0]))
            k += 2
        n = counts[ip]
        inner[chain[0][0]] += n
        outer[chain[-1][0]] += n
        lines[chain[0][1].split('/')[-1]] += n
    print('%s  (%d samples)' % (header, total))
    print('\nby function, inlined code charged to itself:')
    for f, n in inner.most_common():
        if n * 10000 >= total:
            print('  %6.2f%%  %s' % (100.0 * n / total, f))
    print('\nby function, inlined code charged to its caller:')
    for f, n in outer.most_common():
        if n * 10000 >= total:
            print('  %6.2f%%  %s' % (100.0 * n / total, f))
    if nlines:
        print('\nhottest source lines:')
        for f, n in lines.most_common(nlines):
            print('  %6.2f%%  %s' % (100.0 * n / total, f))


main()
