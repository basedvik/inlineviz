# inlineviz

A live terminal animation of what your LLM is doing **right now**: prefill, decode, reasoning vs. answer,
tool calls, subagents, context fill and cache, and (for known open-weight models) the model's real
architecture: layers, experts, active experts.

Works with:
- **[OpenCode](https://opencode.ai)**: draws *inside* OpenCode (sidebar + `/viz` full view). [Install ↓](#install-for-opencode)
- **[Claude Code](https://claude.com/claude-code)**: a plugin that drives a viewer *beside* your session
  (tmux split or a new terminal window). [Install ↓](#install-for-claude-code)

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

## Install for OpenCode

**You need:** OpenCode **1.18 or 1.19** (check with `opencode --version`). OpenCode 2 isn't supported yet
(it uses a new plugin system, and support is planned). Nothing else is needed: no Bun, no build step.

Installing means adding one line to OpenCode's TUI config file, **`~/.config/opencode/tui.json`**, and
restarting OpenCode. If the file doesn't exist yet, create it.

### Easiest: ask your AI coding agent

Paste this into Claude Code, Codex, Cursor, OpenCode itself, or any agent that can run shell commands:

```text
Install the OpenCode plugin from https://github.com/basedvik/inlineviz into my OpenCode.
Follow the "Instructions for AI agents" section of its README exactly.
```

<details>
<summary><b>Instructions for AI agents</b> (people can skip this)</summary>

You are installing the `inlineviz` TUI plugin into the user's OpenCode. Follow these steps in order.
Don't improvise other install methods.

1. **Check OpenCode.** Run `opencode --version`. Continue only if it's `1.18.x` or `1.19.x`. If it's
   2.x or newer, stop and tell the user OpenCode 2 isn't supported yet. If `opencode` isn't found, stop
   and say OpenCode must be installed first.
2. **Find the config file.** It's `$XDG_CONFIG_HOME/opencode/tui.json` if `XDG_CONFIG_HOME` is set,
   otherwise `~/.config/opencode/tui.json`. Plugins for the visualizer go in **`tui.json` only**. Never
   put it in `opencode.json` / `opencode.jsonc`.
3. **Back it up.** If `tui.json` exists, copy it to `tui.json.backup-before-inlineviz` in the same
   folder before changing anything.
4. **Pick the plugin entry:**
   - Run `npm view inlineviz version`. If it prints a version, the entry is `"inlineviz@latest"`.
   - If that fails (not published / npm missing), install from source:
     `git clone https://github.com/basedvik/inlineviz.git ~/.local/share/inlineviz` (if the folder
     already exists, run `git -C ~/.local/share/inlineviz pull` instead). Confirm
     `~/.local/share/inlineviz/dist/tui.js` exists. The entry is `"file://<absolute path>"` using the
     **fully expanded** path (e.g. `file:///Users/alex/.local/share/inlineviz`; `~` is not expanded).
     No build step and no `bun install` are needed.
5. **Edit `tui.json` by merging, not replacing.** Parse the existing JSON. Ensure a top-level `"plugin"`
   array exists, and append the entry to it. Keep every existing entry and all other keys. If an
   `inlineviz` entry (npm or a path ending in `inlineviz`) is already present, don't add a second one.
   If the file didn't exist, create it as `{ "plugin": [ <entry> ] }`. If the file contains comments
   (JSONC), edit it as text and keep the comments. Re-read it afterwards to confirm it's still valid.
6. **Don't** start, restart or send keystrokes to OpenCode yourself (an update prompt could capture
   them), and don't change any other OpenCode settings.
7. **Tell the user:**
   - quit OpenCode completely and reopen it;
   - open a session: the visualizer appears in the right sidebar above "Context" (widen the terminal
     if the sidebar is hidden);
   - type `/viz-demo` to see a demo, or `/viz` for the full-size view;
   - to undo: restore `tui.json.backup-before-inlineviz` (or remove the `inlineviz` entry) and restart.

</details>

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


## Install for Claude Code

**You need:** Claude Code 2.1 or newer, and Node.js 18+ (or Bun) on your PATH. No npm install, no build.

In Claude Code, run:

```text
/plugin marketplace add basedvik/inlineviz
/plugin install inlineviz@inlineviz
```

Then start a new Claude Code session, and type **`/inlineviz:viz`**. The viewer opens beside your session: in a
tmux split if you're in tmux, otherwise in a new Terminal or iTerm window. (The first time, macOS may ask to
let your terminal control Terminal; allow it.) `/inlineviz:viz-demo` plays the built-in demo.

You can also open the viewer yourself in any terminal pane, from a clone of this repo:
`node dist/inlineviz.mjs claude`.

**What's real in Claude Code:** the phases (reading your prompt, working, running tools), every tool call,
subagents starting and finishing, the model, and exact token counts per message (thinking vs. answer, cache
hits, context size), taken from Claude Code's hooks and its own session log. One thing Claude Code doesn't
expose is the live token stream, so **while Claude is working the pace is an estimate** (`▸ WORKING ≈69 tok/s`),
learned from how fast Claude actually was on your previous messages. The real counts land when each message
finishes. Claude's context window size isn't reported, so it shows `~200k` (or 1M for `[1m]` models).

**Privacy:** the plugin's hooks run in the background and record only event names, IDs, tool names, the model
and error types, in `~/.claude/plugins/data/inlineviz…/events.ndjson` (rotated at 5 MB). Never your prompts,
code, commands or tool output. Nothing leaves your machine.

**Uninstall:** `/plugin uninstall inlineviz@inlineviz`.

## Using it in OpenCode

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

### How it learns your model's shape

The expert column shows the model's *real* layers and experts when it can find them. It looks, in order:

1. **Your `arch` setting**, if you've set one (see Options).
2. **The server running the model**, for local and self-hosted setups: **mlx-serve** reports layers and
   whether it's MoE; **Ollama** reports layers and experts. (llama.cpp doesn't report enough, so for it
   the next step or your setting is needed.)
3. **Hugging Face**, when your model ID is a Hugging Face repo name like `mlx-community/Qwen3.8-27B-bf16`.
   Its `config.json` gives exact layers, experts and attention pattern. This sends the model ID (and only
   that) to huggingface.co; set `"archLookup": "server"` or `"off"` to prevent it.
4. **A built-in table** of well-known open models: DeepSeek V3/R1, Kimi K2, Qwen3, gpt-oss, Mixtral,
   Llama 3/4, GLM-4.5, Qwen2.5-Coder.

The header shows where the shape came from (`· via server`, `· via HF`, `· custom`). Results are cached.
If nothing knows the model (always true for closed models like Claude, GPT and Gemini, whose makers
don't publish their architecture), it says **`arch unknown`** and draws the middle of the network as an
abstract stack. Timing, tokens, context and tools are still real. No API keys are ever sent anywhere.

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
| `archLookup` | `"all"` | how to find your model's shape: `"all"` (your server + Hugging Face), `"server"` (your servers only), `"off"` |
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
- **Claude Code viewer shows nothing:** it follows the most recent session that has used the plugin, so send a
  prompt after installing. Check that `node --version` works in your terminal (the hooks need Node or Bun).
- **`/inlineviz:viz` didn't open a window:** it prints the command to run instead; paste that into any terminal pane.

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
