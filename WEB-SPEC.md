# opencodeviz/web — Go/Rust daemon + web canvas: Implementation Spec

## Prompt (paste this to the coding agent)

```text
You are implementing the web variant of opencodeviz in /Users/vikrambhaduri/occ/opencodeviz:
a local daemon (vizd) that listens to the user's agent harness, plus a browser canvas that
animates what the LLM is doing live. Language: <Go | Rust>. Default to Go if unspecified.

WEB-SPEC.md is the contract for this variant. SPEC.md is the source of truth for the
Signal protocol (§5), Sim (§7), registry (§8), scene semantics (§9), the real-vs-illustrative
rule (§4) and demo scripts (§12). Read both fully, then execute WEB-SPEC §11 (Build order)
step by step in this one session. Transcribe; don't redesign. Log any deviation in
devlog.md.

Non-negotiables:
- One core, compiled twice: native (vizd, tests, capture) and WASM (browser). The core
  has no I/O, no clock and no unseeded randomness. Native and WASM must match on every
  conformance fixture (NativeEqualsWasm_*).
- The browser owns animation. vizd sends Signals only (SSE), never rendered frames.
- Security (§7): bind 127.0.0.1, require the token, check Host and Origin. The proxy
  passes bytes through unchanged with no added latency, and never logs or records
  bodies, keys or auth headers.
- Look at the output: read `vizd capture -text` frames, and view the frozen-fixture page
  in a browser, before committing goldens.
- Harness config edits (Claude Code settings.json, OpenCode plugin): back up first, keep
  them idempotent, and make sure hooks never block the harness.
- One green commit per build step. Resolve each §12 unknown by checking, and record it.

When done, report:
1. what works, with evidence;
2. which harnesses you verified live;
3. how each §12 unknown resolved;
4. deviations from the spec;
5. parked debt;
6. exact commands for me to run it.
```

---

> A local daemon (`vizd`) that **listens to the user's agent harness** (OpenCode, Claude Code, Codex, Aider, Ollama, or anything that speaks the Anthropic/OpenAI API) and drives a **browser canvas** rendering of the same visualization as the terminal version.
>
> This is a companion to `SPEC.md`, which stays the source of truth for the **Signal protocol (§5)**, **Sim (§7)**, **architecture registry (§8)**, **layout/pulses/phase looks (§9)**, **real-vs-illustrative rule (§4)** and **demo scripts (§12)**. This doc only specifies what differs: the language, the display-list abstraction, the daemon, harness adapters, the canvas renderer and security. It follows the same `../tdef` patterns (`SPEC.md` §1).
>
> Like `SPEC.md`, it's a contract: signatures, invariants, a named test list and a single-session build order (§11).

---

## 0. TL;DR for the implementing agent

- **One core, compiled twice.** `core` (Sim + scene → display list) is written once in **Go** (default) or **Rust**. It's compiled **natively** into `vizd` (tests, headless capture) and to **WASM** for the browser.
- **The browser owns animation.** `vizd` forwards **Signals** only (SSE). The browser runs the deterministic Sim at a fixed 30 Hz and renders at display rate. Never stream rendered state over the wire.
- **The display list is the seam.** The scene emits draw commands in abstract layout units (§3). Two rasterizers consume them:
  - JS **canvas** (web);
  - native **cells** (braille text frames for `vizd capture -text`, the "read the frames" tool).
- **Adapters live in `vizd`.** The fidelity ladder: streaming API proxy > OpenCode event forwarder > Claude Code hooks + transcript tail > generic NDJSON (§5).
- **Localhost security is mandatory** (§7): 127.0.0.1 only, random token, Origin/Host checks.

---

## 1. Language choice

| | **Go (default)** | **Rust (alternative)** |
|---|---|---|
| Why | Matches `../tdef`: **stdlib only**, deterministic core, same `Frame` model | Best canvas smoothness; small WASM, no GC hitches |
| Daemon | `net/http`, `embed`, `net/http/httputil.ReverseProxy`, `bufio` SSE parsing; browser push via **SSE** (`EventSource`), so no WebSocket dependency | `tokio`, `axum` (SSE), `hyper`/`reqwest` (streaming proxy), `rust-embed`, `notify` (file tail) |
| WASM | `GOOS=js GOARCH=wasm` + `syscall/js`; copy `wasm_exec.js` from `$(go env GOROOT)/lib/wasm/` (older Go: `misc/wasm/`). Several MB, which is fine on localhost. **Allocate nothing in the per-frame path** (reuse buffers) to avoid GC pauses. | `wasm-bindgen` + `wasm-pack build --target web`; `viz-core` is `#![no_std]`-friendly with zero deps |
| Layout | `cmd/vizd/`, `internal/{protocol,sim,registry,scene,cells,adapters,server}/`, `wasm/main.go`, `web/` | workspace: `viz-protocol`, `viz-core` (sim+registry+scene+cells), `viz-wasm`, `vizd`; `web/` |

