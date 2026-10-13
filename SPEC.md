# opencodeviz — Implementation Spec

## Prompt (paste this to the coding agent)

```text
You are implementing opencodeviz in /Users/vikrambhaduri/occ/opencodeviz: a terminal
visualization of what an LLM is doing live (prefill, decode, reasoning, tool calls,
context fill, MoE/dense architecture shape). It ships as an OpenCode TUI plugin and as
a standalone CLI.

SPEC.md in that folder is the contract. Read it fully before writing code, then
execute §15 (Build order) step by step in this one session. Implementation should be
transcription, not redesign: if something in the spec looks wrong, make the smallest
fix that satisfies its invariants and log the deviation in devlog.md. Don't invent a
new architecture.

Non-negotiables:
- src/core has zero dependencies and no clock, Math.random, or I/O. renderViz is a
  pure function of (w, h, sim, palette, opts). Time enters only through Driver.advanceTo.
- Real vs illustrative (§4): every full/compact frame shows the honesty label.
- Write layout.test.ts before layout.ts (§9.1). Implement the named tests in §16.
- After the renderer compiles, run `opencodeviz screens` and `capture -text` and READ
  the frames at 40x14, 62x19, 90x30 and 137x45 before committing goldens. Tests miss
  layout bugs; eyes catch them.
- One green commit per build step (`bun test` and `bun run typecheck` pass). git init first.
- Before touching ~/.config/opencode/tui.json: back it up and record a baseline (idle
  CPU, opencode-tps-meter working). Append the plugin entry; never remove existing
  entries. Restart OpenCode after every plugin change. Afterwards, re-check the
  baseline and report both measurements.
- Resolve every item in §18 (Known unknowns) by checking, not assuming. Record what
  you found.
- Reference implementations on this machine: ../tdef (Go; patterns listed in §1) and
  the installed opencode-tps-meter plugin (path in §19).

When done, report:
1. what works, with the evidence: test counts, a captured frame, the live-OpenCode checks from §15 step 9;
2. how each §18 unknown resolved;
3. any deviations from the spec;
4. parked debt (also written to devlog.md);
5. exact commands for me to run it.
```

---

> A live, terminal-native animation of what an LLM is doing **right now**: prefill, decode, reasoning, tool calls, context fill, and (for open-weight models) its real architecture shape: layers, experts, active experts.
>
> This document is a **contract**, not a mood board. It fixes the module boundaries, signatures, invariants, layout formulas, and a named test list, so implementation is *transcription, not exploration*. A coding agent should be able to build it in **one session**. Read it once top to bottom, then follow §15 (Build order).
>
> It deliberately follows the patterns of the sibling project **`../tdef`** (terminal tower defense; see `../tdef/WHAT-WENT-WELL.md`). §1 lists exactly what's borrowed.
>
> **Companion doc:** `WEB-SPEC.md` covers the Go/Rust daemon + web canvas variant that listens to any harness. It reuses this doc's Signal protocol, Sim, registry and scene semantics.

---

## 0. TL;DR for the implementing agent

- **What you're building:** a host-agnostic core with two thin shells:
  1. **OpenCode TUI plugin** (primary). Renders *inside* OpenCode's terminal UI (sidebar plus a `/viz` overlay) by copying our `Frame` into OpenTUI's cell buffer.
  2. **Standalone CLI** `opencodeviz`. Raw-ANSI renderer for any terminal pane, with demo/replay/stdin/attach sources and **headless `capture` / `screens` tools**.
- **Core = Sim + pure Render.**
  - `Sim` is a deterministic fixed-timestep (30 Hz) state machine fed by timestamped **Signals** (§5).
  - `renderViz(w, h, sim, palette, opts) → Frame` is a **pure function**. It has no clock, no randomness except seeded-from-state, and no I/O. The only impure code is the blit and the drivers.
- **Portability:** hosts only translate their events into Signals (§5). Renderers only consume `Frame`s (§10). This is what makes ports to Claude Code, Codex, proxies, Ollama or the web cheap (§14).
- **Honesty rule:** timing, phases, token counts, context fill and architecture shape are **real**. Which experts, neurons or attended tokens light up is **illustrative**, and the UI always says so (§4).
- **Stack:** TypeScript on **Bun**. `src/core` has **zero dependencies** and imports nothing outside itself (a test enforces this). The CLI uses only Bun/Node built-ins. The OpenCode host uses OpenCode's own `@opentui/*` as *peer* deps. No JSX and no Solid compile step.

---

## 1. Patterns adopted from `../tdef`

