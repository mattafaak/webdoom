# Web Scrutiny Ledger — 12.4a

READ-ONLY findings pass. Fixes belong to 12.4b (robustness/sw) and 15.3 (per-frame catch-all).
Tenets cited: T3 = simplicity, T4 = robustness.

---

## Findings

### ws-001 — main.js : frame() — per-frame catch-all swallows every exception (frozen canvas)

**File/function**: `client/js/main.js`, `frame()` (line 166–169)

**What**: The rAF loop wraps `input.frame()` and `doom._web_frame()` in a bare `catch { running = false; return; }` with no logging, no user-visible message, and no page restore. Any JS exception during a frame — including a legitimate coding error, a WebGL failure, a gamepad TypeError — silently halts the loop and leaves the user on a frozen, unresponsive canvas with no indication of what went wrong and no way back to the launcher without a page reload.

**Why it matters** (T4): unhandled runtime errors produce a wedge UI that looks like a hang. The user has no recovery path. The panel identified this as a 15.3 fix because the correct behaviour requires surfacing the error and calling `restoreOnFailure()` + `status()`, matching the `onDoomError` pattern.

**Severity**: high

**Disposition**: `fixed(15.3)` — catch block now surfaces error via `restoreOnFailure(canvas)` + `status(engine error: …)` + audio/sync teardown, mirroring the `onDoomError` pattern; idempotency guard on `running` prevents double-restore when I_Error/abort also fires; verified by `tools/browser-rafdeath-test.mjs` (RED on unfixed, GREEN on fixed)

---

### ws-002 — main.js / audio.js : onDoomError wedge — ALREADY FIXED (12.3, commit a606528)

**File/function**: `client/js/main.js`, `onDoomError` callback (line 99–104) and `doom.onQuit` (line 155–162)

**What**: Prior to 12.3, `onDoomError` did not restore the landing page, leaving a wedge UI. Commit a606528 added `running = false`, `restoreOnFailure(canvas)`, `status(...)`, and `window.doomAudio?.stop?.()`.

