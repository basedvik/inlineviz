#!/usr/bin/env bun
// inlineviz standalone CLI (SPEC §13), tdef main.go style: subcommands with
// their own flags. Interactive commands render with the ANSI backend; capture
// and screens are headless and byte-identical everywhere.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT } from "../core/frame.ts";
import { DEMO_NAMES, type DemoName, demoDuration, demoSignals, isDemoName } from "../core/demo.ts";
import { phaseTicks, play } from "../core/headless.ts";
import { DEFAULT_PALETTE } from "../core/palette.ts";
import { type Signal, isSignal } from "../core/protocol.ts";
import { type Arch, RULES, archSummary } from "../core/registry.ts";
import { type VizOpts, renderViz } from "../core/render/viz.ts";
import { Driver } from "../core/sim/driver.ts";
import { createSim } from "../core/sim/sim.ts";
import { runInteractive } from "../backends/ansi.ts";
import { parseNdjsonLine } from "../adapters/ndjson.ts";

const HELP = `inlineviz — live visualization of what an LLM is doing

usage:
  inlineviz                          demo loop (all scripts)
  inlineviz demo [script]            ${DEMO_NAMES.join(" | ")} | all
  inlineviz replay <file.ndjson> [-speed 2]
  inlineviz stdin                    read NDJSON Signals from stdin
  inlineviz attach <url> [-session id]   follow a running OpenCode server (opencode serve)
  inlineviz capture -script agentic -size 100x30 [-every 15] [-limit N] [-text|-ansi] [-out frames]
  inlineviz screens [-size 100x30] [-script agentic] [-tick N] [-visible 0.3]
                                       every phase at a size (all sizes if omitted);
                                       -visible blanks cells dimmer than a luminance threshold
  inlineviz registry                 print the architecture table
  inlineviz help

common flags: -fps 30  -ascii-safe  -no-labels  -record out.ndjson  -arch '<json {regex: Arch}>'
`;

type Flags = Record<string, string | boolean>;

function parseFlags(args: string[]): { pos: string[]; flags: Flags } {
  const pos: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("-") && a.length > 1 && isNaN(Number(a))) {
      const k = a.replace(/^-+/, "");
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        flags[k] = next;
        i++;
      } else flags[k] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}

function die(msg: string): never {
  process.stderr.write(`inlineviz: ${msg}\n`);
  process.exit(2);
}

function parseSize(v: string | boolean | undefined, def: [number, number]): [number, number] {
  if (typeof v !== "string") return def;
  const m = v.match(/^(\d+)x(\d+)$/);
  if (!m) die(`bad -size ${v} (want WxH)`);
  return [Number(m[1]), Number(m[2])];
}

function vizOpts(flags: Flags): VizOpts {
  return { labels: !flags["no-labels"], asciiSafe: !!flags["ascii-safe"], bg: DEFAULT };
}

function archOverrides(flags: Flags): Record<string, Arch> | undefined {
  if (typeof flags.arch !== "string") return undefined;
  try {
    return JSON.parse(flags.arch) as Record<string, Arch>;
  } catch {
    die("-arch must be JSON: {\"regex\": {\"kind\":\"moe\",...}}");
  }
}

function scriptName(v: string | boolean | undefined, def: DemoName): DemoName {
  if (typeof v !== "string") return def;
  if (!isDemoName(v)) die(`unknown script ${v} (${DEMO_NAMES.join(", ")}, all)`);
  return v;
}

// ── headless commands ─────────────────────────────────────────────────────

function capture(flags: Flags): void {
  const name = scriptName(flags.script, "agentic");
  const [w, h] = parseSize(flags.size, [100, 30]);
  const every = Number(flags.every ?? 15);
  if (!(every >= 1)) die("-every must be >= 1");
  const limit = flags.limit !== undefined ? Number(flags.limit) : undefined;
  const out = typeof flags.out === "string" ? flags.out : "frames";
  const ansi = !!flags.ansi;
  mkdirSync(out, { recursive: true });
  let n = 0;
  for (const { tick, frame } of play(demoSignals(name), { w, h, pal: DEFAULT_PALETTE, viz: vizOpts(flags), every, limit, arch: archOverrides(flags) })) {
    const file = join(out, `frame-${String(tick).padStart(5, "0")}.${ansi ? "ans" : "txt"}`);
    writeFileSync(file, ansi ? frame.toAnsi() : frame.toText() + "\n");
    n++;
  }
  process.stdout.write(`wrote ${n} frames to ${out}/\n`);
}

