// @bun
// src/hosts/opencode-tui.ts
import { RGBA } from "@opentui/core";
import { createComponent, createElement, setProp } from "@opentui/solid";

// src/adapters/opencode.ts
var OPENCODE_EVENT_TYPES = [
  "session.status",
  "session.idle",
  "session.error",
  "message.updated",
  "message.part.updated",
  "message.part.delta",
  "session.next.text.delta",
  "session.next.reasoning.delta",
  "session.text.delta",
  "session.reasoning.delta"
];
var NEXT_DELTA = {
  "session.next.text.delta": "text",
  "session.next.reasoning.delta": "reasoning",
  "session.text.delta": "text",
  "session.reasoning.delta": "reasoning"
};
function usageFromTokens(t) {
  if (!t)
    return;
  const n = (v) => typeof v === "number" && Number.isFinite(v) ? Math.max(0, v) : 0;
  return { input: n(t.input), output: n(t.output), reasoning: n(t.reasoning), cacheRead: n(t.cache?.read), cacheWrite: n(t.cache?.write) };
}

class OpenCodeAdapter {
  sink;
  deps;
  current;
  followed;
  roles = new Map;
  live = new Set;
  partKind = new Map;
  seen = new Map;
  toolStarted = new Set;
  toolEnded = new Set;
  busy = new Map;
  nextPath = new Set;
  lastModelKey;
  lastSubagents = -1;
  constructor(sink, deps) {
    this.sink = sink;
    this.deps = deps;
  }
  get session() {
    return this.current;
  }
  sync() {
    this.focus(undefined);
  }
  handle(ev) {
    const p = ev.properties ?? {};
    const sid = p.sessionID ?? p.info?.sessionID ?? p.part?.sessionID;
    const wasBusy = sid ? this.busy.get(sid) ?? false : false;
    if (ev.type === "session.status" && sid)
      this.trackBusy(sid, p.status?.type === "busy" || p.status?.type === "retry");
    if (ev.type === "session.idle" && sid)
      this.trackBusy(sid, false);
    if (!this.focus(sid))
      return;
    const ts = this.deps.now();
    switch (ev.type) {
      case "session.status": {
        const type = p.status?.type;
        if (type === "busy" && !wasBusy)
          this.sink({ t: "turn.start", ts });
        else if (type === "retry")
          this.sink({ t: "retry", ts, attempt: Number(p.status.attempt ?? 1), message: p.status.message });
        else if (type === "idle")
          this.sink({ t: "idle", ts });
        return;
      }
      case "session.idle":
        this.sink({ t: "idle", ts });
        return;
      case "session.error":
        this.sink({ t: "error", ts, message: errorMessage(p.error) });
        return;
      case "message.updated": {
        const info = p.info;
        if (!info?.id)
          return;
        this.roles.set(info.id, info.role);
        if (info.role !== "assistant")
          return;
        if (info.time?.completed)
          this.live.delete(info.id);
        else
          this.live.add(info.id);
        if (info.providerID && info.modelID) {
          const key = `${info.providerID}/${info.modelID}`;
          if (key !== this.lastModelKey) {
            this.lastModelKey = key;
            this.sink({
              t: "model",
              ts,
              model: { providerID: info.providerID, modelID: info.modelID, contextLimit: this.deps.contextLimit(info.providerID, info.modelID) }
            });
          }
        }
        return;
      }
      case "message.part.updated": {
        const part = p.part;
        if (!part?.type)
          return;
        switch (part.type) {
          case "step-start":
            this.sink({ t: "step.start", ts });
            return;
          case "step-finish":
            this.sink({ t: "step.end", ts, usage: usageFromTokens(part.tokens), finish: part.reason });
            return;
          case "text":
          case "reasoning": {
            this.partKind.set(part.id, part.type);
            if (part.synthetic || part.ignored)
              return;
            if (!this.live.has(part.messageID) || this.roles.get(part.messageID) !== "assistant")
              return;
            if (sid && this.nextPath.has(sid))
              return;
            const len = typeof part.text === "string" ? part.text.length : 0;
            const before = this.seen.get(part.id) ?? 0;
            if (len > before) {
              this.seen.set(part.id, len);
              this.sink({ t: "delta", ts, kind: part.type, chars: len - before });
            }
            return;
          }
          case "tool": {
            const callID = part.callID ?? part.id;
            const status = part.state?.status;
            if ((status === "pending" || status === "running") && !this.toolStarted.has(callID) && this.live.has(part.messageID)) {
              this.toolStarted.add(callID);
              this.sink({ t: "tool.start", ts, callID, tool: String(part.tool ?? "tool") });
            } else if ((status === "completed" || status === "error") && this.toolStarted.has(callID) && !this.toolEnded.has(callID)) {
              this.toolEnded.add(callID);
              this.sink({ t: "tool.end", ts, callID, ok: status === "completed" });
            }
            return;
          }
          default:
            return;
        }
      }
      case "message.part.delta": {
        if (p.field !== "text" || typeof p.delta !== "string" || !p.delta.length)
          return;
        if (this.roles.get(p.messageID) === "user")
          return;
        if (sid && this.nextPath.has(sid))
          return;
        const kind = this.partKind.get(p.partID) === "reasoning" ? "reasoning" : "text";
        this.seen.set(p.partID, (this.seen.get(p.partID) ?? 0) + p.delta.length);
        this.sink({ t: "delta", ts, kind, chars: p.delta.length });
        return;
      }
      default: {
        const kind = NEXT_DELTA[ev.type];
        if (!kind || typeof p.delta !== "string" || !p.delta.length)
          return;
        if (sid)
          this.nextPath.add(sid);
        this.sink({ t: "delta", ts, kind, chars: p.delta.length });
      }
    }
  }
  focus(sid) {
    const target = this.deps.activeSessionID() ?? this.followed;
    if (target && target !== this.current) {
      this.current = target;
      this.lastModelKey = undefined;
      this.sink({ t: "reset", ts: this.deps.now(), sessionKey: target });
    }
    if (!sid)
      return false;
    return sid === this.current;
  }
  trackBusy(sid, busy) {
    this.busy.set(sid, busy);
    if (busy && !this.deps.activeSessionID())
      this.followed = sid;
    let others = 0;
    for (const [id, b] of this.busy)
      if (b && id !== (this.deps.activeSessionID() ?? this.followed))
        others++;
    if (others !== this.lastSubagents) {
      this.lastSubagents = others;
      this.sink({ t: "subagents", ts: this.deps.now(), busy: others });
    }
  }
}
function errorMessage(e) {
  if (!e || typeof e !== "object")
    return;
  const o = e;
  return String(o.data?.message ?? o.message ?? o.name ?? "error");
}

// src/core/frame.ts
var DEFAULT = -1;

class Frame {
  w;
  h;
  ch;
  fg;
  bg;
  bold;
  constructor(w, h) {
    this.w = Math.max(0, Math.floor(w));
    this.h = Math.max(0, Math.floor(h));
    const n = this.w * this.h;
    this.ch = new Array(n).fill(" ");
    this.fg = new Int32Array(n).fill(DEFAULT);
    this.bg = new Int32Array(n).fill(DEFAULT);
    this.bold = new Uint8Array(n);
  }
  set(x, y, ch, fg, bg = DEFAULT, bold = false) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h)
      return;
    const i = y * this.w + x;
    this.ch[i] = ch;
    this.fg[i] = fg;
    this.bg[i] = bg;
    this.bold[i] = bold ? 1 : 0;
  }
  get(x, y) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h)
      return;
    const i = y * this.w + x;
    return { ch: this.ch[i], fg: this.fg[i], bg: this.bg[i], bold: this.bold[i] === 1 };
  }
  text(x, y, s, fg, bg = DEFAULT, bold = false) {
    for (const c of s) {
      this.set(x, y, c, fg, bg, bold);
      x++;
    }
    return x;
  }
  cellEquals(other, i) {
    return this.ch[i] === other.ch[i] && this.fg[i] === other.fg[i] && this.bg[i] === other.bg[i] && this.bold[i] === other.bold[i];
  }
  toText() {
    const lines = [];
    for (let y = 0;y < this.h; y++) {
      let s = "";
      for (let x = 0;x < this.w; x++)
        s += this.ch[y * this.w + x] || " ";
      lines.push(s);
    }
    return lines.join(`
`);
  }
  toAnsi(truecolor = true) {
    let out = "\x1B[?25l\x1B[2J\x1B[H";
    let pfg = -2, pbg = -2, pbold = -1;
    for (let y = 0;y < this.h; y++) {
      out += `\x1B[${y + 1};1H`;
      for (let x = 0;x < this.w; x++) {
        const i = y * this.w + x;
        if (this.fg[i] !== pfg) {
          out += sgrFg(this.fg[i], truecolor);
          pfg = this.fg[i];
        }
        if (this.bg[i] !== pbg) {
          out += sgrBg(this.bg[i], truecolor);
          pbg = this.bg[i];
        }
        if (this.bold[i] !== pbold) {
          out += this.bold[i] ? "\x1B[1m" : "\x1B[22m";
          pbold = this.bold[i];
        }
        out += this.ch[i] || " ";
      }
    }
    return out + "\x1B[0m\x1B[?25h";
  }
}
function rgbOf(c) {
  return [c >> 16 & 255, c >> 8 & 255, c & 255];
}
function to256(c) {
  const [r, g, b] = rgbOf(c);
  const q = (v) => v < 48 ? 0 : v < 115 ? 1 : Math.min(5, Math.floor((v - 35) / 40));
  return 16 + 36 * q(r) + 6 * q(g) + q(b);
}
function sgrFg(c, truecolor = true) {
  if (c === DEFAULT)
    return "\x1B[39m";
  if (!truecolor)
    return `\x1B[38;5;${to256(c)}m`;
  const [r, g, b] = rgbOf(c);
  return `\x1B[38;2;${r};${g};${b}m`;
}
function sgrBg(c, truecolor = true) {
  if (c === DEFAULT)
    return "\x1B[49m";
  if (!truecolor)
    return `\x1B[48;5;${to256(c)}m`;
  const [r, g, b] = rgbOf(c);
  return `\x1B[48;2;${r};${g};${b}m`;
}
function drawRoundedBox(f, r, fg) {
  const { x, y, w, h } = r;
  if (w < 2 || h < 2)
    return;
  for (let i = 1;i < w - 1; i++) {
    f.set(x + i, y, "\u2500", fg);
    f.set(x + i, y + h - 1, "\u2500", fg);
  }
  for (let j = 1;j < h - 1; j++) {
    f.set(x, y + j, "\u2502", fg);
    f.set(x + w - 1, y + j, "\u2502", fg);
  }
  f.set(x, y, "\u256D", fg);
  f.set(x + w - 1, y, "\u256E", fg);
  f.set(x, y + h - 1, "\u2570", fg);
  f.set(x + w - 1, y + h - 1, "\u256F", fg);
}
function embedSegment(f, y, x, text, left, right, border, fg, bold = false) {
  f.set(x, y, left, border);
  x++;
  for (const c of text) {
    f.set(x, y, c, fg, DEFAULT, bold);
    x++;
  }
  f.set(x, y, right, border);
  return x + 1;
}
function truncate(s, n) {
  if (n <= 0)
    return "";
  const r = [...s];
  return r.length <= n ? s : r.slice(0, n).join("");
}
function cpLen(s) {
  return [...s].length;
}

