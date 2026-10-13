import { describe, expect, test } from "bun:test";
import type { Signal, SignalBody, Usage } from "../src/core/protocol.ts";
import { Driver } from "../src/core/sim/driver.ts";
import {
  IDLE_TIMEOUT_TICKS, TICK_MS, applySignal, contextView, createSim, step,
} from "../src/core/sim/sim.ts";

const usage = (o: Partial<Usage> = {}): Usage => ({ input: 1000, output: 100, reasoning: 0, cacheRead: 0, cacheWrite: 0, ...o });
const at = (tick: number) => tick * TICK_MS;

/** Drive a Sim through `[tick, signal]` pairs on a virtual clock up to `until`. */
function run(events: [number, SignalBody][], until: number) {
  const sim = createSim("test");
  const d = new Driver(sim, { t0: 0 });
  for (const [tick, s] of events) d.push({ ...s, ts: at(tick) } as Signal);
  for (let t = 0; t <= until; t++) d.advanceTo(at(t));
  return sim;
}

describe("sim phases", () => {
  test("IdleToPrefillOnTurnStart", () => {
    const s = run([[5, { t: "turn.start" }]], 6);
    expect(s.phase).toBe("prefill");
    expect(s.prefillTick).toBe(5);
  });

  test("PrefillToDecodeOnFirstDelta", () => {
    const s = run([[0, { t: "turn.start" }], [1, { t: "step.start" }], [40, { t: "delta", kind: "text", chars: 20 }]], 41);
    expect(s.phase).toBe("decode");
  });

  test("TtftTicksMeasured", () => {
    const s = run([[10, { t: "step.start" }], [55, { t: "delta", kind: "reasoning", chars: 8 }]], 60);
    expect(s.ttftTicks).toBe(45);
    expect(s.stream).toBe("reasoning");
  });

  test("DecodeToToolOnToolStart", () => {
    const s = run([[0, { t: "step.start" }], [3, { t: "delta", kind: "text", chars: 40 }], [6, { t: "tool.start", callID: "a", tool: "bash" }]], 7);
    expect(s.phase).toBe("tool");
    expect(s.tools.get("a")?.tool).toBe("bash");
  });

  test("ConcurrentToolsStayInTool", () => {
    const s = run([
      [0, { t: "step.start" }],
      [2, { t: "tool.start", callID: "a", tool: "read" }],
      [2, { t: "tool.start", callID: "b", tool: "grep" }],
      [5, { t: "tool.end", callID: "a", ok: true }],
    ], 6);
    expect(s.phase).toBe("tool");
    expect(s.tools.size).toBe(1);
  });

  test("ToolToPrefillWhenAllToolsEnd", () => {
    const s = run([
      [0, { t: "step.start" }],
      [2, { t: "tool.start", callID: "a", tool: "read" }],
      [9, { t: "tool.end", callID: "a", ok: true }],
    ], 10);
    expect(s.phase).toBe("prefill");
    expect(s.prefillTick).toBe(9);
  });

  test("IdleTimeoutAfterStepEnd", () => {
    const s = run([[0, { t: "step.start" }], [2, { t: "delta", kind: "text", chars: 8 }], [4, { t: "step.end" }]], 4 + IDLE_TIMEOUT_TICKS + 2);
    expect(s.phase).toBe("idle");
  });

  test("NoIdleTimeoutWhileToolRuns", () => {
    const s = run([[0, { t: "step.start" }], [2, { t: "tool.start", callID: "a", tool: "bash" }], [4, { t: "step.end" }]], 300);
    expect(s.phase).toBe("tool");
  });

  test("ErrorFlashThenIdle", () => {
    const s1 = run([[0, { t: "step.start" }], [5, { t: "error", message: "x" }]], 6);
    expect(s1.phase).toBe("error");
    expect(s1.flashes.some((f) => f.kind === "error")).toBe(true);
    const s2 = run([[0, { t: "step.start" }], [5, { t: "error" }]], 50);
    expect(s2.phase).toBe("idle");
  });

  test("RetryUntilNextStep", () => {
    const s1 = run([[0, { t: "step.start" }], [3, { t: "step.end" }], [4, { t: "retry", attempt: 2 }]], 5);
    expect(s1.phase).toBe("retry");
    expect(s1.retryAttempt).toBe(2);
    const s2 = run([[0, { t: "step.start" }], [3, { t: "step.end" }], [4, { t: "retry", attempt: 2 }], [9, { t: "step.start" }]], 10);
    expect(s2.phase).toBe("prefill");
  });

  test("ToolFailFlashes", () => {
    const s = run([[0, { t: "step.start" }], [1, { t: "tool.start", callID: "a", tool: "bash" }], [3, { t: "tool.end", callID: "a", ok: false }]], 4);
    expect(s.flashes.some((f) => f.kind === "toolFail")).toBe(true);
  });
});

