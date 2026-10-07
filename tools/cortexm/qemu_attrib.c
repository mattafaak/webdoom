// tools/cortexm/qemu_attrib.c — a qemu TCG plugin that attributes every guest
// instruction of a cm-doom run to a function bucket and an engine stage, per
// tic.  Host code: tools/cortexm/attrib.mjs builds it (gcc -shared) and runs
// it; the Makefile never compiles it for the board.
//
// Exact, not sampled: every translated instruction carries an inline add of 1
// to its bucket's counter (a scoreboard entry), so the counts are the
// instructions qemu executed, the same quantity -icount shift=0 turns into
// time.  Nothing here touches guest state, so a run with the plugin is the
// measured run (attrib.mjs checks the floor log it writes against the
// leg's).
//
// Events are instruction addresses (attrib.mjs finds them in the ELF): the
// return address of a call, so a window opens and closes at the same point
// of the bracketing call as the guest's own timer reads do, and has the same
// length.
//   B  tic begin   after `last = cm_ticks ()` in cm_main.c
//   E  tic end     after `unsigned now = cm_ticks ()`
//   S  stage start after `t0 = web_perf_now ()` (r_main.c) or
//                  `_ts = web_perf_now ()` (d_main.c), with the stage index
//   X  stage end   after the closing web_perf_now ()
// Instructions between E and the next B are the harness's (hashing, booking)
// and are charged to nothing, as the timer charges them to nothing.
//
// Optional x-split: at the first instruction of a named drawer the plugin
// reads a guest global (the column's dc_x, or a span's ds_x1 and ds_x2) and
// charges that call's instructions to the left (x < split) or right half;
// a span that crosses the split is charged to a third bucket, "cross".
//
// Map file (args: map=FILE out=FILE):
//   N <nbuckets>
//   B <index> <name>
//   R <start hex> <end hex> <bucket>          [start, end)
//   V <addr hex> <kind B|E|S|X> <stage>
//   D <entry hex> <bucket> col <&dc_x hex> <split>
//   D <entry hex> <bucket> span <&ds_x1 hex> <&ds_x2 hex> <split>
//   C <entry hex> <id>                        count calls (an entry executed)
// Output, one block per completed tic:
//   T <tic>
//   <stage> <bucket> <count>        (nonzero only)
//   H <bucket> <stage> <half 0|1|2> <instructions> <calls>
//                                   (x-split drawers only, nonzero only)
//   C <id> <stage> <calls>          (counted entries, nonzero only)
// and at exit "Z <tics> <total instructions in tics> <unmapped>".
// Copyright (C) 2026, GPL-2.0-or-later.
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <qemu-plugin.h>

QEMU_PLUGIN_EXPORT int qemu_plugin_version = QEMU_PLUGIN_VERSION;

#define MAXB 1024
#define NSTAGE 6 /* 0 other, 1 sim, 2 frame, 3 bsp, 4 planes, 5 masked */
#define MAXD 16
#define MAXC 16

struct range
{
    uint64_t lo, hi;
    int b;
};
struct event
{
    uint64_t addr;
    char kind;
    int stage;
};
struct drawer
{
    uint64_t entry;
    int b, span, split;
    uint64_t a1, a2;
};
struct counters
{
    uint64_t cnt[MAXB];
};

static struct range* ranges;
static int nranges;
static struct event* events;
static int nevents;
static struct drawer drawers[MAXD];
static int ndrawers;
static uint64_t centry[MAXC];
static int cid[MAXC], ncentries;
static uint64_t ccount[MAXC][NSTAGE];
static int nbuckets;
static FILE* out;
static struct qemu_plugin_scoreboard* sb;

static uint64_t snap[MAXB];
static uint64_t acc[NSTAGE][MAXB];
static uint64_t half[MAXD][NSTAGE][3], calls[MAXD][NSTAGE][3];
static int in_tic, stage, tic;
static uint64_t total_in_tics;
// the x-split: the open drawer call, its half, and its bucket's count at entry
static int open_d = -1, open_half, open_stage;
static uint64_t open_at;

static uint64_t* live (void)
{
    return ((struct counters*) qemu_plugin_scoreboard_find (sb, 0))->cnt;
}

static void flush (void)
{
    uint64_t* c = live ();
    int b;
    for (b = 0; b < nbuckets; b++)
    {
        uint64_t d = c[b] - snap[b];
        if (d && in_tic)
            acc[stage][b] += d;
        snap[b] = c[b];
    }
}