// src/backends/opentui.ts
var BOLD = 1;
function rgbaToInt(c, fallback) {
  if (!c || typeof c.toInts !== "function")
    return fallback;
  const [r, g, b] = c.toInts();
  return (r & 255) << 16 | (g & 255) << 8 | b & 255;
}

class FrameCopier {
  RGBA;
  cache = new Map;
  transparent;
  constructor(RGBA) {
    this.RGBA = RGBA;
    this.transparent = RGBA.fromInts(0, 0, 0, 0);
  }
  rgba(c) {
    let v = this.cache.get(c);
    if (!v) {
      v = this.RGBA.fromInts(c >> 16 & 255, c >> 8 & 255, c & 255, 255);
      this.cache.set(c, v);
    }
    return v;
  }
  copy(buf, f, ox, oy, defaultFg) {
    for (let y = 0;y < f.h; y++) {
      for (let x = 0;x < f.w; x++) {
        const i = y * f.w + x;
        const ch = f.ch[i] || " ";
        const fg = f.fg[i] === DEFAULT ? defaultFg : f.fg[i];
        const bg = f.bg[i] === DEFAULT ? this.transparent : this.rgba(f.bg[i]);
        buf.setCellWithAlphaBlending(ox + x, oy + y, ch, this.rgba(fg), bg, f.bold[i] ? BOLD : 0);
      }
    }
  }
}

