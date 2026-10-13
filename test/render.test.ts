import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { demoSignals } from "../src/core/demo.ts";
import { DEFAULT, type Frame } from "../src/core/frame.ts";
import { phaseTicks, play } from "../src/core/headless.ts";
import { DEFAULT_PALETTE as PAL } from "../src/core/palette.ts";
import type { Signal, Usage } from "../src/core/protocol.ts";
import { layout } from "../src/core/render/layout.ts";
import { DEFAULT_VIZ_OPTS as OPTS, expertSlots, pulseSlots, renderViz } from "../src/core/render/viz.ts";
import { hashStr } from "../src/core/render/illustrate.ts";
import { Driver } from "../src/core/sim/driver.ts";
import { type SimState, TICK_MS, createSim } from "../src/core/sim/sim.ts";

const usage = (u: Partial<Usage>): Usage => ({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, ...u });

function simAt(signals: Signal[], tick: number, key = "t"): SimState {
  const sim = createSim(key);
  const d = new Driver(sim, { t0: 0, maxCatchUp: 1e9 });
  for (const s of signals) d.push(s);
  d.advanceTo(tick * TICK_MS);
  return sim;
}

/** One-pulse decode scenario for a model; returns the sim at a given pulse stage u. */
function pulseScenario(modelID: string, u: number) {
  const sigs: Signal[] = [
    { t: "model", ts: 0, model: { providerID: "p", modelID, contextLimit: 100000 } },
    { t: "step.end", ts: 10, usage: usage({ input: 5000, cacheRead: 20000 }) },
    { t: "step.start", ts: 100 },
    { t: "delta", ts: 400, kind: "text", chars: 8 },
  ];
  const sim = simAt(sigs, 15);
  expect(sim.pulses.length).toBe(1);
  const p = sim.pulses[0];
  const tick = p.bornTick + Math.round(u * p.sweepTicks);
  return { sim: simAt(sigs, tick), p };
}

const rowText = (f: Frame, y: number) => f.ch.slice(y * f.w, (y + 1) * f.w).join("");

describe("render purity", () => {
  test("RenderDeterministic", () => {
    const sigs = demoSignals("agentic");
    for (const tick of [0, 30, 60, 120, 200]) {
      const a = renderViz(90, 30, simAt(sigs, tick), PAL, OPTS);
      const b = renderViz(90, 30, simAt(sigs, tick), PAL, OPTS);
      expect(Bun.deepEquals(a, b, true)).toBe(true);
    }
  });

  test("RenderAnimates", () => {
    const sigs = demoSignals("agentic");
    const a = renderViz(90, 30, simAt(sigs, 57), PAL, OPTS).toText();
    const b = renderViz(90, 30, simAt(sigs, 72), PAL, OPTS).toText();
    expect(a).not.toBe(b);
  });

  test("RenderIdleBreathes", () => {
    // Ticks 40 and 70 are outside the idle-spark window (first 30 ticks of each 90).
    const s40 = simAt([], 40), s70 = simAt([], 70);
    const a = renderViz(90, 30, s40, PAL, OPTS), b = renderViz(90, 30, s70, PAL, OPTS);
    expect(a.toText()).toBe(b.toText());
    expect(Bun.deepEquals(a.fg, b.fg)).toBe(false);
  });

  test("RenderFitsFrame", () => {
    const sigs = demoSignals("agentic");
    const sims = [simAt(sigs, 0), simAt(sigs, 57), simAt(sigs, 120)];
    for (const [w, h] of [[1, 1], [12, 1], [28, 1], [34, 10], [40, 14], [62, 19], [90, 30], [137, 45], [220, 70]]) {
      for (const s of sims) {
        const f = renderViz(w, h, s, PAL, OPTS);
        expect(f.w).toBe(w);
        expect(f.h).toBe(h);
        expect(f.ch.length).toBe(w * h);
        const L = layout(w, h, s.arch);
        if (L.mode === "full" || L.mode === "compact") {
          expect(f.ch[0]).toBe("╭");
          expect(f.ch[w - 1]).toBe("╮");
          expect(f.ch[(h - 1) * w]).toBe("╰");
          expect(f.ch[h * w - 1]).toBe("╯");
        }
      }
    }
  });
});

