# opencodeviz

A live terminal animation of what an LLM is doing **right now**: prefill, decode, reasoning, tool calls,
context fill, and (for open-weight models) its real architecture shape. It runs **inside OpenCode**
(sidebar + `/viz` overlay) or **standalone** in any terminal.

```
╭─┤qwen3-235b-a22b · MoE 128e/8a · 94L├─────────────┤▸ REASONING  L 1/94  71 tok/s  ttft 1.4s├─╮
│                                        ⢀⣀⠤ ⬢ ● ⢤⣤⠤⠤⠤⢄⣀⣀⣀⣀⣀⣀⣀⣀⣀⣀                              │
│                                   ⣀⡠⠤⠒⢊⣁⣠⠤ ⬢ ● ⢤⣬⠽⠶⣦⣤⡤⠤⠤⠤⠤⠤⠤⠤⠤⠤⠭⠭⠭⡁⠁⠁⠁⠁⠁⠁⠁⠂⠂⠂⠂⠂⠂⠂⠂⠂⠂⠂⡄⡄⡄⡄⡄ ● │
│ ▓▓▓●▓▓▓▓▓▓▓▓▓ ⠄     ⣀⣀⡠⣤⡴⢶⣒⠯⠭⠒⠊⠉⠁⠊⠁⣀⢀⣀⣀⣀⠤⠤ ⬢ ● ⠤⣤⣤⠒⠒⠛⠛⠾⡭⢿⣽⣯⣝⡓⠤⣀⠂⠂⠆⡂⡁⠁⠁⠃⠂⠄⠄⡀⡀⡀⡄⡄⡂⡁⡁⡅⡃⡅⠇⠇⡆⡄⡄ ● │
│ ▓▓▓▓▓▓●▓▓▓●▓▓ ⠤⠴⣒⣊⣉⣭⡴⠶⠛⣊⣉⣁⡠⠤⠤⠔⠒⠒⠒⠉⠉⠉⠁⠔⠒⠉   ⬢ ○ ⠄⡄⠉⠛⠷⣶⣢⡤⣈⣑⠪⢝⠲⢍⡓⠦⣭⣑⠢⠅⡁⠁⠁⡃⠅⠅⡃⠁⠁⠁⡁⡆⡂⡅⠄⡆⡆⡃⠅⠇⠇⠁    │
│ ▓▓▓▓▒▒●······ ⢤⣶⣾⣟⣓⣊⣉⣉⣉⣒⡒⠒⠢⠤⠤⢄⣀⣀⣀⠒⠊⠁    ⢀⡠ ⬢ ●   ⠃⠇⡇⡇⠉⠚⠭⢖⡭⢍⣛⠲⠬⣕⣦⣭⣛⡇⡃⠁⠃⡃⡅⡅⡅⠇⠃⠃⠇⠆⡂⡆⠂⡃⠇⡂⡇⡅⡆⡆⡄ ● │
│  …                                                                                           │
╰─┤ctx ▓······· 94% cached · 22k/131k├─┤think ~402 · out ~0├────────────┤illustrative routing├─╯
```
*(Monochrome text dump. The real thing is truecolor: violet reasoning, amber output, a blue context grid,
salmon/crimson/sage/teal experts, and pink/blue projection lines.)*

Left to right: **context window** (each cell is N tokens; `▓` cached, `▒` fresh, colored = generated this
turn) → **router fan** → **experts** (`⬢`, exactly *k* light per token for MoE models) → **hidden state**
→ **logit fan** → **output nodes** (`◉` = sampled token). A comet carries each sampled token back into the
grid: that loop is autoregressive decoding.

## What's real vs. illustrative

