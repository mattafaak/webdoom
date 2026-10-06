# webdoom netcode

Multiplayer is deterministic lockstep over a server tic relay. Every client
runs the same simulation from the same inputs, and only 8-byte ticcmds travel.
That idea is id's; the transport is not. Vanilla's peer-to-peer packet driver
is replaced by one Node relay that the clients reach over WebSocket.

The code is short and is the authority when this page disagrees with it:
[../server/game.js](../server/game.js) (lobby and relay),
[../client/js/net.js](../client/js/net.js) (client side), and
[../engine/web/d_net.c](../engine/web/d_net.c) (the engine's `d_net`
replacement). The lobby screens that drive it are in
[state-machine.md](state-machine.md); words like *tic*, *ticcmd* and
*consistancy* are in [glossary.md](glossary.md).

## Topology

Up to four players connect to one relay, which also serves the app and the
WAD library on the same port:

| endpoint | carries |
|---|---|
| `/ws/lobby` | JSON control: roster, params, countdown, launch, ping, drop-in requests |
| `/ws/game?slot=N` | binary tic channel for the player in slot N |
| `/ws/spectate` | binary, receive-only: the history, then live bundles |

WebSocket runs over TCP, so delivery is ordered and reliable and there is no
resend protocol. The cost is head-of-line blocking after a lost segment; the
measured section below is why that is accepted rather than replaced with
WebRTC. The server turns Nagle off on every upgraded socket and disables
per-message compression.

## Wire format

Client to server, one message per built tic, 12 bytes:

| bytes | field |
|---|---|
| 0–3 | `u32le` tic |
| 4–11 | `ticcmd_t`: forwardmove, sidemove, angleturn, consistancy, chatchar, buttons |

Server to client, one sealed bundle per tic, `6 + 8 × numplayers` bytes.
Sessions are always four slots wide, so a bundle is 38 bytes:

| bytes | field |
|---|---|
| 0–3 | `u32le` tic |
| 4 | ingame mask: bit N set means slot N is playing this tic |
| 5 | fabricated mask: bit N set means the relay supplied slot N's cmd |
| 6… | `ticcmd_t` × 4, in slot order |

The relay ignores a client tic that is already sealed or more than 512 tics
ahead of the seal point.

## Lockstep

The relay seals tic T the moment every live player's cmd for T has arrived,
then sends the bundle to every player and spectator. In a net game a client's
own cmds are never fed to its simulation: the engine runs bundles and only
bundles, so every client runs a byte-identical input stream.

On the engine side, `netcmds[][]` is a ring of `BACKUPTICS` = 35 tics.
`web_net_bundle` stores one sealed tic and returns `1`. It returns `0`, "no
room, offer it again later", for a tic 35 or more ahead of the sim, and `-1`
for a tic that can never be valid (negative, at or past `0x7FFFFFFF`, or
already run).

The ingame mask is stored per tic and applied when the simulation reaches that
tic (`apply_roster`), not when the bundle arrives. Bundles arrive ahead of the
sim at moments that differ per client, so applying a join or leave on arrival
would desync.

Vanilla's `consistancy[]` check stays on as insurance. It skips the cmds the
relay fabricated (their checksum is stale) and a dropped-in slot's first 35
tics (its ring entries predate it). Every other cmd is still verified, and a
mismatch is an `I_Error`. The `net-2p` and `net-4p` legs go further and compare
full gamestate hashes on every common tic between real wasm clients.

## The client's bundle queue

A hidden tab stops `requestAnimationFrame`, and with it the simulation, but the
socket keeps delivering. So bundles wait in a queue in `net.js` and reach the
engine in tic order, no faster than its ring can hold them:

- `accept` drops a bundle of the wrong length, a tic at or past `0x7FFFFFFF`,
  or a repeat. A gap (a tic later than the next expected one) ends the session:
  the relay sends every tic once and in order, so a gap cannot be recovered.
- The queue holds at most 1,050 tics (30 s). Past that the session ends with
  "fell too far behind the game".
- `offer()` hands the engine every queued bundle its ring has room for. It runs
  on every arriving message and, from `main.js`, before every frame, so a
  backlog drains as the sim catches up. A `0` from the engine leaves the bundle
  queued; a `-1` ends the session.

## Jitter buffer and pacing

Logic runs at 35 Hz (one tic is 28.6 ms). The client does not run straight to
the sealed frontier; it aims a few tics behind it and advances at wall-clock
rate, so uneven arrival reads as a buffer breathing in and out rather than as
stalls followed by jumps.

