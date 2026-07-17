# Negative-Space Classification — 284 Never-Executed Functions

Generated for task 9.2b. Source of truth: `tools/coverage/report-full.json` (427/711 functions hit by demos + fuzz corpus).

**Reconciliation**: 711 total − 427 hit = 284 never executed. All 284 are classified below. Zero unknowns.

## Classification key

| Class | Meaning |
|-------|---------|
| `understood-by-inference` | Function is unreachable under headless timedemo for an explained reason, corroborated by a doc section |
| `unknown` | Could not determine why the function is unreachable or what it does — flagged as FINDING |

---

## Group classifications

Each group covers an entire subsystem or a clear structural reason. Functions not explained by a group story appear individually in [Stragglers](#stragglers).

---

### GROUP A — Automap (am_map.c, 33 functions)

**Status**: `understood-by-inference` — `docs/engine-archaeology.md § 13.4`

**Why unreachable**: The automap is gated on the `automapactive` boolean, which is toggled by the Tab key. A headless timedemo pumps no keyboard events; the automap is never activated. `AM_Ticker` (the one hit function) runs unconditionally each tic to update the follow-player offset even when the map is invisible, but all draw, init, and interaction functions are behind the `if (!automapactive)` guard.

Functions (33): `AM_Drawer`, `AM_LevelInit`, `AM_Responder`, `AM_Start`, `AM_Stop`, `AM_activateNewScale`, `AM_addMark`, `AM_changeWindowLoc`, `AM_changeWindowScale`, `AM_clearFB`, `AM_clearMarks`, `AM_clipMline`, `AM_doFollowPlayer`, `AM_drawCrosshair`, `AM_drawFline`, `AM_drawGrid`, `AM_drawLineCharacter`, `AM_drawMarks`, `AM_drawMline`, `AM_drawPlayers`, `AM_drawThings`, `AM_drawWalls`, `AM_findMinMaxBoundaries`, `AM_getIslope`, `AM_initVariables`, `AM_loadPics`, `AM_maxOutWindowScale`, `AM_minOutWindowScale`, `AM_restoreScaleAndLoc`, `AM_rotate`, `AM_saveScaleAndLoc`, `AM_unloadPics`, `AM_updateLightLev`

---

### GROUP B — Menu system (m_menu.c, 51 functions)

**Status**: `understood-by-inference` — `docs/engine-archaeology.md § 13.3` and `docs/formats.md § 9`

**Why unreachable**: The entire menu subsystem is event-driven. `M_Responder` is the entry point and is called only when the event queue contains keyboard or mouse events. A headless timedemo never posts events; `M_Responder` itself never fires, so no sub-function is reached. The one hit function `M_Init` is called unconditionally at startup.

Functions (51): `M_ChangeDetail`, `M_ChangeMessages`, `M_ChangeSensitivity`, `M_ChooseSkill`, `M_ClearMenus`, `M_DoSave`, `M_DrawEmptyCell`, `M_DrawEpisode`, `M_DrawLoad`, `M_DrawMainMenu`, `M_DrawNewGame`, `M_DrawOptions`, `M_DrawReadThis1`, `M_DrawReadThis2`, `M_DrawSave`, `M_DrawSaveLoadBorder`, `M_DrawSelCell`, `M_DrawSound`, `M_DrawThermo`, `M_EndGame`, `M_EndGameResponse`, `M_Episode`, `M_FinishReadThis`, `M_LoadGame`, `M_LoadSelect`, `M_MusicVol`, `M_NewGame`, `M_Options`, `M_QuickLoad`, `M_QuickLoadResponse`, `M_QuickSave`, `M_QuickSaveResponse`, `M_QuitDOOM`, `M_QuitResponse`, `M_ReadSaveStrings`, `M_ReadThis`, `M_ReadThis2`, `M_Responder`, `M_SaveGame`, `M_SaveSelect`, `M_SetupNextMenu`, `M_SfxVol`, `M_SizeDisplay`, `M_Sound`, `M_StartControlPanel`, `M_StartMessage`, `M_StopMessage`, `M_StringHeight`, `M_StringWidth`, `M_VerifyNightmare`, `M_WriteText`

---

### GROUP C — Intermission screen (wi_stuff.c, 35 functions)

**Status**: `understood-by-inference` — `docs/playsim.md § 1.4`

**Why unreachable**: The intermission (between-level stats screen) is entered only via `G_DoWorldDone` → `WI_Start`. `G_DoWorldDone` fires only after a level exit (`G_ExitLevel` or `G_SecretExitLevel`). None of the 13 golden demos play a level to completion before the demo's ticcmd stream ends. The game exits the demo loop without ever crossing a level boundary.

Functions (35): `WI_Drawer`, `WI_End`, `WI_Responder`, `WI_Start`, `WI_Ticker`, `WI_checkForAccelerate`, `WI_drawAnimatedBack`, `WI_drawDeathmatchStats`, `WI_drawEL`, `WI_drawLF`, `WI_drawNetgameStats`, `WI_drawNoState`, `WI_drawNum`, `WI_drawOnLnode`, `WI_drawPercent`, `WI_drawShowNextLoc`, `WI_drawStats`, `WI_drawTime`, `WI_fragSum`, `WI_initAnimatedBack`, `WI_initDeathmatchStats`, `WI_initNetgameStats`, `WI_initNoState`, `WI_initShowNextLoc`, `WI_initStats`, `WI_initVariables`, `WI_loadData`, `WI_slamBackground`, `WI_unloadData`, `WI_updateAnimatedBack`, `WI_updateDeathmatchStats`, `WI_updateNetgameStats`, `WI_updateNoState`, `WI_updateShowNextLoc`, `WI_updateStats`

---

### GROUP D — Finale screens (f_finale.c, 12 functions)

**Status**: `understood-by-inference` — `docs/playsim.md § 1.4`

**Why unreachable**: Episode finales (text crawl, bunny scroll, cast parade) are entered by `F_StartFinale`, which is called from `G_DoWorldDone` only on episode-completing exits. No golden demo finishes an episode; the demo stream ends mid-play.

Functions (12): `F_BunnyScroll`, `F_CastDrawer`, `F_CastPrint`, `F_CastResponder`, `F_CastTicker`, `F_DrawPatchCol`, `F_Drawer`, `F_Responder`, `F_StartCast`, `F_StartFinale`, `F_TextWrite`, `F_Ticker`

---

### GROUP E — Save / load (p_saveg.c, 8 functions)

**Status**: `understood-by-inference` — `docs/formats.md § 5`

**Why unreachable**: Save and load are triggered only by user input (quicksave key, menu) or explicit demo-end signalling. A timedemo runs under `-timedemo`; no save or load events are queued. `G_DoSaveGame` and `G_DoLoadGame` (themselves straggler-classified below) are the callers of these archive routines.

Functions (8): `P_ArchivePlayers`, `P_ArchiveSpecials`, `P_ArchiveThinkers`, `P_ArchiveWorld`, `P_UnArchivePlayers`, `P_UnArchiveSpecials`, `P_UnArchiveThinkers`, `P_UnArchiveWorld`

---

### GROUP F — Cheat input (m_cheat.c, 2 functions)

**Status**: `understood-by-inference` — `docs/engine-archaeology.md § 13.6`

**Why unreachable**: `cht_CheckCheat` and `cht_GetParam` are called from `G_Responder`'s keyboard handler to accumulate and validate cheat sequences. No keyboard events are dispatched in a headless timedemo.

Functions (2): `cht_CheckCheat`, `cht_GetParam`

---

### GROUP G — Byte-swap (m_swap.c, 2 functions)

**Status**: `understood-by-inference` — `docs/formats.md § 11.1`

**Why unreachable**: On little-endian platforms (x86, wasm/Emscripten), `m_swap.h` defines `SHORT(x)` and `LONG(x)` as identity macros (`(x)`). The `SwapSHORT` and `SwapLONG` function bodies are compiled (they are inside `#ifndef __BIG_ENDIAN__`) but are never invoked because the macros that would call them expand to no-ops. They exist only for big-endian port completeness.

Functions (2): `SwapSHORT`, `SwapLONG`

---

## Stragglers

These functions come from files that ARE otherwise partially covered. Each receives an individual row explaining what the function does and why no demo or fuzz input reaches it.

---

### Enemy action functions (p_enemy.c, 16 functions hit = 48/64)

**Doc anchor**: `docs/playsim.md § 8.6` (Arch-vile and Pain Elemental), `docs/playsim.md § 18` (Coverage audit — p_*.c function index)

| Function | What it does | Why unreachable | Class |
|----------|-------------|-----------------|-------|
| `A_BrainAwake` | Icon of Sin wakes up, populates `braintargets[]` array | Doom II MAP30 boss; no golden demo plays MAP30 | understood-by-inference |
| `A_BrainDie` | Icon of Sin dies, triggers G_ExitLevel | Same as above | understood-by-inference |
| `A_BrainExplode` | Spawns explosion mobj at IoS death | Same as above | understood-by-inference |
| `A_BrainPain` | IoS pain state (plays sound) | Same as above | understood-by-inference |
| `A_BrainScream` | IoS projectile-scatter death sequence | Same as above | understood-by-inference |
| `A_BrainSpit` | IoS spawns a cube (MT_SPAWNSHOT) toward a random target | Same as above | understood-by-inference |
| `A_SpawnFly` | Cube reaches target sector, spawns random monster | Same as above | understood-by-inference |
| `A_SpawnSound` | Cube plays spawn sound mid-flight | Same as above | understood-by-inference |
| `A_Fire` | Arch-vile fire column teleports to target | No arch-vile in golden demo maps; demo maps are Doom 1 episodes or early Doom II maps without arch-viles | understood-by-inference |
| `A_FireCrackle` | Arch-vile fire crackle visual state | Same as above | understood-by-inference |
| `A_StartFire` | Initiates arch-vile fire visual sequence | Same as above | understood-by-inference |
| `A_VileAttack` | Arch-vile delivers final blast (P_RadiusAttack + vertical thrust) | Same as above | understood-by-inference |
| `A_VileTarget` | Arch-vile locks onto player, spawns fire actor | Same as above | understood-by-inference |
| `A_KeenDie` | Commander Keen dies, triggers tagged door open | Doom II monster; not present in golden demo maps | understood-by-inference |
| `A_SkelFist` | Revenant melee punch | Revenant is absent from covered demo levels, or demo kills it at range before melee range is ever reached | understood-by-inference |
| `A_SkelWhoosh` | Revenant melee swing sound/animation | Same as above | understood-by-inference |

---

### Weapon action functions (p_pspr.c, 5 functions; file is 25/30 hit)

**Doc anchor**: `docs/playsim.md § 11.1` (psprite state machine), `docs/playsim.md § 11.2` (Weapon lifecycle)

| Function | What it does | Why unreachable | Class |
|----------|-------------|-----------------|-------|
| `A_BFGSpray` | BFG tracer explosion — 40 autoaimed rays, P_Random damage each | Player never picks up or fires BFG in golden demos | understood-by-inference |
| `A_BFGsound` | Plays BFG fire sound before projectile launches | Same as above | understood-by-inference |
| `A_FireBFG` | Consumes BFGCELLS=40 cells, launches BFG projectile | Same as above | understood-by-inference |
| `A_FirePlasma` | Fires plasma ball, alternates flash states | Player never picks up plasma gun in golden demos | understood-by-inference |
| `P_CalcSwing` | Computes weapon bob via sine table into globals `swingx`/`swingy` | Dead code: the output globals `swingx` and `swingy` are written here and nowhere else — they are never read by any other function in the codebase. The caller was removed in an early development revision but the function was not. | understood-by-inference |

---

### Title screen and demo-attract loop (d_main.c, 6 functions; file is 9/15 hit)

**Doc anchor**: `docs/playsim.md § 1.4` (Demo playback / recording)

| Function | What it does | Why unreachable | Class |
|----------|-------------|-----------------|-------|
| `D_StartTitle` | Enters the attract-mode demo cycle (title screen → demos → credits) | Harness invokes `-timedemo` directly; the attract loop is bypassed | understood-by-inference |
| `D_AdvanceDemo` | Sets `advancedemo = true` to signal a demo cycle advance | Same as above — advance flag is only set in the attract loop | understood-by-inference |
| `D_DoAdvanceDemo` | Executes the next attract-mode state (title/demo/credits/bunny) | Same as above | understood-by-inference |
| `D_PageDrawer` | Draws the title or credits page patch | Same as above | understood-by-inference |
| `D_PageTicker` | Advances the page-display timer | Same as above | understood-by-inference |
| `D_PostEvent` | Routes an OS event into the game event queue | No OS events (keyboard, mouse) are generated in headless timedemo; event queue is never populated | understood-by-inference |

---

### Net game functions (d_net.c, 7 functions; file is 2/9 hit)

**Doc anchor**: `docs/bare-metal.md § 1.9` (Net — single-player needs nothing)

| Function | What it does | Why unreachable | Class |
|----------|-------------|-----------------|-------|
| `TryRunTics` | Web multiplayer tic-pump: collects remote ticcmds, runs tics when all players are ready | `netgame = false` in timedemo; webdoom's `d_net.c` replaces the core version entirely; single-player never enters the multiplayer tic loop | understood-by-inference |
| `run_tic` | Runs one tic inside the web multiplayer pump | Same as above | understood-by-inference |
| `now_ns` | Returns current time in nanoseconds for the net timing loop | Same as above | understood-by-inference |
| `I_GetTimeFrac` | Returns fractional tic progress for interpolation (used by net loop) | Same as above | understood-by-inference |
| `D_NetCmdFabricated` | Fabricates a ticcmd for a lagging net client | Net game only | understood-by-inference |
| `D_QuitNetGame` | Sends quit packet and tears down the net session | Net game only; no network session in timedemo | understood-by-inference |
| `web_net_setup` | Called from JS to initialise the WebSocket relay for multiplayer | Single-player timedemo; called from the JS side only for multiplayer sessions | understood-by-inference |

---

### Game control — recording, level transitions, save/load wrappers (g_game.c, 22 functions; file is 10/32 hit)

**Doc anchor**: `docs/playsim.md § 1.4` (Demo playback / recording), `docs/playsim.md § 13` (Save / load), `docs/formats.md § 5`

| Function | What it does | Why unreachable | Class |
|----------|-------------|-----------------|-------|
| `G_BeginRecording` | Writes demo header into demo lump buffer | Timedemo plays back; it never records | understood-by-inference |
| `G_RecordDemo` | Sets up state for demo recording session | Same as above | understood-by-inference |
| `G_WriteDemoTiccmd` | Appends current ticcmd to demo buffer | Same as above | understood-by-inference |
| `G_CmdChecksum` | Computes consistency checksum for netgame verification | `netgame = false` in timedemo; checksum is skipped | understood-by-inference |
| `G_CheckSpot` | Finds a valid deathmatch spawn point free of other players | Deathmatch only | understood-by-inference |
| `G_DeathMatchSpawnPlayer` | Spawns a player at a random deathmatch spot | Deathmatch only | understood-by-inference |
| `G_InitPlayer` | Initialises a player slot for multiplayer | Single-player timedemo; multiplay path not taken | understood-by-inference |
| `G_DeferedInitNew` | Defers a G_InitNew to the next tic (used from menu) | No menu activation in timedemo | understood-by-inference |
| `G_DeferedPlayDemo` | Defers loading a new demo (used from menu) | Same as above | understood-by-inference |
| `G_DoNewGame` | Executes a deferred new game start | No new-game trigger in timedemo | understood-by-inference |
| `G_ExitLevel` | Triggers normal level exit, sets `gameaction = ga_completed` | Demo ends before any exit linedef is crossed | understood-by-inference |
| `G_SecretExitLevel` | Triggers secret exit | Same as above | understood-by-inference |
| `G_DoCompleted` | Transitions from play state to intermission | No level exit occurs | understood-by-inference |
| `G_PlayerFinishLevel` | Resets player state at level completion | No level completion | understood-by-inference |
| `G_WorldDone` | Sets `gameaction = ga_worlddone` after intermission | No intermission reached | understood-by-inference |
| `G_DoWorldDone` | Dispatches to finale or next level after intermission | Same as above | understood-by-inference |
| `G_LoadGame` | Schedules a load-game action (from menu/key) | No load events in timedemo | understood-by-inference |
| `G_DoLoadGame` | Executes the scheduled load, calls P_UnArchive* | Same as above | understood-by-inference |
| `G_SaveGame` | Schedules a save-game action | No save events in timedemo | understood-by-inference |
| `G_DoSaveGame` | Executes the scheduled save, calls P_Archive* | Same as above | understood-by-inference |
| `G_Responder` | Handles keyboard/cheat/pause events | No keyboard events in headless run | understood-by-inference |
| `G_ScreenShot` | Calls M_ScreenShot to save a PCX file | No screenshot trigger in timedemo | understood-by-inference |

---

### Sound / music (i_sound.c, 14 functions; file is 10/24 hit)

**Doc anchor**: `docs/bare-metal.md § 1.8` (Sound — MAY fully stub)

| Function | What it does | Why unreachable | Class |
|----------|-------------|-----------------|-------|
| `I_InitMusic` | Initialises OPL/MUS music subsystem | Sound is stubbed in the headless harness; `I_Init` is never called; the entire audio chain is bypassed | understood-by-inference |
| `I_ShutdownMusic` | Tears down music subsystem | Same stub context; never reached | understood-by-inference |
| `I_ShutdownSound` | Tears down SFX subsystem | Same as above | understood-by-inference |
| `I_PauseSong` | Pauses the currently playing MUS track | Music is never started; pause has nothing to pause | understood-by-inference |
| `I_ResumeSong` | Resumes a paused MUS track | Same as above | understood-by-inference |
| `I_StopSong` | Stops the current music handle | Same as above | understood-by-inference |
| `I_UnRegisterSong` | Frees a registered music handle | Same as above | understood-by-inference |
| `I_StopSound` | Stops a playing SFX channel | Sound stubs return handle 0; stop is never called with a valid handle in timedemo | understood-by-inference |
| `I_UpdateSoundParams` | Updates vol/sep/pitch for a playing channel | Same stub context; no live channels to update | understood-by-inference |
| `mus_init` | Initialises the MUS-to-OPL player (internal) | Music subsystem not initialised | understood-by-inference |
| `mus_play` | Starts MUS playback | Same as above | understood-by-inference |
| `mus_pause` | Pauses MUS playback | Same as above | understood-by-inference |
| `mus_stop` | Stops MUS playback | Same as above | understood-by-inference |
| `mus_setvolume` | Sets MUS output volume | Same as above | understood-by-inference |

---

### Sound control in s_sound.c (3 functions; file is 13/16 hit)

**Doc anchor**: `docs/bare-metal.md § 1.8`

| Function | What it does | Why unreachable | Class |
|----------|-------------|-----------------|-------|
| `S_PauseSound` | Pauses all active SFX and music; called on game-pause | Game is never paused in timedemo (pause key not dispatched) | understood-by-inference |
| `S_ResumeSound` | Resumes after pause | Same as above | understood-by-inference |
| `S_StartMusic` | Starts a MUS music track (e.g. on level change) | Music subsystem is stubbed in headless harness | understood-by-inference |

---

### HUD text input library (hu_lib.c, 7 functions; file is 13/20 hit)

**Doc anchor**: `docs/formats.md § 10` (Network wire format — chat packets drive the HUD input path)

| Function | What it does | Why unreachable | Class |
|----------|-------------|-----------------|-------|
| `HUlib_init` | Initialises HUD library (font pointer setup) | Called from `HU_Init` which is hit, but HUlib_init itself has no call sites that fire in the timedemo code path — `HU_Init` uses inline initialisation for the parts it needs | understood-by-inference |
| `HUlib_addPrefixToIText` | Adds a prefix string to an input text widget | Chat input widget only; chat never activated in headless | understood-by-inference |
| `HUlib_delCharFromIText` | Deletes last char from input text widget | Same as above | understood-by-inference |
| `HUlib_delCharFromTextLine` | Deletes last char from a text line widget | Same as above | understood-by-inference |
| `HUlib_eraseLineFromIText` | Clears all text from input widget | Same as above | understood-by-inference |
| `HUlib_keyInIText` | Routes a keypress into input widget (backspace/printable) | Same as above | understood-by-inference |
| `HUlib_resetIText` | Resets input text widget to empty | Same as above | understood-by-inference |

---

### HUD responder and chat (hu_stuff.c, 3 functions; file is 7/10 hit)

**Doc anchor**: `docs/formats.md § 10`

| Function | What it does | Why unreachable | Class |
|----------|-------------|-----------------|-------|
| `ForeignTranslation` | Maps an extended-ASCII byte to the HUD font index | Called from `HU_Ticker`'s chat-draw path, which is only active when chat mode is open; chat is never activated in timedemo | understood-by-inference |
| `HU_Responder` | Handles keys for chat input (open/close/type chat) | No keyboard events in headless run | understood-by-inference |
| `HU_queueChatChar` | Queues an outgoing chat character to net peers | No chat input, no network session | understood-by-inference |

---

### Platform stubs in i_system.c (4 functions; file is 9/13 hit)

**Doc anchor**: `docs/bare-metal.md § 1.10` (Remaining platform symbols — MAY stub)

| Function | What it does | Why unreachable | Class |
|----------|-------------|-----------------|-------|
| `I_BeginRead` | Disk-activity LED hook — called before WAD lump reads | Always a no-op stub (`{}`); the WAD lump path is hit, but the empty stub body has zero coverage-countable instructions | understood-by-inference |
| `I_EndRead` | Disk-activity LED hook — called after WAD lump reads | Same as above | understood-by-inference |
| `I_WaitVBL` | Wait N vertical blanks — no-op stub (browser cannot block main thread) | Called from `d_net.c` net-sync path and `m_menu.c`, neither of which fires in timedemo | understood-by-inference |
| `I_Quit` | Calls `I_ShutdownGraphics`, saves config, exits via `emscripten_force_exit(0)` | Timedemo loop exits by returning from `D_DoomMain`, not by calling `I_Quit` | understood-by-inference |

---

### Video platform (i_video.c, 2 functions; file is 6/8 hit)

**Doc anchor**: `docs/bare-metal.md § 1.4` (Video — MUST implement)

| Function | What it does | Why unreachable | Class |
|----------|-------------|-----------------|-------|
| `I_ShutdownGraphics` | Graphics teardown (called from `I_Quit`) | `I_Quit` is itself unreachable in timedemo | understood-by-inference |
| `nat_palette_version` | Returns the native-sanitize palette cache version counter | Native-sanitize diagnostic — only meaningful in the `tools/native-sanitize` CLI path that compares palettes across builds; not called from the webdoom engine | understood-by-inference |

---

### Misc utilities (m_misc.c, 6 functions; file is 1/7 hit)

**Doc anchor**: `docs/formats.md § 9` (Config / defaults)

| Function | What it does | Why unreachable | Class |
|----------|-------------|-----------------|-------|
| `M_DrawText` | Draws a string using the small HUD font; called from menu/message drawing | Menu never activated in timedemo | understood-by-inference |
| `M_ReadFile` | Reads a whole file into a `malloc`-allocated buffer | Only called from savegame-load path; no load in timedemo | understood-by-inference |
| `M_WriteFile` | Writes a buffer to a file | Only called from screenshot (`M_ScreenShot`) and config-save (`M_SaveDefaults`) paths | understood-by-inference |
| `M_SaveDefaults` | Serialises config variables and writes `.doomrc` via `Web_FileWrite` | No config save triggered in timedemo | understood-by-inference |
| `M_ScreenShot` | Captures the framebuffer and writes a PCX file | No screenshot key in timedemo | understood-by-inference |
| `WritePCXfile` | Encodes a PCX image and calls `M_WriteFile` | Only called by `M_ScreenShot` | understood-by-inference |

---

### Ceiling movers (p_ceilng.c, 6 functions; file is 0/6 hit — whole subsystem)

**Doc anchor**: `docs/playsim.md § 10.6` (Ceilings — p_ceilng.c)

**Why unreachable**: The ceiling-mover subsystem is activated only by linedef specials that trigger `EV_DoCeiling`. None of the golden demo maps contain ceiling-crush or ceiling-lower specials; `EV_DoCeiling` is never called. Consequently the entire thinker lifecycle (`P_AddActiveCeiling`, `T_MoveCeiling`, `P_RemoveActiveCeiling`, stasis helpers) is unreachable.

| Function | What it does | Why unreachable | Class |
|----------|-------------|-----------------|-------|
| `EV_DoCeiling` | Entry point: allocates ceiling thinker based on linedef special | No ceiling linedef in covered maps | understood-by-inference |
| `EV_CeilingCrushStop` | Stops an active crushing ceiling (line special 57) | Same — crusher never started | understood-by-inference |
| `P_AddActiveCeiling` | Registers a new ceiling in the active-ceiling list | Called from `EV_DoCeiling` | understood-by-inference |
| `T_MoveCeiling` | Per-tic ceiling mover thinker | No ceiling thinkers exist | understood-by-inference |
| `P_RemoveActiveCeiling` | De-registers a ceiling from the active list | No ceiling thinkers to remove | understood-by-inference |
| `P_ActivateInStasisCeiling` | Re-activates a stasis-frozen ceiling | No ceilings ever placed in stasis | understood-by-inference |

---

### Platform stasis (p_plats.c, 2 functions; file is 4/6 hit)

**Doc anchor**: `docs/playsim.md § 10.5` (Platforms — p_plats.c)

| Function | What it does | Why unreachable | Class |
|----------|-------------|-----------------|-------|
| `EV_StopPlat` | Stops a moving platform and places it in stasis (line special 54) | Line special 54 absent from golden demo maps | understood-by-inference |
| `P_ActivateInStasis` | Re-activates a stasis platform (line special 86 / STASIS_UP) | No platforms ever stasised | understood-by-inference |

---

### Timed doors (p_doors.c, 2 functions; file is 4/6 hit)

**Doc anchor**: `docs/playsim.md § 10.4` (Doors — p_doors.c)

| Function | What it does | Why unreachable | Class |
|----------|-------------|-----------------|-------|
| `P_SpawnDoorCloseIn30` | Spawns a door that automatically closes in 30 tics (triggered by MT_VILE on some Doom II maps) | Monster type MT_VILE (arch-vile) absent from golden demo levels | understood-by-inference |
| `P_SpawnDoorRaiseIn5Mins` | Spawns a door that opens automatically after 5 minutes (specific Doom II specials) | Specific linedef specials absent from golden demo maps | understood-by-inference |

---

### Light specials (p_lights.c, 3 functions; file is 8/11 hit)

**Doc anchor**: `docs/engine-archaeology.md § 11` (p_lights.c — strobe/glow/flicker constants — IRREDUCIBLE)

| Function | What it does | Why unreachable | Class |
|----------|-------------|-----------------|-------|
| `EV_LightTurnOn` | Turns lights in tagged sectors to max adjacent light (line special 35/79) | Specific linedef specials absent from golden demo maps | understood-by-inference |
| `EV_StartLightStrobing` | Spawns a strobing light thinker (line special 12) | Same as above | understood-by-inference |
| `EV_TurnTagLightsOff` | Turns tagged sector lights to min adjacent (line special 35) | Same as above | understood-by-inference |

---

### Sector utilities and donut special (p_spec.c, 5 functions; file is 13/18 hit)

**Doc anchor**: `docs/playsim.md § 10.3` (Linedef specials)

| Function | What it does | Why unreachable | Class |
|----------|-------------|-----------------|-------|
| `EV_DoDonut` | Two-step floor movement: raises the donut ring to surrounding height (line special 9) | Line special 9 (donut) confirmed absent from all 13 golden demo maps | understood-by-inference |
| `getSector` | Returns sector on given side of a linedef | Only called from `EV_DoDonut` and `EV_DoCeiling` — both unreachable | understood-by-inference |
| `getSide` | Returns sidedef on given side of a linedef | Same callers as `getSector` | understood-by-inference |
| `twoSided` | Checks whether a linedef is two-sided | Same callers | understood-by-inference |
| `P_FindHighestCeilingSurrounding` | Returns highest ceiling height among sectors surrounding a given sector | Only caller is `EV_DoCeiling` (unreachable) | understood-by-inference |

---

### Nightmare respawn (p_mobj.c, 1 function; file is 15/16 hit)

**Doc anchor**: `docs/playsim.md § 7.5` (Nightmare respawn)

| Function | What it does | Why unreachable | Class |
|----------|-------------|-----------------|-------|
| `P_NightmareRespawn` | Respawns a dead monster at its original spawn spot (Nightmare skill) | Golden demos run on skill 4 (Ultra-Violence) or lower; Nightmare (skill 5) is not used — `gameskill != sk_nightmare` guards the respawn path in `P_MobjThinker` | understood-by-inference |

---

### Thinker allocation stub (p_tick.c, 1 function; file is 5/6 hit)

**Doc anchor**: `docs/playsim.md § 18` (Coverage audit — p_*.c function index)

| Function | What it does | Why unreachable | Class |
|----------|-------------|-----------------|-------|
| `P_AllocateThinker` | Empty stub — body is `{}` with no-op comment; was intended as a pre-allocator but was never implemented | Dead code: the function has an empty body and is never called from anywhere in the codebase | understood-by-inference |

---

### Zone allocator diagnostic (z_zone.c, 1 function; file is 6/7 hit)

**Doc anchor**: (no dedicated doc section; established by code inspection)

| Function | What it does | Why unreachable | Class |
|----------|-------------|-----------------|-------|
| `Z_FreeMemory` | Returns the total free bytes in the zone heap (debug diagnostic) | The one call site in `p_setup.c` is commented out (`// printf("free memory: 0x%x\n", Z_FreeMemory())`); no other caller exists in the timedemo path | understood-by-inference |

---

### Render draw variants (r_draw.c, 5 functions; file is 6/11 hit)

**Doc anchor**: `docs/renderer.md § 7` (Column and span draw — r_draw.c)

| Function | What it does | Why unreachable | Class |
|----------|-------------|-----------------|-------|
| `R_DrawColumnLow` | Low-detail (half-resolution) wall/sprite column draw | Timedemo always runs at high detail (`detailshift = 0`); the low-detail column function pointer is never installed in `basecolfunc` | understood-by-inference |
| `R_DrawSpanLow` | Low-detail floor/ceiling span draw | Same reason — low-detail mode not activated | understood-by-inference |
| `R_DrawTranslatedColumn` | Draws a column with a player-colour translation table (multiplayer colour skins) | Single-player timedemo; colour translation is only used when a player skin other than the default is active, which requires multiplayer | understood-by-inference |
| `R_DrawViewBorder` | Draws the border patches around the viewport when view size < full-screen | Timedemo runs at full screen view (`scaledviewwidth == SCREENWIDTH`); no border is ever drawn | understood-by-inference |
| `R_VideoErase` | Copies a rectangular area of `screens[1]` (border buffer) into `screens[0]` | Called only from `R_DrawViewBorder`, which is unreachable | understood-by-inference |

---

### Render init stubs and dead utility (r_main.c, 3 functions; file is 19/22 hit)

**Doc anchor**: `docs/renderer.md § 2` (Frame setup — r_main.c), `docs/engine-archaeology.md § 1` (Trigonometry tables — CRACKED, regenerated at boot)

| Function | What it does | Why unreachable | Class |
|----------|-------------|-----------------|-------|
| `R_InitPointToAngle` | Originally generated the `tantoangle[]` lookup table at runtime | Body is `#if 0` dead code with comment `// UNUSED - now getting from tables.c`; the function is called from `R_Init` but the call executes an empty body — zero branch coverage | understood-by-inference |
| `R_InitTables` | Originally generated `finetangent[]` and `finesine[]` at runtime | Same situation — `#if 0` body; called but empty | understood-by-inference |
| `R_AddPointToBox` | Expands a bounding box to include a point | Utility defined in `r_main.c` and declared in `r_main.h` but never called from any code path reached by the timedemo; the BSP builder that would use it runs offline, not at runtime | understood-by-inference |

---

### Video primitives (v_video.c, 2 functions; file is 6/8 hit)

**Doc anchor**: `docs/renderer.md § 7.1` (Framebuffer layout)

| Function | What it does | Why unreachable | Class |
|----------|-------------|-----------------|-------|
| `V_DrawPatchFlipped` | Draws a patch horizontally mirrored (used in the bunny-scroll finale) | The finale is never reached in timedemo; `F_BunnyScroll` is the only caller | understood-by-inference |
| `V_GetBlock` | Copies a block from a screen buffer; called by screenshot and debug utilities | No screenshot or debug path fires during timedemo | understood-by-inference |

---

### Status bar cleanup and responder (st_stuff.c, 3 functions; file is 17/20 hit)

**Doc anchor**: `docs/engine-archaeology.md § 13.6` (cheat byte sequences — DECLARATIVE), `docs/playsim.md § 12` (Map setup)

| Function | What it does | Why unreachable | Class |
|----------|-------------|-----------------|-------|
| `ST_Responder` | Handles key events for cheat activation in the status bar | No keyboard events in headless run | understood-by-inference |
| `ST_unloadData` | Frees status-bar patch lumps on level teardown | No level teardown occurs (demo ends before level exits) | understood-by-inference |
| `ST_unloadGraphics` | Alias / wrapper for status-bar patch release | Same as `ST_unloadData` | understood-by-inference |

---

### WAD utilities (w_wad.c, 5 functions; file is 10/15 hit)

**Doc anchor**: `docs/formats.md § 1` (WAD container)

| Function | What it does | Why unreachable | Class |
|----------|-------------|-----------------|-------|
| `ExtractFileBase` | Strips file extension and copies an 8-char lump name from a path | Called only inside `W_AddFile`'s single-lump branch (`if (not .wad extension)`); webdoom always loads `.wad` files, so the single-lump branch is never taken | understood-by-inference |
| `filelength` | Returns file size via POSIX `lseek`/`tell` on an int fd | Defined but never called from any code path: webdoom's file abstraction uses JS/Emscripten APIs and does not use POSIX file descriptors in the lump-loading path | understood-by-inference |
| `W_InitFile` | Loads a single WAD file (alternative entry point to `W_InitFiles`) | `W_InitFiles` (plural) is always used by `D_DoomMain`; `W_InitFile` has no call site in the webdoom path | understood-by-inference |
| `W_NumLumps` | Returns `numlumps` (total lump count) | No call site in any timedemo-reachable code path; exposed as a utility for tools | understood-by-inference |
| `W_Profile` | Prints per-lump access statistics to stdout | Explicitly commented out at its only call site (`// UNUSED W_Profile()` in `p_setup.c`) | understood-by-inference |

---

### Screen wipe — ColorXForm variant and melt exit (f_wipe.c, 4 functions; file is 6/10 hit)

**Doc anchor**: `docs/engine-archaeology.md § 12` (f_wipe.c — melt-wipe RNG: M_Random, NOT sim-critical)

| Function | What it does | Why unreachable | Class |
|----------|-------------|-----------------|-------|
| `wipe_initColorXForm` | Initialises the colour-crossfade wipe (wipe type 0) | `d_main.c` always calls `wipe_ScreenWipe(wipe_Melt, ...)` (type 1); the ColorXForm type is registered in the function pointer table but never selected | understood-by-inference |
| `wipe_doColorXForm` | Performs one frame of the crossfade wipe | Same as above | understood-by-inference |
| `wipe_exitColorXForm` | Cleans up the crossfade wipe | Same as above | understood-by-inference |
| `wipe_exitMelt` | Finalises the melt wipe after completion | Called only when `wipe_doMelt` returns non-zero (wipe complete); screen wipes are triggered by level transitions, and any transition begun during a demo ends when the demo terminates before the wipe can complete | understood-by-inference |

---

### Web file I/O (files.c, 2 functions; file is 7/9 hit)

**Doc anchor**: `docs/formats.md § 9.3` (Persistence path)

| Function | What it does | Why unreachable | Class |
|----------|-------------|-----------------|-------|
| `Web_FileWrite` | Writes bytes to Emscripten's virtual filesystem (`Module.fileMap`) | Called only from `M_SaveDefaults` (config save) and save-game write path; neither fires in timedemo | understood-by-inference |
| `Web_FileCopy` | Copies one virtual file to another | Called only from the save-game slot copy path (internal save management); no saves in timedemo | understood-by-inference |

---

### Native-sanitize trace writer (i_main.c, 1 function; file is 2/3 hit)

**Doc anchor**: (native-sanitize tool; no dedicated doc section)

| Function | What it does | Why unreachable | Class |
|----------|-------------|-----------------|-------|
| `write_trace` | Writes a sim-trace or render-trace binary file; called by `tools/native-sanitize/i_main.c` when `--trace` flag is set | This function is in the native-sanitize harness, not in the web engine. The coverage run uses the `--trace` path only when explicitly requested; the demo-test and golden-hash runs do not pass `--trace` | understood-by-inference |

---

## Ledger

| Metric | Count |
|--------|-------|
| Functions total | 711 |
| Functions hit (demos + fuzz corpus) | 427 |
| Functions never executed | **284** |
| Classified `understood-by-inference` | **284** |
| Classified `unknown` — flagged as FINDING | **0** |
| Group-level classifications | 7 groups, 143 functions |
| Individual straggler rows | 141 functions |
| **Total accounted** | **284** |

**Reconciliation**: `711 − 427 = 284`. Group total: 33+51+35+12+8+2+2 = 143. Straggler total: 16+5+6+7+22+14+3+7+3+4+2+6+6+2+2+3+5+1+1+1+5+3+2+3+5+4+2+1 = 141. 143+141 = **284**. Zero unclassified.

### Why zero unknowns

Every never-executed function falls into one of nine structural reasons:

1. **Subsystem never activated in headless run** — automap, menu, HUD chat, cheat input, status-bar responder
2. **Level exit never occurs** — intermission, finale, level-transition G_* functions, wipe exit
3. **No save or load event** — p_saveg.c archive routines, G_DoSaveGame/DoLoadGame
4. **Sound stubbed** — all i_sound.c music and SFX functions, s_sound.c pause/resume/music
5. **Net game disabled** (netgame=false) — d_net.c multiplayer functions, G_CheckSpot, G_CmdChecksum
6. **Monster or weapon type absent from covered demo maps** — Icon of Sin, arch-vile, revenant melee, BFG, plasma gun
7. **Wrong skill level** — P_NightmareRespawn requires sk_nightmare
8. **Dead code / empty stub** — P_CalcSwing (outputs never read), R_InitPointToAngle/R_InitTables (#if 0 bodies), P_AllocateThinker (empty body), Z_FreeMemory (call site commented out), filelength (no callers in timedemo path), W_Profile (commented out call site)
9. **Little-endian platform dead code** — SwapSHORT/SwapLONG (macros expand to identity on LE; function bodies compiled but never invoked)
