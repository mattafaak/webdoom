// tools/lib/gzip.mjs — ONE gzip, because there were two and they disagreed.
//
// `size-ledger.mjs` and `stamp-check.mjs` each carried a copy of this function
// with a fifteen-line comment explaining why it shells out rather than using
// `zlib.gzipSync`: the two produce different sizes, and these are GATED
// figures, so switching would silently move a published number.
//
// `payload-size.mjs` used `zlib.gzipSync` — on a file list that includes
// `/engine/doom.wasm`. So one `stamp-full` run gzipped the same bytes two ways,
// published one as `size-002`/`perf-004` and folded the other into `perf-015`,
// and nothing compared them. Measured on the round-13 build:
//
//     gzip -9kc     134,254 B      <- size-002, perf-004
//     zlib level 9  133,485 B      <- folded into perf-015
//     difference        769 B, 0.57%
//
// The comment those two copies carried said 298 bytes. It had more than
// doubled, unnoticed, because nothing was looking.
//
// `gzip -9kc` wins for one reason: it is what the published figures were
// measured with, and a tool that changes a gated number while claiming to
// tidy up is the failure this project names as its own.
//
// Copyright (C) 2026, GPL-2.0-or-later.
import { execSync } from 'node:child_process';

// A gzip that FAILS must return null, not a number.
//
// This was `gzip -9kc "file" | wc -c`, and execSync runs that through /bin/sh,
// which has no pipefail -- so the pipeline's status is wc's, and wc succeeds at
// counting nothing. A missing or unreadable file therefore returned the STRING
// "0", parseInt made it the NUMBER 0, and the surrounding try/catch never fired
// because nothing ever threw. Measured: gzipSize('/nonexistent') === 0, which
// then flows on as a real measurement -- size-002 would be published as 0 bytes.
//
// Dropping the pipe is the whole fix: gzip's own non-zero exit reaches
// execSync, which throws, and stdout's length is the same number `wc -c` was
// counting.
export function gzipSize(path) {
    try {
        return execSync(`gzip -9kc "${path}"`, { maxBuffer: 1 << 28 }).length;
    } catch { return null; }
}

// There is deliberately NO in-memory variant.  The first draft had one, and it
// disagreed with gzipSize() by 11 bytes on doom.wasm: gzip stores the original
// FILENAME in its header, so compressing the same bytes under a temp name is a
// different size.  Every caller here has a real path.  A helper that quietly
// differs from the thing it was extracted to unify would be the bug this module
// exists to remove, reintroduced one layer down.