const SCREEN_SIZES: [number, number][] = [[40, 14], [62, 19], [90, 30], [137, 45], [40, 1]];

/** Text dump keeping only cells brighter than `min` luminance: a way to "see" intensity in plain text. */
function visibleText(f: import("../core/frame.ts").Frame, min: number): string {
  const lines: string[] = [];
  for (let y = 0; y < f.h; y++) {
    let s = "";
    for (let x = 0; x < f.w; x++) {
      const i = y * f.w + x;
      const c = f.fg[i];
      const lum = c === DEFAULT ? 1 : (0.2126 * ((c >> 16) & 255) + 0.7152 * ((c >> 8) & 255) + 0.0722 * (c & 255)) / 255;
      s += lum >= min ? f.ch[i] : " ";
    }
    lines.push(s);
  }
  return lines.join("\n");
}

function screens(flags: Flags): void {
  const vis = flags.visible === true ? 0.3 : typeof flags.visible === "string" ? Number(flags.visible) : undefined;
  const name = scriptName(flags.script, "agentic");
  const sizes = typeof flags.size === "string" ? [parseSize(flags.size, [100, 30])] : SCREEN_SIZES;
  const sigs = demoSignals(name);
  const viz = vizOpts(flags);
  const ticks = typeof flags.tick === "string"
    ? [{ label: `tick ${flags.tick}`, tick: Number(flags.tick) }]
    : phaseTicks(sigs, { w: 1, h: 1, pal: DEFAULT_PALETTE, viz });
  for (const [w, h] of sizes) {
    for (const { label, tick } of ticks) {
      let shown = false;
      for (const fr of play(sigs, { w, h, pal: DEFAULT_PALETTE, viz, every: 1, limit: tick, arch: archOverrides(flags) })) {
        if (fr.tick !== tick) continue;
        const body = vis !== undefined ? visibleText(fr.frame, vis) : fr.frame.toText();
        process.stdout.write(`── ${name} ${w}x${h} · ${label} · tick ${tick} · phase ${fr.sim.phase} ──\n${body}\n\n`);
        shown = true;
      }
      if (!shown) process.stdout.write(`── ${w}x${h} · ${label}: tick ${tick} out of range ──\n`);
    }
  }
}

function registry(): void {
  for (const r of RULES) process.stdout.write(`${r.re.source.padEnd(40)} ${r.arch.kind.padEnd(8)} ${archSummary(r.arch)}${r.arch.note ? `  (${r.arch.note})` : ""}\n`);
}

// ── live sources ──────────────────────────────────────────────────────────

function makeLive(flags: Flags) {
  const sim = createSim("live", archOverrides(flags));
  const driver = new Driver(sim);
  const record = typeof flags.record === "string" ? flags.record : undefined;
  if (record) writeFileSync(record, `# inlineviz recording ${new Date().toISOString()}\n`);
  const push = (s: Signal) => {
    driver.push(s);
    if (record) writeFileSync(record, JSON.stringify(s) + "\n", { flag: "a" });
  };
  return { sim, driver, push };
}

function startInteractive(flags: Flags, setup: (push: (s: Signal) => void, now: () => number) => (() => void) | void, onKey?: (k: string) => void): void {
  const live = makeLive(flags);
  const cleanup = setup(live.push, Date.now) || undefined;
  runInteractive({
    driver: live.driver,
    pal: DEFAULT_PALETTE,
    viz: vizOpts(flags),
    fps: Number(flags.fps ?? 30),
    onKey,
    onExit: cleanup,
  });
}

