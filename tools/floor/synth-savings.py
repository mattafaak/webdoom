#!/usr/bin/env python3
# tools/floor/synth-savings.py — candidate savings in the OPL synth, measured
# for exactness and for cost.  The variants are edits of the reference core,
# tools/floor/opl3-ref/opl3.c (engine/web/opl3.c as it was when phase 1a
# measured them; A, C and D are now made real in engine/web/opl3.c, D in an
# exact-for-any-stream form, and tools/synth-exact-test.mjs holds it to this
# reference).  Each variant is written to a temporary directory, built into a
# synth-bench with the Makefile's flags (less its -fno-pie, which is the
# `nopie` suffix here), and run over the 13 demo songs in both modes at
# 49,716 Hz.
# A variant is EXACT when every render's samples (L2) equal
# tools/floor/synth-ref.json's, which tools/synth-native-test.mjs holds equal to
# build/synth.wasm.  Counts are user-space instructions, pinned to P-cores.
#
# The variants (on opl3.c, each exact only for the register stream mus_opl.c
# produces, which tools/floor/synth-ref.json pins as L1):
#   A  OPL2 mode (NEW=0) computes no bank-1 slot (18..35) and mixes no bank-1
#      channel: in OPL2 mode mus_opl.c never writes bank 1, so those slots hold
#      f_num 0, phase 0 and full attenuation, and output exactly 0.
#   B  skip any slot that is keyed off and fully released.  NOT exact: a
#      released slot's output is 0 or -1 (the sign of its still-advancing
#      phase survives full attenuation, EnvelopeCalcSin0's `^ neg`), so the
#      silence of an OPL voice is a 1-LSB square wave.  Kept as the refuted
#      candidate, with what it would have saved.
#   C  at the chip's own rate the resampler is a one-frame delay, so no
#      multiply or divide: the same samples.
#   D  with rhythm mode never on (mus_opl.c never writes 0xbd), the noise
#      LFSR and the hi-hat/cymbal phase bits are never read: not computed.
#   shipped  no edit of the reference: engine/web/opl3.c as it ships, with A,
#      C and D made real (D exact for any register stream), for comparison.
#   nopie  the same source built -fno-pie (gcc here defaults to PIE, and i386
#      PIC code reaches every table through __x86.get_pc_thunk); a bare-metal
#      build is not PIC.
#
# usage: python3 tools/floor/synth-savings.py [--variants base-O1,A-O1,...]
# Copyright (C) 2026, GPL-2.0-or-later.
import concurrent.futures
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
FS = os.path.join(ROOT, 'tools/freestanding')
WEB = os.path.join(ROOT, 'engine/web')
REF = os.path.join(ROOT, 'tools/floor/opl3-ref/opl3.c')

SLOT4 = '''        OPL3_SlotCalcFB (&chip->slot[ii]);
        OPL3_EnvelopeCalc (&chip->slot[ii]);
        OPL3_PhaseGenerate (&chip->slot[ii]);
        OPL3_SlotGenerate (&chip->slot[ii]);'''


def rep(s, old, new, count=1):
    if s.count(old) != count:
        sys.exit('FAIL synth-savings: the reference opl3.c lacks the text variant edits expect: %r' % old[:70])
    return s.replace(old, new)


def var_a(s):
    for lo, hi in (('18', '33'), ('33', '36')):
        s = rep(s, '    for (ii = %s; ii < %s; ii++)\n    {\n' % (lo, hi) + SLOT4,
                '    for (ii = %s; ii < (chip->newm ? %s : %s); ii++)\n    {\n' % (lo, hi, lo) + SLOT4)
    return rep(s, '    for (ii = 0; ii < 18; ii++)\n    {\n        accm = 0;',
               '    for (ii = 0; ii < (chip->newm ? 18 : 9); ii++)\n    {\n        accm = 0;', 2)


def var_b(s):
    s = rep(s, 'void OPL3_Generate (opl3_chip* chip, Bit16s* buf)\n{',
            'static int OPL3_SlotIdle (const opl3_slot* slot)\n{\n'
            '    return !slot->key && slot->eg_gen == envelope_gen_num_release &&\n'
            '           slot->eg_rout == 0x1ff && !slot->out && !slot->prout;\n}\n\n'
            'void OPL3_Generate (opl3_chip* chip, Bit16s* buf)\n{')
    return rep(s, SLOT4, '        if (OPL3_SlotIdle (&chip->slot[ii]))\n            continue;\n' + SLOT4, 4)


def var_c(s):
    return rep(s, 'void OPL3_GenerateResampled (opl3_chip* chip, Bit16s* buf)\n{',
               'void OPL3_GenerateResampled (opl3_chip* chip, Bit16s* buf)\n{\n'
               '    if (chip->rateratio == 1 << RSM_FRAC)\n    {\n'
               '        if (chip->samplecnt)\n        {\n'
               '            chip->oldsamples[0] = chip->samples[0];\n'
               '            chip->oldsamples[1] = chip->samples[1];\n'
               '            OPL3_Generate (chip, chip->samples);\n        }\n'
               '        chip->samplecnt = 1 << RSM_FRAC;\n'
               '        buf[0] = chip->oldsamples[0];\n        buf[1] = chip->oldsamples[1];\n'
               '        return;\n    }')


def var_d(s):
    return rep(s, '    noise = chip->noise;\n    slot->pg_phase_out = phase;\n',
               '    noise = chip->noise;\n    slot->pg_phase_out = phase;\n    if (!chip->rhy)\n        return;\n')