Pick one at step 0 and record the choice in `devlog.md`. Everything below applies to both; "Go:" / "Rust:" notes mark the differences.

---

## 2. Architecture

```
 harness ──▶ vizd (native)                                   browser (127.0.0.1:7777/?t=TOKEN)
            ├─ adapters/* ──▶ Signal{sessionKey, rxTs, ...}   ├─ app.js: EventSource /stream
            ├─ hub: per-session ring buffers + fan-out ──SSE──▶├─ core.wasm: Driver + Sim + scene
            ├─ recorder (NDJSON, Signals only)                ├─ raster-canvas.js: display list → <canvas>
            ├─ capture: core(native) → cells → text frames    └─ session picker, skin toggle, labels
            └─ embedded web assets
```

Invariants:
- `core` imports nothing from `server`/`adapters`/I/O. The hygiene test from SPEC §16 applies, with no clock and no unseeded randomness.
- The browser's Sim state at tick *t* must equal the native Sim state at tick *t* for the same Signal stream (conformance, §10).

---

## 3. Display list (the core ↔ rasterizer contract)

The scene emits commands in **layout units**: `x` in `[0, cols)`, `y` in `[0, rows)`, where `cols×rows` is a virtual cell grid chosen by the rasterizer (the terminal uses real cells; canvas uses `cols = floor(cssW / cellPx)`). `layout(cols, rows, arch)` from SPEC §9.1 is unchanged and remains the single source of geometry.

```
op        fields (all f32 unless noted)                                  notes
LINE      x0 y0 x1 y1  color:u32  intensity  reveal(0..1)  stipple:u32    progressive reveal = SPEC §9.3
NODE      x y  shape:u32(hex|circle|ring|diamond|hexShared)  color:u32  intensity
CELL      col row  kind:u32(cached|fresh|reasoning|text|empty)  fill(0..1)  intensity
COMET     x y  dx  color:u32  intensity  length
TEXT      x y  str:u32(index into string table)  color:u32  role:u32(phase|model|arch|ctx|tool|label)
BORDER    x y w h  color:u32                                              the tdef-style frame
SEGMENT   edge:u32(top|bottom)  x  str:u32  color:u32  priority:u32       HUD segment in the border
```

Encoding (zero-copy across the WASM boundary):
- One `ArrayBuffer`: a header `{u32 count, u32 strCount, u32 strBytes}`, then fixed 12-word records (`u32 op` + 11 × 32-bit fields, unused = 0), then a UTF-8 string table. JS reads records through a `Uint32Array` + `Float32Array` view over the same buffer.
- Records are **sorted by (layer, color)**: static → grid → lines → nodes → comets → text, which keeps canvas state changes to a minimum.
- The honesty label (`TEXT role=label` / `SEGMENT priority=max`) is **always emitted** in full/compact layouts. Rasterizers must draw it; a test enforces this.

Core API (both languages):
```
NewCore(seed) ; Push(signalJSON) ; AdvanceTo(nowMs) ; Render(cols, rows, alpha, palette, opts) → *DisplayList
DisplayList.Bytes() (WASM: pointer+len into linear memory, JS creates the views; no per-frame copy)
```
`alpha ∈ [0,1)` is the fractional tick for smooth motion at 60–120 Hz. Rendering uses `tick + alpha` for pulse progress `u`. **Purity:** the same `(state, cols, rows, alpha, palette, opts)` produces a byte-identical display list.

**Cells rasterizer** (native, `internal/cells` / `viz-core::cells`): display list → `Frame` (SPEC §10.1) using the braille canvas (SPEC §10.2). `vizd capture -text` and the golden text frames go through this, so the terminal look and tdef's eyeballing habit come for free.

---

## 4. Daemon `vizd`

### 4.1 CLI (tdef `main.go` style)
```
vizd                              serve on 127.0.0.1:7777, print URL with token, open browser
vizd serve [-port 7777] [-proxy-port 7778] [-no-open] [-record dir]
vizd capture -fixture agentic -size 100x30 [-every 15] [-text|-ansi] [-out frames]
vizd replay <file.ndjson> [-speed 2]       feed a recording into the hub (for browser testing)
vizd hooks install claude-code|opencode    write harness config (backup first, idempotent)
vizd hooks uninstall claude-code|opencode
vizd registry                              print architecture table
```

