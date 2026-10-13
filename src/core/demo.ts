// Demo scripts (SPEC §12): precomputed, deterministic Signal streams for tuning
// visuals without spending tokens, and for capture/screens/golden tests.

import type { ModelRef, Signal, SignalBody, Stream, Usage } from "./protocol.ts";
import { mulberry32 } from "./render/illustrate.ts";

export const DEMO_NAMES = ["moe-chat", "agentic", "closed", "dense", "error"] as const;
export type DemoName = (typeof DEMO_NAMES)[number] | "all";

class Script {
  t: number;
  readonly out: Signal[] = [];
  readonly rng: () => number;
  constructor(t0: number, seed: number) {
    this.t = t0;
    this.rng = mulberry32(seed);
  }
  at(dt: number, sig: SignalBody): this {
    this.t += dt;
    this.out.push({ ...sig, ts: Math.round(this.t) } as Signal);
    return this;
  }
  wait(ms: number): this {
    this.t += ms;
    return this;
  }
  /** Bursty stream: chunks of 1–40-ish chars every 20–120 ms averaging `tps` tokens/s. */
  stream(kind: Stream, tokens: number, tps: number): this {
    const totalChars = tokens * 4;
    let sent = 0;
    while (sent < totalChars) {
      const dt = 20 + this.rng() * 100;
      const want = ((tps * 4 * dt) / 1000) * (0.5 + this.rng());
      const chars = Math.max(1, Math.min(totalChars - sent, Math.round(want)));
      sent += chars;
      this.at(dt, { t: "delta", kind, chars });
    }
    return this;
  }
}

const usage = (u: Partial<Usage>): Usage => ({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, ...u });
const model = (providerID: string, modelID: string, contextLimit: number): ModelRef => ({ providerID, modelID, contextLimit });

function moeChat(s: Script): void {
  s.at(0, { t: "model", model: model("openrouter", "qwen/qwen3-235b-a22b", 131072) })
    // Resumed session: the previous step's usage is already known.
    .at(10, { t: "step.end", finish: "stop", usage: usage({ input: 1200, cacheRead: 20500, output: 0 }) })
    .at(10, { t: "idle" })
    .at(300, { t: "turn.start" })
    .at(20, { t: "step.start" })
    .wait(1400)
    .stream("reasoning", 900, 70)
    .stream("text", 300, 70)
    .at(80, { t: "step.end", finish: "stop", usage: usage({ input: 1800, cacheRead: 22000, output: 300, reasoning: 900 }) })
    .at(150, { t: "idle" });
}

function agentic(s: Script): void {
  s.at(0, { t: "model", model: model("openrouter", "openai/gpt-oss-120b", 131072) })
    .at(300, { t: "turn.start" })
    .at(20, { t: "step.start" })
    .wait(900)
    .stream("reasoning", 150, 80)
    .stream("text", 40, 80)
    .at(60, { t: "tool.start", callID: "c1", tool: "bash" })
    .at(40, { t: "step.end", finish: "tool-calls", usage: usage({ input: 9000, output: 40, reasoning: 150 }) })
    .at(2300, { t: "tool.end", callID: "c1", ok: true })
    .at(30, { t: "step.start" })
    .wait(600)
    .stream("reasoning", 80, 80)
    .at(50, { t: "tool.start", callID: "c2", tool: "read" })
    .at(10, { t: "tool.start", callID: "c3", tool: "grep" })
    .at(30, { t: "step.end", finish: "tool-calls", usage: usage({ input: 1400, cacheRead: 9000, output: 0, reasoning: 80 }) })
    .at(800, { t: "tool.end", callID: "c2", ok: true })
    .at(600, { t: "tool.end", callID: "c3", ok: false })
    .at(30, { t: "step.start" })
    .wait(500)
    .stream("text", 400, 60)
    .at(60, { t: "step.end", finish: "stop", usage: usage({ input: 900, cacheRead: 10400, output: 400 }) })
    .at(150, { t: "idle" });
}

function closed(s: Script): void {
  s.at(0, { t: "model", model: model("anthropic", "claude-sonnet-4-5", 200000) })
    .at(10, { t: "step.end", finish: "stop", usage: usage({ input: 2000, cacheRead: 148000, output: 0 }) })
    .at(10, { t: "idle" })
    .at(300, { t: "turn.start" })
    .at(20, { t: "step.start" })
    .wait(2200)
    .stream("text", 700, 90)
    .at(60, { t: "step.end", finish: "stop", usage: usage({ input: 3000, cacheRead: 150000, cacheWrite: 2000, output: 700 }) })
    .at(150, { t: "idle" });
}

function dense(s: Script): void {
  s.at(0, { t: "model", model: model("together", "meta-llama/llama-3.1-70b-instruct", 131072) })
    .at(300, { t: "turn.start" })
    .at(20, { t: "step.start" })
    .wait(1100)
    .stream("text", 250, 25)
    .at(60, { t: "step.end", finish: "stop", usage: usage({ input: 4000, output: 250 }) })
    .at(150, { t: "idle" });
}

function error(s: Script): void {
  s.at(0, { t: "model", model: model("deepseek", "deepseek-chat", 65536) })
    .at(300, { t: "turn.start" })
    .at(20, { t: "step.start" })
    .wait(1500)
    .at(0, { t: "retry", attempt: 1, message: "overloaded" })
    .at(2000, { t: "step.start" })
    .wait(1000)
    .at(0, { t: "retry", attempt: 2, message: "overloaded" })
    .at(2000, { t: "error", message: "provider overloaded" });
}

const SCRIPTS: Record<Exclude<DemoName, "all">, (s: Script) => void> = { "moe-chat": moeChat, agentic, closed, dense, error };

/** Precomputed signals for a demo script starting at t0 (ms). Deterministic. */
export function demoSignals(name: DemoName, t0 = 0): Signal[] {
  const s = new Script(t0, 0xc0ffee);
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

export function isDemoName(n: string): n is DemoName {
  return n === "all" || (DEMO_NAMES as readonly string[]).includes(n);
}

/** Duration of a script in ms (last signal ts − t0), plus a short tail. */
export function demoDuration(name: DemoName): number {
  const sigs = demoSignals(name, 0);
  return (sigs.length ? sigs[sigs.length - 1].ts : 0) + 3500;
}