describe("render phases (tdef TestTitlePhases style)", () => {
  test("RenderPhaseScript", () => {
    const sigs = demoSignals("agentic");
    const ticks = phaseTicks(sigs, { w: 1, h: 1, pal: PAL, viz: OPTS });
    const at = (label: string) => ticks.find((t) => t.label === label)?.tick ?? -1;
    const cases: { tick: number; want: string[]; absent?: string[] }[] = [
      { tick: 0, want: ["○ idle", "gpt-oss-120b", "MoE 128e/4a · 36L"] },
      { tick: at("prefill"), want: ["PREFILL", "ttft"], absent: ["⚙"] },
      { tick: at("decode:reasoning") + 20, want: ["REASONING", "tok/s", "L "] },
      { tick: at("tool"), want: ["⚙ TOOL", "⚙ bash"] },
    ];
    for (const c of cases) {
      expect(c.tick).toBeGreaterThanOrEqual(0);
      const txt = renderViz(90, 30, simAt(sigs, c.tick), PAL, OPTS).toText();
      for (const w of c.want) if (!txt.includes(w)) throw new Error(`tick ${c.tick}: missing ${JSON.stringify(w)}\n${txt}`);
      for (const a of c.absent ?? []) if (txt.includes(a)) throw new Error(`tick ${c.tick}: unexpected ${JSON.stringify(a)}`);
    }
    // After the first tool ends: prefill again, no bash badge.
    const bashEnd = Math.ceil(sigs.find((s) => s.t === "tool.end")!.ts / TICK_MS) + 2;
    const after = renderViz(90, 30, simAt(sigs, bashEnd), PAL, OPTS).toText();
    expect(after).toContain("PREFILL");
    expect(after).not.toContain("⚙ bash");
    // Concurrent tools.
    const both = Math.ceil(sigs.filter((s) => s.t === "tool.start")[2].ts / TICK_MS) + 1;
    expect(renderViz(90, 30, simAt(sigs, both), PAL, OPTS).toText()).toContain("⚙ read +1");
    // The end: idle again.
    const end = Math.ceil(sigs[sigs.length - 1].ts / TICK_MS) + 5;
    expect(renderViz(90, 30, simAt(sigs, end), PAL, OPTS).toText()).toContain("○ idle");
  });
});

describe("render semantics", () => {
  const litHexCount = (f: Frame, x: number, glyphs: string[]) => {
    let n = 0;
    for (let y = 0; y < f.h; y++) {
      const i = y * f.w + x;
      if (glyphs.includes(f.ch[i]) && PAL.hex.includes(f.fg[i])) n++;
    }
    return n;
  };

  test("ExactlyKExpertsLit", () => {
    const { sim, p } = pulseScenario("gpt-oss-120b", 0.36);
    const f = renderViz(90, 30, sim, PAL, OPTS);
    const L = layout(90, 30, sim.arch);
    if (L.mode !== "full") throw new Error("expected full");
    const slots = expertSlots(sim.arch, L.experts);
    const layer = 1 + Math.floor(0.36 * 36);
    const want = pulseSlots(sim.arch, slots, hashStr(sim.sessionKey), p, Math.min(36, Math.max(1, layer)));
    const lit = litHexCount(f, L.experts.x, ["⬢"]);
    expect(lit).toBeGreaterThanOrEqual(1);
    expect(lit).toBeLessThanOrEqual(4); // k = 4 (buckets may merge)
    expect(lit).toBe(want.length);
  });

  test("SharedExpertsAlwaysLit", () => {
    const { sim } = pulseScenario("deepseek-chat", 0.36);
    const f = renderViz(90, 30, sim, PAL, OPTS);
    const L = layout(90, 30, sim.arch);
    if (L.mode !== "full") throw new Error("expected full");
    const slots = expertSlots(sim.arch, L.experts);
    const i = slots.ys[0] * f.w + L.experts.x;
    expect(f.ch[i]).toBe("◈");
    expect(PAL.hex).toContain(f.fg[i]);
  });

  test("DenseColumnUniform", () => {
    const { sim } = pulseScenario("llama-3.1-70b", 0.36);
    const f = renderViz(90, 30, sim, PAL, OPTS);
    const L = layout(90, 30, sim.arch);
    if (L.mode !== "full") throw new Error("expected full");
    const cells = expertSlots(sim.arch, L.experts).ys.map((y) => y * f.w + L.experts.x);
    expect(new Set(cells.map((i) => f.ch[i]))).toEqual(new Set(["┃"]));
    expect(new Set(cells.map((i) => f.fg[i])).size).toBe(1);
  });

  test("UnknownShowsLabel", () => {
    const { sim } = pulseScenario("claude-sonnet-4-5", 0.5);
    expect(rowText(renderViz(90, 30, sim, PAL, OPTS), 29)).toContain("architecture unknown");
    expect(rowText(renderViz(40, 14, sim, PAL, OPTS), 13)).toContain("arch unknown");
    expect(renderViz(90, 30, sim, PAL, OPTS).toText()).toContain("L ?");
  });

  test("HonestySegmentNeverDropped", () => {
    for (const id of ["gpt-oss-120b", "llama-3.1-70b", "claude-x"]) {
      const { sim } = pulseScenario(id, 0.5);
      sim.tools.set("c", { tool: "a-very-long-tool-name-indeed", startTick: 0 });
      for (let w = 34; w <= 220; w += 7) {
        for (let h = 10; h <= 70; h += 9) {
          const f = renderViz(w, h, sim, PAL, OPTS);
          const bottom = rowText(f, h - 1);
          if (!/illustrative|unknown/.test(bottom)) throw new Error(`${id} ${w}x${h}: no honesty label: ${bottom}`);
        }
      }
    }
  });

  test("HudModelInTopBorder", () => {
    const { sim } = pulseScenario("qwen/qwen3-235b-a22b", 0.5);
    expect(rowText(renderViz(90, 30, sim, PAL, OPTS), 0)).toContain("qwen3-235b-a22b · MoE 128e/8a · 94L");
    expect(rowText(renderViz(40, 14, sim, PAL, OPTS), 0)).toContain("qwen3-235b");
  });

  test("ContextGridMatchesUsage", () => {
    const sigs: Signal[] = [
      { t: "model", ts: 0, model: { providerID: "p", modelID: "claude", contextLimit: 200000 } },
      { t: "step.end", ts: 10, usage: usage({ input: 25000, cacheRead: 50000 }) },
    ];
    const f = renderViz(90, 30, simAt(sigs, 5), PAL, OPTS);
    const L = layout(90, 30, simAt(sigs, 5).arch);
    if (L.mode !== "full") throw new Error("expected full");
    let cached = 0, fresh = 0;
    for (let y = L.grid.y; y < L.grid.y + L.grid.h; y++) {
      for (let x = L.grid.x; x < L.grid.x + L.grid.w; x++) {
        const c = f.ch[y * f.w + x];
        if (c === "▓") cached++;
        if (c === "▒") fresh++;
      }
    }
    const cells = L.grid.w * L.grid.h;
    const tpc = Math.ceil(200000 / cells);
    expect(Math.abs(cached - 50000 / tpc)).toBeLessThanOrEqual(1);
    expect(Math.abs(fresh - 25000 / tpc)).toBeLessThanOrEqual(1);
  });

  test("CometLandsThenCellAppears", () => {
    const sigs: Signal[] = [
      { t: "model", ts: 0, model: { providerID: "p", modelID: "gpt-oss-120b", contextLimit: 1000 } },
      { t: "step.end", ts: 10, usage: usage({ input: 100 }) },
      { t: "step.start", ts: 100 },
      { t: "delta", ts: 400, kind: "text", chars: 400 }, // 100 tokens → several cells at 1000/limit
    ];
    const first = simAt(sigs, 15).pulses[0];
    const before = renderViz(90, 30, simAt(sigs, first.bornTick + Math.floor(first.sweepTicks * 0.5)), PAL, OPTS);
    const after = renderViz(90, 30, simAt(sigs, first.bornTick + first.sweepTicks + 1), PAL, OPTS);
    const count = (f: Frame) => f.ch.filter((c, i) => c === "█" && f.fg[i] !== DEFAULT).length;
    expect(count(after)).toBeGreaterThan(count(before));
  });
});