### 4.2 HTTP surface (all require the token, §7)
| Route | Method | Purpose |
|---|---|---|
| `/` , `/assets/*` | GET | embedded web app (Go `embed.FS`, Rust `rust-embed`) |
| `/stream?session=…` | GET (SSE) | `event: hello` `{version, sessions[], serverNow}`; then `event: signal` `{sessionKey, signal}`; `event: sessions` on change. Heartbeat comment every 15 s. |
| `/history?session=…` | GET | ring-buffer contents for late join (§4.3) |
| `/ingest/signals` | POST | NDJSON Signals (`sessionKey` required per line) |
| `/ingest/opencode` | POST | batched raw OpenCode events (§5.2) |
| `/ingest/claude-code` | POST | raw Claude Code hook payload (§5.3) |
| `/anthropic/*`, `/openai/*` | any | streaming proxy on `-proxy-port` (§5.1) |

### 4.3 Hub
- Per session: a ring buffer holding Signals since the last `turn.start` (cap 20k), plus the latest `model` and the latest `step.end.usage`. Sessions expire after 30 min idle.
- **Late join / refresh:** the browser fetches `/history`, pushes everything into its Sim with a virtual clock (fast-forward), and then switches to the live stream. This works because of determinism.
- **Timestamps:** `vizd` stamps `rxTs` (its own clock) on every Signal and keeps the harness time as `srcTs`. The browser uses `rxTs`. On `hello`, it estimates `offset = serverNow − Date.now()`, then plays out at `rxTs − offset + PLAYOUT_MS` (`PLAYOUT_MS = 120`, a jitter buffer). This makes network bursts animate at their true spacing.
- Session keys: `harness:sessionID` (e.g., `opencode:ses_abc`, `claude-code:<session_id>`, `proxy:<hash(client addr + first request id)>`).

---

## 5. Harness adapters (fidelity order)

All adapters are pure functions or small state machines `raw → []Signal`, unit-tested on recorded fixtures (§10). Mappings to Signals are exactly those of SPEC §5 and §11.2.

### 5.1 Streaming API proxy (universal, full fidelity)
- The harness sets `ANTHROPIC_BASE_URL=http://127.0.0.1:7778/anthropic` or `OPENAI_BASE_URL=http://127.0.0.1:7778/openai/v1`. `vizd` forwards to the real upstream (configurable; defaults `https://api.anthropic.com`, `https://api.openai.com`).
- **Passthrough rules** (non-negotiable):
  - Stream immediately. Go: `httputil.ReverseProxy{FlushInterval: -1}`; Rust: forward the body stream, never buffer whole bodies.
  - Set upstream `Accept-Encoding: identity` so the copy is parseable; otherwise forward headers unchanged (including auth).
  - Copy the response through a **bounded** channel to the parser. Under pressure, drop *parse* work, never client bytes. The client must never see added latency.
  - **Never log or record** request/response bodies, `Authorization`, `x-api-key` or cookies. Recordings contain Signals only.