describe("sim data", () => {
  test("DuplicateSignalsIgnored", () => {
    const s = run([
      [0, { t: "step.start" }],
      [1, { t: "step.start" }],
      [2, { t: "tool.start", callID: "a", tool: "x" }],
      [3, { t: "tool.start", callID: "a", tool: "x" }],
    ], 4);
    expect(s.toolsCalled).toBe(1);
    expect(s.stepStartTick).toBe(0);
  });

  test("CalibrationConverges", () => {
    // Estimates say 400 chars/4 = 100 tokens, usage says 150 → factor rises toward 1.5.
    const events: [number, any][] = [];
    let t = 0;
    for (let k = 0; k < 8; k++) {
      events.push([t++, { t: "step.start" }]);
      for (let j = 0; j < 10; j++) events.push([t++, { t: "delta", kind: "text", chars: 40 }]);
      events.push([t++, { t: "step.end", usage: usage({ output: 150 }) }]);
    }
    const s = run(events, t + 1);
    const k = s.calib.get("?")!;
    expect(k).toBeGreaterThan(1.35);
    expect(k).toBeLessThanOrEqual(1.5);
  });

  test("UsageOnlyDegradedPath", () => {
    const s = run([[0, { t: "step.start" }], [60, { t: "step.end", usage: usage({ output: 120 }) }]], 61);
    expect(s.tpsApprox).toBe(true);
    expect(s.tps).toBeCloseTo(60, 0); // 120 tokens over 2 s
    expect(s.phase).toBe("decode");
    const later = run([[0, { t: "step.start" }], [60, { t: "step.end", usage: usage({ output: 120 }) }]], 400);
    expect(later.genTotal).toBeCloseTo(120, 5);
    expect(later.bank).toBe(0);
  });

  test("ResetKeepsCalibration", () => {
    const s = createSim("a");
    s.calib.set("m", 1.3);
    applySignal(s, { t: "turn.start", ts: 0 });
    applySignal(s, { t: "reset", ts: 0, sessionKey: "b" });
    expect(s.sessionKey).toBe("b");
    expect(s.phase).toBe("idle");
    expect(s.calib.get("m")).toBe(1.3);
  });

  test("ModelSignalSetsArchAndLimit", () => {
    const s = run([[0, { t: "model", model: { providerID: "x", modelID: "qwen/qwen3-235b-a22b", contextLimit: 131072 } }]], 1);
    expect(s.arch.kind).toBe("moe");
    expect(s.contextLimit).toBe(131072);
    expect(s.contextApprox).toBe(false);
  });

  test("ContextViewFoldsPreviousTurn", () => {
    const s = run([
      [0, { t: "turn.start" }],
      [1, { t: "step.start" }],
      [2, { t: "delta", kind: "text", chars: 400 }],
      [3, { t: "step.end", usage: usage({ input: 500, cacheRead: 1500, output: 100 }) }],
      [4, { t: "idle" }],
    ], 80);
    const v = contextView(s);
    expect(v.cached).toBe(1500);
    expect(v.fresh).toBe(500);
    expect(v.generated.reduce((a, r) => a + r.tokens, 0)).toBeCloseTo(100, 5);
    applySignal(s, { t: "turn.start", ts: 0 });
    const v2 = contextView(s);
    expect(v2.fresh).toBeCloseTo(600, 5); // the previous output becomes prompt
    expect(v2.generated.length).toBe(0);
  });
});