describe("golden frames", () => {
  // Committed dumps from `capture` (eyeballed before committing). Regenerate deliberately with UPDATE_GOLDEN=1.
  const dir = join(import.meta.dir, "golden");
  const cases: [string, number, number][] = [["agentic", 90, 30], ["moe-chat", 40, 14], ["closed", 62, 19]];
  for (const [script, w, h] of cases) {
    test(`GoldenFrames ${script} ${w}x${h}`, () => {
      const file = join(dir, `${script}-${w}x${h}.txt`);
      let out = "";
      for (const { tick, frame } of play(demoSignals(script as any), { w, h, pal: PAL, viz: OPTS, every: 45 })) {
        out += `── tick ${tick} ──\n${frame.toText()}\n`;
      }
      if (process.env.UPDATE_GOLDEN || !existsSync(file)) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(file, out);
      }
      expect(out).toBe(readFileSync(file, "utf8"));
    });
  }
  test("golden dir is non-empty", () => {
    expect(readdirSync(dir).length).toBeGreaterThanOrEqual(3);
  });
});

describe("live recording replay", () => {
  test("LiveRecordingReplays (OpenCode + llama.cpp, recorded 2026-10-12)", async () => {
    const { parseNdjsonLine } = await import("../src/adapters/ndjson.ts");
    const sigs = readFileSync(join(import.meta.dir, "fixtures", "live-qwen-tool.ndjson"), "utf8")
      .split("\n").map(parseNdjsonLine).filter((s): s is Signal => !!s);
    expect(sigs.length).toBeGreaterThan(50);
    const t0 = sigs[0].ts;
    const rel = sigs.map((s) => ({ ...s, ts: s.ts - t0 }));
    const phases = new Set<string>();
    let sawTool = false;
    let last: SimState | undefined;
    for (const { sim, frame } of play(rel, { w: 90, h: 30, pal: PAL, viz: OPTS, every: 3 })) {
      phases.add(sim.phase);
      if (frame.toText().includes("⚙ bash")) sawTool = true;
      last = sim;
    }
    expect([...phases].sort()).toEqual(["decode", "idle", "prefill", "tool"]);
    expect(sawTool).toBe(true);
    expect(last!.model?.modelID).toBe("qwen3.6-35b-a3b-uncensored");
    expect(last!.contextLimit).toBe(131072);
    expect(last!.promptTokens).toBe(21 + 14848); // last step: input + cacheRead
    expect(last!.phase).toBe("idle");
  });
});
