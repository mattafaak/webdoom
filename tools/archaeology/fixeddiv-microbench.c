#include <stdint.h>
#include <stdlib.h>
#include <emscripten.h>
typedef int32_t fixed_t;
#define MININT ((int) 0x80000000)
#define MAXINT ((int) 0x7fffffff)
static fixed_t A[4096], B[4096];
EMSCRIPTEN_KEEPALIVE void bench_init (void)
{
    uint64_t s = 0x9e3779b97f4a7c15ull;
    for (int i = 0; i < 4096; i++)
    {
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        A[i] = (fixed_t) s;
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        B[i] = (fixed_t) (s | 1);
    }
}
EMSCRIPTEN_KEEPALIVE int bench_double (int N)
{
    fixed_t sink = 0;
    for (int i = 0; i < N; i++)
    {
        fixed_t a = A[i & 4095], b = B[(i >> 3) & 4095];
        fixed_t r;
        if ((abs (a) >> 14) >= abs (b))
            r = (a ^ b) < 0 ? MININT : MAXINT;
        else
        {
            double c = ((double) a) / ((double) b) * 65536.0;
            r = (fixed_t) c;
        }
        sink ^= r;
    }
    return sink;
}
EMSCRIPTEN_KEEPALIVE int bench_int64 (int N)
{
    fixed_t sink = 0;
    for (int i = 0; i < N; i++)
    {
        fixed_t a = A[i & 4095], b = B[(i >> 3) & 4095];
        fixed_t r;
        if ((abs (a) >> 14) >= abs (b))
            r = (a ^ b) < 0 ? MININT : MAXINT;
        else
            r = (fixed_t) (((int64_t) a << 16) / b);
        sink ^= r;
    }
    return sink;
}