EDITS = {'A': var_a, 'B': var_b, 'C': var_c, 'D': var_d}
DEFAULT = ['base-O1', 'base-O1-nopie', 'C-O1', 'A-O1', 'AD-O1', 'ACD-O1', 'ACD-O1-nopie',
           'shipped-O1', 'shipped-O1-nopie', 'base-O2', 'base-O2-nopie', 'ACD-O2-nopie',
           'shipped-O2-nopie', 'B-O1']


def make_flags():
    # the Makefile's CFLAGS + SYNTH_FP + SYNTH_INC, as make would pass them
    out = subprocess.run(['make', '-C', FS, '-n', '-B', 'obj/synth-O1/opl3.o'], capture_output=True,
                         text=True, check=True).stdout
    line = next(l for l in out.splitlines() if l.startswith('gcc') and 'opl3.c' in l)
    flags = line.split()[1:]
    flags = [f for f in flags if f not in ('-MMD', '-MP', '-c', '-o', '-fno-pie') and not f.endswith(('.c', '.o'))]
    return [f if not f.startswith('-I') else '-I' + os.path.join(FS, f[2:]) for f in flags]


def build(name, tmp, flags):
    edits, opt, *rest = name.split('-')
    src = open(os.path.join(WEB, 'opl3.c') if edits == 'shipped' else REF).read()
    for e in '' if edits in ('base', 'shipped') else edits:
        src = EDITS[e](src)
    d = os.path.join(tmp, name)
    os.makedirs(d)
    open(os.path.join(d, 'opl3.c'), 'w').write(src)
    cf = [f for f in flags if f not in ('-O1', '-O2')] + ['-' + opt] + (['-fno-pie'] if rest == ['nopie'] else [])
    objs = []
    for s in (os.path.join(FS, 'fs_mus.c'), os.path.join(d, 'opl3.c'),
              os.path.join(WEB, 'synth_main.c'), os.path.join(FS, 'synth-bench.c')):
        o = os.path.join(d, os.path.basename(s)[:-2] + '.o')
        subprocess.run(['gcc'] + cf + ['-I' + WEB, '-c', s, '-o', o], check=True, cwd=FS)
        objs.append(o)
    exe = os.path.join(d, 'synth-bench')
    subprocess.run(['gcc'] + objs + ['-m32', '-no-pie', '-Wl,--wrap=OPL3_WriteRegBuffered', '-lm', '-o', exe],
                   check=True)
    return exe


def pcores():
    try:
        spec = open('/sys/devices/cpu_core/cpus').read().strip()
    except OSError:
        return list(range(os.cpu_count()))
    out = []
    for r in spec.split(','):
        a, _, b = r.partition('-')
        out += range(int(a), int(b or a) + 1)
    return out


def main():
    names = DEFAULT
    if '--variants' in sys.argv:
        names = sys.argv[sys.argv.index('--variants') + 1].split(',')
    ref = json.load(open(os.path.join(ROOT, 'tools/floor/synth-ref.json')))['demos']
    flags = make_flags()
    tmp = tempfile.mkdtemp(prefix='synth-savings-')
    # every variant's sources, objects and binary: removed however the run ends
    # (a failed build, a FAIL from a render, an interrupt), not left in $TMPDIR
    try:
        exes = {n: build(n, tmp, flags) for n in names}
        cpus, lock = pcores(), threading.Lock()

        def run(job):
            n, key = job
            r = ref[key]
            with lock:
                cpu = cpus.pop()
            try:
                o = subprocess.run(['taskset', '-c', str(cpu), exes[n], '--wad', os.path.join(ROOT, 'wads/lib', r['wad']),
                                    '--song', r['song'], '--mode', '1' if key.endswith('opl3') else '0',
                                    '--tics', str(r['tics']), '--count'], capture_output=True, text=True)
            finally:
                with lock:
                    cpus.append(cpu)
            if o.returncode:
                sys.exit('FAIL synth-savings: %s %s: %s' % (n, key, o.stderr.strip()))
            f = lambda k: re.search(r'\b%s=(\S+)' % k, o.stdout).group(1)
            return n, key, f('l2') == r['l2'], int(f('instr')), int(f('worst_block')), r['frames']

        jobs = [(n, k) for n in names for k in ref]
        with concurrent.futures.ThreadPoolExecutor(len(cpus)) as ex:
            res = list(ex.map(run, jobs))
        base = {}
        print('%-14s %-5s %-9s %10s %10s %14s %8s' % ('variant', 'mode', 'exact', 'M instr/s', 'M per tic', 'worst tic (M)', 'vs base'))
        for n in names:
            for m in ('opl2', 'opl3'):
                rs = [r for r in res if r[0] == n and r[1].endswith(m)]
                ok = sum(r[2] for r in rs)
                secs = sum(r[5] for r in rs) / 49716.0
                per_s = sum(r[3] for r in rs) / secs
                base.setdefault(m, per_s if n == names[0] else None)
                rel = '%+.1f%%' % (100.0 * (per_s / base[m] - 1)) if base[m] else ''
                print('%-14s %-5s %2d/%-6d %10.2f %10.2f %14.2f %8s' % (n, m, ok, len(rs), per_s / 1e6, per_s / 35e6,
                                                                        max(r[4] for r in rs) / 1e6, rel))
        print('synth-savings: %d pinned runs, %d variants x %d renders; "exact" = L2 equals tools/floor/synth-ref.json'
              % (len(jobs), len(names), len(ref)))

    finally:
        shutil.rmtree(tmp, ignore_errors=True)

main()
