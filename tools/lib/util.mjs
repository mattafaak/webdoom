// Shared by every tool: the repo root, a sleep, argv helpers, a free port.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createServer } from 'node:net';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const sleep = ms => new Promise(r => setTimeout(r, ms));

// --name value   (undefined when absent)
export function argValue(name) {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
}
// argv without the --name value pairs listed, and without node + script
export function positional(...valueFlags) {
    const out = [];
    const a = process.argv.slice(2);
    for (let i = 0; i < a.length; i++) {
        if (valueFlags.includes(a[i])) { i++; continue; }
        out.push(a[i]);
    }
    return out;
}
// The build directory a harness loads doom.js from (--build-dir DIR, default build).
export const buildDirArg = () => argValue('--build-dir') ?? 'build';

// A port nobody is listening on right now.  Legs used to hard-code one each
// (and four pairs collided); an orphaned server on a fixed port hung the
// next run silently.
export function freePort() {
    return new Promise((res, rej) => {
        const s = createServer();
        s.unref();
        s.on('error', rej);
        s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
    });
}
