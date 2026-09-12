# Security

webdoom is a LAN game server and a browser client. The threat model is
stated in `spec.md` tenet 4 — *no input from the network, the WAD, or the
user may corrupt memory or wedge a state machine* — and the deployment
reality it is written against is a plain-HTTP address on a LAN or tailnet,
where anything on the network can answer `ws://host:8666/ws/lobby`.

## Reporting

Open a GitHub issue. If you would rather not, say so in an issue with no
detail and a maintainer will arrange somewhere else to send it.

There is no bug bounty and no embargo policy; this is a hobby DOOM port.
A report that comes with a reproducer will be fixed faster than one that
does not, because every fix here lands with a gate that fails before it.

## What is already hardened, and where the gate is

Each of these was a real defect with a reproducer before it was a gate.
`bash tools/run-tests.sh` runs all of them.

| surface | gate |
|---------|------|
| Malformed / hostile WebSocket frames into the server | `net-fuzz` |
| A hostile SERVER against the lobby client | `hostile-lobby` |
| A hostile server's frames into the engine | `hostile-server` |
| Adversarial HTTP paths, and a hostile data directory | `http-fuzz` |
| Hostile WAD lump content (GENMIDI, MUS) | `wad-content-fuzz` |
| Adversarial maps under ASan/UBSan | `adversarial-map`, `native-asan` |
| Mutated demos, wasm vs native | `fuzz-diff` |
| Demo-store caps, quotas and ids | `demo-store-fuzz` |
| localStorage and the rebind UI as user input | `browser-settings` |
| Resource caps: connections, spectators, send backlog, tic history | `net-fuzz` |

## What is deliberately NOT defended

Saying so plainly is part of the contract.

- **There is no authentication.** Anyone who can reach the port can join
  a game, spectate one, or upload a demo. That is the design: it is a
  LAN party, and the server advertises its own address at startup.
- **There is no transport encryption.** Plain HTTP on a LAN is the
  primary environment (`spec.md` §"Deployment reality: insecure origins")
  and the client degrades loudly rather than silently there.
- **Do not expose the server to the public internet.** Nothing here is
  written for that, the caps are sized for a LAN table, and the demo
  store accepts uploads from anyone who can reach it.
- **Game data is not distributed with this project** and never will be.
  You supply your own IWADs.

## A note on the gates

If you are reading this because you found something, the fastest path to
a fix is a failing gate. This project treats a gate that passes over a
defect as a defect in its own right — see `CLAUDE.md`, "Three ways a gate
you just wrote can lie to you".