| tdef pattern (where) | How it applies here |
|---|---|
| **Pure renderers** `Render…(w, h, state, frame, pal) *Frame` (`render/`) | `renderViz(w, h, sim, pal, opts): Frame`. Every visual is a function of explicit inputs. |
| **Clock is an argument:** an integer 30fps tick counter, no wall clock in render | `sim.tick` (30 Hz integer). All fades and animation are `f(sim.tick − bornTick)`. No `Date.now()`/`performance.now()` anywhere in `src/core`. |
| **Deterministic engine** with a fixed-timestep accumulator, `steps < 10` catch-up clamp (`tui/app.go stepGame`) | `Driver.advanceTo(nowMs)` steps the Sim at `1000/30` ms per tick, at most 10 steps per call; excess time is dropped. Signal `ts` maps to a tick, so replays are byte-identical. |
| **Frame model** `Frame{W,H,C []Cell}`, `Set` with out-of-bounds no-op, `.Text()` / `.ANSI()` exporters (`render/frame.go`) | `src/core/frame.ts` holds the same shape, with truecolor ints (`0xRRGGBB`, `-1` = terminal default). |
| **Diff blit** that only writes changed cells, keeps the pen position and color, and resets `prev` on resize/screen switch (`blitTo`) | `src/backends/ansi.ts` `Blitter`, plus a synchronized-update wrapper. |
| **SIGWINCH as a pure notifier;** size re-queried on the main loop (race fix) | The CLI resize listener only sets a flag; the loop reads the size and resets `prev`. |
| **The terminal is the frame:** one rounded box with the **HUD embedded in the border** (btop-style segments, `embedSegment`, `centerEmbed`) | Full/compact modes draw a `╭╮╰╯` box. Model/arch, phase/tps, ctx and the honesty label are embedded segments in the top and bottom edges. |
| **`RenderTooSmall`** below the minimum size | Strip mode down to 1 row; below `W < 12` a centered `·`. |
| **Headless tools committed to the CLI:** `capture -text`, fixed virtual size, byte-identical dumps (`main.go`) | `opencodeviz capture` and `opencodeviz screens` (§13.3). The retro's "throwaway `/tmp` harness" regret becomes a committed tool here. |
| **ANSI screen-state reconstructor** (a retro lesson: a grep on blit output gave false negatives) | `test/vt.ts`, a ~60-line VT reconstructor. Blit tests assert *reconstructed screen == frame.text()*. |
| **Test shapes:** `Deterministic`, `Animates`, `FitsFrame` across sizes, phase-script tests with `want`/`absent` strings per frame (`TestTitlePhases`) | The named test list in §16. Same shapes. |
| **Layout budget as a test first** (retro: "write the vertical budget as a test with exact expected rows *first*") | `layout.test.ts` is written before `layout.ts`, with exact rows and columns at fixed sizes. |
| **One source of truth for geometry** (`MenuRects` derived from the layout functions) | `layout(w, h, arch)` returns every region rect. The renderer *and* tests (and any future mouse hit-testing) derive from it. |
| **Verify by looking** (4 layout bugs found only by eyeballing) | Build step 6 is mandatory: render every mode × phase × size with `screens` and **read the frames** before committing. |
| **Baseline before, regression after** | Measure OpenCode idle CPU and confirm `opencode-tps-meter` still works *before* installing the plugin; re-measure after; report both. |
| **One commit per concern, green at every commit; devlog + debt ledger** | `git init` (the folder isn't a repo yet), commit per build step, keep `devlog.md` (what/why, parked debt, process gotchas). |
| **Zero external deps** | `src/core` and the CLI need no dependencies. Only the OpenCode host touches peer deps. |
| **Themes as data** (`Theme` per level) | `Palette` as data, with the default taken from the reference image; the OpenCode host blends against the active theme background. |

---

## 2. Visual concept

The layout renders the reference image `hero-neural-net.png` in a terminal: a grid on the left, sparse lines fanning into a column of colored hexagons, a column of circle nodes, then a dense fan converging on a small output column. Each region maps onto a stage of a transformer forward pass:

```
╭┤ qwen3-235b-a22b · MoE 128e/8a · 94L ├──────────────────┤ ▸ DECODE  L 41/94  63 tok/s  ttft 1.8s ├╮
│ ▓▓●▓▓▓▓▓●▓▓ ⠤⣀⡀⣀⠤⢔⣪⣕⡮⠤⠖⠛⠊⠉⠉ ⡠⢊⠔⠁  ⣀⠤⠒⠉  ⬢ ○  ⠙⠿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣾⣿⣿⣿⣽⣖⡮⢵⣒⡤⢄⣀            │
│ ▓▓░▓▓░●●●░▓ ⢤⠖⢛⣿⠿⢽⣎⡁      ⡠⡪⠔⠁⣀⠤⠒⠉      ⬢ ●⠠⣤⣤⣄⣈⣛⣿⣿⣿⣿⣿⣿⣿⣿⣾⣿⣿⣿⣿⣷⡯⢽⣶⣿⣿⣶⣟⣵⢖⣤⣄⣀    │
│ ●▓▓▓▓░●●░▓▓ ⢼⠺⡉   ⠈⠙⠫⠶⣢⢄⣠⡪⣊⠤⠒⠉      ⣀⣀⠤⠄⬢ ○  ⠙⠻⢿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣾⣿⣿⣿⣿⣷⡯⢽⣾⣿⣿⣿⣟⣵⣟⣿⣾⣿⣷⣦⣤⣀⡀│
│ ▓▓▓░▓▓▓▓▓░░  ⠑⠵⡄      ⣠⡯⠞⠯⢕⣒⣤⣤⡤⠔⠒⠊⠉⠉  ⣀⠄⬢ ●⠠⣤⣤⣤⣤⣭⣿⣿⣿⣿⣿⣿⣿⣿⣾⣿⣿⣿⣿⣿⡯⢽⣿⣿⣿⣿⣿⣵⣿⣿⣿⣿⣶⣦⠄●│
│ ...                                                                                            │
╰┤ ctx ▓▓▓▓▓▓░░ 71% cached · 46k/200k ├──┤ thinking ▮▮▮▮▯ out ▮▮▯ ├──┤ ⚙ bash 1.2s ├─┤ illustrative routing ├╯
```
*(A monochrome prototype frame inside the tdef-style border. The real thing is truecolor. The dense right fan must **not** saturate to solid `⣿` as it does here; see §9.2 stipple.)*

| Region (left → right) | Meaning | Data source |
|---|---|---|
| **Context grid** | The context window. 1 cell = N tokens. `▓` cached prompt, `▒` fresh prompt, colored = generated this turn, `·` unused | **Real** (usage + context limit) |
| **Orange dots on grid** | "Tokens attended to" by the current pulse | Illustrative |
| **Router fan** (braille lines) | Token → router → experts | Illustrative paths; sparsity is real for MoE |
| **Expert column** `⬢` | Experts in the current layer; exactly *k* light per token (+ shared) | **Real** N, k; illustrative choice |
| **Hidden column** `●`/`○` | Hidden state | Illustrative |
| **Logit fan** (braille mesh) | Projection to vocab / sampling | Timing **real**, paths illustrative |
| **Output column** | Candidate next tokens; one flares `◉` = sampled token | Timing **real** |
| **Comet back to grid** | Sampled token appended to context, so the loop is autoregressive | Timing **real** |
| **Border `L x/N`** | Pulse progress through the layer stack | **Real** N; pace slowed for visibility |

**The signature moment:** a token flares at the output, a comet travels back along the bottom edge, it lands in the next grid cell, and the next pulse launches. That loop *is* autoregressive decoding.

---

## 3. Goals / non-goals

**Goals**
- Calm, elegant, readable at a glance. Motion encodes real activity and is never noise.
- Faithful to real signals: phase, TTFT, throughput, reasoning vs. text, tools, context fill, cache share, model shape.
- Runs inside OpenCode (no extra pane) and standalone in any terminal.
- Portable: a new host only writes a Signal adapter; a new renderer only consumes `Frame`s.
- Cheap: render + blit < 2 ms at 120×40; 30 fps active, 10 fps idle, 0 when not visible.

**Non-goals**
- Real activations/attention/routing. They aren't observable from hosted APIs, and the viz never pretends otherwise.
- Browser/WebGL in v1 (it's a port target, §14).
- A tokenizer dependency. Use chars/4, calibrated against real usage (§7.3).

---

## 4. Real vs illustrative (product rule)

Enforce this by module boundary:
- `src/core/sim/*` holds only **real** data derived from Signals.
- `src/core/render/illustrate.ts` is the **only** place randomness lives: a seeded PRNG (`mulberry32`), seeded from **state** (`hash(sessionKey) ^ pulse.index ^ layer`), never from time. The same Sim state always renders the same frame.
- Every full/compact frame embeds an honesty segment in the bottom border: `illustrative routing` (MoE/dense) or `architecture unknown`. Strip mode shows a dim `~` after the expert glyphs.

| Real | Illustrative |
|---|---|
| Phase: idle / prefill / decode / tool / retry / error | Which experts light (count *k* is real) |
| TTFT (request → first delta) | Which grid cells get orange "attention" dots |
| Tokens/sec (smoothed deltas, calibrated with usage) | Which hidden circles light |
| Reasoning vs. text stream | Which output node flares (the timing is real) |
| Tool name, start/end, ok/failed, duration | Layer-sweep speed (real layers run in ms) |
| Input / output / reasoning / cache-read / cache-write tokens per step | Everything mid-network for closed models |
| Context limit (provider metadata) and fill % | |
| Architecture (layers, experts, k, shared) from public model cards | |

---

## 5. Signal protocol (the portability contract)

JSON-serializable. The same type is used in-process, over NDJSON stdin, in replay files and over sockets. **`ts` is epoch ms.**

```ts
// src/core/protocol.ts
export type ModelRef = { providerID: string; modelID: string; contextLimit?: number };
export type Usage = { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number };

export type Signal =
  | { t: "model"; ts: number; model: ModelRef }
  | { t: "turn.start"; ts: number }                                   // user prompt sent
  | { t: "step.start"; ts: number }                                   // one LLM request begins (prefill)
  | { t: "delta"; ts: number; kind: "text" | "reasoning"; chars: number; tokens?: number }
  | { t: "tool.start"; ts: number; callID: string; tool: string }
  | { t: "tool.end"; ts: number; callID: string; ok: boolean }
  | { t: "step.end"; ts: number; usage?: Usage; finish?: string }
  | { t: "retry"; ts: number; attempt: number; message?: string }
  | { t: "error"; ts: number; message?: string }
  | { t: "idle"; ts: number }
  | { t: "subagents"; ts: number; busy: number }
  | { t: "reset"; ts: number; sessionKey: string };                   // switched to another session

export type SignalSink = (s: Signal) => void;
```

Rules:
- `delta.tokens` is optional; if absent the Sim estimates it (§7.3). Adapters with real per-chunk counts (proxies, Ollama) should fill it.
- The Sim tolerates duplicates: it ignores a second `tool.start` for a known `callID`, or `step.start` while already in a step.
- A host that can't observe something just doesn't emit it, and the Sim degrades (§7.4).
- NDJSON: one Signal per line; lines starting with `#` are comments.

---

## 6. Repository layout

```
opencodeviz/
  SPEC.md  README.md  devlog.md
  package.json  tsconfig.json  .gitignore
  src/
    core/                       ← zero deps; imports nothing outside src/core
      protocol.ts               §5
      frame.ts                  §10.1  Frame, Cell, text(), ansi(), box/segment helpers
      palette.ts                §9.6
      registry.ts               §8
      sim/
        sim.ts                  §7.1  SimState, createSim, applySignal, step
        driver.ts               §7.2  ms→tick mapping, accumulator, signal queue
        rate.ts                 §7.3
      render/
        layout.ts               §9.1  layout(w,h,arch) → Layout (single source of geometry)
        illustrate.ts           §4    seeded PRNG + illustrative picks
        braille.ts              §10.2
        viz.ts                  §9    renderViz(w,h,sim,pal,opts) → Frame (pure)
        strip.ts                §9.7
      demo.ts                   §12
    adapters/
      opencode.ts               §11.2  OpenCode Event → Signal
      ndjson.ts                 NDJSON lines ↔ Signals
    hosts/
      opencode-tui.ts           §11    OpenCode TUI plugin module
      cli.ts                    §13    standalone CLI (subcommands)
    backends/
      ansi.ts                   §13.2  Terminal (raw mode, alt screen) + Blitter (diff)
      opentui.ts                §11.4  Frame → OptimizedBuffer copy
  test/
    vt.ts                       ANSI screen-state reconstructor (test helper)
    fixtures/*.ndjson           signal streams (handwritten + recorded)
    fixtures/opencode/*.json    raw OpenCode event sequences
    golden/*.txt                committed frame dumps
    *.test.ts                   §16
```

`package.json` essentials:

```jsonc
{
  "name": "opencodeviz",
  "type": "module",
  "bin": { "opencodeviz": "./src/hosts/cli.ts" },
  "exports": { ".": "./src/hosts/opencode-tui.ts", "./tui": "./src/hosts/opencode-tui.ts" },
  "scripts": { "test": "bun test", "typecheck": "tsc --noEmit", "viz": "bun src/hosts/cli.ts" },
  "peerDependencies": { "@opencode-ai/plugin": ">=1.18.0", "@opentui/core": "*", "@opentui/solid": "*" },
  "peerDependenciesMeta": { "@opentui/core": { "optional": true }, "@opentui/solid": { "optional": true } },
  "devDependencies": {
    "@opencode-ai/plugin": "^1.18.16", "@opencode-ai/sdk": "^1.18.16",
    "@opentui/core": "*", "@opentui/solid": "*", "typescript": "^5", "@types/bun": "latest"
  }
}
```

> ⚠️ **Never bundle** `@opentui/*` or `solid-js` into the plugin. They must resolve to OpenCode's copies; duplicate runtimes break reactivity and `RGBA` identity. This matches what the user's working `opencode-tps-meter` plugin does.

---

## 7. Sim (deterministic, fixed timestep)

### 7.1 State and reducers

```ts
export const TICK_HZ = 30;
export type Phase = "idle" | "prefill" | "decode" | "tool" | "retry" | "error";

export interface Pulse { index: number; bornTick: number; tokens: number; stream: "text" | "reasoning"; sweepTicks: number }
export interface Flash { kind: "error" | "toolFail" | "land"; bornTick: number; cell?: number }

export interface SimState {
  tick: number;                       // integer, +1 per step
  sessionKey: string;                 // seeds illustrate.ts
  phase: Phase; phaseTick: number;    // tick when phase was entered
  stream: "text" | "reasoning";
  model?: ModelRef; arch: Arch;       // §8
  prefillTick?: number; ttftTicks?: number;
  tools: Map<string, { tool: string; startTick: number }>;
  usage?: Usage;                      // latest step.end usage
  promptTokens?: number;              // §11.2 formula, from latest usage
  generated: { stream: "text" | "reasoning"; tokens: number }[]; // this turn, run-length encoded
  bank: number;                       // estimated tokens awaiting pulse emission
  tps: number; tpsApprox: boolean;    // display rate; approx when usage-only
  calib: Map<string, number>;         // modelID → chars→tokens factor
  pulses: Pulse[]; flashes: Flash[];
  nextPulseIndex: number; lastEmitTick: number; lastSignalTick: number;
  retryAttempt?: number; subagentsBusy: number;
  rate: RateWindow;                   // §7.3, ring buffer
}

export function createSim(sessionKey?: string): SimState;
export function applySignal(s: SimState, sig: Signal, atTick: number): void;   // mutates s; deterministic
export function step(s: SimState): void;                                        // advance exactly one tick; deterministic
```

Mutation in place is fine (it's the cheap path); the invariant is **determinism**: the same initial state and the same `(signal, tick)` sequence must produce identical state. Tests compare `structuredClone`-style snapshots.

**Phase machine** (in `applySignal` / `step`):

```
            turn.start / step.start
   IDLE ───────────────────────────────▶ PREFILL ──first delta──▶ DECODE
    ▲                                       ▲                       │
    │ idle signal, or 90 ticks (3 s)        │ tool map empties      │ tool.start
    │ after step.end with no tools running  │                       ▼
    │                                       └──────────────────── TOOL
  any ──error──▶ ERROR (36 ticks, flash) ──▶ IDLE
  any ──retry──▶ RETRY (until next step.start or delta)
```
- PREFILL sets `prefillTick`. On the first delta: `ttftTicks = tick − prefillTick`, then DECODE.
- TOOL leaves to **PREFILL**, not DECODE, because the next step re-reads the prompt plus tool results.
- `turn.start` clears `generated`, `pulses`, `bank`; keeps `calib`.
- `reset` replaces the state with `createSim(newKey)`, carrying over `calib` and `arch` cache only.

`step(s)`: `tick++`; run the pulse emitter (§9.3); drop pulses with `tick − bornTick > sweepTicks` and flashes older than 45 ticks; apply the idle timeout; update `tps` decay (if no deltas for 30 ticks, `tps *= 0.9` per tick until < 1 → 0).

### 7.2 Driver (time → ticks)

```ts
export class Driver {
  constructor(sim: SimState, opts?: { maxCatchUp?: number /*10*/ });
  push(sig: Signal): void;            // queue; first-ever signal or first advanceTo sets t0
  advanceTo(nowMs: number): number;   // steps Sim to floor((nowMs - t0) * TICK_HZ / 1000); returns steps taken
}
```
- A signal is applied at `tickOf(sig.ts) = floor((sig.ts − t0) * 30 / 1000)`, clamped to ≥ current tick, **before** the step that reaches that tick.
- Like tdef: at most `maxCatchUp = 10` steps per `advanceTo`. If further behind, jump `t0` forward so the Sim doesn't fast-forward through a stall. Queued signals are still applied in order.
- `advanceTo` is idempotent for the same `nowMs`, so several surfaces rendering in one frame (sidebar + overlay) can each call it safely.
- **Replay/capture** use a virtual clock: `advanceTo(t)` in fixed increments of `1000/30`, which gives byte-identical output in any environment.

### 7.3 Throughput and calibration (real)

- Per delta: `est = sig.tokens ?? (chars + carry[stream]) / 4`. Keep the fractional carry per stream. Multiply by `calib.get(modelID) ?? 1`.
- On `step.end` with usage: `observed = output + reasoning`. If the step's raw estimate is `> 20`: `k = clamp(lerp(k, observed / rawEstimate, 0.3), 0.5, 2.0)`.
- **Rate:** a ring buffer of `(tick, tokens)` (256 entries). `tps = Σ tokens in the last 60 ticks / 2 s`. Hide it when < 1.
- **Bank:** each delta's estimate is added to `bank`. The pulse emitter drains it, turning bursty network chunks into a smooth cadence at the real average rate.

### 7.4 Degraded inputs
- **Usage only, no deltas** (e.g., Claude Code hooks): on `step.end` with `output + reasoning = n` over step duration `d` ticks, add `n` to `bank`, set `tps = n / (d/30)`, `tpsApprox = true` (the border shows `≈63 tok/s`).
- **No model:** `arch = unknown`.
- **No contextLimit:** 200,000, shown as `~200k`.

---

## 8. Architecture registry (real shapes)

`src/core/registry.ts`. Strip any `provider/` prefix, lowercase, match ordered regexes; **first match wins** (specific before general).

```ts
export type Arch =
  | { kind: "moe"; family: string; layers: number; experts: number; active: number; shared: number; note?: string }
  | { kind: "dense"; family: string; layers: number; note?: string }
  | { kind: "unknown"; family: string; note?: string };
export function archFor(model: ModelRef | undefined, overrides?: Record<string, Arch>): Arch;
```

Seed data, from public model cards / `config.json` as of writing. Pin it with a test, and spot-check anything marked:

| Match (regex on modelID) | kind | layers | experts | active | shared | Notes |
|---|---|---|---|---|---|---|
| `deepseek.*(v3\|r1\|chat\|reasoner)` | moe | 61 | 256 | 8 | 1 | first 3 layers dense |
| `kimi-k2` | moe | 61 | 384 | 8 | 1 | |
| `qwen3.*235b` | moe | 94 | 128 | 8 | 0 | |
| `qwen3.*30b-a3b` | moe | 48 | 128 | 8 | 0 | |
| `qwen3-coder.*480b` | moe | 62 | 160 | 8 | 0 | |
| `gpt-oss-120b` | moe | 36 | 128 | 4 | 0 | |
| `gpt-oss-20b` | moe | 24 | 32 | 4 | 0 | |
| `mixtral.*8x22b` | moe | 56 | 8 | 2 | 0 | |
| `mixtral.*8x7b` | moe | 32 | 8 | 2 | 0 | |
| `llama-4-maverick` | moe | 48 | 128 | 1 | 1 | alternating dense/MoE layers |
| `llama-4-scout` | moe | 48 | 16 | 1 | 1 | |
| `glm-4\.5(?!-air)` | moe | 92 | 160 | 8 | 1 | **verify** |
| `llama-?3.*405b` | dense | 126 | | | | |
| `llama-?3.*70b` | dense | 80 | | | | |
| `llama-?3.*8b` | dense | 32 | | | | |
| `qwen2\.5-coder.*32b` | dense | 64 | | | | |
| `claude\|gpt-[45]\|^o[134]\|gemini\|grok` | unknown | | | | | closed weights |
| *(fallback)* | unknown | | | | | |

Rendering by kind:
- **moe:** the expert column shows real N (bucketed, §9.2); exactly *k* lit per layer step; *shared* experts drawn as always-on `◈` at the top. Border: `MoE {N}e/{k}a · {L}L`.
- **dense:** the expert column is a uniform bar; every row lights on each pulse. Border: `dense · {L}L`.
- **unknown:** dim `⬡` with a slow shimmer, `L ?`, and the honesty segment reads `architecture unknown`. Phases, timing and context stay real.

Overrides: plugin option `arch` / CLI `--arch '<json>'`, keyed by a modelID regex.

---

## 9. Render (pure)

```ts
export interface VizOpts { labels: boolean; asciiSafe: boolean; bg: number /*0xRRGGBB*/ }
export function renderViz(w: number, h: number, sim: Readonly<SimState>, pal: Palette, opts: VizOpts): Frame;
```
**Invariants:** no access to clocks, globals, env or I/O; the same arguments give a deep-equal `Frame`; never writes out of bounds (Frame.set no-ops, and tests also assert the layout keeps everything inside); never throws for any `w ≥ 1, h ≥ 1`.

### 9.1 Layout (single source of geometry, written test-first)

```ts
export type Rect = { x: number; y: number; w: number; h: number };
export type Layout =
  | { mode: "full" | "compact"; box: Rect; grid: Rect; fanA: Rect; experts: Rect; hidden?: Rect; fanB?: Rect; out: Rect;
      outN: number; topSegs: Rect[]; bottomSegs: Rect[] }
  | { mode: "strip"; line: Rect }
  | { mode: "tiny" };
export function layout(w: number, h: number, arch: Arch): Layout;
```

| Mode | Condition | Content |
|---|---|---|
| **full** | `w ≥ 90 && h ≥ 18` | border box with HUD segments · grid · router fan · experts · hidden · logit fan · output |
| **compact** | `w ≥ 34 && h ≥ 10` | border box with short HUD · grid · router fan · experts · output (no hidden column, no logit fan) |
| **strip** | `w ≥ 12` (any `h ≥ 1`) | one line on row 0 (§9.7) |
| **tiny** | otherwise | a centered `·` (tdef's `RenderTooSmall` equivalent) |

**full**, with the interior inset 1 cell for the border (`ix = 1, iy = 1, iw = w−2, ih = h−2`):
```
grid.w  = clamp(round(iw*0.14), 8, 22)         grid.h = clamp(round(ih*0.62), 6, ih)
grid.x  = ix + 1                                grid.y = iy + floor((ih - grid.h)/2)
fanA.x  = grid.x + grid.w + 1                   fanA.w = round(iw*0.47) - fanA.x
experts = { x: fanA.x + fanA.w + 1, y: iy, w: 1, h: ih }
hidden  = { x: experts.x + 2,        y: iy, w: 1, h: ih }
out.x   = ix + iw - 2                            outN = clamp(round(ih*0.4), 4, 12)
fanB    = { x: hidden.x + 2, y: iy, w: out.x - 1 - (hidden.x + 2), h: ih }
out     = { x: out.x, y: iy + floor((ih - outN)/2), w: 1, h: outN }
```
**compact:** same box and grid formulas; `fanA` runs to `w − 6`, `experts.x = w − 5`, `out.x = w − 3`, `outN = clamp(round(ih*0.5), 3, 8)`. The OpenCode sidebar (~40 cols) lands in compact.

`topSegs` / `bottomSegs`: the rects for embedded border segments. Truncate lowest-priority segments first. Priority, top: phase/tps > model > arch. Bottom: honesty label > ctx > thinking/out > tool badge. **The honesty label is never dropped in full/compact.**

Write `layout.test.ts` **first** with exact expected rects at `40×14`, `62×19`, `90×30`, `137×45`, plus property checks over all sizes `w∈[1,220], h∈[1,70]`: regions inside the box, pairwise non-overlapping, and the expert column height ≥ 1.

### 9.2 Static elements

- **Border:** rounded box `╭╮╰╯─│` in `pal.border`, segments drawn with tdef-style brackets `┤ text ├` (`embedSegment` / `centerEmbed` ported into `frame.ts`).
- **Context grid** `grid.w × grid.h`. `tokensPerCell = ceil(contextLimit / (grid.w*grid.h))`. Fill row-major:
  1. cached `cacheRead` → `▓` gridBlue
  2. fresh `input + cacheWrite` → `▒` gridBlueLt
  3. generated this turn (`sim.generated`, in order): reasoning = violet, text = amber; partial last cell uses the ramp `░▒▓█`
  4. unused → `·` gridEmpty
  Until the first usage arrives, show generated only; the ctx segment reads `ctx ?`.
- **Experts:** `rows = experts.h`. If `experts + shared ≤ rows`, one glyph each. Otherwise **bucket** with `perRow = ceil(experts / (rows − shared))`, and a row lights if any of its experts is active. Glyph `⬢` (asciiSafe: `◆`); shared `◈`. Row hue = `pal.hex[hash(row) % 4]`.
- **Hidden:** `○` at rest, `●` lit.
- **Output:** `outN` × `●` dim; the sampled node becomes `◉`.
- **Static meshes** (braille, low intensity):
  - Router fan: lines from ~40% of grid rows to ~50% of expert rows. Seeded by `hash(w,h,arch.family)`, so they're stable.
  - Logit fan: lines from **every 3rd** hidden row to every output node, **stipple = 2** (every other sub-pixel). This prevents the solid `⣿` blob.

### 9.3 Pulses (Sim emits, Render draws)

Emitter in `step()`:
```
MAX_PULSE_HZ = 14 → minGapTicks = ceil(30/14) = 3 ; MAX_CONCURRENT = 6
if phase == "decode" && bank >= 1 && tick - lastEmitTick >= minGapTicks && pulses.length < MAX_CONCURRENT:
   per = max(1, ceil(tps / MAX_PULSE_HZ)); take = min(bank, per)
   bank -= take; pulses.push({ index: nextPulseIndex++, bornTick: tick, tokens: take, stream,
                               sweepTicks: clamp(round(270 / max(tps,1)), 9, 20) })
   append take tokens to generated (visually counted when the pulse "lands", see below)
```

Render a pulse at `u = (sim.tick − bornTick) / sweepTicks`:

| u | Stage | Drawing |
|---|---|---|
| 0.00–0.30 | attend + route | pick `m = 3..6` filled grid cells biased to recent (`idx = n−1−floor(n·r^2.2)`); orange `●` on them; router lines from them to the chosen experts, **revealed progressively** (`upTo = u/0.30`) |
| 0.30–0.42 | experts fire | chosen expert rows at intensity 1.0 in their hue; shared pulse too. For MoE, re-pick the *k* experts each time the layer counter changes (visible per-layer re-routing) |
| 0.42–0.52 | hidden | ~35% of hidden rows lit (seeded by pulse index) |
| 0.52–0.85 | project | logit lines from lit hidden rows to all outputs, progressive, alternating meshPink/meshBlue per cell |
| 0.85–0.92 | sample | one output node (seeded) → `◉` in stream color |
| 0.92–1.00 | append | 3-cell comet along the row above the bottom border from `out.x` to the grid's next cell; at u=1 that cell is drawn at landing intensity |

Layer counter: `L = 1 + floor(u · layers)` of the newest pulse, in the top border.
"Visually counted" generated cells: the grid renders `generated` minus the tokens of pulses with `u < 1`, so a cell appears exactly when its comet lands. This is pure, with no extra state.

### 9.4 Intensity is analytic (no mutable energy buffers)

Every lit element derives intensity from its age: `I(age) = exp(−age / τ)` with τ in ticks (`τ_mesh = 5`, `τ_flash = 8`). Overlapping contributions in one cell combine by **max**. Braille cells take the color of the highest-intensity contributor (one fg per braille char) and OR the dot masks of contributors with `I > 0.04`. Final `fg = mix(bg, color, I^0.8)`, quantized to 33 levels via precomputed ramps.

### 9.5 Phase looks

| Phase | Look |
|---|---|
| **idle** | Breathing: static-mesh base intensity `0.06 + 0.06·(1+sin(2π·tick/120))/2`. Every 60–120 ticks (seeded by `floor(tick/90)`), one faint spark travels one router line. |
| **prefill** | A band ~4 cols wide sweeps the grid over *fresh* cells (27 ticks per sweep, looping); cached cells stay steadily lit (cache hits skip the work, which is real). Router fan: many lines at 0.4; ~60% of experts shimmer (aggregate routing). Border: `▸ PREFILL` and a `ttft` counting up from `prefillTick`. |
| **decode** | Pulses (§9.3). Stream color on the sampled node, comet and generated cells. |
| **tool** | Output column at 0.3; bottom-border badge `⚙ {tool} {secs}s` (`+n` for concurrent tools) with braille spinner `⠁⠂⠄⡀⢀⠠⠐⠈` indexed by `tick/3`; a `toolFail` flash turns the badge red. |
| **retry** | Phase segment `RETRY #n` pulsing warn-amber (`tick/15` parity); meshes at idle intensity. |
| **error** | Whole interior tinted crimson at `I(age)` from the error flash, then IDLE. |

### 9.6 Palette (data)

From the reference image, for dark terminals. The OpenCode host passes `bg` from `api.theme.current.background` so light themes still blend correctly.

```ts
export const DEFAULT_PALETTE = {
  border: 0x4B5263, label: 0x8B93A1, text: 0xD7DAE0,
  gridBlue: 0x3B6A9A, gridBlueLt: 0x7FA7CF, gridEmpty: 0x3A3F4B, attendDot: 0xF28C28,
  route: 0x5B93C7, hex: [0xE8706A, 0xC8404F, 0xA9D18E, 0x4FA3AE], hidden: 0x4A8CC7,
  meshPink: 0xE07AA0, meshBlue: 0x8DB8D8, output: 0xB7CDE3,
  reasoning: 0xA78BFA, textOut: 0xF5B455, tool: 0x4FA3AE, warn: 0xF5B455, error: 0xE5484D,
} as const;
export type Palette = typeof DEFAULT_PALETTE;
```

### 9.7 Strip mode (1 line)

```
◖▓▓▓▒▒░·· ⬢⬢⬡⬢⬡⬡⬢⬡~ ◉ 63t/s ⚙bash
```
A 9-cell mini context bar; 8 mini experts (k lit by bucket for MoE / all for dense / shimmer for unknown); `◉` flashes per pulse; tps; tool badge. Drop from the right as width shrinks. Used for OpenCode's `session_prompt_right` slot.

---

## 10. Graphics primitives

### 10.1 Frame (ported from tdef `render/frame.go`)

```ts
export const DEFAULT = -1;                                  // terminal default color
export interface Cell { ch: string; fg: number; bg: number; bold: boolean }   // ch = one grapheme; "" = space
export class Frame {
  readonly w: number; readonly h: number;
  readonly ch: string[]; readonly fg: Int32Array; readonly bg: Int32Array; readonly bold: Uint8Array;
  constructor(w: number, h: number);                        // all cells: " ", DEFAULT, DEFAULT, 0
  set(x: number, y: number, ch: string, fg: number, bg?: number, bold?: boolean): void; // OOB → no-op
  text(): string;                                           // rows joined by "\n", like tdef Text()
  ansi(): string;                                           // full-screen truecolor dump, like tdef ANSI()
  cellEquals(other: Frame, i: number): boolean;
}
export function drawRoundedBox(f: Frame, r: Rect, fg: number): void;
export function embedSegment(f: Frame, y: number, x: number, text: string, left: string, right: string, border: number, fg: number, bold: boolean): number;
export function centerEmbed(f: Frame, y: number, text: string, left: string, right: string, border: number, fg: number, bold: boolean): number;
```
`ansi()` positions each row with CUP (`\x1b[{y};1H`). tdef's comment explains why: a wider terminal would otherwise smear the rows.

### 10.2 Braille canvas
- Sub-pixel resolution `(w*2)×(h*4)`; `BITS = [[0x01,0x08],[0x02,0x10],[0x04,0x20],[0x40,0x80]]`, bit = `BITS[sy&3][sx&1]`, char = `String.fromCharCode(0x2800 + mask)`.
- Storage per render call: `Uint8Array mask`, `Float32Array inten`, `Int32Array color` sized to the fan rects. Allocating per frame is acceptable at these sizes (tdef allocates a Frame per frame too); optimize only if profiling says so.
- `line(x0,y0,x1,y1,color,inten,{upTo?, stipple?})`: integer DDA; `upTo∈[0,1]` truncates for the progressive reveal; `stipple=2` plots every other point. Combine: max intensity wins the cell color; masks OR.
- `blitTo(frame, rect, bg)` writes braille chars for cells with `mask ≠ 0` (glyph columns are drawn afterwards, on top).

### 10.3 Illustrate
`mulberry32(seed)`, `hash32(...ints)`, `pickK(n, k, rng)` (distinct), `pickRecent(nFilled, m, rng)`. All seeds come from state values (`sessionKey`, `pulse.index`, layer, `w`, `h`), never time.

---

## 11. Host 1: OpenCode TUI plugin (primary)

Verified against the installed `@opencode-ai/plugin@1.18.16`, `@opencode-ai/sdk@1.18.16` (OpenCode 1.18.32) and `@opentui/core@0.5.x` typings, and against the user's working `opencode-tps-meter` plugin.

### 11.1 Module shape and install

```ts
// src/hosts/opencode-tui.ts
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui";
const tui: TuiPlugin = async (api, options, meta) => { /* §11.2–11.5 */ };
export default { id: "opencodeviz", tui } satisfies TuiPluginModule;
```

Register in **`~/.config/opencode/tui.json`** (TUI plugins live there; server plugins live in `opencode.jsonc`). Back the file up first, then **append** to the list without removing the existing entry:
```json
{ "plugin": ["opencode-tps-meter@latest", ["file:///Users/vikrambhaduri/occ/opencodeviz", { "surface": "sidebar" }]] }
```
- Entries are `string | [string, options]`. `TuiPluginEntry.source` includes `"file"`, so local plugins are supported. **Verify the exact spec form:** try `file:///abs/path`, then the bare absolute path, then `bun link`. Check the logs in `~/.local/share/opencode/log/`.
- OpenCode runs TS via Bun, so no build step is needed for local use. **Restart OpenCode after every plugin change.** (tdef's stale-binary lesson: verify the code the user actually runs.)
- For publishing: `bun build` with `--external @opentui/core --external @opentui/solid --external solid-js --external '@opencode-ai/*'`.

### 11.2 OpenCode events → Signals (`src/adapters/opencode.ts`)

```ts
export class OpenCodeAdapter {
  constructor(sink: SignalSink, deps: { activeSessionID(): string | undefined; contextLimit(providerID: string, modelID: string): number | undefined; now(): number });
  handle(event: { type: string; properties: any }): void;
}
```
In the TUI, subscribe with `api.event.on(type, e => adapter.handle(e))` for each type below (there's no wildcard). Collect the unsubscribers and dispose them in `api.lifecycle.onDispose`. These **stable v1 events** are the primary path (the same ones `opencode-tps-meter` uses):

| Event (`properties`) | Signal(s) | Notes |
|---|---|---|
| `session.status` `{sessionID, status:{type:"busy"\|"idle"\|"retry", attempt?, message?}}` | busy (from non-busy) → `turn.start`; retry → `retry`; idle → `idle` | |
| `session.idle` `{sessionID}` | `idle` | |
| `session.error` | `error` | |
| `message.updated` `{sessionID, info}` | record `info.id → info.role`; if assistant and `providerID/modelID` changed → `model{contextLimit}` | `contextLimit` = `api.state.provider.find(p => p.id === providerID)?.models[modelID]?.limit.context` |
| `message.part.updated` `{sessionID, part, time}` | `step-start` → `step.start`; `step-finish` → `step.end{usage, finish: part.reason}`; `text`/`reasoning` → record `part.id → kind`; `tool` → below | Deltas lack the part type, so cache it from here |
| `message.part.delta` `{sessionID, messageID, partID, field, delta}` | `field === "text"` and message role ≠ user → `delta{kind: partKind.get(partID) ?? "text", chars: delta.length}` | |
| tool part `state.status` | first `pending`/`running` per `callID` → `tool.start{callID, tool}`; `completed` → `tool.end{ok:true}`; `error` → `tool.end{ok:false}` | Dedupe by `callID` |

Usage: `StepFinishPart.tokens {input, output, reasoning, cache:{read, write}}` → `Usage{input, output, reasoning, cacheRead, cacheWrite}`.
**Prompt size** = `promptTokens(usage)`, a small, commented, unit-tested function. Default `input + cacheRead + cacheWrite`. *Verify live* against OpenCode's own context display; if a provider's `input` already includes cached tokens, use `input + cacheWrite` for that provider (test both shapes).

**Session focus:** `api.route.current` → when `name === "session"`, `params.sessionID` is active. Drop events for other sessions, except that their busy/idle status updates `subagents{busy}`. When the active session changes, emit `reset{sessionKey}`.

**Optional fast path** (feature-detect only): newer builds also emit `session.next.*` (e.g., `session.next.text.delta {delta}`, `session.next.reasoning.delta`, `session.next.step.started {model:{id, providerID}}`, `session.next.step.ended {tokens, finish}`, `session.next.tool.called|success|failed {callID, tool?}`), and some builds name them without `next`. Once a session receives any `*.text.delta`, ignore v1 deltas for that session to avoid double counting. **The v1 path must work fully on its own.**

### 11.3 Surfaces

Use `@opentui/solid`'s runtime exports directly (`createElement`, `setProp`, `insertNode`, `createComponent`). This is what compiled Solid emits (confirmed in `opencode-tps-meter`'s `dist/tui.mjs`), so **no JSX and no compiler**.

1. **Sidebar** (default): `api.slots.register({ order: 50, slots: { sidebar_content(_ctx, props) { return VizBox({ height: opts.sidebarHeight ?? 14 }); } } })`.
2. **Strip:** slot `session_prompt_right` → `VizBox({ height: 1, width: 28 })`.
3. **Overlay** (`/viz`): a command that toggles an xlarge dialog containing `VizBox({ width: "100%", height: "100%" })`:
   ```ts
   api.command?.register(() => [{ title: "Toggle model visualizer", value: "opencodeviz.toggle", category: "View",
     slash: { name: "viz" },
     onSelect: () => api.ui.dialog.open ? api.ui.dialog.clear() : api.ui.dialog.replace(() =>
       createComponent(api.ui.Dialog, { size: "xlarge", onClose: () => api.ui.dialog.clear(),
         get children() { return VizBox({ width: "100%", height: "100%" }); } })) }]);
   ```
   `api.command` is deprecated in favor of `api.keymap.registerLayer({commands, bindings})`, but it still works and its shape is known. Use the keymap API only if its `@opentui/keymap` types are clear.

All surfaces share **one** `Driver` + `SimState`.

### 11.4 Drawing element (no subclass needed)

OpenTUI `RenderableOptions` include `live?: boolean` and `renderAfter?(this, buffer: OptimizedBuffer, deltaTime)`. A plain `box` can therefore be a 30 fps canvas:

```ts
function VizBox(size: { width?: number | string; height?: number | string }) {
  const el = createElement("box");
  setProp(el, "flexShrink", 0);
  size.width !== undefined ? setProp(el, "width", size.width) : setProp(el, "flexGrow", 1);
  if (size.height !== undefined) setProp(el, "height", size.height);
  setProp(el, "live", true);
  setProp(el, "renderAfter", function (this: { x: number; y: number; width: number; height: number }, buffer: OptimizedBuffer) {
    driver.advanceTo(performance.now());                    // idempotent per now
    const frame = renderViz(this.width, this.height, sim, pal, { ...vizOpts, bg: themeBg() });
    copyFrame(buffer, frame, this.x, this.y);               // backends/opentui.ts
  });
  return el;
}
```
- `copyFrame` calls `buffer.setCell(x, y, ch, rgba(fg), rgba(bg))`. Its signature is `setCell(x, y, char, fg: RGBA, bg: RGBA, attributes?)`; set bold via attributes if needed. Cache RGBA objects by color int (`Map<number, RGBA>`, built with `RGBA.fromInts(r,g,b,255)`). Map `DEFAULT` bg to the theme background.
- If importing `RGBA` from `@opentui/core` fails at runtime, use the host's class: `api.theme.current.background.constructor.fromInts`.
- **Frame pacing:** a 250 ms interval sets `el.live = sim.phase !== "idle" || breathing`. If idle CPU > 3%, switch idle to `live = false` plus `el.requestRender()` at 10 fps. Clear the interval on dispose.
- **Fallback** if `renderAfter` isn't honored on `box`: `extend({ viz_canvas: VizRenderable })` from `@opentui/solid`, where `class VizRenderable extends Renderable { constructor(ctx, o) { super(ctx, { ...o, live: true }) } renderSelf(buf) { … } }`, then `createElement("viz_canvas")`.

### 11.5 Options

```ts
type VizOptions = {
  surface?: "sidebar" | "strip" | "both";   // default "sidebar"
  sidebarHeight?: number;                   // default 14
  asciiSafe?: boolean;                      // ⬢→◆, ◉→@
  labels?: boolean;                         // default true (honesty segment)
  arch?: Record<string, Arch>;              // regex(modelID) → Arch
};
```

---

## 12. Demo scripts (build before any host)

`src/core/demo.ts`: `demoSignals(name, t0): Signal[]`, fully precomputed with timestamps and a seeded PRNG, so they're deterministic and usable directly by `capture`.
- `moe-chat`: `qwen3-235b-a22b` (contextLimit 131072); turn.start → 1.4 s prefill → 900 reasoning tokens at ~70 tok/s in bursty chunks (1–40 chars every 20–120 ms) → 300 text tokens → step.end(usage) → idle.
- `agentic`: `gpt-oss-120b`; prefill → reasoning → tool bash 2.3 s → prefill 0.6 s → concurrent read + grep → … → answer → idle. Growing `cacheRead` across steps.
- `closed`: `claude-sonnet-4-5` (unknown arch), 200k limit, 150k cacheRead, 90 tok/s text.
- `dense`: `llama-3.1-70b`, 25 tok/s.
- `error`: prefill → retry ×2 → error.
- `all`: concatenation with 3 s idle gaps (the CLI default loop).

---

## 13. Host 2: standalone CLI (`src/hosts/cli.ts`)

### 13.1 Commands (tdef `main.go` style: subcommands with their own flags, plus `help`)

```
opencodeviz                         live demo loop (= demo all, looping)
opencodeviz demo [script]           play one demo script
opencodeviz replay <file.ndjson> [-speed 2]
opencodeviz stdin                   read NDJSON Signals from stdin (universal port, §14)
opencodeviz attach <url> [-session id]   follow a running OpenCode server over SSE
opencodeviz capture -script moe-chat -size 100x30 [-every 15] [-limit N] [-text|-ansi] [-out frames]
opencodeviz screens -size 100x30 [-tick N] [-script agentic]   every layout mode × phase → stdout (text)
opencodeviz registry                print the architecture table
opencodeviz help
common flags: -fps 30  -ascii-safe  -no-labels  -record out.ndjson  -arch '<json>'
```
- `attach`: `createOpencodeClient({ baseUrl })` from `@opencode-ai/sdk`, subscribe to the event stream (`client.event.subscribe()` → async iterable), and feed it through the same `OpenCodeAdapter`. Active session: `-session`, else the most recently busy one. Context limits come from the providers/config endpoint (check the SDK for the exact call). This is the only CLI command that uses the SDK; load it lazily so the rest of the CLI stays dependency-free.
- `capture`/`screens` use the **virtual clock** (§7.2), so output is byte-identical everywhere. `capture -text` writes `frame-00015.txt` etc.; `-ansi` writes `.ans`. This is the committed "see the output" tool that tdef's retrospective wished it had.

### 13.2 Terminal and blit (`src/backends/ansi.ts`, mirroring tdef `tui/term.go` + `blitTo`)
- `Terminal.open()`: `process.stdin.setRawMode(true)`; alt screen `\x1b[?1049h`; hide cursor `\x1b[?25l`. `close()` reverses all of it plus `\x1b[0m`. Call it from `finally`, `process.on("exit")`, SIGINT, SIGTERM and `uncaughtException`, so the terminal is always restored.
- Resize: `process.stdout.on("resize")` **only sets a flag**. The loop reads `columns/rows` and calls `blitter.reset()`, so the next blit is a full redraw (same as tdef's winch notifier).
- `Blitter.blit(frame): string`: if `prev` is null or a different size → `\x1b[2J\x1b[H` + full draw; else only changed cells. It tracks the pen (`x, y, fg, bg, bold`) and only emits CUP/SGR when they change, clips to the terminal size, wraps the frame in `\x1b[?2026h … \x1b[?2026l`, and makes one `write` per frame.
- Color: truecolor `\x1b[38;2;r;g;bm` when `COLORTERM ∈ {truecolor, 24bit}`, else the nearest 256-color index (`16 + 36r + 6g + b`); `DEFAULT` → `\x1b[39m` / `\x1b[49m`.
- Loop: `setInterval(1000/fps)` → handle the resize flag → drain input → `driver.advanceTo(performance.now())` → `renderViz` → `blit`. Idle: skip to every 3rd interval (10 fps).
- Keys: `q`/Ctrl-C quit · `d` next demo script · `l` toggle labels.
- `-tmux`: when `$TMUX` is set, `tmux split-window -h -l 45% "opencodeviz attach …"`.

---

## 14. Porting to other hosts and renderers

The core needs only `Signal`s in and produces `Frame`s out.

**New host = an adapter that emits Signals**, either in-process (TS → `driver.push`) or out-of-process in **any language** printing NDJSON into `opencodeviz stdin`.

| Host | How to get Signals | Fidelity |
|---|---|---|
| **Anything talking to Anthropic/OpenAI-compatible APIs** (Claude Code, Codex CLI, Aider, custom agents) | **Local streaming proxy** (future `src/adapters/proxy.ts`): forward to the real API and tee SSE. Point the tool at it with `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL`. Anthropic mapping: request → `step.start`; `content_block_delta` `text_delta`/`thinking_delta` → `delta`; `tool_use` block → `tool.start` (tool.end = the next request carrying its `tool_result`); `message_delta.usage` → `step.end`. OpenAI mapping: `choices[].delta.content`/`reasoning_content`, `tool_calls`, `usage` (with `stream_options.include_usage`). | **Full**: exact streaming and exact usage. The best universal option. |
| **Claude Code (no proxy)** | Hooks: `UserPromptSubmit` → `turn.start`, `PreToolUse` → `tool.start`, `PostToolUse` → `tool.end`, `Stop` → `idle`; each hook appends a Signal line to a FIFO read by `opencodeviz stdin`. Tail the session `transcript_path` JSONL for assistant `message.usage` → `step.end`, and `message.model` → `model`. | **Phases + usage only.** Decode uses the degraded path (§7.4), shown as `≈`. |
| **Ollama / llama.cpp** | Streaming chunks give real token counts; the final chunk has `prompt_eval_count`, `prompt_eval_duration`, `eval_count`, `eval_duration` (exact prefill and decode rate). Architecture is exact from `/api/show` → `model_info` (`*.block_count`, `*.expert_count`, `*.expert_used_count`), which bypasses the registry. | **Full timing + real shape.** |
| **OpenCode headless/remote** | `opencodeviz attach`. | Full. |

**New renderer = a consumer of `Frame`** (or of `SimState` directly):
- **Web:** fully specified in **`WEB-SPEC.md`**: a Go (default) or Rust daemon `vizd` that listens to the user's harness (streaming API proxy, OpenCode forwarder, Claude Code hooks + transcript tail, Ollama, NDJSON) and a browser canvas driven by the same Sim compiled to WASM, using a display-list seam shared with a native braille rasterizer.
- **Other TUI stacks** (Go like tdef, Ratatui, Bubble Tea, Textual): port `src/core` (≈1.5k LOC, zero deps; the Frame model already mirrors tdef's Go `render.Frame`, so a Go port is close to mechanical), or run headless and stream Frames.

Invariants for every port: the Signal schema, the real-vs-illustrative split, seeded determinism, and the visible honesty label.

---

## 15. Build order (single session; one green commit per step)

0. **Baseline** (before touching anything): `git init`; `.gitignore` (`node_modules`, `frames/`); record OpenCode idle CPU (`top -l 3 -pid <pid>`) and confirm the tps meter shows during a prompt. Note both in `devlog.md`.
1. **Scaffold:** package.json, tsconfig (strict, `moduleResolution: "bundler"`, `types: ["bun-types"]`), folders, `bun install`, an empty `bun test` passing. Commit.
2. **Frame + braille + vt reconstructor:** `frame.ts` (with box/segment helpers), `braille.ts`, `test/vt.ts`. Tests §16 *frame*, *braille*. Commit.
3. **Sim + driver + rate:** tests §16 *sim*. Commit.
4. **Registry:** tests §16 *registry*. Commit.
5. **Layout, test-first:** write `layout.test.ts` with exact rects (§9.1) **before** `layout.ts`; then implement. Commit.
6. **Render + demo + `screens`/`capture`:** `illustrate.ts`, `viz.ts`, `strip.ts`, `demo.ts`, plus the CLI's `screens`/`capture` subcommands. **Then look:** run `screens` at 40×14, 62×19, 90×30, 137×45 and `capture -script agentic -every 15 -text`, and **read the frames**. Fix centering/collision/overflow issues, which tests rarely catch. Generate `test/golden/*.txt` only after eyeballing; commit them with the tests §16 *render*. Commit.
7. **ANSI backend + interactive CLI** (`demo`, `replay`, `stdin`, keys, resize). Run it in a real terminal and tune constants (§9.3–9.5) until it's calm at 90×30 and legible at 40×14. Blit tests §16 *blit*. Commit.
8. **OpenCode adapter:** handwrite fixtures in `test/fixtures/opencode/` from the shapes in §11.2 / §18; tests §16 *adapter*. Commit.
9. **TUI plugin:** `opencode-tui.ts`, `backends/opentui.ts`. Back up `tui.json`, append the entry, restart OpenCode, then verify: sidebar renders; `/viz` toggles the overlay; a prompt shows PREFILL → DECODE with distinct reasoning/text colors; a tool shows the badge; ctx roughly matches OpenCode's own display; idle breathes. **Regression vs. baseline:** the tps meter still works; idle CPU is re-measured and reported. Commit.
10. **`attach` + `-record`:** attach to `opencode serve`, record a real session to `test/fixtures/live-*.ndjson`, replay it, and add a replay golden test. Commit.
11. **Docs:** README (install snippet, real-vs-illustrative table, options, CLI, porting summary, a captured frame) and the `devlog.md` entry (what was built, decisions, **parked debt**, **process gotchas**). Commit.

Process gotchas carried over from tdef (log new ones in the devlog as they happen):
- zsh mangles `grep --include=*.ts` globs; quote them or use the dedicated search tool.
- Never `git checkout -- <file>` to undo one change; it reverts *all* uncommitted edits in that file. Make surgical edits.
- A PTY/blit check that greps literal strings gives false negatives, because diff blits fragment text. Verify through `test/vt.ts` reconstruction. When a check fails, interrogate the check before the code.
- Verify the artifact the user actually runs: restart OpenCode after edits; the `tui.json` entry must point at this working tree.

---

## 16. Named test list (the contract)

**frame**
- `FrameSetOutOfBoundsIsNoop`, `FrameTextShape` (h lines of w chars), `FrameAnsiReconstructs` (vt(frame.ansi()) == frame.text()), `RoundedBoxCorners`, `EmbedSegmentReturnsNextColumn`, `CenterEmbedClampsToCorners`.

**braille**
- `BrailleBitsMatchUnicode` (each sub-pixel → expected codepoint), `LineEndpointsPlotted`, `LineUpToTruncates`, `StippleHalvesDots`, `MaxIntensityWinsColor`.

**blit** (via `test/vt.ts`)
- `BlitFirstFrameFullRedraw`, `BlitOnlyChangedCells` (output length ≪ full for a 1-cell change), `BlitSequenceReconstructs` (random frame sequence → reconstructed screen equals the last frame at each step), `BlitResetAfterResize`, `BlitClipsToTerminal`.

**sim**
- One test per arrow in §7.1 (`IdleToPrefillOnTurnStart`, `PrefillToDecodeOnFirstDelta`, `DecodeToToolOnToolStart`, `ToolToPrefillWhenAllToolsEnd`, `ConcurrentToolsStayInTool`, `IdleTimeoutAfterStepEnd`, `ErrorFlashThenIdle`, `RetryUntilNextStep`).
- `TtftTicksMeasured`, `CalibrationConverges`, `UsageOnlyDegradedPath`, `DuplicateSignalsIgnored`, `ResetKeepsCalibration`.
- `SimDeterministic` (same signal/tick stream twice → deep-equal state), `DriverCatchUpClamped` (a 5 s stall → ≤ 10 steps), `DriverIdempotentSameNow`, `SignalAppliedAtItsTick`.
- `EmitterCapsPulseRate` (300 tok/s → ≤ 14 pulses/s, bank conserved), `PulsesExpire`.

**registry**
- One assertion per seed row; `ProviderPrefixStripped`, `SpecificBeforeGeneral` (`qwen3-coder-480b` ≠ `qwen3-235b`), `ClosedModelsUnknown`, `OverridesWin`.

**layout** (written first)
- `LayoutExact_40x14`, `LayoutExact_62x19`, `LayoutExact_90x30`, `LayoutExact_137x45`, `LayoutModesByThreshold`, `LayoutRegionsInsideBox` and `LayoutRegionsDisjoint` (all `w∈[1,220], h∈[1,70]`), `HonestySegmentNeverDropped` (full/compact).

**render**
- `RenderDeterministic` (same inputs → deep-equal Frame), `RenderAnimates` (decode: tick t vs t+15 differ), `RenderIdleBreathes` (idle: tick 0 vs 60 differ only in intensity, not glyphs).
- `RenderFitsFrame` for sizes `{1×1, 12×1, 28×1, 34×10, 40×14, 62×19, 90×30, 137×45, 220×70}`: no throw, frame dims exact, border intact in full/compact.
- `RenderPhaseScript` (tdef `TestTitlePhases` style): replay demo `agentic` at fixed ticks with `want`/`absent` strings, e.g. `PREFILL`+`ttft` → `DECODE`+`tok/s` → `⚙ bash` → after the tool, `PREFILL` and no `⚙` → finally no `DECODE`.
- `ExactlyKExpertsLit` (moe at the expert-fire stage: lit `⬢` count == bucketed k), `SharedExpertsAlwaysLit`, `DenseColumnUniform`, `UnknownShowsLabel`, `HudModelInTopBorder`, `ContextGridMatchesUsage` (cell counts per kind == expected from usage/limit, ±1 cell), `CometLandsThenCellAppears`.
- `GoldenFrames` (committed `test/golden/*.txt` from `capture`; regenerate deliberately with `UPDATE_GOLDEN=1`).

**adapter**
- `TextDeltaToSignal`, `ReasoningDeltaUsesPartKind`, `UnknownPartDefaultsText`, `UserMessageDeltasIgnored`, `StepFinishToUsage`, `ToolLifecycleDeduped`, `ModelSignalWithContextLimit`, `OtherSessionsOnlyCountSubagents`, `SessionSwitchEmitsReset`, `PromptTokensBothShapes`, `NextPathSuppressesV1Deltas`.

**hygiene**
- `CoreImportsNothingOutsideCore` (scan `src/core/**` import specifiers), `CoreHasNoClockOrRandom` (no `Date.now`, `performance.now`, `Math.random` in `src/core/**` except `driver.ts`, which receives `now` as an argument and never reads a clock).

---

## 17. Acceptance criteria

- [ ] Every commit green: `bun test` + `bun run typecheck`.
- [ ] `opencodeviz` demo loop at 30 fps, < 5% CPU at 120×40; the terminal is always restored (quit, Ctrl-C, crash).
- [ ] `opencodeviz screens` / `capture` output is byte-identical across runs.
- [ ] In OpenCode: sidebar viz renders, `/viz` toggles the overlay, and it coexists with `opencode-tps-meter` (verified against the baseline).
- [ ] Live: PREFILL within one frame of sending; TTFT shown; DECODE tracks throughput; reasoning violet vs. text amber; tool badge appears and clears; returns to IDLE.
- [ ] Context grid within ±5% of OpenCode's own context usage after the first step.
- [ ] Known MoE models show the correct `N e/k a · L` with exactly *k* (bucketed) lit; dense shows a uniform bar; closed models show `architecture unknown`.
- [ ] The honesty segment is present in every full/compact frame.
- [ ] `devlog.md` lists what shipped, the decisions, parked debt and process gotchas.

---

## 18. Known unknowns: verify, don't assume

| Item | How to verify | Fallback |
|---|---|---|
| Local TUI plugin spec in `tui.json` | Try `file:///abs`, abs path, `bun link`; read the OpenCode log | `npm pack` → path to the tarball |
| `live` + `renderAfter` honored on `box` | Draw a moving `█` in a 10×3 box | `extend()` + `Renderable` subclass (§11.4) |
| `RGBA` import from the plugin | Log `typeof RGBA.fromInts` at startup | `api.theme.current.background.constructor` |
| `input` includes or excludes cached tokens per provider | Compare the grid % to OpenCode's context display for Anthropic and one OpenAI-compatible model | Per-provider rule in `promptTokens` |
| `session.next.*` vs `session.*` event names in this build | Subscribe to the candidates and log the types seen during one prompt | v1 only |
| Sidebar slot size | Log `this.width/this.height` in `renderAfter` | Layout modes adapt |
| `⬢` width in the user's terminal | Eyeball the demo | `asciiSafe` |
| Registry numbers | HF `config.json` (`num_hidden_layers`, `n_routed_experts`/`num_experts`, `num_experts_per_tok`, `n_shared_experts`) | `note: "unverified"` |

---

## 19. Reference: verified type excerpts

From `@opencode-ai/plugin@1.18.16` `dist/tui.d.ts`, `@opencode-ai/sdk@1.18.16` `dist/v2/gen/types.gen.d.ts`, `@opentui/core@0.5.10`:

```ts
// TUI plugin
type TuiPlugin = (api: TuiPluginApi, options: PluginOptions | undefined, meta: TuiPluginMeta) => Promise<void>;
type TuiPluginModule = { id?: string; tui: TuiPlugin; server?: never };
// api.event.on<Type extends Event["type"]>(type, handler) => unsubscribe
// api.slots.register({ order?, slots: { sidebar_content(ctx, {session_id}), session_prompt_right(ctx, {session_id}), app_bottom, home_footer, ... } })
// api.route.current: { name: "session", params: { sessionID } } | { name: "home" } | ...
// api.ui.dialog.replace(render, onClose?) / clear() / open ; api.ui.Dialog({ size: "medium"|"large"|"xlarge", onClose, children })
// api.command?.register(() => TuiCommand[])  — TuiCommand { title, value, description?, category?, keybind?, slash?: { name, aliases? }, onSelect? }
// api.state.provider: ReadonlyArray<Provider> → Provider.models[modelID].limit.context
// api.theme.current.background: RGBA ; api.lifecycle.onDispose(fn) ; api.renderer: CliRenderer

// Events (subset)
{ type: "message.part.delta";   properties: { sessionID; messageID; partID; field: string; delta: string } }
{ type: "message.part.updated"; properties: { sessionID; part: Part; time: number } }
{ type: "message.updated";      properties: { sessionID; info: Message } }
{ type: "session.status";       properties: { sessionID; status: {type:"idle"} | {type:"busy"} | {type:"retry"; attempt; message; next} } }
{ type: "session.idle";         properties: { sessionID } }

// Parts / messages
StepFinishPart { type: "step-finish"; reason: string; cost: number; tokens: { total?; input; output; reasoning; cache: { read; write } } }
ToolPart       { type: "tool"; callID; tool; state: { status: "pending" | "running" | "completed" | "error", ... } }
TextPart       { type: "text"; text; synthetic?; time? }     ReasoningPart { type: "reasoning"; text; time }
AssistantMessage { role: "assistant"; modelID; providerID; tokens{...}; time{ created; completed? }; finish? }

// OpenTUI
RenderableOptions { width?; height?; live?: boolean;
  renderBefore?(this, buffer: OptimizedBuffer, dt: number): void; renderAfter?(this, buffer: OptimizedBuffer, dt: number): void; onSizeChange?(this): void }
OptimizedBuffer.setCell(x, y, char, fg: RGBA, bg: RGBA, attributes?) ; drawText(text, x, y, fg, bg?, attributes?)
RGBA.fromInts(r, g, b, a?) ; RGBA.fromHex(hex)
@opentui/solid: createElement, setProp, insertNode, insert, createComponent, effect, extend
```

**Working references on this machine:**
- `~/.cache/opencode/packages/opencode-tps-meter@latest/node_modules/opencode-tps-meter/dist/tui.mjs`: real handlers for `message.part.delta` / `message.part.updated` / `message.updated` / `session.idle`, a `slots.register` call, and the module export shape `{ id, tui }`.
- `../tdef/render/frame.go`, `../tdef/tui/app.go` (`loop`, `stepGame`, `blitTo`), `../tdef/tui/term.go`, `../tdef/render/screens_test.go`: the patterns from §1, in Go.