- **Depth.** Between `launch` and boot the client sends 12 lobby pings. Jitter
  is the 75th-percentile round trip minus the fastest; an unanswered ping (3 s
  timeout) counts as 50 ms. Depth is `ceil(jitter / 28.6) + 1`, clamped to
  2–4 tics. It is sized to jitter, not to mean latency, because lockstep
  already pays the mean once: a cmd must round-trip before it applies. The
  engine clamps any requested depth to 1–16. Spectators use 2.
- **Pacing.** `TryRunTics` targets `frontier − depth` and runs at most one tic
  per tic of wall clock, never past a sealed tic. If a stall lets the margin
  grow past twice the depth, it runs one extra tic per frame until the margin
  is back, so input lag cannot creep up on a bad link.
- **Building cmds.** `NetUpdate` builds at most 16 tics ahead of the sim. After
  more than a second without frames (a hidden tab) it resumes instead of
  fast-forwarding, and it builds from the tic the sim is on rather than for
  tics the relay sealed without this client.
- **Rendering.** Frames are uncapped. The view and sprites interpolate between
  the last two tics (`I_GetTimeFrac`), clamped so a stalled sim holds still.
  This is render-side only; the simulation is untouched.

## Stalls, drops and the end of a session

On the relay, a sweep runs every 50 ms:

| condition | what the relay does |
|---|---|
| a live player's cmd for the seal tic is more than 250 ms late | repeats that player's last cmd, sets its fabricated bit, and seals |
| a player has not filled the seal tic for 5 s | drops the player: ingame bit clears, everyone else plays on |
| a launched player never connects within 10 s | drops that slot |
| any live player has not sent a cmd yet, within 10 s of launch | fabricates nothing (wasm boot times differ) |
| every player is gone | ends the session and reopens the lobby |

Only cmds that fill the tic the relay is waiting on count as progress. A peer
sending other tics cannot keep itself inside the grace window.

On the client, the session ends and the player returns to the launcher with a
reason on the status line whenever the game socket closes or errors, the relay
skips a tic, the backlog overflows, or the engine refuses a tic as invalid.
The reason is the socket's close reason when the server gave one, otherwise
"the connection to the game server was lost". Quitting from the game menu
closes the socket deliberately and shows no reason. The `net-hidden` leg checks
both sides of the 5 s line: a tab hidden for 3 s stays in the game and catches
up, and one hidden for 7 s is dropped and told so.

## Drop-in

A player can join a game that is already running.

1. A newcomer on `/ws/lobby` gets `inprogress` (params, frontier, who is
   playing, free slots) instead of a seat. `join` reserves a free slot; the
   reservation lapses after 30 s if the joiner never goes live.
2. The server answers `welcome` and a `launch` with `join: true` and the
   current frontier. The client boots and connects to `/ws/game?slot=N`.
3. The relay streams the whole sealed history, then live bundles. The client
   replays it unpaced, one `web_replay_tic` per bundle, yielding every 512
   tics to let more arrive and driving the loading bar. If no tic advances
   for 15 s, the join fails.
4. At the frontier, `web_end_catchup` moves cmd building to the current tic,
   and the client starts sending. Its first cmd tells the relay it has caught
   up; the relay schedules it live 12 tics later.
5. On that sealed tic the ingame bit flips for every client at once. The
   engine marks the slot `PST_REBORN`, so `G_Ticker` spawns it (a co-op start,
   or a `P_Random` deathmatch spot) identically everywhere, and the joiner's
   view snaps back to its own slot.

The replay rebuilds the exact world by construction; `join-coop`, `join-dm`
and `edge` check it by state hash.

## Spectators

`/ws/spectate` needs no slot and no credential, and is receive-only by
structure: the server registers no message handler on it, and the client sets
`netSend` to a no-op. Up to 8 spectators may watch a session.

A spectator catches up exactly as a drop-in does, then watches live. Its
engine runs as the first ingame slot, so the simulation matches that player's
(same `mo`, same sound listener); after catch-up the view parks on the first
live player. Spectators mark every slot fabricated (`0xFF`), which turns the
consistancy check off for them, so a spectator-side divergence would be silent.
The `spectate` leg's per-tic state-hash comparison is therefore the
correctness check for this path; `spectate-inject` and `spectate-fuzz` cover
injection and hostile clients.

## The history and the server's limits

Drop-in and spectating replay the sealed history from tic 0, so it cannot be a
ring: a joiner handed only the tail would desync with nothing to notice. It is
kept in 1,024-tic slabs and stops growing at a cap. Past the cap both features
refuse by name and live play continues.