static void close_drawer (void)
{
    if (open_d >= 0)
    {
        uint64_t now = live ()[drawers[open_d].b];
        if (in_tic)
            half[open_d][open_stage][open_half] += now - open_at;
        open_d = -1;
    }
}

static void write_tic (void)
{
    int s, b, d, h, c;
    fprintf (out, "T %d\n", tic);
    for (s = 0; s < NSTAGE; s++)
        for (b = 0; b < nbuckets; b++)
            if (acc[s][b])
            {
                fprintf (out, "%d %d %" PRIu64 "\n", s, b, acc[s][b]);
                total_in_tics += acc[s][b];
                acc[s][b] = 0;
            }
    for (d = 0; d < ndrawers; d++)
        for (s = 0; s < NSTAGE; s++)
            for (h = 0; h < 3; h++)
                if (half[d][s][h] || calls[d][s][h])
                {
                    fprintf (out, "H %d %d %d %" PRIu64 " %" PRIu64 "\n",
                             drawers[d].b, s, h, half[d][s][h], calls[d][s][h]);
                    half[d][s][h] = calls[d][s][h] = 0;
                }
    for (c = 0; c < ncentries; c++)
        for (s = 0; s < NSTAGE; s++)
            if (ccount[c][s])
            {
                fprintf (out, "C %d %d %" PRIu64 "\n", cid[c], s, ccount[c][s]);
                ccount[c][s] = 0;
            }
}

static void on_event (unsigned int vcpu, void* ud)
{
    const struct event* e = ud;
    (void) vcpu;
    close_drawer ();
    flush ();
    switch (e->kind)
    {
    case 'B':
        in_tic = 1;
        stage = 0;
        break;
    case 'E':
        if (in_tic)
        {
            write_tic ();
            tic++;
        }
        in_tic = 0;
        stage = 0;
        break;
    case 'S':
        stage = e->stage;
        break;
    case 'X':
        stage = 0;
        break;
    }
}

static int read_i32 (uint64_t addr)
{
    GByteArray* buf = g_byte_array_sized_new (4);
    int32_t v = 0;
    if (qemu_plugin_read_memory_vaddr (addr, buf, 4) && buf->len == 4)
        memcpy (&v, buf->data, 4);
    else
    {
        fprintf (stderr, "qemu_attrib: cannot read guest 0x%" PRIx64 "\n",
                 addr);
        exit (3);
    }
    g_byte_array_free (buf, TRUE);
    return v;
}

static void on_drawer (unsigned int vcpu, void* ud)
{
    const struct drawer* d = ud;
    (void) vcpu;
    close_drawer ();
    open_d = (int) (d - drawers);
    open_at = live ()[d->b];
    open_stage = stage;
    if (d->span)
    {
        int x1 = read_i32 (d->a1), x2 = read_i32 (d->a2);
        open_half = x2 < d->split ? 0 : x1 >= d->split ? 1 : 2;
    }
    else
        open_half = read_i32 (d->a1) < d->split ? 0 : 1;
    if (in_tic)
        calls[open_d][open_stage][open_half]++;
}

static void on_counted (unsigned int vcpu, void* ud)
{
    (void) vcpu;
    if (in_tic)
        ccount[(uint64_t*) ud - centry][stage]++;
}

static int bucket_of (uint64_t a)
{
    int lo = 0, hi = nranges - 1;
    while (lo <= hi)
    {
        int m = (lo + hi) / 2;
        if (a < ranges[m].lo)
            hi = m - 1;
        else if (a >= ranges[m].hi)
            lo = m + 1;
        else
            return ranges[m].b;
    }
    return 0; /* bucket 0 is "unmapped" */
}

static void on_trans (struct qemu_plugin_tb* tb, void* ud)
{
    size_t n = qemu_plugin_tb_n_insns (tb), i;
    int k;
    (void) ud;
    for (i = 0; i < n; i++)
    {
        struct qemu_plugin_insn* insn = qemu_plugin_tb_get_insn (tb, i);
        uint64_t a = qemu_plugin_insn_vaddr (insn);
        qemu_plugin_u64 e = {sb, offsetof (struct counters, cnt) +
                                     sizeof (uint64_t) * bucket_of (a)};
        for (k = 0; k < nevents; k++)
            if (events[k].addr == a)
                qemu_plugin_register_vcpu_insn_exec_cb (
                    insn, on_event, QEMU_PLUGIN_CB_NO_REGS, &events[k]);
        for (k = 0; k < ndrawers; k++)
            if (drawers[k].entry == a)
                qemu_plugin_register_vcpu_insn_exec_cb (
                    insn, on_drawer, QEMU_PLUGIN_CB_NO_REGS, &drawers[k]);
        for (k = 0; k < ncentries; k++)
            if (centry[k] == a)
                qemu_plugin_register_vcpu_insn_exec_cb (
                    insn, on_counted, QEMU_PLUGIN_CB_NO_REGS, &centry[k]);
        qemu_plugin_register_vcpu_insn_exec_inline_per_vcpu (
            insn, QEMU_PLUGIN_INLINE_ADD_U64, e, 1);
    }
}

