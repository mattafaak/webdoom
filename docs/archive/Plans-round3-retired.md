# Plans archive — round 3 rows retired in round 11 (2026-09-17)

**ARCHIVE.** Not maintained. These nine rows left `Plans.md`'s open table on
2026-09-17 because each had stopped describing anything a reader could act on:
the four FastDoom toggles were deleted from the engine in round 10, and the
five N64 rows below need a device or a decomposition that nobody has. The rows
are preserved verbatim, each under the verdict that retired it. Markers and
landing hashes are unchanged; `Plans.md` links this file from its open table.

## 20.3a–d — the FastDoom toggles: **RETIRED (round 10, 2026-09-16)**

All four landed and all four were removed again. No player could reach a
compile-time variant; 20.3b measured a net loss in its own entry and 20.3d was
never measured at all. The removal was proven the way their presence was:
`build/doom.wasm` stayed byte-identical (`b65732eb1be202690e861c36d7849afe`,
355,883 bytes) with the guarded blocks and all eight `#line` directives gone,
so the directives had been inert. Their measurements and kill rules stay in
`docs/optimization-ledger.md` §20.3a–d as history; `docs/renderer.md` §12b
records what replaced the table they built.

**The DoDs below name build trees and golden families that no longer exist**
(`build-fakeflat/`, `*-render-potato.json`, `toggle-identity`). That is why
they are here rather than in the open table: a DoD nobody can run is not a
definition of done, it is a description of a former one.

| Task | 内容 | DoD | Depends | Status |
|------|------|-----|---------|--------|

| 20.3 | **DECOMPOSED** FastDoom-class presentation-side harvest: fake-flat mode, status-bar redraw skip, potato/half-width columns, differential-blit analysis — each behind a toggle, each a separate ledger entry, visual-change modes get their OWN goldens (never touch the 320 vanilla goldens), fleet + icount measured | (superseded — see 20.3a–20.3d) | 20.1b | cc:分割 |
| 20.3a | FastDoom fake-flat: sky/ceiling/floor drawn as solid color when far (texture reads skipped); guard behind `WEBDOOM_FAKEFLAT` toggle; visual-change mode → OWN render golden set required | toggle-off: wasm binary byte-identical to master (md5 match); red-proof: corrupt a vanilla golden → FAIL, restore → PASS (vanilla goldens untouched); toggle-on: own render golden set committed (generated from toggle-on build, never modified vanilla goldens); icount reduction measured on 4 fleet hosts + committed ledger row; 13/13 sim (state-hash) goldens unchanged toggle-on and toggle-off | 20.1b | cc:完了 [6d19915] |
| 20.3b | FastDoom status-bar redraw skip: skip re-rendering the status bar when nothing changed between frames; guard behind `WEBDOOM_SBSKIP` toggle; non-visual when static → may produce pixel-identical output | toggle-off: wasm binary byte-identical to master (md5 match); red-proof: corrupt vanilla golden → FAIL, restore → PASS; toggle-on: if pixel-identical to toggle-off, that identity is the proof (no separate golden set); if not pixel-identical, own golden set committed; measured speedup on 4 fleet hosts + ledger row; 13/13 sim goldens unchanged | 20.1b | cc:完了 [2d7756c] |
| 20.3c | FastDoom potato/half-width columns: half-resolution column renderer (column drawn at half width, horizontally doubled); guard behind `WEBDOOM_POTATO` toggle; visual change → OWN render golden set required | toggle-off: wasm binary byte-identical to master (md5 match); red-proof as above (vanilla goldens untouched); toggle-on: own render golden set committed; icount reduction measured on 4 fleet hosts + ledger row; 13/13 sim (state-hash) goldens unchanged toggle-on and toggle-off | 20.1b | cc:完了 [085a5ba] |
| 20.3d | FastDoom differential blit: copy only changed screen regions to the canvas transfer buffer; guard behind `WEBDOOM_DIFFBLIT` toggle; blit path only — framebuffer content unchanged so no visual delta | toggle-off: wasm binary byte-identical to master (md5 match); red-proof: corrupt vanilla golden → FAIL, restore → PASS; toggle-on: pixel output byte-identical (blit path only); measured throughput gain on wasm→canvas transfer path across 4 fleet hosts + ledger row; 13/13 sim goldens unchanged | 20.1b | cc:完了 [b150eec] |

## 20.4d, 20.5, 20.5a, 20.5b — N64 beyond the emulator gate: **BLOCKED**

`20.4c` is done and green (`n64-demos`, 13/13 bit-identical on emulated N64),
and these four sit past it.

- **20.4d, SummerCart64 hardware evidence** — **blocked on a device.**
  `sc64deployer` is not installed and no USB serial device is present. Nothing
  in this repository can move it.
- **20.5 / 20.5a, the RDP renderer** — **blocked on a decomposition.** A second
  rasterizer with its own golden family under a 0-line `engine/core` diff
  constraint is a phase, not a task; it needs a 20.1b-style breakdown before
  anyone starts, and it does not have one.
- **20.5b, RDP hardware speedup** — **blocked twice**: on 20.5a and on the same
  missing device as 20.4d.

| Task | 内容 | DoD | Depends | Status |
|------|------|-----|---------|--------|

| 20.4d | N64 SummerCart64 hardware evidence + fps: load ROM on real N64 via SummerCart64; capture UART log; compare against ares expected output; measure fps on hardware + ares (both committed) | committed UART capture (tools/n64/sc64-uart.log) showing D_DoomMain + at least one demo completing; fps committed for both ares and hardware; any ares divergence filed as FINDING; partial filed as partial (no fabrication) | 20.4c | cc:TODO |
| 20.5 | **DECOMPOSED** N64 sub-phase B (the first): RDP-rasterized columns/spans while the playsim stays bit-exact — no demo-exact vanilla port has ever shipped RDP-assisted rendering | (superseded — see 20.5a–20.5b) | 20.4 | cc:分割 |
| 20.5a | **Depends corrected 25.4a: was 20.4d (hardware), now 20.4c.** N64 RDP renderer + ares gate: implement RDP-rasterized column/span rendering alongside existing software path; enable via `WEBDOOM_RDP_RENDER` build flag; playsim untouched — ares 13/13 sim gate must still pass | ares 13/13 sim gate (20.4c script) exits 0 with RDP path enabled (sim hashes unchanged — render path does not affect playsim); own render golden set committed for RDP visual output (not vanilla); engine/core diff vs master = 0 lines (RDP path in tools/n64/ shim only) | 20.4c | cc:TODO |
| 20.5b | N64 RDP hardware speedup measurement: run sub-phase A ROM and sub-phase B ROM on real N64 via SummerCart64; measure fps for both; commit comparison | committed fps comparison (tools/n64/rdp-speedup.md): sub-phase A fps vs sub-phase B fps on hardware (≥1 map/area); speedup % stated; FINDING filed if RDP is slower or within noise; no record claim — the numbers are the deliverable | 20.5a | cc:TODO |

---

Retired by round 11. The open table in `Plans.md` keeps only rows with an owner
and a machine to run them on.