| limit | default | env var |
|---|---|---|
| history | 63,000 tics (30 min) | `WEBDOOM_MAX_HISTORY_TICS` |
| open sockets, all endpoints | 50 | `WEBDOOM_MAX_CONNS` |
| spectators per session | 8 | `WEBDOOM_MAX_SPECTATORS` |
| bytes queued to a peer that is not reading | 4 MiB, then dropped | `WEBDOOM_SEND_BACKLOG` |
| messages and pings per socket per second | 300 | `WEBDOOM_RATE_CAP` |
| drop-in reservation | 30 s | `WEBDOOM_JOIN_TIMEOUT` (ms) |
| frame size | lobby 1,024 B; game and spectate 64 B | — |

Lobby fields are treated as hostile JSON: names are cleaned to 10 characters
of `[A-Za-z0-9 _-]`, and a WAD not in the server's library is refused.

## Lobby protocol

```
→ (connect)                 ← {t:'welcome', slot, color}
                            ← {t:'roster', players:[{slot,color,name}], freeSlots, params, inGame}
→ {t:'name', name}          (default name is the colour)
→ {t:'slot', slot}          (pick a free colour: colour is slot)
→ {t:'params', params}      (wad, episode, map, skill, mode, nomonsters, fast, respawn, timer)
→ {t:'start'}               ← {t:'countdown', n:3..1}
                            ← {t:'launch', params, numplayers:4, slots, names}
→ {t:'ping', t0}            ← {t:'pong', t0}
                            ← {t:'full', reason}
while a game is live:
→ (connect)                 ← {t:'inprogress', params, frontier, players:[{slot,color,name,live}], freeSlots}
→ {t:'join', slot, name}    ← {t:'welcome', …}, {t:'launch', …, join:true, frontier}
```

Slots are taken in join order: 0 Green, 1 Indigo, 2 Brown, 3 Red, which are
DOOM's own player colour translations. Choosing a colour chooses a slot, so
occupied slots can be sparse; phantom slots ride along not-ingame from tic 0.
The server clamps every param to a value the engine accepts, and the client
refuses a `launch` whose params or player count it could not have produced
(`launch-args`, `hostile-lobby`).

## Measured

These are the figures behind keeping TCP. Each was taken with a Node wasm
client that polled `_web_gametic()` after every `_web_frame()` on a 14 ms loop,
so they are tic-arrival times as the game loop sees them, not TCP timestamps.

**Tic arrival gaps, 2026-07-19, server on alder:**

| path | gaps | p50 | p99 | max |
|---|---|---|---|---|
| loopback on alder | 440 | 30.6 ms | 33.5 ms | 40.3 ms |
| wbox → alder over Tailscale | 424 | 33.8 ms | 83.9 ms | 142.7 ms |

The tailnet p99 is about three tics. It comes from the relay's 50 ms sweep and
wbox's slow poll loop, not from retransmission: loss on the path was 0%, and no
multi-second stall was seen. A UDP transport would remove ordered-delivery
stalls that are not occurring at a measurable rate, so WebRTC stays out of
scope.

**Other figures:**

| what | result | host, date |
|---|---|---|
| tic-arrival gaps on loopback after the history moved to slabs | p50 28.68 ms, p99 29.08 ms, max 41.96 ms (n = 441) | alder, 2026-09-17 |
| survivors' stall after a peer closes its socket | mean 26 ms, max 33 ms (n = 5, 2 players) | alder loopback, 2026-07-19 |
| survivors' stall after a peer goes silent without closing | at most 300 ms: the 250 ms grace plus one 50 ms sweep | derived from `server/game.js` |
| drop-in replay of 436–505 tics | 125–149 ms, about 100× real time (n = 3) | joiner on wbox, server on alder, 2026-07-19 |
| history memory at the 63,000-tic cap | 8.1 MB RSS in slabs, against 28.8 MB as one Buffer per tic | Node, after GC, 2026-09-16 |

The 2026-09-17 loopback run sits 0.1 ms above the tic period at p50, so the
remaining short-lived allocations in `sealTic` and `seal` are left alone: no
instrument here could show what removing them returns, and the lockstep path is
where an unmeasured change becomes a desync.

## Tests

`net-2p` and `net-4p` compare per-tic state hashes between real wasm clients
through the relay; `join-coop`, `join-dm` and `edge` do the same for drop-in;
`spectate`, `spectate-inject` and `spectate-fuzz` cover spectators; `churn` and
`net-hidden` cover connections that come and go; `net-fuzz`, `hostile-server`,
`hostile-lobby` and `launch-args` send hostile frames both ways;
`wire-constants` checks that the two sides agree on shared constants; and
`browser-net` and `browser-join` run the same flows in real tabs.
`bash tools/run-tests.sh --list` shows them all.