- Anthropic SSE → Signals: request start → `step.start` (+ `turn.start` if the last step for this session ended > 2 s ago and its finish wasn't a tool-use stop); `message_start.message.model` → `model`; `content_block_start{type: tool_use}` → `tool.start{callID: id, tool: name}`; `content_block_delta{text_delta}` → `delta{text}`, `{thinking_delta}` → `delta{reasoning}`; `message_delta.usage` + `message_stop` → `step.end{usage, finish: stop_reason}`. A `tool_result` block in the *next* request → `tool.end{callID: tool_use_id, ok: !is_error}`.
- OpenAI Chat Completions SSE → Signals: `choices[].delta.content` → `delta{text}`; `delta.reasoning_content` (where present) → `delta{reasoning}`; `delta.tool_calls[]` (first chunk per id) → `tool.start`; final `usage` (inject `stream_options: {include_usage: true}` **only if** the user enables `-inject-usage`; otherwise rely on what's sent) → `step.end`. Responses API (`/v1/responses`): map `response.output_text.delta`, `response.reasoning*.delta`, `response.output_item.added{function_call}`, `response.completed.usage`.
- Usage normalization: Anthropic `input_tokens` excludes cache; `cache_read_input_tokens` / `cache_creation_input_tokens` → `cacheRead` / `cacheWrite`. OpenAI `prompt_tokens` **includes** `prompt_tokens_details.cached_tokens`, so set `input = prompt − cached`. Unit-test both.
- Caveat to document: tools logged in via subscription/OAuth may not honor base-URL overrides. Detect "no traffic after a prompt" and point the user at the hooks adapter.

### 5.2 OpenCode
- **Preferred:** a ~30-line OpenCode **server plugin** (`hooks/opencode/vizd-forward.ts`, installed by `vizd hooks install opencode`) whose `event` hook batches events every 16 ms and `fetch`-POSTs them to `/ingest/opencode` with the token. This needs no port discovery and also works for remote/headless OpenCode.
- **Alternative:** `vizd` subscribes to the OpenCode server's SSE event stream (find the event endpoint in `@opencode-ai/sdk` `sdk.gen` and verify it; the plugin's `PluginInput.serverUrl` gives the base URL).
- Mapping: reuse SPEC §11.2 exactly (v1 events; optional `session.next.*` fast path with double-count suppression). Session focus: the most recently busy session per OpenCode instance, overridable in the browser picker.

### 5.3 Claude Code (no proxy)
- `vizd hooks install claude-code` backs up `~/.claude/settings.json`, then adds command hooks for `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `SubagentStop`, each running `curl -s -m 1 -H "X-Viz-Token: …" --data-binary @- http://127.0.0.1:7777/ingest/claude-code || true`. Hooks must **never block or fail** the harness (`-m 1`, `|| true`).
- Mapping: `UserPromptSubmit` → `turn.start` + `step.start`; `PreToolUse` → `tool.start{callID: tool_use_id or hash, tool: tool_name}`; `PostToolUse` → `tool.end` + `step.start` (the model resumes); `Stop` → `idle`; `SubagentStop` → `subagents` decrement.
- **Transcript tail:** the hook payload includes `transcript_path`. `vizd` watches that JSONL (Go: poll stat/size every 200 ms, stdlib only; Rust: `notify`). New assistant entries with `message.usage` → `step.end{usage}`, and `message.model` → `model`. Decode uses the **degraded path** (SPEC §7.4); the UI shows `≈`.
- Optional: an OTLP/HTTP logs receiver (`/v1/logs`) for Claude Code's OpenTelemetry export, if the user enables it. Verify the current event and attribute names in the Claude Code docs before mapping; treat it as an enhancement, not the baseline.

### 5.4 Ollama / llama.cpp
- Via the proxy (`/ollama/*` → `http://127.0.0.1:11434`): stream chunks give per-chunk tokens; the final chunk's `prompt_eval_count/prompt_eval_duration/eval_count/eval_duration` → exact prefill and decode timing.
- **Exact architecture:** `POST /api/show {model}` → `model_info["<arch>.block_count" | ".expert_count" | ".expert_used_count"]` overrides the registry. Mark it `source: "runtime"` and show `exact shape` in the HUD.

### 5.5 Generic
`POST /ingest/signals` (NDJSON) and `vizd replay`. This is the escape hatch for any harness in any language.

---

## 6. Web app (`web/`, vanilla, no framework, no bundler required)

Files: `index.html`, `app.js` (stream client, playout, picker, loop), `raster-canvas.js`, `core.wasm` + loader (Go: `wasm_exec.js`; Rust: wasm-pack glue). All are embedded into `vizd`.

### 6.1 Loop
```
on rAF(now):
  if document.hidden: return (and stop scheduling until visible)
  driver.advanceTo(now + offset - PLAYOUT_MS)        // fixed 30 Hz Sim, ≤10 catch-up steps (SPEC §7.2)
  alpha = fractional tick
  dl = core.render(cols, rows, alpha, palette, opts) // zero-copy views
  raster.draw(dl)
```

### 6.2 Canvas rasterizer
- **Sizing:** `canvas.width = cssW * devicePixelRatio` (same for height); `ctx.scale(dpr, dpr)`; `cellPx = 12` CSS px by default, so `cols = floor(cssW / cellPx)`, `rows = floor(cssH / (cellPx*1.6))`. Snap 1px lines to `.5`.
- **Layers:** the **static layer** (meshes at base intensity, empty grid, node outlines, border) is drawn into an `OffscreenCanvas` **only when `(cols, rows, arch)` changes**, then `drawImage`d each frame. The **dynamic layer** is drawn on top every frame.
- **Glow without `shadowBlur`:** active lines get two strokes, one wide (3×) at `0.25·intensity` and one thin at `intensity`, under `globalCompositeOperation = "lighter"`. Nodes use pre-rendered radial-gradient sprites per (shape, color), stamped with `drawImage` and `globalAlpha = intensity`.
- **Batching:** records arrive sorted by color, so `strokeStyle` only changes when the color changes; one `beginPath` per color run.
- **Skins** (toggle `s`):
  - **vector** (reference-image look, default): smooth lines, hex/circle sprites, the grid as rounded squares;
  - **ascii**: rasterize the same display list to a monospace cell grid in the canvas, with braille dots drawn as tiny circles. It mirrors the terminal version.
- Canvas2D is the baseline. Move to WebGL2 instanced lines only if profiling shows > 4 ms/frame at 1440p.
- Theme: `prefers-color-scheme` swaps the palette background; colors blend against it as in SPEC §9.4.

### 6.3 UI chrome
Session picker (`follow most recent active` default), skin toggle, label toggle (**the honesty label stays visible either way; the toggle only hides the extra legend**), connection status dot, and a "no traffic yet? set ANTHROPIC_BASE_URL=…" helper panel populated from `/hello`.

---

## 7. Security (localhost servers are reachable from every website the user visits)
- Bind `127.0.0.1` only (proxy port too). Refuse to start on `0.0.0.0` unless `-unsafe-bind` is passed.
- A 128-bit random token is generated at start and printed in the URL `/?t=…`. The web app stores it in `sessionStorage` and sends it on every request (query for `EventSource`, header elsewhere). Hooks and plugins get it from `~/.config/vizd/token` (mode 0600), written at start.
- Reject requests whose `Host` isn't `127.0.0.1:<port>` / `localhost:<port>` (blocks DNS rebinding) and SSE/ingest requests with a foreign `Origin`.
- Ingest endpoints: max body 1 MB, max 200 req/s per session, JSON-validated against the Signal schema. Unknown fields are dropped.
- The proxy never stores secrets (§5.1). Recordings and fixtures are scanned in tests for `sk-`, `Bearer `, `x-api-key`.

---

## 8. Testing methodology

| Layer | Test | Tooling |
|---|---|---|
| Conformance | `fixtures/*.ndjson` → expected Sim snapshots at ticks (`expected/*.state.json`) and display-list dumps (`expected/*.dl.txt`). **Native and WASM run the same fixtures.** A mismatch fails the build. | `go test` / `cargo test`; WASM via Node (`node wasm_exec_node.js` for Go, `wasm-pack test --node` for Rust) |
| Scene | `DisplayListDeterministic`, `HonestyLabelAlwaysEmitted`, `ExactlyKExpertNodesLit`, `SortedByLayerThenColor`, `StaticLayerUnchangedAcrossTicks` | native |
| Cells | golden text frames via `vizd capture -text` (eyeball, then commit) | native |
| Adapters | recorded raw inputs → expected Signals: Anthropic SSE (text, thinking, tool_use, usage w/ cache), OpenAI chat + responses SSE, OpenCode event batches, Claude Code hook payloads + transcript lines, Ollama stream | native |
| Proxy | fake upstream SSE server: **byte-identical** passthrough; first byte through in < 5 ms; slow parser doesn't slow the client; no secrets in recordings | native, `httptest` / `tokio::test` |
| Security | wrong token → 401; foreign Origin/Host → 403; oversized body → 413 | native |
| Hub | late-join replay reproduces the live Sim state at tick *t* | native |
| Browser | deterministic page `/?fixture=agentic&tick=240&t=…` renders a frozen frame; smoke test checks the canvas is non-blank and the label pixel region is non-empty; optional Playwright screenshot diff | Playwright (dev-only) |

---

## 9. Performance budget
- WASM `render` < 1.5 ms and canvas draw < 3 ms at 160×60 virtual cells on a laptop (Chrome).
- Go WASM: zero allocations in `AdvanceTo` + `Render` (pooled display-list buffer; strings interned at layout time). Verify with `testing.AllocsPerRun` natively.
- `vizd` idle CPU < 0.5%; proxy adds < 1 ms latency to time-to-first-byte.

---

## 10. Named test list (contract)

**protocol:** `SignalRoundTripJSON`, `UnknownFieldsDropped`, `SessionKeyRequired`.
**sim (ported from SPEC §16 sim):** all of them, plus `NativeEqualsWasm_<fixture>` for every fixture.
**scene:** `DisplayListDeterministic`, `DisplayListPureAlpha` (alpha changes only pulse-related records), `HonestyLabelAlwaysEmitted`, `ExactlyKExpertNodesLit`, `SharedExpertsAlwaysLit`, `DenseUniform`, `UnknownLabel`, `SortedByLayerThenColor`, `LayoutUnitsInBounds` (all records inside `cols×rows` for sizes 34×10 … 220×70).
**cells:** `CellsGolden_<fixture>_<size>`, `CellsMatchSPECFrameModel`.
**adapters:** `AnthropicTextThinkingToolUsage`, `AnthropicToolResultEndsTool`, `AnthropicCacheUsageNormalized`, `OpenAIChatStream`, `OpenAIPromptIncludesCached`, `OpenAIResponsesStream`, `OpenCodeBatchMapsLikeSPEC`, `ClaudeHooksPhases`, `ClaudeTranscriptUsage`, `OllamaFinalTimings`, `OllamaShowOverridesRegistry`.
**proxy:** `ProxyByteIdentical`, `ProxyFlushesImmediately`, `ProxySlowParserDoesNotBlock`, `ProxyNoSecretsRecorded`, `ProxyUpstreamErrorPassthrough`.
**server/security:** `TokenRequired`, `ForeignOriginRejected`, `RebindHostRejected`, `BodyLimit`, `RateLimit`, `HistoryReplayEqualsLive`.
**hooks install:** `InstallBacksUpFirst`, `InstallIdempotent`, `UninstallRestoresExactly`, `HookNeverBlocks` (vizd down → hook exits 0 in < 1.2 s).
**hygiene:** `CoreNoIO`, `CoreNoClock`, `CoreNoUnseededRandom`.

---

## 11. Build order (single session; one green commit per step)

0. **Choose Go or Rust**, `git init` (or reuse the repo), log the choice in `devlog.md`. Copy the SPEC §12 demo scripts into `fixtures/*.ndjson`.
1. **Protocol + Sim** port (SPEC §5, §7) with conformance snapshots generated from the fixtures and committed after inspection.
2. **Scene → display list** (SPEC §9 semantics in layout units), with scene tests.
3. **Cells rasterizer + `vizd capture -text`.** **Read the frames** at 40×14, 90×30, 137×45 before committing goldens.
4. **WASM build + `web/` canvas rasterizer** in frozen-fixture mode (`/?fixture=…&tick=…`). **Look at it in a browser**, tune the glow/sprite constants, and get the `NativeEqualsWasm_*` tests passing.
5. **`vizd serve`:** embedded assets, token, Host/Origin checks, hub, SSE `/stream`, `/history`, `/ingest/signals`, `vizd replay`. The live loop with playout buffer works end to end via `replay`.
6. **Streaming proxy** (Anthropic first, then OpenAI chat/responses, then Ollama) with byte-identical and flush tests, then a **real** run: point a harness at it and record a session to `fixtures/live-*.ndjson` (Signals only).
7. **OpenCode forwarder plugin + `/ingest/opencode`** (reuse SPEC §11.2 mapping and its fixtures). Live check with OpenCode; `opencode-tps-meter` must still work (baseline/regression).
8. **Claude Code hooks + transcript tail + `vizd hooks install/uninstall`** (backup first). Live check: prompt → tool → stop; the browser shows phases and `≈` rate.
9. **Docs:** README section "Web + daemon" (install, harness setup per adapter, security model, real vs. illustrative), plus a `devlog.md` entry with parked debt and process gotchas.

---

## 12. Known unknowns (verify, don't assume)

| Item | How to verify | Fallback |
|---|---|---|
| OpenCode server SSE event endpoint path | `grep` the `@opencode-ai/sdk` `sdk.gen` for the event subscribe URL | Forwarder plugin (§5.2 preferred path) |
| Base-URL overrides honored with subscription/OAuth logins | Run a prompt through the proxy; check for traffic | Hooks adapter (§5.3) |
| Claude Code hook payload fields (`transcript_path`, `tool_use_id`) on the installed version | Log one payload per hook type to a fixture | Hash-based callIDs; usage from transcript only |
| Claude Code OTEL event names/attributes | Current Claude Code monitoring docs | Skip OTLP; hooks + transcript suffice |
| OpenAI `reasoning_content` availability per provider | Record a stream per provider | Treat all as text |
| Go WASM GC hitches at 60 fps | Chrome performance profile during the `agentic` fixture | Lower the render rate to 30 Hz with interpolation off, or switch the core to Rust/TinyGo |