// src/core/render/illustrate.ts
function hash32(...xs) {
  let h = 2654435769 | 0;
  for (const x of xs) {
    let k = Math.imul(x | 0, 3432918353);
    k = k << 15 | k >>> 17;
    k = Math.imul(k, 461845907);
    h ^= k;
    h = h << 13 | h >>> 19;
    h = Math.imul(h, 5) + 3864292196 | 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 2246822507);
  h ^= h >>> 13;
  h = Math.imul(h, 3266489909);
  h ^= h >>> 16;
  return h >>> 0;
}
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0;i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = a + 1831565813 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function pickK(n, k, rng) {
  k = Math.max(0, Math.min(k, n));
  const out = [];
  const seen = new Set;
  while (out.length < k) {
    const v = Math.floor(rng() * n);
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}
function pickRecent(nFilled, m, rng) {
  m = Math.max(0, Math.min(m, nFilled));
  const out = [];
  const seen = new Set;
  let guard = 0;
  while (out.length < m && guard++ < m * 20) {
    const idx = nFilled - 1 - Math.floor(nFilled * Math.pow(rng(), 1.4));
    if (idx >= 0 && !seen.has(idx)) {
      seen.add(idx);
      out.push(idx);
    }
  }
  return out;
}

// src/core/demo.ts
var DEMO_NAMES = ["moe-chat", "agentic", "closed", "dense", "error"];

class Script {
  t;
  out = [];
  rng;
  constructor(t0, seed) {
    this.t = t0;
    this.rng = mulberry32(seed);
  }
  at(dt, sig) {
    this.t += dt;
    this.out.push({ ...sig, ts: Math.round(this.t) });
    return this;
  }
  wait(ms) {
    this.t += ms;
    return this;
  }
  stream(kind, tokens, tps) {
    const totalChars = tokens * 4;
    let sent = 0;
    while (sent < totalChars) {
      const dt = 20 + this.rng() * 100;
      const want = tps * 4 * dt / 1000 * (0.5 + this.rng());
      const chars = Math.max(1, Math.min(totalChars - sent, Math.round(want)));
      sent += chars;
      this.at(dt, { t: "delta", kind, chars });
    }
    return this;
  }
}
var usage = (u) => ({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, ...u });
var model = (providerID, modelID, contextLimit) => ({ providerID, modelID, contextLimit });
function moeChat(s) {
  s.at(0, { t: "model", model: model("openrouter", "qwen/qwen3-235b-a22b", 131072) }).at(10, { t: "step.end", finish: "stop", usage: usage({ input: 1200, cacheRead: 20500, output: 0 }) }).at(10, { t: "idle" }).at(300, { t: "turn.start" }).at(20, { t: "step.start" }).wait(1400).stream("reasoning", 900, 70).stream("text", 300, 70).at(80, { t: "step.end", finish: "stop", usage: usage({ input: 1800, cacheRead: 22000, output: 300, reasoning: 900 }) }).at(150, { t: "idle" });
}
function agentic(s) {
  s.at(0, { t: "model", model: model("openrouter", "openai/gpt-oss-120b", 131072) }).at(300, { t: "turn.start" }).at(20, { t: "step.start" }).wait(900).stream("reasoning", 150, 80).stream("text", 40, 80).at(60, { t: "tool.start", callID: "c1", tool: "bash" }).at(40, { t: "step.end", finish: "tool-calls", usage: usage({ input: 9000, output: 40, reasoning: 150 }) }).at(2300, { t: "tool.end", callID: "c1", ok: true }).at(30, { t: "step.start" }).wait(600).stream("reasoning", 80, 80).at(50, { t: "tool.start", callID: "c2", tool: "read" }).at(10, { t: "tool.start", callID: "c3", tool: "grep" }).at(30, { t: "step.end", finish: "tool-calls", usage: usage({ input: 1400, cacheRead: 9000, output: 0, reasoning: 80 }) }).at(800, { t: "tool.end", callID: "c2", ok: true }).at(600, { t: "tool.end", callID: "c3", ok: false }).at(30, { t: "step.start" }).wait(500).stream("text", 400, 60).at(60, { t: "step.end", finish: "stop", usage: usage({ input: 900, cacheRead: 10400, output: 400 }) }).at(150, { t: "idle" });
}
function closed(s) {
  s.at(0, { t: "model", model: model("anthropic", "claude-sonnet-4-5", 200000) }).at(10, { t: "step.end", finish: "stop", usage: usage({ input: 2000, cacheRead: 148000, output: 0 }) }).at(10, { t: "idle" }).at(300, { t: "turn.start" }).at(20, { t: "step.start" }).wait(2200).stream("text", 700, 90).at(60, { t: "step.end", finish: "stop", usage: usage({ input: 3000, cacheRead: 150000, cacheWrite: 2000, output: 700 }) }).at(150, { t: "idle" });
}
function dense(s) {
  s.at(0, { t: "model", model: model("together", "meta-llama/llama-3.1-70b-instruct", 131072) }).at(300, { t: "turn.start" }).at(20, { t: "step.start" }).wait(1100).stream("text", 250, 25).at(60, { t: "step.end", finish: "stop", usage: usage({ input: 4000, output: 250 }) }).at(150, { t: "idle" });
}
function error(s) {
  s.at(0, { t: "model", model: model("deepseek", "deepseek-chat", 65536) }).at(300, { t: "turn.start" }).at(20, { t: "step.start" }).wait(1500).at(0, { t: "retry", attempt: 1, message: "overloaded" }).at(2000, { t: "step.start" }).wait(1000).at(0, { t: "retry", attempt: 2, message: "overloaded" }).at(2000, { t: "error", message: "provider overloaded" });
}
var SCRIPTS = { "moe-chat": moeChat, agentic, closed, dense, error };
function demoSignals(name, t0 = 0) {
  const s = new Script(t0, 12648430);
  if (name === "all") {
    for (const n of DEMO_NAMES) {
      SCRIPTS[n](s);
      s.wait(3000);
    }
  } else {
    SCRIPTS[name](s);
  }
  return s.out;
}
function demoDuration(name) {
  const sigs = demoSignals(name, 0);
  return (sigs.length ? sigs[sigs.length - 1].ts : 0) + 3500;
}

// src/core/palette.ts
var DEFAULT_PALETTE = {
  border: 4936291,
  label: 9147297,
  text: 14146272,
  gridBlue: 3893914,
  gridBlueLt: 8366031,
  gridEmpty: 3817291,
  attendDot: 15895592,
  route: 6001607,
  hex: [15233130, 13123663, 11129230, 5219246],
  hidden: 4885703,
  meshPink: 14711456,
  meshBlue: 9287896,
  output: 12045795,
  reasoning: 10980346,
  textOut: 16102485,
  tool: 5219246,
  warn: 16102485,
  error: 15026253,
  bg: 1447965
};
var LEVELS = 32;
function shade(color, bg, i) {
  if (!(i > 0))
    return bg === DEFAULT ? DEFAULT : bg;
  if (i >= 1)
    return color;
  const t = Math.round(Math.pow(i, 0.8) * LEVELS) / LEVELS;
  const b = bg === DEFAULT ? DEFAULT_PALETTE.bg : bg;
  const r = (color >> 16 & 255) * t + (b >> 16 & 255) * (1 - t);
  const g = (color >> 8 & 255) * t + (b >> 8 & 255) * (1 - t);
  const bl = (color & 255) * t + (b & 255) * (1 - t);
  return Math.round(r) << 16 | Math.round(g) << 8 | Math.round(bl);
}

// src/core/registry.ts
var moe = (family, layers, experts, active, shared, note) => ({ kind: "moe", family, layers, experts, active, shared, ...note ? { note } : {} });
var dense2 = (family, layers, note) => ({ kind: "dense", family, layers, ...note ? { note } : {} });
var unknown = (family, note) => ({ kind: "unknown", family, ...note ? { note } : {} });
var RULES = [
  { re: /deepseek.*(v3|r1|chat|reasoner)/, arch: moe("deepseek-v3", 61, 256, 8, 1, "first 3 layers dense") },
  { re: /kimi-k2/, arch: moe("kimi-k2", 61, 384, 8, 1) },
  { re: /qwen3-coder.*480b/, arch: moe("qwen3-coder-480b", 62, 160, 8, 0) },
  { re: /qwen3.*235b/, arch: moe("qwen3-235b", 94, 128, 8, 0) },
  { re: /qwen3.*30b-a3b/, arch: moe("qwen3-30b-a3b", 48, 128, 8, 0) },
  { re: /gpt-oss-120b/, arch: moe("gpt-oss-120b", 36, 128, 4, 0) },
  { re: /gpt-oss-20b/, arch: moe("gpt-oss-20b", 24, 32, 4, 0) },
  { re: /mixtral.*8x22b/, arch: moe("mixtral-8x22b", 56, 8, 2, 0) },
  { re: /mixtral.*8x7b/, arch: moe("mixtral-8x7b", 32, 8, 2, 0) },
  { re: /llama-4-maverick/, arch: moe("llama-4-maverick", 48, 128, 1, 1, "alternating dense/MoE layers") },
  { re: /llama-4-scout/, arch: moe("llama-4-scout", 48, 16, 1, 1) },
  { re: /glm-4\.5(?!-air)/, arch: moe("glm-4.5", 92, 160, 8, 1, "verify") },
  { re: /llama-?3.*405b/, arch: dense2("llama-3-405b", 126) },
  { re: /llama-?3.*70b/, arch: dense2("llama-3-70b", 80) },
  { re: /llama-?3.*8b/, arch: dense2("llama-3-8b", 32) },
  { re: /qwen2\.5-coder.*32b/, arch: dense2("qwen2.5-coder-32b", 64) },
  { re: /claude|gpt-[45]|^o[134]|gemini|grok/, arch: unknown("closed", "closed weights") }
];
var UNKNOWN = unknown("unknown");
function normalizeModelID(id) {
  const s = id.toLowerCase();
  const i = s.lastIndexOf("/");
  return i >= 0 ? s.slice(i + 1) : s;
}
function archFor(model, overrides) {
  if (!model)
    return UNKNOWN;
  const id = normalizeModelID(model.modelID);
  if (overrides) {
    for (const [pat, arch] of Object.entries(overrides)) {
      try {
        if (new RegExp(pat, "i").test(id))
          return arch;
      } catch {}
    }
  }
  for (const r of RULES)
    if (r.re.test(id))
      return r.arch;
  return UNKNOWN;
}
function archSummary(a) {
  switch (a.kind) {
    case "moe":
      return `MoE ${a.experts}e/${a.active}a \xB7 ${a.layers}L`;
    case "dense":
      return `dense \xB7 ${a.layers}L`;
    default:
      return "arch unknown";
  }
}

// src/core/sim/rate.ts
var RATE_CAP = 256;
var RATE_WINDOW_TICKS = 60;
var MIN_SPAN_TICKS = 15;
function createRate() {
  return { ticks: new Array(RATE_CAP).fill(0), toks: new Array(RATE_CAP).fill(0), head: 0, size: 0 };
}
function ratePush(r, tick, tokens) {
  r.ticks[r.head] = tick;
  r.toks[r.head] = tokens;
  r.head = (r.head + 1) % RATE_CAP;
  if (r.size < RATE_CAP)
    r.size++;
}
function rateTps(r, tick, hz) {
  let sum = 0;
  let oldest = Infinity;
  for (let k = 0;k < r.size; k++) {
    const i = (r.head - 1 - k + RATE_CAP) % RATE_CAP;
    const t = r.ticks[i];
    if (tick - t >= RATE_WINDOW_TICKS)
      break;
    sum += r.toks[i];
    if (t < oldest)
      oldest = t;
  }
  if (oldest === Infinity)
    return -1;
  const span = Math.max(MIN_SPAN_TICKS, tick - oldest + 1);
  return sum * hz / span;
}

// src/core/sim/sim.ts
var TICK_HZ = 30;
var TICK_MS = 1000 / TICK_HZ;
var DEFAULT_CONTEXT = 200000;
var IDLE_TIMEOUT_TICKS = 90;
var ERROR_TICKS = 36;
var PULSE_MIN_GAP = 3;
var MAX_PULSES = 6;
var FLASH_TTL = 45;
var CALIB_MIN_EST = 20;
function createSim(sessionKey = "default", archOverrides) {
  return {
    tick: 0,
    sessionKey,
    phase: "idle",
    phaseTick: 0,
    stream: "text",
    arch: UNKNOWN,
    archOverrides,
    contextLimit: DEFAULT_CONTEXT,
    contextApprox: true,
    stepOpen: false,
    stepStartTick: 0,
    stepRawEst: 0,
    stepTokens: 0,
    stepGenStart: 0,
    tools: new Map,
    toolsCalled: 0,
    promptGenBase: 0,
    generated: [],
    genTotal: 0,
    turnReasoning: 0,
    turnText: 0,
    bank: 0,
    draining: false,
    tps: 0,
    tpsApprox: false,
    lastDeltaTick: -1e6,
    calib: new Map,
    pulses: [],
    flashes: [],
    nextPulseIndex: 0,
    lastEmitTick: -1e6,
    lastSignalTick: 0,
    subagentsBusy: 0,
    rate: createRate()
  };
}
function promptTokens(u) {
  return u.input + u.cacheRead + u.cacheWrite;
}
function setPhase(s, p) {
  if (s.phase === p)
    return;
  s.phase = p;
  s.phaseTick = s.tick;
}
function calibKey(s) {
  return s.model?.modelID ?? "?";
}
function addGenerated(s, stream, tokens) {
  if (tokens <= 0)
    return;
  const last = s.generated[s.generated.length - 1];
  if (last && last.stream === stream)
    last.tokens += tokens;
  else
    s.generated.push({ stream, tokens });
  s.genTotal += tokens;
  if (stream === "reasoning")
    s.turnReasoning += tokens;
  else
    s.turnText += tokens;
}
function spawnPulse(s, tokens) {
  const sweep = Math.max(9, Math.min(20, Math.round(270 / Math.max(s.tps, 1))));
  s.pulses.push({ index: s.nextPulseIndex++, bornTick: s.tick, tokens, stream: s.stream, sweepTicks: sweep });
  s.bank -= tokens;
  if (s.bank < 0.000000001)
    s.bank = 0;
  s.lastEmitTick = s.tick;
  addGenerated(s, s.stream, tokens);
}
function flushBank(s) {
  if (s.bank >= 0.5)
    spawnPulse(s, s.bank);
  else
    s.bank = 0;
}
function startTurn(s) {
  if (s.promptTokens !== undefined)
    s.promptTokens += Math.max(0, s.genTotal - s.promptGenBase);
  s.generated = [];
  s.genTotal = 0;
  s.promptGenBase = 0;
  s.turnReasoning = 0;
  s.turnText = 0;
  s.pulses = [];
  s.bank = 0;
  s.draining = false;
  s.tools.clear();
  s.toolsCalled = 0;
  s.turnTick = s.tick;
  s.ttftTicks = undefined;
  s.tpsApprox = false;
}
function beginPrefill(s) {
  s.prefillTick = s.tick;
  s.ttftTicks = undefined;
  setPhase(s, "prefill");
}
function applySignal(s, sig) {
  s.lastSignalTick = s.tick;
  switch (sig.t) {
    case "model": {
      s.model = sig.model;
      s.arch = archFor(sig.model, s.archOverrides);
      if (sig.model.contextLimit && sig.model.contextLimit > 0) {
        s.contextLimit = sig.model.contextLimit;
        s.contextApprox = false;
      }
      return;
    }
    case "turn.start": {
      startTurn(s);
      beginPrefill(s);
      return;
    }
    case "step.start": {
      if (s.stepOpen)
        return;
      if (s.phase === "idle" || s.phase === "error")
        startTurn(s);
      s.stepOpen = true;
      s.stepStartTick = s.tick;
      s.stepRawEst = 0;
      s.stepTokens = 0;
      s.stepGenStart = s.genTotal;
      if (s.phase !== "prefill")
        beginPrefill(s);
      s.retryAttempt = undefined;
      return;
    }
    case "delta": {
      const raw = sig.tokens ?? sig.chars / 4;
      if (!(raw > 0))
        return;
      const k = s.calib.get(calibKey(s)) ?? 1;
      const est = raw * k;
      s.stepRawEst += raw;
      s.stepTokens += est;
      s.bank += est;
      s.stream = sig.kind;
      s.lastDeltaTick = s.tick;
      s.tpsApprox = false;
      ratePush(s.rate, s.tick, est);
      const r = rateTps(s.rate, s.tick, TICK_HZ);
      if (r >= 0)
        s.tps = r;
      if (s.phase === "tool")
        return;
      if (s.phase === "prefill" && s.prefillTick !== undefined)
        s.ttftTicks = s.tick - s.prefillTick;
      if (s.phase === "idle" || s.phase === "error")
        startTurn(s);
      s.retryAttempt = undefined;
      setPhase(s, "decode");
      return;
    }
    case "tool.start": {
      if (s.tools.has(sig.callID))
        return;
      s.tools.set(sig.callID, { tool: sig.tool, startTick: s.tick });
      s.toolsCalled++;
      if (s.phase === "decode")
        flushBank(s);
      setPhase(s, "tool");
      return;
    }
    case "tool.end": {
      if (!s.tools.delete(sig.callID))
        return;
      if (!sig.ok)
        s.flashes.push({ kind: "toolFail", bornTick: s.tick });
      if (s.tools.size === 0 && s.phase === "tool")
        beginPrefill(s);
      return;
    }
    case "step.end": {
      if (sig.usage) {
        const u = sig.usage;
        s.usage = u;
        s.promptTokens = promptTokens(u);
        s.promptGenBase = s.stepGenStart;
        const observed = u.output + u.reasoning;
        if (s.stepRawEst > CALIB_MIN_EST && observed > 0) {
          const key = calibKey(s);
          const k = s.calib.get(key) ?? 1;
          const next = k + (observed / s.stepRawEst - k) * 0.3;
          s.calib.set(key, Math.max(0.5, Math.min(2, next)));
        }
        if (s.stepTokens === 0 && observed > 0) {
          const secs = Math.max(1, s.tick - s.stepStartTick) / TICK_HZ;
          s.tps = observed / secs;
          s.tpsApprox = true;
          s.bank += observed;
          s.stream = u.output >= u.reasoning ? "text" : "reasoning";
          s.draining = true;
          if (s.phase === "prefill" && s.prefillTick !== undefined)
            s.ttftTicks = undefined;
          setPhase(s, "decode");
        }
      }
      if (!s.draining && s.phase === "decode")
        flushBank(s);
      s.stepOpen = false;
      s.lastFinish = sig.finish;
      return;
    }
    case "retry": {
      s.retryAttempt = sig.attempt;
      setPhase(s, "retry");
      return;
    }
    case "error": {
      s.flashes.push({ kind: "error", bornTick: s.tick });
      s.tools.clear();
      s.stepOpen = false;
      s.bank = 0;
      s.draining = false;
      setPhase(s, "error");
      return;
    }
    case "idle": {
      if (!s.draining)
        flushBank(s);
      s.tools.clear();
      s.stepOpen = false;
      if (s.phase !== "error")
        setPhase(s, "idle");
      return;
    }
    case "subagents": {
      s.subagentsBusy = Math.max(0, sig.busy);
      return;
    }
    case "reset": {
      const keep = { calib: s.calib, overrides: s.archOverrides, tick: s.tick };
      Object.assign(s, createSim(sig.sessionKey, keep.overrides));
      s.calib = keep.calib;
      s.tick = keep.tick;
      s.phaseTick = keep.tick;
      s.lastSignalTick = keep.tick;
      return;
    }
  }
}
function step(s) {
  s.tick++;
  const t = s.tick;
  const emitting = s.phase === "decode" || s.draining;
  if (emitting && s.bank >= 1 && t - s.lastEmitTick >= PULSE_MIN_GAP && s.pulses.length < MAX_PULSES) {
    const per = Math.max(1, Math.ceil(s.tps / 10));
    const take = Math.min(s.bank, s.bank > per * 4 ? Math.ceil(s.bank / 4) : per);
    spawnPulse(s, take);
  }
  if (s.draining && s.bank < 1) {
    if (s.bank > 0)
      spawnPulse(s, s.bank);
    s.draining = false;
  }
  if (s.pulses.length)
    s.pulses = s.pulses.filter((p) => t - p.bornTick <= p.sweepTicks * 1.5);
  if (s.flashes.length)
    s.flashes = s.flashes.filter((f) => t - f.bornTick <= FLASH_TTL);
  if (!s.tpsApprox && t - s.lastDeltaTick > 30 && s.tps > 0) {
    s.tps *= 0.9;
    if (s.tps < 1)
      s.tps = 0;
  }
  if (s.phase === "error" && t - s.phaseTick >= ERROR_TICKS)
    setPhase(s, "idle");
  if (s.phase !== "idle" && s.phase !== "error" && s.phase !== "retry" && !s.stepOpen && s.tools.size === 0 && !s.draining && s.bank < 1 && t - s.lastSignalTick >= IDLE_TIMEOUT_TICKS) {
    setPhase(s, "idle");
  }
}
function inflightTokens(s) {
  let n = 0;
  for (const p of s.pulses)
    if (s.tick - p.bornTick < p.sweepTicks)
      n += p.tokens;
  return n;
}
function contextView(s) {
  const known = s.promptTokens !== undefined && s.usage !== undefined;
  const cached = known ? s.usage.cacheRead : 0;
  const fresh = known ? Math.max(0, s.promptTokens - s.usage.cacheRead) : 0;
  let skip = s.promptGenBase;
  let remaining = Math.max(0, s.genTotal - s.promptGenBase - inflightTokens(s));
  const gen = [];
  for (const r of s.generated) {
    let n = r.tokens;
    if (skip > 0) {
      const d = Math.min(skip, n);
      skip -= d;
      n -= d;
    }
    if (n <= 0 || remaining <= 0)
      continue;
    const take = Math.min(n, remaining);
    remaining -= take;
    gen.push({ stream: r.stream, tokens: take });
  }
  const genSum = gen.reduce((a, r) => a + r.tokens, 0);
  return {
    limit: s.contextLimit,
    approx: s.contextApprox,
    cached,
    fresh,
    generated: gen,
    used: cached + fresh + genSum,
    known
  };
}

// src/core/render/braille.ts
var BITS = [
  [1, 8],
  [2, 16],
  [4, 32],
  [64, 128]
];
var DOT_THRESHOLD = 0.04;
var DOMINANCE = 0.5;

class BrailleCanvas {
  cw;
  ch;
  mask;
  inten;
  color;
  constructor(cw, ch) {
    this.cw = Math.max(0, cw);
    this.ch = Math.max(0, ch);
    const n = this.cw * this.ch;
    this.mask = new Uint8Array(n);
    this.inten = new Float32Array(n);
    this.color = new Int32Array(n);
  }
  get pw() {
    return this.cw * 2;
  }
  get ph() {
    return this.ch * 4;
  }
  plot(sx, sy, color, i) {
    if (sx < 0 || sy < 0 || sx >= this.cw * 2 || sy >= this.ch * 4 || i < DOT_THRESHOLD)
      return;
    const c = (sy >> 2) * this.cw + (sx >> 1);
    const bit = BITS[sy & 3][sx & 1];
    const cur = this.inten[c];
    if (i * DOMINANCE > cur) {
      this.mask[c] = bit;
      this.inten[c] = i;
      this.color[c] = color;
    } else if (i >= cur * DOMINANCE) {
      this.mask[c] |= bit;
      if (i > cur) {
        this.inten[c] = i;
        this.color[c] = color;
      }
    }
  }
  line(x0, y0, x1, y1, color, i, opts = {}) {
    x0 = Math.round(x0);
    y0 = Math.round(y0);
    x1 = Math.round(x1);
    y1 = Math.round(y1);
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    const upTo = opts.upTo === undefined ? 1 : Math.max(0, Math.min(1, opts.upTo));
    const last = Math.floor(n * upTo);
    const st = Math.max(1, opts.stipple ?? 1);
    if (n === 0) {
      if (upTo > 0)
        this.plot(x0, y0, color, i);
      return;
    }
    for (let k = 0;k <= last; k += st) {
      this.plot(Math.round(x0 + (x1 - x0) * k / n), Math.round(y0 + (y1 - y0) * k / n), color, i);
    }
  }
  blitTo(f, ox, oy, bg) {
    for (let y = 0;y < this.ch; y++) {
      for (let x = 0;x < this.cw; x++) {
        const c = y * this.cw + x;
        if (this.mask[c] === 0)
          continue;
        f.set(ox + x, oy + y, String.fromCharCode(10240 + this.mask[c]), shade(this.color[c], bg, this.inten[c]), bg);
      }
    }
  }
}

// src/core/render/layout.ts
var FULL_MIN = { w: 90, h: 18 };
var COMPACT_MIN = { w: 34, h: 10 };
var STRIP_MIN_W = 12;
var clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
function layout(w, h, _arch) {
  w = Math.floor(w);
  h = Math.floor(h);
  if (w >= FULL_MIN.w && h >= FULL_MIN.h)
    return full(w, h);
  if (w >= COMPACT_MIN.w && h >= COMPACT_MIN.h)
    return compact(w, h);
  if (w >= STRIP_MIN_W && h >= 1)
    return { mode: "strip", line: { x: 0, y: 0, w, h: 1 } };
  return { mode: "tiny" };
}
function full(w, h) {
  const ix = 1, iy = 1, iw = w - 2, ih = h - 2;
  const gw = clamp(Math.round(iw * 0.14), 8, 22);
  const gh = clamp(Math.round(ih * 0.62), 6, ih);
  const grid = { x: ix + 1, y: iy + Math.floor((ih - gh) / 2), w: gw, h: gh };
  const fanAx = grid.x + grid.w + 1;
  const fanA = { x: fanAx, y: iy, w: Math.round(iw * 0.47) - fanAx, h: ih };
  const experts = { x: fanA.x + fanA.w + 1, y: iy, w: 1, h: ih };
  const hidden = { x: experts.x + 2, y: iy, w: 1, h: ih };
  const outX = ix + iw - 2;
  const outN = Math.min(clamp(Math.round(ih * 0.4), 4, 12), Math.floor((ih + 1) / 2));
  const fanB = { x: hidden.x + 2, y: iy, w: outX - 1 - (hidden.x + 2), h: ih };
  const out = { x: outX, y: iy + Math.floor((ih - (2 * outN - 1)) / 2), w: 1, h: 2 * outN - 1 };
  return { mode: "full", box: { x: 0, y: 0, w, h }, grid, fanA, experts, hidden, fanB, out, outN, cometY: h - 2 };
}
function compact(w, h) {
  const ix = 1, iy = 1, iw = w - 2, ih = h - 2;
  const gw = clamp(Math.round(iw * 0.25), 6, 16);
  const gh = clamp(Math.round(ih * 0.7), 3, ih);
  const grid = { x: ix + 1, y: iy + Math.floor((ih - gh) / 2), w: gw, h: gh };
  const fanAx = grid.x + grid.w + 1;
  const fanA = { x: fanAx, y: iy, w: w - 6 - fanAx, h: ih };
  const experts = { x: w - 5, y: iy, w: 1, h: ih };
  const outN = Math.min(clamp(Math.round(ih * 0.5), 3, 8), Math.floor((ih + 1) / 2));
  const out = { x: w - 3, y: iy + Math.floor((ih - (2 * outN - 1)) / 2), w: 1, h: 2 * outN - 1 };
  return { mode: "compact", box: { x: 0, y: 0, w, h }, grid, fanA, experts, out, outN, cometY: h - 2 };
}
function outY(L, i) {
  return L.out.y + 2 * i;
}
function gridCell(grid, i) {
  const h = Math.max(1, grid.h);
  const col = Math.floor(i / h), row = i % h;
  return { col, row, x: grid.x + col, y: grid.y + row };
}

// src/core/render/strip.ts
function renderStrip(f, s, pal, opts) {
  const bg = opts.bg;
  const G = glyphsFor(opts.asciiSafe);
  const t = s.tick;
  const parts = [];
  const gm = gridModel(contextView(s), 9);
  const bar = [{ text: "\u25D6", color: pal.border, i: 1 }];
  for (let i = 0;i < 9; i++) {
    const k = gm.kind[i];
    let glyph = k === CELL_CACHED ? "\u2593" : k === CELL_FRESH ? "\u2592" : k === CELL_REASONING || k === CELL_TEXT ? "\u2588" : "\xB7";
    if (k && gm.frac[i] > 0 && gm.frac[i] < 1)
      glyph = " \u2591\u2592\u2593\u2588"[Math.max(1, Math.ceil(gm.frac[i] * 4))];
    const color = k === CELL_CACHED ? pal.gridBlue : k === CELL_FRESH ? pal.gridBlueLt : k === CELL_REASONING ? pal.reasoning : k === CELL_TEXT ? pal.textOut : pal.gridEmpty;
    bar.push({ text: glyph, color, i: k ? 0.8 : 0.9 });
  }
  parts.push(bar);
  const slots = expertSlots(s.arch, { x: 0, y: 0, w: 1, h: 8 });
  const lit = new Float32Array(slots.ys.length);
  const seed = hashStr(s.sessionKey);
  let sample = 0;
  let sampleColor = pal.output;
  for (const p of s.pulses) {
    const u = pulseU(s, p);
    if (u >= 1)
      continue;
    const eI = stageI(u, 0.3, 0.42, p.sweepTicks);
    if (eI > 0)
      for (const sl of pulseSlots(s.arch, slots, seed, p, 1))
        lit[sl] = Math.max(lit[sl], eI);
    const sI = stageI(u, 0.85, 0.92, p.sweepTicks);
    if (sI > sample) {
      sample = sI;
      sampleColor = p.stream === "reasoning" ? pal.reasoning : pal.textOut;
    }
  }
  const ex = [{ text: " ", color: 0, i: 0 }];
  for (let i = 0;i < slots.ys.length; i++) {
    const shimmer = s.arch.kind === "unknown" ? 0.15 + 0.08 * Math.sin(t / 10 + i) : 0.25;
    const I = Math.max(shimmer, lit[i]);
    ex.push({ text: lit[i] > 0.3 ? G.hex : G.hexOff, color: pal.hex[i % pal.hex.length], i: I });
  }
  ex.push({ text: "~", color: pal.label, i: 0.5 });
  parts.push(ex);
  parts.push([{ text: " ", color: 0, i: 0 }, { text: sample > 0.3 ? G.sample : G.node, color: sample > 0.3 ? sampleColor : pal.output, i: Math.max(0.3, sample) }]);
  if (s.tps >= 1)
    parts.push([{ text: ` ${s.tpsApprox ? "\u2248" : ""}${Math.round(s.tps)}t/s`, color: pal.text, i: 0.85 }]);
  if (s.tools.size > 0) {
    const first = [...s.tools.values()][0];
    parts.push([{ text: ` \u2699${first.tool}`, color: pal.tool, i: 1 }]);
  } else if (s.phase === "prefill") {
    parts.push([{ text: " prefill", color: pal.gridBlueLt, i: 0.8 }]);
  } else if (s.phase === "error") {
    parts.push([{ text: " \u2715", color: pal.error, i: 1 }]);
  }
  let x = 0;
  for (const group of parts) {
    const len = group.reduce((n, p) => n + [...p.text].length, 0);
    if (x + len > f.w)
      break;
    for (const p of group)
      x = f.text(x, 0, p.text, p.i > 0 ? shade(p.color, bg, p.i) : 0, bg);
  }
}

// src/core/render/viz.ts
var DEFAULT_VIZ_OPTS = { labels: true, asciiSafe: false, bg: DEFAULT };
var SPINNER = "\u2801\u2802\u2804\u2840\u2880\u2820\u2810\u2808";
var TAU = 5;
var LAND_TAU = 8;
function glyphsFor(asciiSafe) {
  return {
    hex: asciiSafe ? "\u25C6" : "\u2B22",
    hexOff: asciiSafe ? "\u25C7" : "\u2B21",
    shared: asciiSafe ? "\u25C6" : "\u25C8",
    sample: asciiSafe ? "@" : "\u25C9",
    node: "\u25CF",
    nodeOff: "\u25CB",
    dense: "\u2503"
  };
}
function stageI(u, a, b, sweep) {
  if (u < a)
    return 0;
  if (u <= b)
    return 1;
  return Math.exp(-((u - b) * sweep) / TAU);
}
function sampleIndex(seed, p, outN) {
  return Math.floor(mulberry32(hash32(seed, p.index, 23))() * outN);
}
function pulseU(s, p) {
  return (s.tick - p.bornTick) / p.sweepTicks;
}
function expertSlots(arch, col) {
  const rows = col.h;
  let count;
  let shared = 0;
  let perSlot = 1;
  let experts = rows;
  if (arch.kind === "moe") {
    shared = Math.min(arch.shared, Math.max(0, rows - 1));
    experts = arch.experts;
    const avail = Math.max(1, rows - shared);
    perSlot = arch.experts <= avail ? 1 : Math.ceil(arch.experts / avail);
    count = shared + Math.ceil(arch.experts / perSlot);
  } else {
    count = rows;
  }
  count = Math.max(1, Math.min(count, rows));
  const spacing = Math.max(1, Math.floor(rows / count));
  const offset = Math.max(0, Math.floor((rows - ((count - 1) * spacing + 1)) / 2));
  const ys = [];
  for (let i = 0;i < count; i++)
    ys.push(col.y + offset + i * spacing);
  return { ys, shared, perSlot, experts };
}
function pulseSlots(arch, slots, seed, p, layer) {
  const rng = mulberry32(hash32(seed, p.index, layer, 7));
  if (arch.kind === "moe") {
    const set = new Set;
    for (let i = 0;i < slots.shared; i++)
      set.add(i);
    for (const e of pickK(arch.experts, arch.active, rng))
      set.add(slots.shared + Math.floor(e / slots.perSlot));
    return [...set].filter((i) => i < slots.ys.length);
  }
  if (arch.kind === "dense")
    return slots.ys.map((_, i) => i);
  return pickK(slots.ys.length, Math.min(3, slots.ys.length), rng);
}
var CELL_EMPTY = 0;
var CELL_CACHED = 1;
var CELL_FRESH = 2;
var CELL_REASONING = 3;
var CELL_TEXT = 4;
function gridModel(cv, cells) {
  const kind = new Uint8Array(cells);
  const frac = new Float32Array(cells);
  const tpc = Math.max(1, Math.ceil(cv.limit / Math.max(1, cells)));
  const segs = [];
  let acc = 0;
  if (cv.cached > 0)
    segs.push({ end: acc += cv.cached, kind: CELL_CACHED });
  if (cv.fresh > 0)
    segs.push({ end: acc += cv.fresh, kind: CELL_FRESH });
  for (const r of cv.generated)
    segs.push({ end: acc += r.tokens, kind: r.stream === "reasoning" ? CELL_REASONING : CELL_TEXT });
  const used = Math.min(acc, tpc * cells);
  const segAt = (tok) => {
    for (const s of segs)
      if (tok < s.end)
        return s.kind;
    return segs.length ? segs[segs.length - 1].kind : CELL_EMPTY;
  };
  let nFilled = 0;
  for (let i = 0;i < cells; i++) {
    const start = i * tpc;
    if (used <= start)
      continue;
    nFilled++;
    if (used < start + tpc) {
      kind[i] = segAt(used - 0.000001);
      frac[i] = (used - start) / tpc;
    } else {
      kind[i] = segAt(start + tpc / 2);
      frac[i] = 1;
    }
  }
  return { kind, frac, nFilled, tokensPerCell: tpc };
}
function fmtK(n) {
  n = Math.max(0, n);
  if (n < 1000)
    return `${Math.round(n)}`;
  if (n < 1e4)
    return `${(n / 1000).toFixed(1)}k`;
  if (n < 1e6)
    return `${Math.round(n / 1000)}k`;
  return `${(n / 1e6).toFixed(1)}M`;
}
var secs = (ticks) => `${(ticks / TICK_HZ).toFixed(1)}s`;
function renderViz(w, h, sim, pal, opts = DEFAULT_VIZ_OPTS) {
  const f = new Frame(w, h);
  const L = layout(w, h, sim.arch);
  if (L.mode === "tiny") {
    f.set(Math.floor(f.w / 2), Math.floor(f.h / 2), "\xB7", shade(pal.label, opts.bg, 0.7));
    return f;
  }
  if (L.mode === "strip") {
    renderStrip(f, sim, pal, opts);
    return f;
  }
  drawScene(f, L, sim, pal, opts);
  return f;
}
function drawScene(f, L, s, pal, opts) {
  const bg = opts.bg;
  const t = s.tick;
  const G = glyphsFor(opts.asciiSafe);
  const seed = hashStr(s.sessionKey);
  const arch = s.arch;
  const full = L.mode === "full";
  const sh = (c, i) => shade(c, bg, i);
  const idle = s.phase === "idle";
  const base = idle ? 0.06 + 0.06 * (1 + Math.sin(2 * Math.PI * t / 120)) / 2 : 0.1;
  const g = L.grid;
  const cells = g.w * g.h;
  const cv = contextView(s);
  const gm = gridModel(cv, cells);
  const gridI = new Float32Array(cells);
  const gridGlyph = new Array(cells).fill("\xB7");
  const gridColor = new Int32Array(cells).fill(pal.gridEmpty);
  for (let i = 0;i < cells; i++) {
    const k = gm.kind[i];
    const partial = gm.frac[i] > 0 && gm.frac[i] < 1;
    switch (k) {
      case CELL_CACHED:
        gridGlyph[i] = "\u2593";
        gridColor[i] = pal.gridBlue;
        gridI[i] = 0.75;
        break;
      case CELL_FRESH:
        gridGlyph[i] = "\u2592";
        gridColor[i] = pal.gridBlueLt;
        gridI[i] = 0.7;
        break;
      case CELL_REASONING:
        gridGlyph[i] = "\u2588";
        gridColor[i] = pal.reasoning;
        gridI[i] = 0.85;
        break;
      case CELL_TEXT:
        gridGlyph[i] = "\u2588";
        gridColor[i] = pal.textOut;
        gridI[i] = 0.85;
        break;
      default:
        gridI[i] = 0.9;
    }
    if (k !== CELL_EMPTY && partial)
      gridGlyph[i] = " \u2591\u2592\u2593\u2588"[Math.max(1, Math.ceil(gm.frac[i] * 4))];
  }
  if (s.phase === "prefill") {
    const since = t - (s.prefillTick ?? t);
    const bx = since % 27 / 27 * (g.w + 6) - 3;
    const anyFresh = gm.kind.some((k) => k === CELL_FRESH);
    for (let i = 0;i < cells; i++) {
      const d = Math.abs(gridCell(g, i).col - bx);
      if (d >= 2.5)
        continue;
      const boost = 1 - d / 2.5 * 0.5;
      if (gm.kind[i] === CELL_FRESH)
        gridI[i] = Math.max(gridI[i], boost);
      else if (!anyFresh && gm.kind[i] === CELL_EMPTY && gridCell(g, i).col < Math.max(2, g.w / 3)) {
        gridGlyph[i] = "\u2591";
        gridColor[i] = pal.gridBlueLt;
        gridI[i] = 0.5 * boost;
      }
    }
  }
  const slots = expertSlots(arch, L.experts);
  const expertI = new Float32Array(slots.ys.length);
  const expertBase = arch.kind === "unknown" ? 0.12 + 0.06 * Math.sin(t / 10) : 0.22;
  for (let i = 0;i < slots.ys.length; i++) {
    expertI[i] = arch.kind === "unknown" ? Math.max(0.06, expertBase + 0.05 * Math.sin(t / 10 + i * 0.7)) : expertBase;
  }
  const hiddenRows = full ? L.hidden.h : 0;
  const hiddenI = new Float32Array(hiddenRows);
  const outN = L.outN;
  const outI = new Float32Array(outN);
  const outBase = s.phase === "tool" ? 0.12 : 0.25;
  outI.fill(outBase);
  let sampled = -1;
  let sampledColor = pal.textOut;
  let sampledI = 0;
  const fanA = new BrailleCanvas(L.fanA.w, L.fanA.h);
  const fanB = full ? new BrailleCanvas(L.fanB.w, L.fanB.h) : undefined;
  const ay = (yAbs) => (yAbs - L.fanA.y) * 4 + 2;
  const ax1 = L.fanA.w * 2 - 1;
  {
    const rng = mulberry32(hash32(L.box.w, L.box.h, hashStr(arch.family), 11));
    for (let r = 0;r < g.h; r++) {
      if (rng() >= 0.4)
        continue;
      for (const sl of pickK(slots.ys.length, Math.min(2, slots.ys.length), rng)) {
        fanA.line(0, ay(g.y + r), ax1, ay(slots.ys[sl]), pal.route, base);
      }
    }
  }
  if (fanB && full) {
    const FL = L;
    const by = (yAbs) => (yAbs - FL.fanB.y) * 4 + 2;
    const bx1 = FL.fanB.w * 2 - 1;
    for (let r = 1;r < FL.hidden.h; r += 4) {
      for (let o = 0;o < outN; o++) {
        fanB.line(0, by(FL.hidden.y + r), bx1, by(outY(FL, o)), (r + o) % 2 ? pal.meshPink : pal.meshBlue, base * 0.8, { stipple: 2 });
      }
    }
  }
  if (idle) {
    const cyc = Math.floor(t / 90);
    const ph = t % 90 / 30;
    if (ph < 1 && g.h > 0 && slots.ys.length > 0) {
      const rng = mulberry32(hash32(seed, cyc, 17));
      const r = Math.floor(rng() * g.h);
      const sl = Math.floor(rng() * slots.ys.length);
      fanA.line(0, ay(g.y + r), ax1, ay(slots.ys[sl]), pal.route, 0.35 * (1 - ph), { upTo: ph });
    }
  }
  if (s.phase === "prefill") {
    for (let j = 0;j < 3; j++) {
      const b = Math.floor(t / 3) - j;
      const age = t - b * 3;
      const rng = mulberry32(hash32(seed, b, 13));
      const I = 0.45 * Math.exp(-age / 4);
      for (let n = 0;n < 6 && g.h > 0; n++) {
        const r = Math.floor(rng() * g.h);
        const sl = Math.floor(rng() * slots.ys.length);
        fanA.line(0, ay(g.y + r), ax1, ay(slots.ys[sl]), pal.route, I);
      }
    }
    for (let i = 0;i < slots.ys.length; i++) {
      if (hash32(seed, i, Math.floor(t / 2), 19) / 4294967296 < 0.6) {
        expertI[i] = Math.max(expertI[i], 0.35 + 0.15 * Math.sin(t / 4 + i));
      }
    }
  }
  let newest;
  let landed;
  const attendByPulse = [];
  for (const p of s.pulses) {
    const u = pulseU(s, p);
    if (u < 1 && (!newest || p.bornTick >= newest.bornTick))
      newest = p;
    if (u >= 1 && (!landed || p.bornTick >= landed.bornTick))
      landed = p;
    if (u >= 1)
      continue;
    const sweep = p.sweepTicks;
    const rng = mulberry32(hash32(seed, p.index, 3));
    const color = p.stream === "reasoning" ? pal.reasoning : pal.textOut;
    const layers = arch.kind === "unknown" ? 1 : arch.layers;
    const layer = 1 + Math.min(layers - 1, Math.floor(u * layers));
    const m = 2 + Math.floor(rng() * 3);
    const att = pickRecent(gm.nFilled, m, rng);
    const aI = stageI(u, 0, 0.3, sweep);
    attendByPulse.push({ born: p.bornTick, cells: att, i: aI });
    const routeLayer = u < 0.3 ? 0 : layer;
    const lit = pulseSlots(arch, slots, seed, p, routeLayer);
    if (att.length && lit.length) {
      const n = Math.max(att.length, Math.min(lit.length, 8));
      const lineI = 0.9 * aI;
      for (let l = 0;l < n; l++) {
        const cell = att[l % att.length];
        const sl = lit[l % lit.length];
        fanA.line(0, ay(gridCell(g, cell).y), ax1, ay(slots.ys[sl]), pal.route, lineI, { upTo: Math.min(1, u / 0.3) });
      }
    }
    const eI = stageI(u, 0.3, 0.42, sweep);
    if (eI > 0)
      for (const sl of lit)
        expertI[sl] = Math.max(expertI[sl], arch.kind === "unknown" ? 0.55 * eI : eI);
    let litHidden = [];
    if (full) {
      const FL = L;
      const hI = stageI(u, 0.42, 0.52, sweep);
      const hr = mulberry32(hash32(seed, p.index, 5));
      for (let r = 0;r < FL.hidden.h; r++)
        if (hr() < 0.35)
          litHidden.push(r);
      if (hI > 0)
        for (const r of litHidden)
          hiddenI[r] = Math.max(hiddenI[r], hI);
      const pI = stageI(u, 0.52, 0.85, sweep);
      if (pI > 0 && fanB) {
        const by = (yAbs) => (yAbs - FL.fanB.y) * 4 + 2;
        const bx1 = FL.fanB.w * 2 - 1;
        const upTo = Math.min(1, (u - 0.52) / 0.33);
        const targets = new Set([sampleIndex(seed, p, outN), ...pickK(outN, Math.min(3, outN), mulberry32(hash32(seed, p.index, 31)))]);
        for (const r of litHidden.slice(0, 3)) {
          for (const o of targets) {
            fanB.line(0, by(FL.hidden.y + r), bx1, by(outY(FL, o)), (r + o) % 2 ? pal.meshPink : pal.meshBlue, 0.8 * pI, { upTo });
          }
        }
      }
    }
    const sI = stageI(u, 0.85, 0.92, sweep);
    if (sI > 0) {
      const o = sampleIndex(seed, p, outN);
      if (sI >= sampledI) {
        sampled = o;
        sampledColor = color;
        sampledI = sI;
      }
      outI[o] = Math.max(outI[o], sI);
    }
    if (u >= 0.92) {
      const fr = Math.min(1, (u - 0.92) / 0.08);
      const startX = L.out.x - 1;
      const endX = g.x + g.w;
      const hx = Math.round(startX + (endX - startX) * fr);
      const tail = ["\u2022", "\u2219", "\xB7"];
      for (let k = 0;k < 3; k++) {
        const x = hx + k;
        if (x > startX)
          break;
        f.set(x, L.cometY, tail[k], sh(color, 1 - k * 0.3), bg);
      }
    }
  }
  const attended = new Map;
  const newestAttend = attendByPulse.filter((a) => a.i > 0.05).sort((a, b) => b.born - a.born)[0];
  if (newestAttend)
    for (const c of newestAttend.cells)
      attended.set(c, newestAttend.i);
  if (landed && gm.nFilled > 0) {
    const age = s.tick - (landed.bornTick + landed.sweepTicks);
    const I = Math.exp(-age / LAND_TAU);
    const c = gm.nFilled - 1;
    gridI[c] = Math.max(gridI[c], I);
  }
  fanA.blitTo(f, L.fanA.x, L.fanA.y, bg);
  if (fanB && full)
    fanB.blitTo(f, L.fanB.x, L.fanB.y, bg);
  for (let i = 0;i < cells; i++) {
    const { x, y } = gridCell(g, i);
    const a = attended.get(i);
    if (a !== undefined && a > 0.05 && gm.kind[i] !== CELL_EMPTY)
      f.set(x, y, "\u25CF", sh(pal.attendDot, Math.max(0.35, a)), bg);
    else
      f.set(x, y, gridGlyph[i], sh(gridColor[i], gridI[i]), bg);
  }
  for (let i = 0;i < slots.ys.length; i++) {
    const hue = pal.hex[hash32(i, 29) % pal.hex.length];
    let ch;
    if (arch.kind === "dense")
      ch = G.dense;
    else if (arch.kind === "unknown")
      ch = G.hexOff;
    else
      ch = i < slots.shared ? G.shared : G.hex;
    const color = arch.kind === "dense" ? pal.hidden : arch.kind === "unknown" ? pal.label : hue;
    f.set(L.experts.x, slots.ys[i], ch, sh(color, expertI[i]), bg);
  }
  if (full) {
    const FL = L;
    for (let r = 0;r < FL.hidden.h; r++) {
      const on = hiddenI[r] > 0.3;
      f.set(FL.hidden.x, FL.hidden.y + r, on ? G.node : G.nodeOff, sh(pal.hidden, Math.max(0.3, hiddenI[r])), bg);
    }
  }
  for (let o = 0;o < outN; o++) {
    if (o === sampled)
      f.set(L.out.x, outY(L, o), G.sample, sh(sampledColor, Math.max(0.5, sampledI)), bg);
    else
      f.set(L.out.x, outY(L, o), G.node, sh(pal.output, outI[o]), bg);
  }
  if (!full && sampled >= 0)
    f.set(L.out.x - 1, outY(L, sampled), "\u2500", sh(sampledColor, sampledI), bg);
  let borderColor = pal.border;
  if (s.phase === "error") {
    const e = Math.exp(-(t - s.phaseTick) / 12);
    borderColor = mixColor(pal.border, pal.error, e);
  }
  const fail = s.flashes.find((fl) => fl.kind === "toolFail");
  drawRoundedBox(f, L.box, borderColor);
  drawHud(f, L, s, pal, opts, newest, cv, borderColor, fail ? Math.exp(-(t - fail.bornTick) / 10) : 0);
}
function mixColor(a, b, t) {
  t = Math.max(0, Math.min(1, t));
  const ch = (sh) => Math.round((a >> sh & 255) * (1 - t) + (b >> sh & 255) * t);
  return ch(16) << 16 | ch(8) << 8 | ch(0);
}
function placeSegs(f, y, segs, x0, x1, border) {
  const avail = x1 - x0 + 1;
  const order = [...segs].sort((a, b) => b.prio - a.prio);
  const chosen = new Set;
  const width = new Map;
  let used = 0;
  for (const sg of order) {
    const need = cpLen(sg.text) + 2 + (chosen.size ? 1 : 0);
    if (used + need <= avail) {
      chosen.add(sg);
      width.set(sg, cpLen(sg.text));
      used += need;
    } else if (sg.minLen !== undefined) {
      const room = avail - used - 2 - (chosen.size ? 1 : 0);
      if (room >= sg.minLen) {
        chosen.add(sg);
        width.set(sg, room);
        used += room + 2 + (chosen.size > 1 ? 1 : 0);
      }
    }
  }
  const left = segs.filter((sg) => chosen.has(sg) && sg.side === "l");
  const right = segs.filter((sg) => chosen.has(sg) && sg.side === "r");
  let x = x0;
  for (const sg of left) {
    const txt = truncate(sg.text, width.get(sg));
    x = embedSegment(f, y, x, txt, "\u2524", "\u251C", border, sg.fg, sg.bold) + 1;
  }
  let xr = x1;
  for (let i = right.length - 1;i >= 0; i--) {
    const sg = right[i];
    const txt = truncate(sg.text, width.get(sg));
    const start = xr - (cpLen(txt) + 2) + 1;
    embedSegment(f, y, start, txt, "\u2524", "\u251C", border, sg.fg, sg.bold);
    xr = start - 2;
  }
  return [...chosen];
}
function honestyLabel(arch, full) {
  if (arch.kind === "unknown")
    return full ? "architecture unknown" : "arch unknown";
  return full ? "illustrative routing" : "illustrative";
}
function drawHud(f, L, s, pal, opts, newest, cv, border, failI) {
  const full = L.mode === "full";
  const t = s.tick;
  const bg = opts.bg;
  const dim = (c, i = 0.85) => shade(c, bg, i);
  const arch = s.arch;
  let phaseText;
  let phaseColor = pal.text;
  const tps = s.tps >= 1 ? `${s.tpsApprox ? "\u2248" : ""}${Math.round(s.tps)}${full ? " tok/s" : "t/s"}` : "";
  switch (s.phase) {
    case "idle":
      phaseText = "\u25CB idle";
      phaseColor = dim(pal.label, 0.8);
      break;
    case "prefill": {
      const since = t - (s.prefillTick ?? t);
      phaseText = full ? `\u25B8 PREFILL  ttft ${secs(since)}` : `\u25B8 PREFILL ${secs(since)}`;
      phaseColor = pal.gridBlueLt;
      break;
    }
    case "decode": {
      const label = s.stream === "reasoning" ? full ? "REASONING" : "THINK" : "DECODE";
      phaseColor = s.stream === "reasoning" ? pal.reasoning : pal.textOut;
      if (full) {
        let lay = "";
        if (arch.kind === "unknown")
          lay = "L ?";
        else if (newest) {
          const u = pulseU(s, newest);
          lay = `L ${1 + Math.min(arch.layers - 1, Math.floor(u * arch.layers))}/${arch.layers}`;
        } else
          lay = `L \u2013/${arch.layers}`;
        const ttft = s.ttftTicks !== undefined ? `  ttft ${secs(s.ttftTicks)}` : "";
        phaseText = `\u25B8 ${label}  ${lay}${tps ? "  " + tps : ""}${ttft}`;
      } else {
        phaseText = `\u25B8 ${label}${tps ? " " + tps : ""}`;
      }
      break;
    }
    case "tool":
      phaseText = "\u2699 TOOL";
      phaseColor = pal.tool;
      break;
    case "retry":
      phaseText = `RETRY #${s.retryAttempt ?? 1}`;
      phaseColor = Math.floor(t / 15) % 2 ? pal.warn : dim(pal.warn, 0.5);
      break;
    case "error":
      phaseText = "\u2715 ERROR";
      phaseColor = pal.error;
      break;
  }
  const modelName = s.model ? normalizeModelID(s.model.modelID) : "no model yet";
  const top = [
    { text: full ? `${modelName} \xB7 ${archSummary(arch)}` : modelName, fg: pal.text, side: "l", prio: 2, minLen: 6 },
    { text: phaseText, fg: phaseColor, side: "r", prio: 3, bold: true }
  ];
  if (s.subagentsBusy > 0)
    top.push({ text: `+${s.subagentsBusy} agents`, fg: pal.label, side: "l", prio: 1 });
  placeSegs(f, L.box.y, top, L.box.x + 2, L.box.x + L.box.w - 3, border);
  const bottom = [];
  const label = honestyLabel(arch, full);
  bottom.push({ text: label, fg: dim(pal.label, 0.75), side: "r", prio: 10 });
  if (s.tools.size > 0) {
    let first;
    for (const v of s.tools.values())
      if (!first || v.startTick < first.startTick)
        first = v;
    const more = s.tools.size > 1 ? ` +${s.tools.size - 1}` : "";
    const spin = SPINNER[Math.floor(t / 3) % SPINNER.length];
    bottom.push({
      text: `\u2699 ${first.tool}${more} ${secs(t - first.startTick)} ${spin}`,
      fg: failI > 0.2 ? pal.error : pal.tool,
      side: "l",
      prio: 6,
      minLen: 6
    });
  } else if (failI > 0.2) {
    bottom.push({ text: "\u2699 tool failed", fg: pal.error, side: "l", prio: 6 });
  }
  bottom.push({ text: ctxText(cv, full), fg: dim(pal.gridBlueLt), side: "l", prio: 4, minLen: 5 });
  if (full && (s.turnReasoning > 0 || s.turnText > 0)) {
    bottom.push({ text: `think ~${fmtK(s.turnReasoning)} \xB7 out ~${fmtK(s.turnText)}`, fg: dim(pal.label), side: "l", prio: 3 });
  }
  placeSegs(f, L.box.y + L.box.h - 1, bottom, L.box.x + 2, L.box.x + L.box.w - 3, border);
}
function ctxText(cv, full) {
  const lim = `${cv.approx ? "~" : ""}${fmtK(cv.limit)}`;
  if (!cv.known) {
    if (cv.used === 0)
      return full ? `ctx ? / ${lim}` : `ctx ?`;
    return full ? `ctx ? + ${fmtK(cv.used)} new / ${lim}` : `ctx ?+${fmtK(cv.used)}`;
  }
  const pct = cv.cached + cv.fresh > 0 ? Math.round(cv.cached / (cv.cached + cv.fresh) * 100) : 0;
  if (!full)
    return `ctx ${fmtK(cv.used)}/${lim}`;
  const n = 8;
  const toCells = (v) => Math.round(v / Math.max(1, cv.limit) * n);
  const c = Math.min(n, toCells(cv.cached));
  const fr = Math.min(n - c, toCells(cv.fresh));
  const gen = Math.min(n - c - fr, toCells(cv.used - cv.cached - cv.fresh));
  const bar = "\u2593".repeat(c) + "\u2592".repeat(fr) + "\u2588".repeat(gen) + "\xB7".repeat(n - c - fr - gen);
  return `ctx ${bar} ${pct}% cached \xB7 ${fmtK(cv.used)}/${lim}`;
}

// src/core/sim/driver.ts
class Driver {
  sim;
  queue = [];
  t0;
  maxCatchUp;
  constructor(sim, opts = {}) {
    this.sim = sim;
    this.maxCatchUp = opts.maxCatchUp ?? 10;
    this.t0 = opts.t0;
  }
  get origin() {
    return this.t0;
  }
  push(sig) {
    if (this.t0 === undefined)
      this.t0 = sig.ts - this.sim.tick * TICK_MS;
    this.queue.push(sig);
  }
  tickOf(ts) {
    return Math.floor((ts - (this.t0 ?? ts)) / TICK_MS + 0.000001);
  }
  advanceTo(nowMs) {
    if (this.t0 === undefined)
      this.t0 = nowMs - this.sim.tick * TICK_MS;
    let target = this.tickOf(nowMs);
    let steps = target - this.sim.tick;
    if (steps > this.maxCatchUp) {
      this.t0 += (steps - this.maxCatchUp) * TICK_MS;
      target = this.sim.tick + this.maxCatchUp;
      steps = this.maxCatchUp;
    }
    this.applyDue();
    let taken = 0;
    while (this.sim.tick < target) {
      step(this.sim);
      taken++;
      this.applyDue();
    }
    return taken;
  }
  applyDue() {
    if (this.queue.length === 0)
      return;
    let i = 0;
    while (i < this.queue.length && this.tickOf(this.queue[i].ts) <= this.sim.tick) {
      applySignal(this.sim, this.queue[i]);
      i++;
    }
    if (i > 0)
      this.queue.splice(0, i);
  }
  get pending() {
    return this.queue.length;
  }
}

// src/hosts/opencode-tui.ts
import { appendFileSync } from "fs";
var DEBUG_FILE = process.env.INLINEVIZ_DEBUG ?? process.env.OPENCODEVIZ_DEBUG;
var debug = (msg) => {
  if (!DEBUG_FILE)
    return;
  try {
    appendFileSync(DEBUG_FILE, JSON.stringify({ t: Date.now(), ...msg }) + `
`);
  } catch {}
};
function parseOptions(o) {
  const v = o ?? {};
  return {
    surface: v.surface === "strip" || v.surface === "both" ? v.surface : "sidebar",
    sidebarHeight: typeof v.sidebarHeight === "number" && v.sidebarHeight >= 1 ? Math.floor(v.sidebarHeight) : 14,
    asciiSafe: !!v.asciiSafe,
    labels: v.labels !== false,
    fps: typeof v.fps === "number" && v.fps >= 1 ? Math.min(30, v.fps) : 20,
    idleFps: typeof v.idleFps === "number" && v.idleFps >= 0 ? Math.min(30, v.idleFps) : 0,
    arch: v.arch
  };
}
var tui = async (api, options) => {
  const opts = parseOptions(options);
  const sim = createSim("opencode", opts.arch);
  const driver = new Driver(sim);
  const pal = DEFAULT_PALETTE;
  const RGBAClass = typeof RGBA?.fromInts === "function" ? RGBA : api.theme.current.background.constructor;
  const copier = new FrameCopier(RGBAClass);
  const disposers = [];
  const boxes = new Set;
  const lastGeo = new Map;
  const perf = new Map;
  let demoUntil = 0;
  const push = (s) => {
    if (Date.now() < demoUntil)
      return;
    driver.push(s);
  };
  const activeSessionID = () => {
    const r = api.route.current;
    return r.name === "session" && typeof r.params?.sessionID === "string" ? r.params.sessionID : undefined;
  };
  const contextLimit = (providerID, modelID) => api.state.provider.find((p) => p.id === providerID)?.models?.[modelID]?.limit?.context;
  const adapter = new OpenCodeAdapter(push, { activeSessionID, contextLimit, now: Date.now });
  let seeded;
  const seed = () => {
    const sid = adapter.session;
    if (!sid || sid === seeded)
      return;
    try {
      const msgs = api.state.session.messages(sid);
      for (let i = msgs.length - 1;i >= 0; i--) {
        const m = msgs[i];
        if (m?.role !== "assistant" || !m.providerID || !m.modelID)
          continue;
        seeded = sid;
        const ts = Date.now();
        push({ t: "model", ts, model: { providerID: m.providerID, modelID: m.modelID, contextLimit: contextLimit(m.providerID, m.modelID) } });
        const t = m.tokens;
        if (t && (t.input || t.cache?.read)) {
          push({
            t: "step.end",
            ts,
            usage: { input: (t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0), output: 0, reasoning: 0, cacheRead: t.cache?.read ?? 0, cacheWrite: t.cache?.write ?? 0 }
          });
        }
        break;
      }
    } catch {}
  };
  for (const type of OPENCODE_EVENT_TYPES) {
    try {
      disposers.push(api.event.on(type, (e) => {
        adapter.handle(e);
        seed();
      }));
    } catch {}
  }
  const themeInt = (key) => rgbaToInt(api.theme.current[key], key === "text" ? 14146272 : pal.bg);
  function VizBox(size, bgKey, tag) {
    const el = createElement("box");
    setProp(el, "flexShrink", 0);
    if (size.width !== undefined)
      setProp(el, "width", size.width);
    else
      setProp(el, "flexGrow", 1);
    if (size.height !== undefined)
      setProp(el, "height", size.height);
    setProp(el, "renderAfter", function(buffer) {
      const w = Math.floor(this.width ?? 0), h = Math.floor(this.height ?? 0);
      const geo = `${this.screenX ?? this.x},${this.screenY ?? this.y},${w}x${h}`;
      if (DEBUG_FILE && geo !== lastGeo.get(tag)) {
        lastGeo.set(tag, geo);
        const par = this.parent;
        debug({
          tag,
          x: this.x,
          y: this.y,
          screenX: this.screenX,
          screenY: this.screenY,
          w,
          h,
          parent: par ? { x: par.x, y: par.y, w: par.width, h: par.height } : null,
          renderer: { w: api.renderer.width, h: api.renderer.height }
        });
      }
      const rw = Math.floor(api.renderer.width ?? w), rh = Math.floor(api.renderer.height ?? h);
      const sx = Math.floor(this.screenX ?? this.x ?? 0), sy = Math.floor(this.screenY ?? this.y ?? 0);
      const fitH = rh - sy - 2;
      if (tag === "overlay" && h > fitH && fitH >= 8)
        queueMicrotask(() => setProp(el, "height", fitH));
      const dw = Math.min(w, rw - sx), dh = Math.min(h, rh - sy);
      if (dw < 1 || dh < 1)
        return;
      const tStart = DEBUG_FILE ? performance.now() : 0;
      driver.advanceTo(Date.now());
      const viz = { labels: opts.labels, asciiSafe: opts.asciiSafe, bg: themeInt(bgKey) };
      const frame = renderViz(dw, dh, sim, pal, viz);
      copier.copy(buffer, frame, sx, sy, themeInt("text"));
      if (DEBUG_FILE) {
        const st = perf.get(tag) ?? { n: 0, ms: 0, since: Date.now() };
        st.n++;
        st.ms += performance.now() - tStart;
        if (Date.now() - st.since >= 2000) {
          debug({ tag, frames: st.n, fps: +(st.n / ((Date.now() - st.since) / 1000)).toFixed(1), msPerFrame: +(st.ms / st.n).toFixed(3), cells: dw * dh });
          st.n = 0;
          st.ms = 0;
          st.since = Date.now();
        }
        perf.set(tag, st);
      }
    });
    boxes.add(el);
    return el;
  }
  const ACTIVE_MS = 1000 / opts.fps;
  const idleMs = opts.idleFps > 0 ? 1000 / opts.idleFps : Infinity;
  let lastRender = 0;
  let lastFocusCheck = 0;
  let wasActive = true;
  const pace = setInterval(() => {
    const now = Date.now();
    if (now - lastFocusCheck >= 100) {
      lastFocusCheck = now;
      adapter.sync();
      seed();
    }
    const active = sim.phase !== "idle" || sim.pulses.length > 0 || driver.pending > 0 || sim.bank >= 1;
    const due = active ? ACTIVE_MS : wasActive ? 0 : idleMs;
    wasActive = active;
    if (now - lastRender < due)
      return;
    lastRender = now;
    for (const b of boxes) {
      if (b.isDestroyed) {
        boxes.delete(b);
        continue;
      }
      b.requestRender();
    }
  }, ACTIVE_MS);
  disposers.push(() => clearInterval(pace));
  const slots = {};
  if (opts.surface === "sidebar" || opts.surface === "both") {
    slots.sidebar_content = () => VizBox({ height: opts.sidebarHeight }, "backgroundPanel", "sidebar");
  }
  if (opts.surface === "strip" || opts.surface === "both") {
    slots.session_prompt_right = () => VizBox({ height: 1, width: 28 }, "background", "strip");
  }
  api.slots.register({ order: 50, slots });
  let overlayOpen = false;
  const closeOverlay = () => {
    overlayOpen = false;
    api.ui.dialog.clear();
  };
  const toggleOverlay = () => {
    if (overlayOpen)
      return closeOverlay();
    overlayOpen = true;
    const height = Math.max(12, Math.floor((api.renderer.height ?? 40) * 0.45));
    api.ui.dialog.replace(() => createComponent(api.ui.Dialog, {
      size: "xlarge",
      onClose: () => {
        overlayOpen = false;
        api.ui.dialog.clear();
      },
      get children() {
        return VizBox({ height }, "backgroundPanel", "overlay");
      }
    }), () => {
      overlayOpen = false;
    });
    try {
      api.ui.dialog.setSize("xlarge");
    } catch {}
  };
  let demoTimers = [];
  const playDemo = () => {
    for (const t of demoTimers)
      clearTimeout(t);
    demoTimers = [];
    const t0 = Date.now();
    demoUntil = t0 + demoDuration("all");
    driver.push({ t: "reset", ts: t0, sessionKey: "demo" });
    for (const s of demoSignals("all", t0))
      demoTimers.push(setTimeout(() => driver.push({ ...s, ts: Date.now() }), s.ts - t0));
    demoTimers.push(setTimeout(() => {
      demoUntil = 0;
      seeded = undefined;
      driver.push({ t: "reset", ts: Date.now(), sessionKey: adapter.session ?? "opencode" });
      seed();
    }, demoDuration("all")));
    if (!overlayOpen)
      toggleOverlay();
  };
  disposers.push(() => demoTimers.forEach(clearTimeout));
  const commands = [
    { name: "inlineviz.toggle", title: "Toggle model visualizer", slashName: "viz", category: "View", run: toggleOverlay },
    { name: "inlineviz.demo", title: "Model visualizer: play demo", slashName: "viz-demo", category: "View", run: playDemo }
  ];
  let registered = false;
  try {
    const km = api.keymap;
    if (km && typeof km.registerLayer === "function") {
      const off = km.registerLayer({ commands: commands.map((c) => ({ ...c, namespace: "palette" })) });
      if (typeof off === "function")
        disposers.push(off);
      registered = true;
    }
  } catch {}
  if (!registered && api.command) {
    const off = api.command.register(() => commands.map((c) => ({ title: c.title, value: c.name, category: c.category, slash: { name: c.slashName }, onSelect: () => c.run() })));
    disposers.push(off);
  }
  api.lifecycle.onDispose(() => {
    for (const d of disposers) {
      try {
        d();
      } catch {}
    }
    boxes.clear();
  });
};
var plugin = { id: "inlineviz", tui };
var opencode_tui_default = plugin;
export {
  opencode_tui_default as default
};
