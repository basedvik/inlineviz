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

## 2026-10-13: context grid fills column-major

User report (screenshot, qwen3.8-27b, `ctx 20k/262k` in the sidebar): only the top-left blocks drove the
animation. The cause: the grid is drawn to scale against the context *limit* and filled row-major, so ~8%
usage put every filled cell, every attention dot, and therefore every bright router line in one row.
- The grid now fills **column-major** (columns left → right, each top → bottom) via a single `gridCell()`
  helper in `layout.ts`, used by the grid drawing, the prefill wave, and the router-line origins.
  Proportions are unchanged (still honest); a small context now spans many rows.
- Attention picks are less recency-biased (`r^2.2` → `r^1.4`).
- New test `GridFillsColumnMajor` (8% of a 262k context at 40×14 spans > 3 rows, ≤ 2 columns).
  Goldens were regenerated after eyeballing 40×14 frames: the routing now leaves from ~8 rows instead of 1.

## 2026-10-13: architecture discovery (server metadata + Hugging Face)

User question: how to accurately get the shape of their own models (screenshot: `qwen3.8-27b-bf` showed
`arch unknown`). What I found, live:
- **OpenCode's config / models.dev metadata** identifies models (family, `open_weights`,
  `canonical_model_id`) but never describes them (no layers/experts). A name table alone breaks on
  community builds.