**Completeness check** (performed here):
- `onDoomError` path (line 99–104): `running = false` ✓ · `restoreOnFailure(canvas)` ✓ · `status()` ✓ · `doomAudio.stop()` ✓
- `onQuit` path (line 155–162): `running = false` ✓ · canvas hidden + landing restored ✓ · `doomAudio.stop()` ✓ · `onQuit?.()` (lobby's `returnToMenu`) ✓
- `returnToMenu()` in lobby.js (line 70–79): resets `booted`, closes lobby WS, resumes fire, shows menu ✓

Both paths share teardown symmetry. No gap found.

**Severity**: n/a

**Disposition**: `already-fixed(12.3, commit a606528)`

---

### ws-003 — sw.js : SHELL precache omits fire.js and countdown.js

**File/function**: `client/sw.js`, `install` event handler (lines 7–15)

**What**: The precache list in the `install` handler is:

```
'/', '/css/webdoom.css',
'/js/lobby.js', '/js/main.js', '/js/video.js', '/js/input.js',
'/js/audio.js', '/js/settings.js', '/js/net.js', '/js/music-worklet.js',
'/js/menu.js', '/js/doomfont.js', '/js/persist.js',
'/engine/doom.js', '/engine/doom.wasm'
```

`lobby.js` imports (line 7–13):

| import | in SHELL precache? |
|--------|--------------------|
| `./main.js` | YES |
| `./net.js` | YES |
| `./doomfont.js` | YES |
| `./menu.js` | YES |
| `./countdown.js` | **NO** |
| `./fire.js` | **NO** |

`fire.js` and `countdown.js` are missing. The service worker's `install` calls `c.addAll()` and then `skipWaiting()` only after all URLs resolve. If `fire.js` or `countdown.js` fail to fetch at install time (network loss), the new SW install fails silently (the old SW remains active). For offline SP gameplay, both files must be in the cache, but since they are not precached they rely entirely on the network-first runtime cache (the general shell fetch handler). If the user has never visited the page while online after a new SW version ships, or if runtime-cache filling raced, offline launch fails.

**Why it matters** (T4, rme-005): README promises "single player works offline". This is the known latent bug identified in promises-index.md as FLAGGED for 12.4b/15.1.

**Full import graph verification**: All other ES module imports from `lobby.js` and `main.js` are present in the precache. `music-worklet.js` is loaded via `ctx.audioWorklet.addModule()` (not ES import) and IS precached. Dynamic `import('/engine/doom.js')` IS precached. `/css/webdoom.css` and `/` (index.html) are precached. Only `fire.js` and `countdown.js` are missing.

**Severity**: high

**Disposition**: `fixed(12.4b, this commit)` — added `/js/fire.js` and `/js/countdown.js` to the `c.addAll([...])` list; build-time drift check in `tools/check-sw-precache.mjs`

---

### ws-004 — sw.js : skipWaiting() + clients.claim() mid-game shell swap semantics

**File/function**: `client/sw.js`, `install` handler (line 14) and `activate` handler (lines 17–23)

**What**: The SW calls `self.skipWaiting()` after install completes and `self.clients.claim()` during activate. This means a new SW version activates immediately without waiting for all existing tabs to close. During activation, old `webdoom-shell-*` caches are deleted (lines 19–21), including any cache the currently-running tab was served from.

**Consequences for a running client**:
1. `controllerchange` fires → `lobby.js` reveals `#sw-update` banner (line 427–431) ✓ — deliberate design.
2. Old shell cache is deleted. Any future network request that misses the network and falls back to cache would find no old shell entries. During an active game, JS is already in memory and no further JS module fetches occur, so this is not observable in practice.
3. The new shell IS fully populated before `skipWaiting()` fires (because `skipWaiting` is chained after `c.addAll()` resolves), so the new SW immediately serves the complete new shell.
4. WADs are in the separate `webdoom-wads-v1` cache (different name, never deleted), so WAD serving is unaffected.

**Paper risk**: if a long-running game fetched something from the old shell after it was evicted (not observed in code review — all JS is in-memory post-boot) it would need to fall back to the network. Low practical impact.

**Mitigation in place**: `controllerchange` banner is non-intrusive and never interrupts an active match. The design is deliberate.

**Why it matters** (T4): subtle SW lifecycle semantics; no current user-visible regression.

**Severity**: med

**Disposition**: `won't-fix(mitigated-by-design-controllerchange-banner-and-in-memory-js)` — the banner satisfies the UX contract; shell deletion during a live game has no observable effect

---

### ws-005 — serve.js : static HTTP path traversal guard (no bypass found on paper)

**File/function**: `server/serve.js`, `createServer` handler (lines 38–71)

**What**: The guard is:

```js
const url = new URL(req.url, 'http://x');
let path = normalize(url.pathname);
if (path.includes('..')) return send(res, 400, 'bad path');
```

**On-paper bypass analysis** (required by scope):

| Attack vector | Analysis | Result |
|--------------|----------|--------|
| Encoded traversal (`%2e%2e`, `%2F`) | `new URL(...).pathname` percent-decodes. `normalize('/../etc/passwd')` → `'/../etc/passwd'`. `path.includes('..')` → TRUE → 400 | Blocked |
| Double-slash (`//etc/passwd`) | `new URL('http://x//etc/passwd').pathname` = `//etc/passwd`. `normalize('//etc/passwd')` on Node.js POSIX preserves leading `//` but contains no `..`. Enters MOUNTS loop: `startsWith('/')` matches. `path.slice('/'.length)` = `/etc/passwd`. `path.join(clientDir, '/etc/passwd')` = `clientDir + '/etc/passwd'` (Node.js `join` never resets to root for an intermediate absolute segment). Result is under the server root. | Safe |
| Backslash (`%5c`) | Linux treats `\` as a filename character; `path.normalize` on POSIX does not interpret it as a separator. No traversal path. | Safe |
| `/../` after normalize | `normalize('/a/b/../../..')` → `'/..'`. `path.includes('..')` → TRUE → 400 | Blocked |
| Null byte | `new URL` rejects URLs with null bytes (throws). Handler does not catch this; HTTP server's `http.IncomingMessage` trims at null byte. Effectively safe. | Safe |
| Symlink escape | If a symlink inside a mount dir points outside, `statSync(file)` follows it and `isFile()` passes. This is a deployment concern, not a code vulnerability. | Environmental |

No bypass found. Guard is sound for the stated threat model (LAN server, no internet exposure).

**Additional note**: No HTTP security headers (CSP, X-Content-Type-Options, etc.) are set. Acceptable for a LAN-only game server.

**Severity**: low

**Disposition**: `won't-fix(no-bypass-found-on-paper-lan-only-threat-model)` — fuzz coverage added by 12.4b is additive

---

### ws-006 — game.js / main.js : G_DoReborn → P_SpawnPlayer with zeroed mapthing on drop-in

**File/function**: `server/game.js`, drop-in join logic; `client/js/main.js`, join path

**What**: When a player drops into a running game, the server sets `p.joinAt = session.tic + JOIN_MARGIN` (game.js line 294). At that tic the ingame bit for the slot is set in the sealed bundle. The engine's lockstep then calls `G_DoReborn` → `P_SpawnPlayer` for that slot. If the current map lacks a player start for that slot (mapthing type 1–4 for players 1–4), `P_SpawnPlayer` is called with a zeroed mapthing: type 0 → playernum resolves to -1 → OOB read in `playeringame[]`.

**Reachability analysis**:
- All standard IWADs (doom.wad, doom2.wad, tnt.wad, plutonia.wad, chex.wad, hacx.wad) include 4 player start spots on all their maps.
- The server controls the WAD library; clients cannot upload WADs. The `wad` param is validated to a sanitized filename (line 178: `String(p.wad).replace(/[^a-z0-9_.-]/g, '')`), and only files present in `wads/lib/` are served.
- Drop-in is only possible via a running netgame on a server-chosen map; the lobby host picks the WAD from the server's manifest.
- With any standard IWAD from the server's library: **unreachable**.
- With a custom WAD that a server operator installs lacking player starts: theoretically reachable, but this is operator-controlled deployment configuration.

**Severity**: low

**Disposition**: `won't-fix(unreachable-with-valid-wads-server-controls-wad-library)` — if server gains user-uploaded WAD support, revisit

---

### ws-007 — audio.js : visibilitychange listener leak across quit/reboot cycles

**File/function**: `client/js/audio.js`, `createAudio()` (line 43–46) and `stop()` (lines 112–118)

**What**: `createAudio` adds:

```js
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && ctx && ctx.state === 'suspended')
        ctx.resume().catch(() => {});
});
```

`stop()` removes the three `keydown/mousedown/touchstart` event listeners (lines 113–115) but does NOT remove the `visibilitychange` listener. Each boot/quit cycle (`bootDoom` → quit → `bootDoom` again) adds one more `visibilitychange` listener. After N cycles, N listeners fire on every tab reveal.

**Impact**: Stale listeners harmlessly guard on `ctx && ctx.state` — the old `ctx` is set to `null` in `stop()` (line 118), so stale callbacks short-circuit. No observable bug, but listeners accumulate in memory.

**Why it matters** (T4): listener leak pattern; also a T3 signal (asymmetric add/remove).

**Severity**: low

**Disposition**: `fixed(12.4b, this commit)` — captured listener as named `onVisible` ref; `document.removeEventListener('visibilitychange', onVisible)` added to `stop()`

---

### ws-008 — persist.js : sync interval and visibilitychange listener leak; old doom poked after quit

**File/function**: `client/js/persist.js`, `startSync()` (lines 51–87); `client/js/main.js` line 137

**What**: `startSync(doom, iwad)` starts a `setInterval(sync, 3000)` and adds `document.addEventListener('visibilitychange', ...)`. Neither is returned for cleanup; the returned `{ sync }` object has no `stop()`. `startSync` is called at main.js line 137 and its return value is discarded.

On quit → re-boot:
1. Old interval continues firing every 3 seconds.
2. Old interval calls `sync()` which calls `doom._web_save_defaults()` on line 61 — the old `doom` wasm instance that has already called `I_Quit()` → `abort()`. Calling wasm exports on an aborted instance throws a `RuntimeError`. This call is not wrapped in try/catch (the outer try/catch at line 63 only guards IndexedDB operations, not the line 61 call).
3. The error propagates as an unhandled promise rejection from the async `sync()` function.
4. A second visibilitychange listener is also added on each re-boot (same orphan pattern as ws-007).

**Why it matters** (T4): after each quit→reboot cycle, an orphaned async interval pokes dead wasm and emits unhandled promise rejections. After N cycles there are N orphaned intervals. The error is silent in production but masks other issues and wastes CPU.

**Severity**: med

**Disposition**: `fixed(12.4b, this commit)` — added `stop()` to returned object (clears interval, removes visibilitychange listener); wrapped `doom._web_save_defaults()` in try/catch; wired `syncHandle.stop()` into `doom.onQuit` and `onDoomError` in main.js; teardown tested in `tools/persist-test.mjs`

---

### ws-009 — net.js : ping pong-handler override on concurrent pings

**File/function**: `client/js/net.js`, `connectLobby()` → `ping()` (lines 17–21)

**What**: Each `ping()` call does `handlers.set('pong', ...)`, overwriting any previously registered pong handler. If two pings are outstanding simultaneously, the first ping's Promise never resolves (memory leak, potential hang in any future code that concurrently pings).

**In-practice impact**: The only caller is lobby.js line 162: `for (let i = 0; i < 12; i++) rtts.push(await lobby.ping().catch(() => 50))`. Pings are `await`-ed sequentially, so only one is outstanding at a time. The race is not triggered by current code.

**Why it matters** (T3/T4): fragile API design; any future concurrent ping call silently breaks.

**Severity**: low

**Disposition**: `won't-fix(sequential-in-practice-no-concurrent-caller)` — note in 12.4b or later if ping API is generalised

---

### ws-010 — settings.js : mouseMove checkbox saves to wrong key; has no effect until page reload

**File/function**: `client/js/settings.js`, `render()` (line 44)

**What**: The "Mouse Y moves player (1993 style)" checkbox saves to `s.mouseMove`:

```js
panel.querySelector('#mmove').onchange = e => { s.mouseMove = e.target.checked; saveSettings(s); };
```

But the actual setting used by `input.js` is `s.mouseY` (`'off' | 'look' | 'move'`). The `loadSettings()` migration at input.js line 57 converts `mouseMove → mouseY` only on the NEXT page load:

```js
if (s.mouseMove === true && !s.mouseY) s.mouseY = 'move';
delete s.mouseMove;
```

In the current session, toggling the checkbox sets `s.mouseMove` in the live settings object, but `input.js:frame()` reads `settings.mouseY`, which is unchanged. The checkbox has zero effect until the page is reloaded.

Additionally, the checkbox is rendered from `s.mouseMove` (line 28 references `${s.mouseMove ? 'checked' : ''}`), but the richer `s.mouseY` has three states ('off', 'look', 'move') that the binary checkbox does not represent. The settings UI does not expose the 'look' option at all.

**Why it matters** (T3/T4): user sees checkbox appear to toggle; setting silently has no effect. Breaks the UI-settings contract.

**Severity**: med

**Disposition**: `fixed(12.4b, this commit)` — checkbox now reads `s.mouseY === 'move'` and writes `s.mouseY = checked ? 'move' : 'off'` directly; removed stale `mouseMove` migration from `loadSettings` (legacy `mouseMove` key stripped on load)

---

### ws-011 — game.js : session.history array grows unboundedly

**File/function**: `server/game.js`, `sealTic()` (line 395) and `session` object (line 222)

**What**: `session.history.push(buf)` is called for every sealed tic (line 395). Each bundle is 6 + 8×4 = 38 bytes. At 35 Hz: ~1.3 KB/s. A 60-minute game accumulates ~4.7 MB. There is no cap, eviction, or stream-and-drop mechanism.

**Why this matters**: for a LAN game (designed use case), this is harmless — games last tens of minutes and the array is used only for drop-in catch-up replay. For pathologically long games or automated soak tests, memory growth could become visible.

**Severity**: low

**Disposition**: `won't-fix(harmless-for-lan-timescales-4-7-mb-per-60-min)` — revisit if server is ever used as a persistent relay for long-running sessions

---

### ws-012 — audio.js : new AudioContext() not wrapped in try/catch; silently drops on exception

**File/function**: `client/js/audio.js`, `arm()` async function (line 22)

**What**: `ctx = new AudioContext()` on line 22 is outside any try/catch. `new AudioContext()` can throw `DOMException: The AudioContext was not allowed to start` (browser autoplay policy) or `NotSupportedError` in some environments. If it throws, the `arm` async function rejects. Since `arm` is installed as an event listener callback (`window.addEventListener('keydown', arm, ...)`), the rejected Promise is silently ignored (event listener return values are discarded). The exception is not logged and the user gets no audio without any diagnostic.

**Why it matters** (T4): silent failure in the audio initialisation path; no user-facing error message.

**Severity**: low

**Disposition**: `fixed(12.4b, this commit)` — `new AudioContext()` wrapped in try/catch; logs `console.warn('AudioContext creation failed:', err)` and returns early

---

### ws-013 — input.js : navigator.getGamepads?.()[0] can throw TypeError in no-getGamepads browsers

**File/function**: `client/js/input.js`, `pollGamepad()` (line 207)

**What**:

```js
const gp = navigator.getGamepads?.()[0];
```

If `navigator.getGamepads` is undefined (very old browser or restricted environment), `navigator.getGamepads?.()` short-circuits to `undefined`. Then `undefined[0]` throws `TypeError: Cannot read properties of undefined (reading '0')`. This propagates uncaught through `frame()` and into the rAF try/catch in `main.js` (line 166–169), which silently sets `running = false` — triggering the ws-001 frozen-canvas wedge.

**Practical impact**: Chrome, Edge, and Firefox (the stated target browsers) all define `navigator.getGamepads`. The failure path is only reachable in unsupported browsers. However, the combination with ws-001 means any such error halts the game silently.

**Severity**: low

**Disposition**: `fixed(12.4b, this commit)` — changed to `const gpads = navigator.getGamepads?.(); const gp = gpads?.[0];` (double optional chain, no TypeError on missing API)

---

### ws-014 — main.js / lobby.js : WAD cache absent on insecure origins — silent re-download every session

**File/function**: `client/js/main.js`, `fetchWad()` (line 35); `client/js/lobby.js`, boot block (line 423); `client/sw.js`

**What**: The service worker (`sw.js`) is the only WAD cache, keyed by `?v=sha8` in the `webdoom-wads-v1` cache. SW registration requires a secure context. Players connecting via plain `http://<LAN-IP>:8666` (the documented and default mode — see `start.sh`, `server/serve.js:84-92`) get no SW: `navigator.serviceWorker` is absent, the guard in lobby.js line 423 (`if ('serviceWorker' in navigator)`) silently skips registration, and the `fetchWad` fetch hits the server on every session. The degradation was never surfaced to the user.

**Dimensions**:
- No WAD caching on LAN-IP origins: WAD re-downloads on every page load (4–17 MB per game, per session).
- Silent degradation: `status('')` left blank; user had no indication that offline caching was unavailable.
- No `navigator.storage.persist()` call anywhere in the client; IDB data (savegames) subject to eviction.

**Storage arithmetic** (IDB fallback tier added by 16.3):
- Typical WAD sizes: doom.wad ~12 MB, doom2.wad ~14 MB, sigil.wad ~4 MB, nerve.wad ~4 MB, tnt.wad ~17 MB, plutonia.wad ~17 MB, chex.wad ~6 MB.
- Full library (8 IWADs + PWADs): ~80–120 MB.
- Chrome IDB quota: up to ~60% of available disk; 80–120 MB is well within quota on any modern device.
- Eviction story: without `storage.persist()`, the browser may evict IDB data under storage pressure; the IDB WAD cache is then cold and the next session re-downloads (same as pre-fix behaviour). With `persist()` (requested after first successful IDB WAD write), the data is preserved until the user explicitly clears site data.

**Why it matters** (T4): the whole point of the WAD cache (SW or IDB) is to avoid repeated multi-MB downloads on a LAN server that may have limited bandwidth. Silent failure defeats this purpose.

**Severity**: high

**Disposition**: `fixed(16.3)` — `client/js/wad-cache.js` adds an IDB fallback store keyed by full sha256. `fetchWad()` in `main.js` detects SW presence via `navigator.serviceWorker.controller`; on insecure origins it reads IDB before network and writes IDB after a network fetch. On secure origins with an active SW the IDB write is skipped (no duplicate storage). `lobby.js` surfaces a non-silent status: `"offline caching unavailable (insecure origin) — WADs cached locally instead"`. `navigator.storage.persist()` is requested after the first successful IDB WAD write. `wad-cache.js` added to `sw.js` SHELL precache so the module is available offline. Verified by `tools/browser-insecure-test.mjs` (session 2 zero /wads/ server hits from IDB).

---

## Coverage Table

Every in-scope file is listed. "0" findings is a recorded result.

| file | findings |
|------|----------|
| client/js/audio.js | ws-007, ws-012 |
| client/js/countdown.js | 0 |
| client/js/doomfont.js | 0 |
| client/js/fire.js | 0 |
| client/js/input.js | ws-013 |
| client/js/lobby.js | ws-014 (degraded-mode status) |
| client/js/main.js | ws-001, ws-002 (already-fixed), ws-014 (fetchWad IDB fallback) |
| client/js/wad-cache.js | (new — ws-014 fix implementation) |
| client/js/menu.js | 0 |
| client/js/music-worklet.js | 0 |
| client/js/net.js | ws-009 |
| client/js/persist.js | ws-008 |
| client/js/settings.js | ws-010 |
| client/js/video.js | 0 |
| client/sw.js | ws-003, ws-004, ws-014 (precache updated) |
| client/index.html | 0 |
| server/serve.js | ws-005 |
| server/game.js | ws-006, ws-011 |
| server/ui-assets.js | 0 |

**Total files covered**: 18 (note: task spec says 17; count above is 13 js/ + sw.js + index.html + serve.js + game.js + ui-assets.js = 18)

---

## Summary

| dimension | count |
|-----------|-------|
| total entries | 14 |
| active findings | 13 |
| already-fixed | 1 (ws-002) |
| high | 3 (ws-001, ws-003, ws-014) |
| med | 3 (ws-004, ws-008, ws-010) |
| low | 7 (ws-005, ws-006, ws-007, ws-009, ws-011, ws-012, ws-013) |
| fixed(12.4b) | 6 (ws-003, ws-007, ws-008, ws-010, ws-012, ws-013) |
| fixed(15.3) | 1 (ws-001) |
| fixed(16.3) | 1 (ws-014) |
| won't-fix | 5 (ws-004, ws-005, ws-006, ws-009, ws-011) |
| already-fixed | 1 (ws-002) |

---

## Notable findings (top 5)

1. **ws-001** (high): per-frame `catch {}` in main.js silently freezes canvas on any JS exception — frozen with no recovery path (fixed: 15.3)
2. **ws-003** (high): sw.js SHELL precache omits `fire.js` and `countdown.js`, both imported by lobby.js — breaks offline SP promise (rme-005) (fix: 12.4b)
3. **ws-014** (high): WAD cache absent on insecure LAN-IP origins — SW never engages; WADs re-download every session; silent degradation (fix: 16.3)
4. **ws-008** (med): `startSync()` in persist.js leaks its interval and visibilitychange listener; orphaned interval pokes dead wasm after quit→reboot, emitting unhandled promise rejections (fix: 12.4b)
4. **ws-010** (med): settings.js saves `mouseMove` but input.js reads `mouseY`; checkbox toggle has no effect in the current session (fix: 12.4b)
5. **ws-004** (med): `skipWaiting()` + `clients.claim()` evicts the old shell cache mid-game; handled by controllerchange banner but subtle for offline SP (won't-fix with existing banner)
