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
