# inlineviz

A live terminal animation of what your LLM is doing **right now**, inside [OpenCode](https://opencode.ai):
prefill, decode, reasoning vs. answer, tool calls, context fill and cache, and (for known open-weight
models) the model's real architecture: layers, experts, active experts.

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
*(A monochrome text dump. In your terminal it's truecolor: violet reasoning, amber answers, a blue
context grid, colored experts.)*

Left to right: **your context window** (each cell is N tokens: `▓` cached, `▒` fresh, colored = written
this turn) → **router** → **experts** (`⬢`, exactly *k* light per token on MoE models) → **hidden state**
→ **output** (`◉` = the token being sampled). Each sampled token flies back into the context grid,
because that loop *is* how an LLM writes.

## Install

**You need:** OpenCode **1.18 or 1.19** (check with `opencode --version`). OpenCode 2 isn't supported yet
(it uses a new plugin system, and support is planned). Nothing else is needed: no Bun, no build step.

Installing means adding one line to OpenCode's TUI config file, **`~/.config/opencode/tui.json`**, and
restarting OpenCode. If the file doesn't exist yet, create it.

### Option 1: from npm (recommended)

> ⏳ **Not published to npm yet.** Until it is, use Option 2.

Put this in `~/.config/opencode/tui.json`:

```json
{
  "plugin": ["inlineviz@latest"]
}
```

OpenCode downloads it automatically the next time it starts.

### Option 2: from source (works today)

1. Download it anywhere you like:

   ```sh
   git clone https://github.com/basedvik/inlineviz.git ~/inlineviz
   ```

2. Find the folder's full path (you'll need it in the next step):

   ```sh
   cd ~/inlineviz && pwd        # e.g. /Users/you/inlineviz
   ```

3. Put that path in `~/.config/opencode/tui.json`, with `file://` in front:

   ```json
   {
     "plugin": ["file:///Users/you/inlineviz"]
   }
   ```

   Use the full path; `~` doesn't work here.

To update later: `cd ~/inlineviz && git pull`, then restart OpenCode.

### Then

**Restart OpenCode** (quit it completely and open it again).

**Already have other TUI plugins?** Add `inlineviz` to your existing list instead of replacing it:

```json
{
  "plugin": [
    "opencode-tps-meter@latest",
    "inlineviz@latest"
  ]
}
```

> It must go in **`tui.json`**, not `opencode.json`/`opencode.jsonc`. Those are for a different kind of plugin, and
> putting it there won't work.

## Use it

- **Sidebar:** open any session and a compact visualizer sits in the right sidebar, above *Context*.
  If you don't see the sidebar, widen the terminal (or toggle the sidebar from `ctrl+p`).
- **`/viz`:** a big full-size view. Run `/viz` again to close it.
- **`/viz-demo`:** plays built-in demo sessions (MoE, dense, closed models, tool calls, errors) without
  spending any tokens.

Send a prompt and watch it go: **PREFILL** while the model reads your context → **THINK** (violet) while it
reasons → **DECODE** (amber) as it answers → `⚙ tool` while tools run → idle.

## What's real and what's illustrative