- **mlx-serve** (the user's Mac Studio, `http://…:11234/v1/models`) reports `num_layers` and `is_moe`
  in each model's `meta`. **llama.cpp** reports only `n_embd`/`n_params`/`n_ctx_train`, with no layers.
- **Hugging Face `config.json`** is exact whenever the model ID is a repo ID (true for MLX):
  `mlx-community/Qwen3.8-27B-bf16` = dense, 64 layers, `layer_types` 3 linear : 1 full attention;
  `ddalcu/Qwen3.8-Flash-Next-…` = MoE 512 experts / 10 active / shared expert, 48 layers. mlx-serve's
  `architecture: "qwen3_5_moe"` label for the 27B is just a family string; its `is_moe: false` and the HF
  config agree that it's dense.

Built:
- `src/core/archparse.ts` (pure): `archFromHFConfig` (incl. `text_config` wrappers, shared experts via
  `n_shared_experts` / `shared_expert_intermediate_size`, full-attention layers from `layer_types`),
  `archFromOllamaShow` (GGUF `*.block_count` / `*.expert_count` / `*.expert_used_count`),
  `archFromServerMeta` (mlx-serve), `mergeArch`, `looksLikeHFRepo`.
- `src/adapters/discover.ts` (I/O): provider `baseURL` → `GET /models` meta → Ollama (`/api/version`
  gate, then `POST /api/show`) → Hugging Face config (full shape, or only the attention pattern when
  it agrees with the server). 4 s timeouts, no auth headers ever, cache hits 7 d / misses 1 d.
- New `arch` Signal; Sim keeps `discovered` per modelID (survives resets). Resolution order:
  override → discovered → table → unknown. HUD shows provenance (`· via server` / `· via HF` /
  `· custom`) and marks full-attention layers in the layer counter (`L 4/64 full-attn`).
- TUI plugin: discovery on every new model, cached in `api.kv`, option `archLookup` = all|server|off.
  CLI `attach` uses it too (provider baseURLs from `/config/providers`).

Evidence:
- `bun test` → 127 pass. 22 new tests run against **real fixtures** (`test/fixtures/hf/*.json` fetched from
  huggingface.co: Qwen3.8-27B, Flash-Next, DeepSeek-V3, Qwen3-30B-A3B; `test/fixtures/mlxserve-models.json`
  from the user's mlx-serve). DeepSeek-V3 and Qwen3-30B-A3B parse to exactly the registry values.
- Live discovery: 27B → `dense · 64L (via server)` + 16 full-attention layers in 260 ms; Flash-Next →
  `MoE 512e/10a · 48L (via hf)` + 12 full-attention layers; llama.cpp qwen3.6 → unknown (expected); Claude → unknown.
- Frames: the sidebar shows a dense `┃` column + `illustrative` label; full width shows
  `dense · 64L · via server`; the layer counter sweeps 1→64 and shows `full-attn` on layers 4, 8, ….

Open: llama.cpp-only setups still need the `arch` option (llama.cpp doesn't expose layer counts; reading
the GGUF header locally would fix it when the file is on the same machine).

## 2026-10-13: sidebar label truncation

User screenshot (sidebar, 37 cols): the model name read `qwen3.8-27b-bf`, i.e. `qwen3.8-27b-bf16` silently cut to
fit beside `▸ DECODE 11t/s`, which looked like a glitch.
- Compact layouts now use `shortModelName()` (registry.ts): provider prefix plus trailing noise suffixes
  (precision/quant/packaging/flavor: `-bf16`, `-q4_k_m`, `-8bit`, `-mlx`, `-serve`, `-mixed-4`, `-instruct`,
  `-it`, `-uncensored`, …) stripped from the end only, so `-reap-288` and `-2507` survive. Full width
  still shows the whole ID.
- Any truncated HUD segment now ends in `…`.
- Tests: 8 real-ID cases + `SidebarShowsShortModelNameUncut` (the screenshot case at 100+ tok/s) +
  `TruncatedLabelsEndWithEllipsis`. 137 pass; goldens unchanged.

## 2026-10-13: Claude Code plugin (no npm needed)

The user is locked out of npm, so this is the next host. Claude Code plugins install from a GitHub repo
that's its own marketplace.

**Verified first** (docs + a probe plugin that recorded payload *shapes* only, Claude Code 2.1.283, Haiku):
- Hooks give phases, tools (`tool_use_id`), `PostToolBatch` (model resumes), `SubagentStart/Stop`
  (`agent_id`, `agent_type`; subagent tool calls carry `agent_id`; `agent_type: ""` = internal helpers that
  never fire SubagentStart), `SessionStart.model`, `Stop`/`StopFailure`. `async: true` hooks never block.
- **No live token stream:** `MessageDisplay` has `delta`/`index`/`final` but fired once per message with the
  whole text (1,342 chars), so decode can't be measured live.
- The transcript writes each content block as its own line; lines share `message.id` and repeat the final
  usage incl. `output_tokens_details.thinking_tokens`. Exact per message, but only after the message ends.
- Plugins can't draw in Claude Code's UI, so the viewer runs beside it.

**Built**
- `src/adapters/claude.ts` (pure): hook record + transcript → Signals; usage dedup by message.id;
  `seedFromTranscript` folds history into context; no assumed context window (`[1m]` → 1M).
- `claude/hook.mjs` + `hook.sh`: async recorder; writes ONLY event, ids, tool name, model, error type to
  `${CLAUDE_PLUGIN_DATA}/events.ndjson` (5 MB rotation). Tested: a payload with a secret command and prompt
  writes neither; garbage input exits 0.
- `src/adapters/claude-tail.ts`: byte-offset polling of the events file + the followed transcript; follows the
  newest active session; bootstraps the unfinished turn; **rediscovers the events file** if the plugin's data
  folder appears after the viewer started.
- Sim **estimate mode** (new `mode {streaming:false}` signal): PREFILL for 0.6 s, then `▸ WORKING ≈N tok/s`
  pulses at the pace learned per model from real messages (default 40). Estimated pulses never count into
  the context grid; real usage lands exactly. Late usage is paired with the oldest pending step start (queue),
  and usage never ends WORKING; only tool.start / Stop / error do.
- CLI `claude` + `open` (tmux split → Terminal/iTerm via osascript → print the command); `cli-entry.ts`
  + `bun run build:cli` → `dist/inlineviz.mjs` (151 KB, runs on Node 20).
- Plugin: `.claude-plugin/{plugin,marketplace}.json` (repo root = marketplace + plugin), `hooks/hooks.json`,
  `commands/viz.md`, `commands/viz-demo.md`, `bin/inlineviz` (on Claude's Bash PATH). `claude plugin validate`
  passes for both manifests.

**Live verification** (real Claude Code sessions with `--plugin-dir`, viewer in a second PTY)
- Final run: idle → PREFILL → `WORKING ≈40` → `⚙ Agent` → `+1 agents` → `⚙ Bash` → PREFILL → real usage
  `ctx 38k 79% cached · think ~123 · out ~154` → `WORKING ≈69` (learned) → idle → Claude's self-started follow-up
  turn `WORKING ≈72` → idle.
- `inlineviz open demo` inside a detached tmux session opened a second pane running the viewer.

**Bugs found live and fixed:** a pinned `-session` never focused (unit test); a viewer started before the
plugin's first run never found the events file; late usage stalled the next step in PREFILL (twice: after a
tool batch, and across Claude's self-started follow-up turn).

**Process gotchas**
- Claude Code launched from *inside* Claude Code inherits `CLAUDE_CODE_CHILD_SESSION=1` and doesn't write
  its transcript. Test with `env -u CLAUDECODE -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_SESSION_ID …`.
  It also skipped transcripts for sessions in temp folders.
- In zsh, `$VAR` holding `env -u …` isn't word-split (exit 127): write it inline.
- The folder-trust prompt defaults to "No, exit": send arrow-down before Enter.

**Open:** subagent lanes (data is there: per-agent tool events); the Claude Code context window size is
unknown (shows ~200k); `MessageDisplay` might stream in a future Claude Code version, in which case decode
would become real.