static void at_exit (void* ud)
{
    (void) ud;
    fprintf (out, "Z %d %" PRIu64 " %" PRIu64 "\n", tic, total_in_tics,
             live ()[0]);
    fclose (out);
}

static int cmp_range (const void* a, const void* b)
{
    const struct range *x = a, *y = b;
    return x->lo < y->lo ? -1 : x->lo > y->lo;
}

static int load_map (const char* path)
{
    FILE* f = fopen (path, "r");
    char line[512];
    int cap = 0, ecap = 0;
    if (!f)
        return -1;
    while (fgets (line, sizeof (line), f))
    {
        uint64_t lo, hi;
        int b, st, sp;
        char kind;
        char what[8];
        if (line[0] == 'N' && sscanf (line, "N %d", &nbuckets) == 1)
            continue;
        if (line[0] == 'R' &&
            sscanf (line, "R %" SCNx64 " %" SCNx64 " %d", &lo, &hi, &b) == 3)
        {
            if (nranges == cap)
                ranges =
                    realloc (ranges, sizeof (*ranges) * (cap = cap * 2 + 64));
            ranges[nranges].lo = lo;
            ranges[nranges].hi = hi;
            ranges[nranges].b = b;
            nranges++;
        }
        else if (line[0] == 'V' &&
                 sscanf (line, "V %" SCNx64 " %c %d", &lo, &kind, &st) == 3)
        {
            if (nevents == ecap)
                events =
                    realloc (events, sizeof (*events) * (ecap = ecap * 2 + 16));
            events[nevents].addr = lo;
            events[nevents].kind = kind;
            events[nevents].stage = st;
            nevents++;
        }
        else if (line[0] == 'C' && ncentries < MAXC &&
                 sscanf (line, "C %" SCNx64 " %d", &lo, &b) == 2)
        {
            centry[ncentries] = lo;
            cid[ncentries] = b;
            ncentries++;
        }
        else if (line[0] == 'D' && ndrawers < MAXD &&
                 sscanf (line, "D %" SCNx64 " %d %7s", &lo, &b, what) == 3)
        {
            struct drawer* d = &drawers[ndrawers];
            d->entry = lo;
            d->b = b;
            d->span = !strcmp (what, "span");
            if (d->span
                    ? sscanf (line, "D %*x %*d %*s %" SCNx64 " %" SCNx64 " %d",
                              &d->a1, &d->a2, &sp) == 3
                    : sscanf (line, "D %*x %*d %*s %" SCNx64 " %d", &d->a1,
                              &sp) == 2)
            {
                d->split = sp;
                ndrawers++;
            }
        }
    }
    fclose (f);
    qsort (ranges, nranges, sizeof (*ranges), cmp_range);
    return nbuckets > 0 && nbuckets <= MAXB && nranges > 0 && nevents > 0 ? 0
                                                                          : -1;
}

QEMU_PLUGIN_EXPORT int qemu_plugin_install (qemu_plugin_id_t id,
                                            const qemu_info_t* info, int argc,
                                            char** argv)
{
    const char *map = NULL, *outp = NULL;
    int i;
    (void) info;
    for (i = 0; i < argc; i++)
    {
        if (!strncmp (argv[i], "map=", 4))
            map = argv[i] + 4;
        else if (!strncmp (argv[i], "out=", 4))
            outp = argv[i] + 4;
    }
    if (!map || !outp || load_map (map) != 0)
    {
        fprintf (stderr, "qemu_attrib: need map=FILE (with buckets, ranges "
                         "and events) and out=FILE\n");
        return -1;
    }
    out = fopen (outp, "w");
    if (!out)
        return -1;
    sb = qemu_plugin_scoreboard_new (sizeof (struct counters));
    qemu_plugin_register_vcpu_tb_trans_cb (id, on_trans, NULL);
    qemu_plugin_register_atexit_cb (id, at_exit, NULL);
    return 0;
}
