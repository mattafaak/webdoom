#!/usr/bin/env node
// Standalone drop-in joining client for catch-up duration measurement.
// Ships alongside doom.js, doom.wasm, doom.wad to a remote host; the server
// runs on the caller's machine; this script connects and measures catchUp time.
//
// Usage: node tools/join-client.mjs <ws://HOST:PORT> [/path/to/doom.wad]
// Output (stdout): JSON line { frontier, catchup_ms }
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

process.on('uncaughtException', e => {
    process.stderr.write(`UNCAUGHT: ${e?.message ?? String(e).slice(0, 300)}\n`);
    process.exit(1);
});

const __dir = dirname(fileURLToPath(import.meta.url));
const serverBase = process.argv[2];
if (!serverBase) {
    process.stderr.write('usage: node join-client.mjs <ws://HOST:PORT> [wad]\n');
    process.exit(1);
}
const wadPath = process.argv[3] ?? join(__dir, '..', 'wads', 'lib', 'doom.wad');
const buildDir = join(__dir, '..', 'build');

const { connectLobby, attachRelay, launchArgs } =
    await import(join(__dir, '..', 'client', 'js', 'net.js'));
const createDoom = (await import(join(buildDir, 'doom.js'))).default;
const wadBytes = readFileSync(wadPath);

const sleep = ms => new Promise(r => setTimeout(r, ms));

const doom = await createDoom({
    print: () => {},
    printErr: t => {
        if (/consistency|I_Error/i.test(t))
            process.stderr.write(`[doom] ${t}\n`);
    },
    onDoomError: msg => { process.stderr.write(`[doom error] ${msg}\n`); process.exit(1); },
});
{
    const p = doom._malloc(wadBytes.length);
    doom.HEAPU8.set(wadBytes, p);
    doom.ccall('web_register_file', null, ['string', 'number', 'number'],
               ['doomu.wad', p, wadBytes.length]);
}

const lobby = connectLobby(serverBase);
const launchMsg = await new Promise((res, rej) => {
    lobby.on('inprogress', () => lobby.send({ t: 'join' }));
    lobby.on('launch', res);
    lobby.on('error', e => rej(e instanceof Error ? e : new Error(String(e))));
    setTimeout(() => rej(new Error('lobby timeout after 30s')), 30000);
});

if (!launchMsg.join) {
    process.stderr.write('server did not send a join launch\n');
    process.exit(1);
}

const slot = lobby.slot;
const frontier = launchMsg.frontier ?? 0;

doom.callMain(launchArgs(launchMsg.params, false));

const relay = attachRelay(doom, serverBase, {
    slot, numplayers: launchMsg.numplayers,
    slots: launchMsg.slots, names: launchMsg.names, jitterMs: 2,
});

const t0 = performance.now();
await relay.catchUp(frontier, () => {});
const catchup_ms = +(performance.now() - t0).toFixed(1);

relay.quit();
lobby.close();

process.stdout.write(JSON.stringify({ frontier, catchup_ms }) + '\n');
process.exit(0);