| Real (from OpenCode's events) | Illustrative (labeled on screen) |
|---|---|
| Phase: prefill / thinking / answering / tools / retry / error | *Which* experts light up (how *many* is real) |
| Time to first token, tokens/sec | Which context cells get the orange "attention" dots |
| Context size, cache hits, context limit | Which hidden and output nodes light |
| Tool name, duration, success/failure | The layer-by-layer sweep pace (real layers take microseconds) |
| Layers, experts, active experts for known models (public model cards) | Everything mid-network for closed models |

Hosted APIs don't expose a model's internals, so the inside of the network is a faithful-in-spirit
animation driven by real timing. Every frame says so in its bottom border (`illustrative routing`), and
closed or unrecognized models show `architecture unknown` rather than made-up numbers.

**Known architectures:** DeepSeek V3/R1, Kimi K2, Qwen3 (235B, 30B-A3B, Coder 480B), gpt-oss (120B, 20B),
Mixtral, Llama 4 Maverick/Scout, GLM-4.5, Llama 3.x, Qwen2.5-Coder. Add your own with the `arch` option.

## Options

Optional. To change settings, wrap the entry in `[ entry, { settings } ]`:

```json
{
  "plugin": [
    ["inlineviz@latest", { "surface": "sidebar", "fps": 20 }]
  ]
}
```

(From source it's the same, using your `file://` path in place of `inlineviz@latest`.)

| option | default | |
|---|---|---|
| `surface` | `"sidebar"` | `"sidebar"`, `"strip"` (a one-line meter beside the prompt) or `"both"` |
| `sidebarHeight` | `14` | rows |
| `fps` | `20` | frame rate while the model is working |
| `idleFps` | `0` | idle animation rate (`0` = still frame when idle) |
| `asciiSafe` | `false` | use `◆`/`@` if your terminal draws `⬢`/`◉` too wide |
| `arch` | – | teach it a model's shape: `{ "my-model-regex": { "kind": "moe", "family": "my-model", "layers": 48, "experts": 128, "active": 8, "shared": 0 } }` (or `{ "kind": "dense", "family": "x", "layers": 32 }`) |

**Performance:** idle costs almost nothing (+~0.7% CPU in testing). While the model is working, animating
costs roughly 15–25% of one core at 20 fps, mostly because OpenCode redraws its screen for each frame.
Lower `fps` if that matters to you.

## Uninstall

Remove the `inlineviz` line from `~/.config/opencode/tui.json` and restart OpenCode.
If you installed from source, you can also delete the folder you cloned.

## Standalone CLI (optional)

There's also a standalone version for any terminal pane. It needs [Bun](https://bun.sh).

```sh
git clone https://github.com/basedvik/inlineviz && cd inlineviz && bun install
bun src/hosts/cli.ts                      # demo loop: d = next demo, l = labels, q = quit
bun src/hosts/cli.ts attach http://127.0.0.1:4096   # follow a running `opencode serve`
bun src/hosts/cli.ts help                 # replay, stdin, capture, screens, registry…
```

Anything can drive it: pipe newline-delimited JSON events into `bun src/hosts/cli.ts stdin`
(format in `src/core/protocol.ts`). `SPEC.md` §14 sketches adapters for Claude Code, API proxies and
Ollama, and `WEB-SPEC.md` describes a web-canvas variant.

## Troubleshooting

- **Nothing shows up:**
  1. Quit OpenCode completely and start it again; plugins load at startup.
  2. Check the entry is in `~/.config/opencode/tui.json`, not `opencode.json`.
  3. Check `tui.json` is valid JSON (commas between entries, no trailing comma).
  4. From source: the path must be the full path with `file://` in front, and the folder must contain
     `package.json` and `dist/tui.js`.
  5. Check your version with `opencode --version`. It needs 1.18 or 1.19; OpenCode 2 isn't supported yet.
- **Sidebar is hidden:** the visualizer lives in OpenCode's session sidebar, which only shows inside a
  session on a wide enough terminal. Widen the window, or type `/viz` for the full-size view.
- **Weird spacing around `⬢`/`◉`:** set `"asciiSafe": true`.
- **Debugging:** `INLINEVIZ_DEBUG=/tmp/inlineviz.log opencode` logs the plugin's geometry and per-frame timing.

## Development

```sh
bun install
bun test              # 104 tests: simulation, layout, rendering, golden frames, OpenCode adapter, live replay
bun run typecheck
bun run build         # → dist/tui.js (what OpenCode loads)
```

To develop against your own OpenCode, point `tui.json` at your checkout:
`"file:///absolute/path/to/inlineviz"`. That uses `dist/tui.js`, so run `bun run build` after changes.

`src/core` is pure and dependency-free (event protocol, deterministic simulation, model registry,
renderer); `src/adapters` maps OpenCode events; `src/hosts` holds the OpenCode plugin and the CLI.
`SPEC.md` is the original design contract (see `devlog.md` for what changed during the build).

## License

MIT
