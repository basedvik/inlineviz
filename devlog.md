# devlog

Running log for opencodeviz. Newest entries at the bottom. The user commits to git
themselves, so instead of one commit per build step (SPEC §15), each step is logged
here with its evidence.

---

## 2026-10-12 — Step 0: baseline + environment

**Environment**
- macOS (darwin 25.5), zsh, `COLORTERM=truecolor`, `TERM=xterm-256color`.
- Node 20.19.3. **Bun was not installed** → installed with `brew install oven-sh/bun/bun` (1.4.3).
- OpenCode 1.18.32 (Homebrew), running as pid 9195 during this session.
- User's TUI plugins (`~/.config/opencode/tui.json`): `opencode-tps-meter@latest`.

**Baseline (before installing the plugin)**
- OpenCode idle CPU: 0.1–0.3% (3 × 1 s samples with `ps -o %cpu`), RSS ≈ 1.40 GB.
- tps meter: installed and registered in both `tui.json` and `opencode.jsonc`. It can't be
  eyeballed from this session; re-check by hand after installing opencodeviz.

**SPEC §18 unknowns resolved by reading OpenCode's bundled source**
(`strings` on `/opt/homebrew/Cellar/opencode/1.18.32/bin/opencode`)
- *Local TUI plugin spec:* `Jq(spec) = spec.startsWith("file://") || spec.startsWith(".") || isAbsolute(spec)`
  → source `"file"`. For a directory, OpenCode reads `package.json` and uses
  `exports["./tui"]` (`import` or `default` condition). An absolute path works.
- *`live` + `renderAfter` on `box`:* the Renderable constructor copies `renderBefore/renderAfter` from
  options; `render()` calls `renderAfter.call(this, buffer, deltaTime)` after `renderSelf`.
  `live` is a real setter that propagates `liveCount` to its parents. Setting both via
  `setProp` assigns the fields, so this works.
- *Coordinates:* `x`/`y` getters sum the parents' `_x`; rendering uses `_screenX/_screenY`
  (`screenX`/`screenY` getters exist). The plugin draws at `screenX/screenY` and falls back to `x/y`.
- `OptimizedBuffer.setCell(x, y, char, fg, bg, attrs = 0)` and `RGBA.fromInts(r, g, b, a = 255)` confirmed.
- *Commands:* the non-deprecated API is `api.keymap.registerLayer({ commands: [{ name, title, slashName,
  category, namespace: "palette", run() }] })`, as used by OpenCode's own diff-viewer plugin.
  Implemented that, with `api.command.register` as a fallback.

Still open (needs a live OpenCode session): provider `input` vs cached-token semantics,
`session.next.*` event names on this build, sidebar slot size, `⬢` width.

**Deviation from SPEC:** no git commits (the user will commit); this devlog replaces the
per-step commit trail.

## Steps 1–4: scaffold, Frame/braille/VT, Sim/Driver, registry

**Built**
- `package.json` (exports `.` and `./tui` → `src/hosts/opencode-tui.ts`; `@opentui/*` and the plugin as
  optional peers, so nothing gets bundled), `tsconfig.json` (strict), `.gitignore`.
- `src/core/protocol.ts` (Signal types + `isSignal` validator + `SignalBody`), `frame.ts` (port of
  tdef `render/frame.go`: `set`/`toText`/`toAnsi`, rounded box, `embedSegment`/`centerEmbed`),
  `palette.ts` (reference-image colors + quantized `shade`), `render/braille.ts`.
- `src/core/sim/{sim,driver,rate}.ts`: the phase machine from SPEC §7.1, calibration, degraded
  usage-only path, pulse emitter, `contextView()`. `registry.ts`: the SPEC §8 seed table.
- `test/vt.ts`: ANSI screen reconstructor (the tdef retro lesson).

**Evidence:** `bun test` → 63 pass / 0 fail; `tsc --noEmit` clean.

**Bugs caught by tests**
- My own test expected `embedSegment` to return 7. The correct value is 6 (┤ at 1, text 2..4, ├ at 5).
  As tdef's retro says, interrogate the check first.
