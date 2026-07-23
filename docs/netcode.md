# webdoom netcode

Deterministic lockstep over a server tic-relay. The 1993 insight is kept
(every client runs an identical simulation; only 8-byte inputs travel),
the 1993 transport is not.

## Topology

```
client A ──ws──┐
client B ──ws──┤  server relay: seals one bundle per tic
client C ──ws──┤  (also serves the app + WAD library on the same port)
client D ──ws──┘
```

- `/ws/lobby` — JSON control channel (roster, params, countdown, ping)
- `/ws/game?slot=N` — binary tic channel

WebSocket = TCP = ordered + reliable. Vanilla's retransmit/ack protocol
has no equivalent here because the transport already guarantees it. The
only latency concern is TCP head-of-line blocking, which is negligible
on LAN/tailnet.

## Wire format

Client → server, one message per built tic (12 bytes):

| bytes | field |
|-------|-------|
| 0–3   | `u32le` tic number |
| 4–11  | `ticcmd_t` (forwardmove, sidemove, angleturn, consistancy, chatchar, buttons) |

Server → client, one **sealed bundle** per tic (6 + 8n bytes):

| bytes | field |
|-------|-------|
| 0–3   | `u32le` tic number |
| 4     | ingame mask (bit N = slot N still playing) |
| 5     | fabricated mask (bit N = relay fabricated slot N's cmd) |
| 6…    | `ticcmd_t` × numplayers, slot order |

The server seals tic T the instant every live player's cmd for T has
arrived. Clients execute bundles and only bundles — their own local
cmds are never fed to the simulation in a net game, so all clients run
byte-identical input streams. Desync is impossible by construction;
the vanilla `consistancy[]` check stays enabled as insurance and the
harness (`tools/net-test.mjs`) compares full gamestate hashes per tic.

## Stall and drop handling

| condition | behavior |
|-----------|----------|
| cmd late > 250 ms | relay duplicates that player's last cmd and seals (fabricated bit set) |
| silent > 5 s | player dropped: ingame bit clears, their doomguy idles, everyone else keeps playing |
| never connected within 10 s of launch | treated as dropped |
| all players gone | session ends, lobby reopens |

Fabricated cmds carry a stale `consistancy` checksum, so clients skip
the consistency comparison for exactly those tics (the fabricated mask
says which). Every genuinely-transmitted cmd is still verified.

## Timing

- Game logic is locked at 35 Hz; clients self-pace off `performance.now()`.
- Input delay: `max(1, ceil(RTT/2 / 28.6ms))` tics, measured via lobby
  ping before launch. LAN ≈ 1 tic ≈ 28 ms.
- A hidden browser tab stops producing cmds (rAF pauses); the grace
  path carries that player (they stand still) until they return.
- Rendering is uncapped: view and sprites interpolate between the last
  two tics (`I_GetTimeFrac`), render-side only — the simulation the
  netcode checksums is untouched.

## Spectator protocol

A read-only observer connects to `/ws/spectate` (no slot parameter, no
auth). The endpoint is structurally receive-only: `spectateConnect` has
no `ws.on('message')` handler at all — zero ticcmd write code exists on
the path, so injection is impossible by construction, not by flag.

**Catch-up flow**

1. Client connects to `/ws/spectate`.
2. Server immediately streams the full `session.history` (every sealed
   bundle from tic 0 to the current frontier) as a burst of binary
   messages. Each message is a standard 6+8n-byte sealed bundle.
3. Server then forwards every subsequent `sealTic` bundle in real time.
4. Client replays the history burst with `web_replay_tic` (one call per
   bundle, unpaced) and enters live mode at the frontier, identical to
   the drop-in machinery (`attachRelay.catchUp`).

**Structural enforcement**

- Server: no `ws.on('message')` listener in `spectateConnect`.
- Client: `doom.netSend = () => {}` — ticcmds are built locally (engine
  normal path) but discarded before transmission.
- The spectator engine uses the first ingame slot as `consoleplayer` so
  the simulation is bit-identical to that player's engine (same mo
  pointer, same sound listener). Local ticcmds never reach `netcmds[]`
  in netgame mode; the sim reads only sealed bundles.

**Memory bound** (`session.history` is the sole log)

`session.history` already exists for drop-in catch-up. Spectators reuse
it — no parallel log. One entry per sealed tic:
`6 + 8 × 4 = 38 bytes/tic; 38 × 35 Hz ≈ 1.33 KB/s ≈ 4.8 MB/hr`.
Released when the session ends (`endSession` sets `session = null`).

Note: spectators bypass the consistancy ring check (`fabMask=0xFF` in
`attachSpectate.deliver()`), so a spectator-side state divergence — if a
future bug introduced one — would be silent: no error, no disconnect,
just an incorrect view. The per-tic `_web_state_hash` equality test
(`spectate-test.mjs`) is therefore the primary correctness gate for the
spectator path. Player engines are unaffected; they keep the full check.

## Lobby protocol (JSON)

```
→ (connect)                    ← {t:'welcome', slot, color}
                               ← {t:'roster', players:[{slot,color,name}],
                                              freeSlots, params, inGame}
→ {t:'name', name}             (custom name; default is the color name)
→ {t:'slot', slot}             (pick a free color — color IS slot)
→ {t:'params', params:{wad, episode, map, skill, mode}}
→ {t:'start'}                  ← {t:'countdown', n:3..1}
                               ← {t:'launch', params, numplayers:4, slots, names}
→ {t:'ping', t0}               ← {t:'pong', t0}
```

Slots are assigned in join order: 0 Green, 1 Indigo, 2 Brown, 3 Red —
DOOM's native player color translations. Names default to the color;
both are optional to touch. Because a chosen color = a chosen slot,
occupied slots may be sparse: sessions are always 4 wide, phantom slots
ride along not-ingame from tic 0, and the engine's playeringame mask
mirrors the launch slots. Custom names reach in-game chat prefixes.
