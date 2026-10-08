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
| `/ws/game?slot=N&token=T` | binary tic channel for the player in slot N |
| `/ws/spectate` | binary, receive-only: the history, then live bundles |

A seat is bound to the lobby socket it was given to. At launch, and on a
drop-in reservation, the server sends each seat's random token only in that
seat's own `launch` frame, and `/ws/game` binds a slot only with its current
token. The token dies when the relay socket holding the slot closes, so a
player who drops comes back through the lobby's drop-in.

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

A page whose game loop stops (a frozen page, or a hidden one where no Worker
can be made; see [A hidden tab](#a-hidden-tab)) stops the simulation, but the
socket keeps delivering. So bundles wait in a queue in `net.js` and reach the
engine in tic order, no faster than its ring can hold them:

- `accept` drops a bundle of the wrong length, a tic at or past `0x7FFFFFFF`,
  or a repeat. A gap (a tic later than the next expected one) ends the session:
  the relay sends every tic once and in order, so a gap cannot be recovered.
- The queue holds at most 1,050 tics (30 s). Past that the session ends with
  "fell too far behind the game".
- `offer()` hands the engine every queued bundle its ring has room for. It runs
  on every arriving message and, from `main.js`, before every frame and every
  tick of the hidden-page clock, so a backlog drains as the sim catches up. A
  `0` from the engine leaves the bundle queued; a `-1` ends the session.

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
  more than a second without frames (a frozen page) it resumes instead of
  fast-forwarding, and it builds from the tic the sim is on rather than for
  tics the relay sealed without this client.
- **Rendering.** Frames are uncapped. The view and sprites interpolate between
  the last two tics (`I_GetTimeFrac`), clamped so a stalled sim holds still.
  This is render-side only; the simulation is untouched.

## Stalls, drops and the end of a session

On the relay, a sweep runs every 50 ms, each time just after the relay has
read every frame that arrived. It keeps two times per player: `lastHeard`,
when any well-formed frame last came from it, and `lastSeen`, when it last
filled the tic the relay is waiting on (the seal tic) or had a tic sealed
with its own cmd.

| condition | what the relay does |
|---|---|
| a live player has sent nothing for 250 ms, and through five sweeps since in each of which another live player was heard: it is *silent* | stops waiting for it: each tic the others fill is sealed at their own 35 tics/s, with its last cmd repeated and its fabricated bit set, until its next frame |
| every live player is quiet at once, or the player owing the seal tic is still heard but has filled nothing for 250 ms | repeats the missing cmds, sets their fabricated bits, and seals one tic per sweep |
| a player has not filled the seal tic for 5 s | drops the player: its ingame bit clears, everyone else plays on, and its socket is closed with code 4000 and "dropped by the server: no input from this player for 5 seconds" |
| a launched player never connects within 10 s | drops that slot |
| any live player has not sent a cmd yet, within 10 s of launch | fabricates nothing (wasm boot times differ) |
| every player is gone | ends the session and reopens the lobby |

A repeated cmd carries none of its one-tic events: its chat character is 0,
and its buttons are 0 when `BT_SPECIAL` makes them a pause or a savegame,
which repeated would toggle the pause, or save, on every fabricated tic. The
sweep never fabricates while any player missing the seal tic has filled one
within the 250 ms: that player's next cmd is in flight.

Silence is measured from `lastHeard`. A player that comes back holds the seal
again with its first frame, even though its first cmds are for tics already
sealed without it and are discarded. Measured from `lastSeen`, it would never
fill a tic, would stay silent, and would be dropped while sending: `net-hidden`
reads exactly that when the rule is changed. Progress is measured from
`lastSeen`: only cmds that fill the seal tic count, so a peer sending other
tics cannot keep itself inside the drop window (`net-fuzz`). A tic sealed with
a player's own cmd counts too: when a seat that never connected held the seal
for 10 s, the others waited with their lead sent, and the first sweep after
the release found them 10 s stale and dropped every one whose reply took
longer than that sweep (50 ms) to arrive. That was true at 7349c27 as well;
`net-fuzz` checks it with players 150 ms away.

Silence is counted only in sweeps in which someone else was heard since the
sweep before. When everyone goes quiet at once (the opening melt, a stall of
the relay, of its link or of a host running several clients), their frames
come back as bursts, read one socket at a time. Judged by the clock alone, the
second player would look silent while its burst was still unread, and the
first player's whole burst would be sealed with the second fabricated: 13–14
tics for one player with the relay stopped for 400 ms (`net-fuzz` checks a
relay stall and a quiet of both players). Counted this way the rule also
works on a loaded host, whose sweeps come late but still come; an earlier
form that skipped every sweep more than 100 ms late, and required someone to
have been heard in the last 100 ms, switched itself off there.

On the client, the session ends and the player returns to the launcher with a
reason on the status line whenever the game socket closes or errors, the relay
skips a tic, the backlog overflows, or the engine refuses a tic as invalid.
The reason is the socket's close reason when the server gave one, otherwise
"the connection to the game server was lost". Quitting from the game menu
closes the socket deliberately and shows no reason. `net-hidden` checks both
sides of the 5 s line with Node clients: one silent for 3 s stays in the game
and catches up while the other plays on at 35 tics/s, and one silent for 7 s
is dropped and told why. `browser-net-hidden` does the same in real tabs for a
page frozen for 7 s.

## A hidden tab

A hidden page gets no `requestAnimationFrame`, which is what drives the game
in `main.js`. In single player that is a pause. A netplay page, a spectator's
included, switches to a clock instead. On `visibilitychange` to hidden it
creates an inline blob Worker that posts every 28 ms; once the Worker exists
it cancels the pending frame, releases held keys, mouse buttons and the pad's
sticks (`input.release()`), and turns the engine's drawing off
(`_web_set_nodraw(1)`). Each message runs `relay.offer()` and `_web_frame()`,
and the engine's own pacing runs one tic of the 35 Hz game per step. Visible
again, the Worker is terminated, drawing comes back on, and the frame loop
resumes.

- One driver runs at a time.
- A session booted while hidden starts on the clock.
- The session's teardown removes the listener and the Worker, and a throw on
  the clock ends the session like a throw in a frame.
- Where no Worker can be made, the page freezes while hidden, as before.

The clock is a dedicated Worker because Chrome throttles a hidden page's own
timers and, by its documentation, not a Worker's; what is measured is that
the Worker's messages reached the hidden page on time. Measured in
headless Chrome on alder (`browser-net-hidden`, five runs, 2026-10-08), the
hidden player ran at 34.9–35.1 tics/s for 12 s and was fabricated on 0 of
420–421 bundles; its 428–429 steps came at p50 28.0 ms, p99 29.9–31.1 ms and
max 30.0–31.8 ms apart.

Accepted, not solved:

- A tab that comes back after the game state changed while it was hidden (a
  level ended) melts from the last picture it drew, with its sim paused,
  which the relay handles as a short silence. (The opening melt held gametic
  0 for 1.0–1.2 s in the Node harness.)
- The reverse, inferred from the rule and not measured: while one player is
  hidden it does not melt at a level change, so the visible players' melts
  are silences, and the hidden player plays on while their last cmds repeat.
- Sound is left alone: the engine goes on starting sound effects on the
  clock, and whether they are heard while hidden is up to the browser and
  `audio.js`'s pump, a page timer (not measured).

Risks left open:

- A frozen page has less time to come back. The relay now seals the tics it
  missed at 35 tics/s instead of 20, so there are more to catch up. Node
  clients on alder loopback (2026-10-08, one run per length) survived 3.5 s
  of silence and were dropped at 3.75 s, against 4.0 s and 4.25 s before.
  Catching up after 3 s took 0.81–0.95 s (nine runs) instead of 0.24–0.28 s
  (four), while the others ran at the sweep's pace.
- A page hidden for more than 5 minutes, Chrome's Energy Saver freezing a
  page, Firefox and mobile browsers are not measured. Each one that stops the
  clock still ends in the drop, with its reason.

## Drop-in

A player can join a game that is already running.

1. A newcomer on `/ws/lobby` gets `inprogress` (params, frontier, who is
   playing, free slots) instead of a seat. `join` reserves a free slot; the
   reservation lapses after 30 s if the joiner never goes live.
2. The server answers `welcome` and a `launch` with `join: true` and the
   current frontier, carrying the reservation's token. The client boots and
   connects to `/ws/game?slot=N&token=T`. A reservation that lapsed still
   binds with its token until another newcomer reserves the slot.
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
                            ← {t:'launch', params, numplayers:4, slots, names, token}
→ {t:'ping', t0}            ← {t:'pong', t0}
                            ← {t:'full', reason}
while a game is live:
→ (connect)                 ← {t:'inprogress', params, frontier, players:[{slot,color,name,live}], freeSlots}
→ {t:'join', slot, name}    ← {t:'welcome', …}, {t:'launch', …, join:true, frontier, token}
```

Slots are taken in join order: 0 Green, 1 Indigo, 2 Brown, 3 Red, which are
DOOM's own player colour translations. Choosing a colour chooses a slot, so
occupied slots can be sparse; phantom slots ride along not-ingame from tic 0.
The server clamps every param to a value the engine accepts, and the client
refuses a `launch` whose params or player count it could not have produced
(`launch-args`, `hostile-lobby`).

## Measured

These are the figures behind keeping TCP, and behind the stall rules above.
The tic-arrival gaps were taken with a Node wasm client that polled
`_web_gametic()` after every `_web_frame()` on a 14 ms loop, so they are
tic-arrival times as the game loop sees them, not TCP timestamps; each other
figure names how it was taken.

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
| survivors' stall after a peer goes silent without closing | about 250–300 ms (five sweeps, the last at least 250 ms after its last frame), then 35 tics/s | derived from `server/game.js` |
| survivors' tic rate while a peer is silent for 3 s, from 0.5 s in | 34.7–35.7 tics/s (6 runs); 19.4–20.0 (3 runs) before a silent peer stopped holding the seal | Node clients, alder loopback, 2026-10-08 (`net-hidden`) |
| a hidden netplay tab on the Worker clock, 12 s | 34.9–35.1 tics/s; steps p50 28.0 ms, p99 29.9–31.1 ms, max 30.0–31.8 ms apart (n = 428–429); fabricated on 0 of 420–421 bundles (5 runs) | headless Chrome on alder, 2026-10-08 (`browser-net-hidden`) |
| fabrication after the relay process is stopped for 400 ms | 0 in 4 runs with the sweep after the relay's reads; 1 tic, once for one player only, in 3 of 4 with the sweep straight from its timer (and at 7349c27, 1 each); 13–14 for one player when silence was judged by the clock alone | alder loopback, SIGSTOP, 2026-10-08 |
| drop-in replay of 436–505 tics | 125–149 ms, about 100× real time (n = 3) | joiner on wbox, server on alder, 2026-07-19 |
| history memory at the 63,000-tic cap | 8.1 MB RSS in slabs, against 28.8 MB as one Buffer per tic | Node, after GC, 2026-09-16 |

The 2026-09-17 loopback run sits 0.1 ms above the tic period at p50, so the
remaining short-lived allocations in `sealTic` and `seal` are left alone: no
instrument here could show what removing them returns, and the lockstep path is
where an unmeasured change becomes a desync.

## Tests

`net-2p` and `net-4p` compare per-tic state hashes between real wasm clients
through the relay; `join-coop`, `join-dm` and `edge` do the same for drop-in;
`spectate`, `spectate-inject` and `spectate-fuzz` cover spectators; `churn`
covers connections that come and go; `net-hidden` and `browser-net-hidden`
cover a player whose page is hidden or stops; `net-fuzz`, `hostile-server`,
`hostile-lobby` and `launch-args` send hostile frames both ways;
`wire-constants` checks that the two sides agree on shared constants; and
`browser-net` and `browser-join` run the same flows in real tabs.
`bash tools/run-tests.sh --list` shows them all.