- Real bug: after the catch-up clamp shifts `t0`, `(ts - t0) / 33.33…` landed at 9.999999, so the
  next tick never came. Fixed with a 1e-6 epsilon in `Driver.tickOf`.

**Deviations from SPEC**
- `applySignal(s, sig)` has no `atTick` parameter. The Driver applies due signals at the current
  `sim.tick` before each step, which is simpler and equally deterministic.
- Pulse emitter: a minimum gap of 3 ticks means ≤ 10 pulses/s (SPEC said 14/s, which 3-tick gaps
  can't reach). Tokens per pulse = `ceil(tps/10)`, and when the bank exceeds 4× that it drains
  `bank/4` per pulse. `EmitterCapsPulseRate` checks both the rate cap and token conservation.
- Context bookkeeping added (not in SPEC): `promptGenBase` and a fold on `turn.start`, so a step's
  own output isn't double-counted once the next usage arrives.

## Steps 5–7: layout (test-first), renderer, demo, CLI + ANSI backend

**Built**
- `test/layout.test.ts` was written **before** `layout.ts`, with rects hand-computed from the SPEC §9.1
  formulas at 40×14, 62×19, 90×30, 137×45, plus a property sweep over every size w∈[1,220] × h∈[1,70]
  (regions inside the box, x-disjoint, comet row). It passed on the first implementation.
- `render/illustrate.ts` (seeded PRNG; the only randomness), `render/viz.ts` (pure `renderViz`),
  `render/strip.ts`, `core/demo.ts` (5 deterministic scripts + `all`), `core/headless.ts` (virtual-clock
  playback), `hosts/cli.ts` (demo/replay/stdin/attach/capture/screens/registry/help),
  `backends/ansi.ts` (diff Blitter + Terminal loop, tdef style), `adapters/ndjson.ts`.

**Eyeball passes** (`opencodeviz screens`); each found something tests didn't:
1. The right logit fan saturated into a solid `⣿` block (the SPEC's warned failure). It had two causes:
   (a) a braille cell has one fg color, so a bright active line *promoted* the faint mesh dots
   sharing its cell; (b) output nodes on adjacent rows meant converging lines filled every row.
   Fixes: a braille **dominance rule** (contributors dimmer than 0.5× the brightest drop their dots),
   **output nodes spaced two rows apart** (as in the reference image), and active projection
   to sampled + 3 nodes from ≤ 3 hidden rows. The static logit mesh is every 4th hidden row,
   stippled.
2. A tool phase showed the stale pre-tool `76 tok/s`, which was misleading, so it was removed.
3. The ctx segment said "0% cached" before any usage existed. It now reads `ctx ? + 13 new / 131k`.
4. The strip mini-bar drew a full `█` for a sliver of context; it now uses the `░▒▓█` partial ramp.
5. Overlapping pulses painted most of a small context orange with attention dots. Dots now come
   from the newest pulse only, 2–4 of them.
6. The compact header truncated the model name, so the compact label is "THINK" (full stays "REASONING").
7. The grid was all `·` until the first step.end because prompt size is unknown, which is honest for
   a brand-new session. The `moe-chat` and `closed` demos now start with a prior step's usage
   ("resumed session") so they're representative.
- Added `screens -visible 0.3`: blanks cells below a luminance threshold. Plain text can't show
  intensity, and this is how fix 1 was verified.

**Evidence**
- `bun test` → 87 pass / 0 fail. Render tests cover SPEC §16 *render*: Deterministic, Animates,
  IdleBreathes, FitsFrame (1×1…220×70), a PhaseScript (tdef TestTitlePhases style), ExactlyKExpertsLit,
  SharedExpertsAlwaysLit, DenseColumnUniform, UnknownShowsLabel, HonestySegmentNeverDropped
  (3 archs × 27 sizes, with a long tool name competing for space), HudModelInTopBorder,
  ContextGridMatchesUsage (±1 cell), CometLandsThenCellAppears, plus 3 golden files.
- Goldens were regenerated with `UPDATE_GOLDEN=1` only after reading the frames.
- Interactive: ran `opencodeviz demo agentic` under `script` (a PTY) and sent `q` after 4 s →
  111 frames (~28 fps), and the VT reconstruction of the byte stream shows a clean compact frame
  (tool phase, `⚙ bash 0.2s`, `ctx 9.2k/131k`). The exit stream ends with `?25h` + `?1049l`, so the
  terminal is restored.
- Perf (agentic script, 600 frames): render + blit = **0.23 ms/frame at 120×40** (budget 2 ms),
  0.42 ms at 200×60; ~4 KiB/frame of ANSI at 120×40.

**Deviations from SPEC**
- `Layout` has no `topSegs`/`bottomSegs` rects. HUD segments are placed by `placeSegs()` with
  priorities inside the box, and the honesty-label guarantee is tested at render level.
- Output column `out.h = 2·outN − 1` (nodes every other row); `outY(L, i)` is the accessor.
- Compact mode draws a `─` connector into the sampled output node, since it has no logit fan.

## Steps 8–10: OpenCode adapter, live verification, TUI plugin, attach/record

**Built**
- `src/adapters/opencode.ts`: `OpenCodeAdapter`. Primary path is v1 events (`session.status`,
  `session.idle`, `session.error`, `message.updated`, `message.part.updated`, `message.part.delta`); the
  `session.next.*` / `session.*` delta events are feature-detected per session, and once seen, v1 deltas
  for that session are suppressed. Part kinds are learned from `message.part.updated`, because deltas
  don't carry the type. Full-text part updates count only their growth, so providers that don't
  stream deltas still work. User-message text and messages that aren't live are ignored. Focus = the TUI
  route's session, else the most recently busy one. Other busy sessions → `subagents`.
- `src/adapters/opencode-sse.ts`: `attach` over `GET /event` with reconnect; context limits come from
  `GET /config/providers`.
- `src/backends/opentui.ts` (Frame → `setCellWithAlphaBlending`, transparent DEFAULT bg, RGBA cache)
  and `src/hosts/opencode-tui.ts`: the sidebar slot, a strip slot, `/viz` + `/viz-demo` via
  `api.keymap.registerLayer` (with `api.command` fallback), startup seeding of model + context from
  `api.state`, and the `OPENCODEVIZ_DEBUG=<file>` geometry/timing log.

**§18 unknowns resolved**
- *Token semantics:* OpenCode's bundled source computes, for every provider,
  `input = max(0, inputTokens − cacheRead − cacheWrite)` and `output = outputTokens − reasoning`.
  So `input` excludes cache, the prompt is `input + cache.read + cache.write`, and no per-provider
  rule is needed. (`PromptTokensMatchOpenCodeNormalization` pins this.)
- *Runtime module sharing:* OpenCode registers virtual modules for its runtime packages
  (`J.module(spec)` + exact-specifier `onResolve`), so the plugin's `@opentui/*` imports resolve to
  the host's copies even though this folder has its own `node_modules` (installed for types). The
  plugin rendered correctly in the live TUI, which confirms it.
- *Sidebar slot size:* 37×14 at (100,3) in a 140×45 terminal, which is compact mode.
- *Dialog placement:* OpenCode puts dialog content starting around mid-screen (y=22 of 45, 116 wide).
- *`session.next.*` events:* not observed on this build during live runs; the v1 path carried everything.

**Live verification** (OpenCode 1.18.32, your default model `llamacpp/qwen3.6-35b-a3b-uncensored` on
the Mac mini at :11435, so no API cost)
1. `opencode serve --port 4199` + `opencodeviz attach … -record` + two `opencode run --attach` prompts
   (a text reply; a bash tool call). The recorded Signals show the full real sequence:
   `turn.start → model(contextLimit 131072) → step.start → reasoning deltas → text deltas → step.end
   (input 4, cacheRead 14776) → idle`, and for the tool prompt `tool.start(bash) → tool.end(ok) →
   step.end(finish tool-calls) → step.start → step.end(stop) → idle`. The first prompt sat in a
   real ~60 s+ PREFILL (the Mac mini prefilling the ~14k-token system prompt); later prompts hit the
   llama.cpp prompt cache. The recording is saved as `test/fixtures/live-qwen-tool.ndjson`
   (Signals only, no content) with a replay test.
   - Note: this provider reports `reasoning: 0` even though reasoning streams as reasoning parts
     (the reasoning tokens are inside `output`). Calibration uses `output + reasoning`, so it's unaffected.
   - Reconstructing the attach viewer's PTY output showed PREFILL → THINK → `⚙ TOOL` + `⚙ bash` badge →
     `ctx 15k/131k`, all correct.
2. TUI plugin, appended to `~/.config/opencode/tui.json` (original backed up as
   `tui.json.backup-20261012-opencodeviz`; `opencode-tps-meter` kept). I drove a *separate*
   OpenCode TUI in a 140×45 PTY (`opencode -c` in a scratch dir) and reconstructed its screens:
   - the sidebar viz renders above OpenCode's Context section;
   - `/viz` and `/viz-demo` show in slash autocomplete ("Toggle model visualizer", "Model visualizer: play demo");
   - a prompt typed in the TUI animated `○ idle → ▸ PREFILL 0.0s…1.2s → ▸ THINK 2t/s → 28t/s → ○ idle`;
   - the `/viz` overlay renders full mode with the HUD inside the screen.

**Bugs found live and fixed**
- *turn.start never fired on a session's first busy event.* The busy map was updated before the
  "was busy" check. Caught by the fixture test `BasicTurnSignalSequence`.
- *Sidebar showed "no model yet" / `ctx ?`.* Startup seeding marked itself done before OpenCode had
  loaded the messages. It now retries until an assistant message is found.
- *Overlay overflowed the screen* (31 rows from y=22 of 45). It now starts at 45% of the height,
  shrinks itself once to fit if needed, and never draws past the screen edge.
- *Idle CPU.* See below.

**CPU** (`ps %cpu`, 12 × 1 s samples, OpenCode TUI idle in a 140×45 PTY, same session)

| config | idle | active (`/viz-demo` playing) |
|---|---|---|
| `--pure` (no external plugins) | 1.19–1.35% | – |
| tps-meter only (your original config) | **1.48%** | – |
| first cut: `live` + 10 fps idle breathing | 16.1% | – |
| requestRender pacing, 2 fps idle | 8.5% | – |
| **final: static idle frame (`idleFps 0`)** | **2.15%** | **23.3% @ fps 20** (16.1% @ fps 5, 24% @ 30) |
| overlay open, idle | 2.72% (built-in `/models` dialog under `--pure`: 2.14%) | – |

`OPENCODEVIZ_DEBUG` timing shows *our* `renderAfter` costs ~1.0 ms/frame (116×20 overlay) + ~0.5 ms
(37×14 sidebar) at a steady ~19 fps, i.e. < 3% CPU. The rest of the active cost is OpenCode
re-rendering its whole screen for each frame we request (~9 ms/frame). That's inherent to animating
inside the host, so `fps` is an option and the README documents the cost. In-OpenCode defaults:
`fps 20`, `idleFps 0`. The standalone CLI keeps idle breathing.

**Incident (no lasting effect):** in the first TUI PTY run, OpenCode showed its own "Update Available
(v1.19.0)" dialog, and my scripted Enter (meant for `/viz`) confirmed it ("Updating to v1.19.0…"),
then Ctrl-C interrupted it. Verified afterwards: `opencode --version` = 1.18.32, Homebrew Cellar has
only 1.18.32, the `/opt/homebrew/bin/opencode` symlink resolves to it, `brew info` lists 1.19.0 as
*available* (not installed), and no brew process is running. Every later run sets
`OPENCODE_DISABLE_AUTOUPDATE=1`.
**Process gotcha:** when driving any TUI with scripted keys, disable its auto-update/modals first.

**Deviations from SPEC**
- Frame pacing inside OpenCode uses `requestRender` from a timer, not `live` (measured above).
- Overlay height is adaptive rather than fixed 100%.
- `attach` is implemented; the `-tmux` convenience flag is not (parked).

## Parked debt / open items
- **Your model's shape:** `qwen3.6-35b-a3b` shows `architecture unknown`. llama.cpp's `/v1/models` and
  `/props` expose size and `n_embd` but not layers/experts, and the GGUF is on the remote Mac mini.
  Options: add an `arch` override (README), or build a GGUF-header reader (block/expert counts) for
  local files / Ollama's `/api/show` (WEB-SPEC §5.4).
- **Overlay close** (`/viz` toggle / `esc`) isn't visually verified. OpenTUI redraws only changed
  cells, so the PTY reconstruction can't distinguish a closed dialog from stale cells. Check by hand.
- **Colors** were checked numerically and through the `-visible` luminance view, not by eye in a real
  truecolor terminal. Look at `bun src/hosts/cli.ts` in Ghostty/iTerm and tune `palette.ts` if needed.
- `opencode-tui.ts` has no unit test (it needs the OpenTUI/Solid runtime); it's covered by the live
  PTY runs above.
- No `-tmux` split helper; no `strip` surface verified live (unit-tested via `screens -size 40x1`).
- `session.next.*` fast path is untested against a build that emits it.
- GLM-4.5 registry row is marked `verify`.

## Packaging for other people (inlineviz)

- Renamed the package / plugin id / CLI to **`inlineviz`** (matches the GitHub repo; the npm name
  was free on 2026-10-12). Commands are `inlineviz.toggle` / `inlineviz.demo`; the slash commands
  are still `/viz` and `/viz-demo`. The debug env var is `INLINEVIZ_DEBUG` (`OPENCODEVIZ_DEBUG` is
  still accepted).
- `bun run build` → `dist/tui.js` (67 KB ESM, target bun). Externals: `@opentui/*`, `solid-js`,
  `@opencode-ai/*`, so they resolve to OpenCode's runtime copies. `exports` `.` and `./tui` point at
  `dist/tui.js`. **`dist/` is committed**, so a plain `git clone` + `file://` path works without a build step.
- `prepublishOnly` = build + test + typecheck. `files` = dist, src, README, LICENSE (npm pack: 61.5 KB).
- `@opencode-ai/sdk` moved to `dependencies` (the CLI's `attach` needs it).
- Added an MIT LICENSE (holder: the GitHub handle `basedvik`) and rewrote the README for users:
  install via `opencode plugin inlineviz` / `tui.json` / GitHub, plus options, uninstall,
  troubleshooting, and the measured CPU cost.
- Local dev: `tui.json` → `file:///…/opencodeviz` now loads `dist/tui.js`, so **run `bun run build`
  after source changes**.

### Install paths: what was verified (correction)
- **`github:basedvik/inlineviz` in `tui.json` does NOT work** on OpenCode 1.18.32. In an isolated test
  (`XDG_CONFIG_HOME` pointing at a config whose only plugin was the GitHub spec), OpenCode created
  `~/.cache/opencode/packages/github:basedvik/inlineviz/` but never populated the package, and nothing rendered.
  Plain `npm install github:basedvik/inlineviz` *does* install correctly, so this is OpenCode's
  installer, not the package. OpenCode's docs list only npm packages and local paths, so the README
  no longer offers a GitHub spec.
- An earlier "pass" was a false positive: `OPENCODE_TUI_CONFIG` *adds* a TUI config on top of the global
  one, so the user's `file://` entry was what rendered. Use `XDG_CONFIG_HOME` for isolated config tests.
- **Verified:** `file:///abs/path` to a checkout (loads `dist/tui.js` via `exports["./tui"]`).
  **Not yet verified:** `inlineviz@latest` from npm (not published; tps-meter proves the mechanism).
- **OpenCode 2 / V2 plugins:** upstream docs say "V1 plugin implementations do not run in V2". V2 CLI
  plugins use `Plugin.define({ id, setup(context) })` from `@opencode/plugin/tui`, configured in
  `cli.json` `plugins`, with `sidebar.content` and `session.panel` slots. The CLI's latest release is
  1.19.0 (V1); `@opencode/plugin` is at 2.0.27. V2 support is parked debt (a new host file + event
  mapping; the core is reusable). tps-meter's `./tui` + `./v2/tui` layout is the reference.