describe("driver + emitter", () => {
  test("SimDeterministic", () => {
    const ev: [number, any][] = [
      [0, { t: "model", model: { providerID: "p", modelID: "gpt-oss-120b" } }],
      [1, { t: "turn.start" }], [2, { t: "step.start" }],
      ...Array.from({ length: 60 }, (_, i) => [10 + i, { t: "delta", kind: i < 30 ? "reasoning" : "text", chars: 7 + (i % 13) }] as [number, any]),
      [80, { t: "tool.start", callID: "c1", tool: "bash" }], [120, { t: "tool.end", callID: "c1", ok: true }],
      [140, { t: "step.end", usage: usage() }], [150, { t: "idle" }],
    ];
    const a = run(ev, 200);
    const b = run(ev, 200);
    expect(Bun.deepEquals(a, b, true)).toBe(true);
  });

  test("DriverCatchUpClamped", () => {
    const sim = createSim();
    const d = new Driver(sim, { t0: 0 });
    d.advanceTo(0);
    expect(d.advanceTo(5000)).toBe(10);
    expect(sim.tick).toBe(10);
    expect(d.advanceTo(5000 + TICK_MS)).toBe(1);
  });

  test("DriverIdempotentSameNow", () => {
    const sim = createSim();
    const d = new Driver(sim, { t0: 0 });
    d.advanceTo(at(5));
    expect(d.advanceTo(at(5))).toBe(0);
    expect(sim.tick).toBe(5);
  });

  test("SignalAppliedAtItsTick", () => {
    const sim = createSim();
    const d = new Driver(sim, { t0: 0 });
    d.push({ t: "turn.start", ts: at(7) });
    d.advanceTo(at(6));
    expect(sim.phase).toBe("idle");
    d.advanceTo(at(7));
    expect(sim.phase).toBe("prefill");
    expect(sim.prefillTick).toBe(7);
  });

  test("EmitterCapsPulseRate", () => {
    // 300 tok/s for 3 s (1200 chars every tick = 300 tokens per 30 ticks... = 10 tok/tick).
    const ev: [number, any][] = [[0, { t: "step.start" }]];
    for (let t = 1; t <= 90; t++) ev.push([t, { t: "delta", kind: "text", chars: 40 }]);
    const sim = createSim();
    const d = new Driver(sim, { t0: 0 });
    for (const [tick, s] of ev) d.push({ ...s, ts: at(tick) });
    let maxNewPerSecond = 0;
    let lastIndex = 0;
    for (let t = 0; t <= 90; t++) {
      d.advanceTo(at(t));
      if (t % 30 === 0 && t > 0) {
        maxNewPerSecond = Math.max(maxNewPerSecond, sim.nextPulseIndex - lastIndex);
        lastIndex = sim.nextPulseIndex;
      }
    }
    expect(maxNewPerSecond).toBeLessThanOrEqual(10);
    // Bank conserved: generated + bank == delivered estimate.
    expect(sim.genTotal + sim.bank).toBeCloseTo(900, 5);
  });

  test("PulsesExpire", () => {
    const s = run([[0, { t: "step.start" }], [1, { t: "delta", kind: "text", chars: 8 }], [2, { t: "step.end" }]], 100);
    expect(s.pulses.length).toBe(0);
  });

  test("StepWithoutDriverAdvancesTick", () => {
    const s = createSim();
    step(s);
    step(s);
    expect(s.tick).toBe(2);
  });
});