/** Schedule demo signals re-timed to start now; loops when `loop` is set. */
function scheduleDemo(name: DemoName, push: (s: Signal) => void, loop: boolean): () => void {
  let timers: ReturnType<typeof setTimeout>[] = [];
  let stopped = false;
  const run = () => {
    if (stopped) return;
    const t0 = Date.now();
    for (const s of demoSignals(name, t0)) timers.push(setTimeout(() => push({ ...s, ts: Date.now() }), s.ts - t0));
    if (loop) timers.push(setTimeout(run, demoDuration(name)));
  };
  run();
  return () => {
    stopped = true;
    for (const t of timers) clearTimeout(t);
    timers = [];
  };
}

function demo(pos: string[], flags: Flags, loopDefault: boolean): void {
  let idx = Math.max(0, (DEMO_NAMES as readonly string[]).indexOf(pos[0] ?? ""));
  let name: DemoName = pos[0] ? scriptName(pos[0], "all") : "all";
  let stop: (() => void) | undefined;
  let pushRef: ((s: Signal) => void) | undefined;
  startInteractive(
    flags,
    (push) => {
      pushRef = push;
      stop = scheduleDemo(name, push, loopDefault || name === "all");
      return () => stop?.();
    },
    (k) => {
      if (k === "d" && pushRef) {
        stop?.();
        idx = (idx + 1) % DEMO_NAMES.length;
        name = DEMO_NAMES[idx];
        pushRef({ t: "reset", ts: Date.now(), sessionKey: `demo-${name}` });
        stop = scheduleDemo(name, pushRef, true);
      }
    },
  );
}

function replay(pos: string[], flags: Flags): void {
  const file = pos[0] ?? die("replay needs a file");
  const speed = Number(flags.speed ?? 1);
  const sigs: Signal[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const s = parseNdjsonLine(line);
    if (s) sigs.push(s);
  }
  if (!sigs.length) die(`no signals in ${file}`);
  startInteractive(flags, (push) => {
    const src0 = sigs[0].ts;
    const t0 = Date.now() + 300;
    const timers = sigs.map((s) => setTimeout(() => push({ ...s, ts: Date.now() }), Math.max(0, t0 + (s.ts - src0) / speed - Date.now())));
    return () => timers.forEach(clearTimeout);
  });
}

function stdin(flags: Flags): void {
  if (process.stdin.isTTY) die("stdin: pipe NDJSON Signals in, e.g. `cat rec.ndjson | inlineviz stdin`");
  startInteractive(flags, (push) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const s = parseNdjsonLine(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (s) push({ ...s, ts: Date.now() });
      }
    });
  });
}

async function attach(pos: string[], flags: Flags): Promise<void> {
  const url = pos[0] ?? "http://127.0.0.1:4096";
  const { attachOpenCode } = await import("../adapters/opencode-sse.ts");
  startInteractive(flags, (push, now) => {
    const ctl = attachOpenCode(url, push, now, typeof flags.session === "string" ? flags.session : undefined);
    return () => ctl.stop();
  });
}

// ── main ──────────────────────────────────────────────────────────────────

export async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  const { pos, flags } = parseFlags(rest);
  switch (cmd) {
    case undefined:
      return demo([], parseFlags(argv).flags, true);
    case "demo":
      return demo(pos, flags, false);
    case "replay":
      return replay(pos, flags);
    case "stdin":
      return stdin(flags);
    case "attach":
      return attach(pos, flags);
    case "capture":
      return capture(flags);
    case "screens":
      return screens(flags);
    case "registry":
      return registry();
    case "help":
    case "-h":
    case "--help":
      process.stdout.write(HELP);
      return;
    default:
      if (cmd.startsWith("-")) return demo([], parseFlags(argv).flags, true);
      die(`unknown command ${cmd}\n\n${HELP}`);
  }
}

if (import.meta.main) {
  // Validate early so typos in -arch etc. fail before the alt screen.
  void isSignal;
  await main(process.argv.slice(2));
}
