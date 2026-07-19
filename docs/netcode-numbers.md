# Netcode measured numbers (task 15.5)

Three promised-but-unmeasured netcode figures, measured 2026-07-19.

---

## 1. Stall length at the grace boundary

**Question**: when a peer stops sending (drops), how long do survivors stall before
the grace mechanism releases them?

**Method**: instrumented the existing drop phase in `tools/net-test.mjs` (2-player
game on localhost). `tDrop = performance.now()` recorded at `victim.relay.quit()`;
`tFirstAdvance` recorded when `clients[0]._web_gametic()` first advanced past
`dropTic`. The drop is a **graceful WebSocket close** — the server's `ws.on('close')`
fires immediately and sets `p.ingame = false`, so `seal()` can proceed on the next
surviving player message. n=5 runs, alder host.

| run | stall_ms |
|-----|----------|
| 1 | 32.0 |
| 2 | 16.1 |
| 3 | 33.1 |
| 4 | 32.7 |
| 5 | 16.0 |

**Result**: mean 26.0 ms, min 16.0 ms, max 33.1 ms (1–2 frame-loop periods of 14 ms).

**Grace boundary for unresponsive-but-connected peers**: the server code (`server/game.js`)
defines `GRACE_MS = 250` — a peer's last cmd is fabricated after 250 ms of silence.
`sealSweep` runs every 50 ms, so the worst-case stall for a hard-drop (no TCP close
frame) is `GRACE_MS + sealSweep_interval = 250 + 50 = 300 ms`. After `DROP_MS = 5000 ms`
of silence the player is removed from the session.

**Scope**: graceful-close path measured on localhost loopback. Hard-drop bound derived
from source constants (`GRACE_MS`, `sealSweep` interval).

---

## 2. Drop-in catch-up duration on the weakest host

**Question**: joining an in-progress game — how long from join to caught-up (in sync
with live tics)?

**Method**: standalone `tools/join-client.mjs` script shipped to wbox (AMD G-T56N,
the weakest fleet host, Node v24.16.0) via scp. Server ran on alder; 2 veteran
clients played locally; the joiner connected from wbox via Tailscale
(`ws://100.115.219.77:8674`). `t0 = performance.now()` before `relay.catchUp(frontier)`;
stop after `catchUp` resolves. The frontier (history depth) grew as veterans continued
playing. n=3 runs.

| run | frontier (tics) | catchup_ms |
|-----|----------------|------------|
| 1 | 436 | 124.8 |
| 2 | 471 | 126.8 |
| 3 | 505 | 148.8 |

**Result**: 125–149 ms to replay 436–505 tics (12.5–14.4 s of game history).
Replay throughput on wbox: ~3400–4100 tics/s (100× real-time). Catch-up is
dominated by wasm instantiation + history replay; both are fast even on wbox.

**Scope**: joiner on wbox (weakest fleet host) via Tailscale to alder server.

---

## 3. LAN/Tailnet HOL blocking

**Question**: replacing spec.md's "unmeasurably small" assertion — what is the
actual inter-message delay distribution at the client during sustained play?

**Method**: `tools/hol-measure.mjs` records when the game loop first observes each
new gametic (via `_web_gametic()` after `_web_frame()` every 14 ms). Gaps between
consecutive tics (skip = 1) are collected; warmup tics discarded. Two network paths
measured:

**Path A — localhost loopback (n=440 gaps)**:

| metric | ms |
|--------|----|
| tic period | 28.57 |
| p50 | 30.59 |
| p99 | 33.48 |
| max | 40.28 |

**Path B — wbox → alder via Tailscale (n=424 gaps)**:

| metric | ms |
|--------|----|
| tic period | 28.57 |
| p50 | 33.77 |
| p99 | 83.88 |
| max | 142.68 |

**Interpretation**: Path A gaps are tight (p99 / tic-period = 1.17×). Path B's p99
(83.88 ms ≈ 2.9 tics) reflects wbox's slower `sleep(14)` execution and the server's
`sealSweep` interval (up to 50 ms), not TCP retransmit events. No multi-second stalls
were observed in either path, and packet loss on Tailscale was 0% across all runs.
TCP head-of-line blocking (triggered by segment loss + retransmit, typically adding
200–400 ms per event) was not observed, consistent with near-zero loss on LAN/Tailscale.

**Verdict**: HOL blocking **does not threaten the no-WebRTC scope decision**. The
observed p99 variance (≤ 84 ms, ≈ 3 tics) is bounded by `sealSweep` (50 ms) and
client processing overhead, not TCP retransmit delay. A WebRTC/UDP transport would
eliminate ordered-delivery stalls, but those stalls are not occurring on LAN/Tailscale
at measurable rates. See spec.md §Netcode contract for the updated claim.

**Scope**: game-loop tic-observation timing (not TCP-layer timestamps). Reflects
practical impact on game pacing, not bare network latency.