| Real (from your harness's events) | Illustrative (seeded, labeled on screen) |
|---|---|
| Phase: idle / prefill / decode / tool / retry / error | *Which* experts light (the count *k* is real) |
| Time to first token | Which grid cells get the orange "attention" dots |
| Tokens/sec (streamed deltas, calibrated against real usage) | Which hidden nodes / output nodes light |
| Reasoning vs. answer text | Layer-sweep pace (real layers take microseconds) |
| Tool name, duration, success/failure | Everything mid-network for closed models |
| Input / output / reasoning / cache-read / cache-write tokens | |
| Context limit and fill | |
| Layers, experts, active experts (public model cards) | |

Every boxed frame carries a label in its bottom border: `illustrative routing`, or `architecture unknown`
for closed models (Claude, GPT, Gemini, …) and anything not in the registry.

## Inside OpenCode

Add it to **`~/.config/opencode/tui.json`** (TUI plugins live there; server plugins live in `opencode.jsonc`):

```json
{
  "plugin": [
    "opencode-tps-meter@latest",
    ["file:///Users/vikrambhaduri/occ/opencodeviz", { "surface": "sidebar" }]
  ]
}
```

Restart OpenCode. Then:

- **Sidebar:** a compact viz above OpenCode's Context section (inside a session).
- **`/viz`:** opens a full-size overlay; running `/viz` again toggles it closed. OpenCode dialogs also
  close with `esc`, but closing hasn't been verified on screen yet (see `devlog.md`).
- **`/viz-demo`:** plays the built-in demo scripts in the overlay (no tokens spent).

Options (the second element of the plugin tuple):

| option | default | |
|---|---|---|
| `surface` | `"sidebar"` | `"sidebar"`, `"strip"` (one line next to the prompt) or `"both"` |
| `sidebarHeight` | `14` | rows |
| `fps` | `20` | render rate while the model works (the simulation always runs at 30 Hz) |
| `idleFps` | `0` | idle animation rate; `0` = static idle frame |
| `asciiSafe` | `false` | `⬢`→`◆`, `◉`→`@` for terminals that draw them double-width |
| `labels` | `true` | |
| `arch` | – | `{ "<modelID regex>": { "kind": "moe", "family": "x", "layers": 40, "experts": 128, "active": 8, "shared": 0 } }` |

**CPU cost** (measured on this machine, OpenCode 1.18.32, 140×45, `ps` averages; see `devlog.md`):
idle +0.7% over baseline (static idle frame); active ≈ 20% while animating at 20 fps. Our own drawing is
~1 ms/frame for a full overlay, and most of the active cost is OpenCode re-rendering its whole screen
for each frame we request. Lower `fps` if that matters.

**Your local model** (`llamacpp/qwen3.6-35b-a3b-uncensored`) isn't in the registry, so it shows
`architecture unknown` rather than made-up numbers. If you know its shape (GGUF metadata
`*.block_count`, `*.expert_count`, `*.expert_used_count`, or the HF `config.json`), add it:

```json
["file:///Users/vikrambhaduri/occ/opencodeviz", { "arch": { "qwen3\\.6-35b-a3b": { "kind": "moe", "family": "qwen3.6-35b-a3b", "layers": 0, "experts": 0, "active": 0, "shared": 0 } } }]
```
(fill in the real numbers)

## Standalone CLI

```sh
bun install
bun src/hosts/cli.ts                    # demo loop (all scripts); keys: d next script, l labels, q quit
bun src/hosts/cli.ts demo agentic       # moe-chat | agentic | closed | dense | error | all
bun src/hosts/cli.ts attach http://127.0.0.1:4096   # follow a running `opencode serve`
bun src/hosts/cli.ts replay rec.ndjson -speed 2
cat rec.ndjson | bun src/hosts/cli.ts stdin
bun src/hosts/cli.ts capture -script agentic -size 100x30 -every 15 -text -out frames   # headless, byte-identical
bun src/hosts/cli.ts screens -size 90x30 -visible 0.3   # every phase as text; -visible blanks dim cells
bun src/hosts/cli.ts registry
```
Common flags: `-fps 30 -ascii-safe -no-labels -record out.ndjson -arch '<json>'`.

## Porting to other harnesses

The core takes **Signals** in (one JSON object per line: `turn.start`, `step.start`, `delta`,
`tool.start/end`, `step.end{usage}`, `idle`, …; see `src/core/protocol.ts`) and produces **Frames** out.
Anything that can print NDJSON Signals can drive `opencodeviz stdin`: a streaming API proxy, Claude Code
hooks plus its transcript, Ollama. `SPEC.md` §14 covers the mappings, and `WEB-SPEC.md` covers a
Go/Rust daemon + web canvas variant.

## Development

```sh
bun test            # 104 tests: sim, layout (written first), render, goldens, adapter, live replay, hygiene
bun run typecheck
UPDATE_GOLDEN=1 bun test test/render.test.ts   # only after reading the new frames
OPENCODEVIZ_DEBUG=/tmp/viz.log opencode         # plugin geometry + per-frame timing log
```

Layout: `src/core` (pure, zero deps: protocol, sim, registry, render), `src/adapters` (OpenCode events,
SSE attach, NDJSON), `src/backends` (ANSI blitter, OpenTUI copy), `src/hosts` (CLI, OpenCode TUI plugin).
`SPEC.md` is the contract, and `devlog.md` records what was built, what was verified and what's still open.
