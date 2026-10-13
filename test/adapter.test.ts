import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type OpenCodeEvent, OpenCodeAdapter, usageFromTokens } from "../src/adapters/opencode.ts";
import type { Signal } from "../src/core/protocol.ts";
import { Driver } from "../src/core/sim/driver.ts";
import { createSim, promptTokens } from "../src/core/sim/sim.ts";

const fixture = (name: string): OpenCodeEvent[] =>
  JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "opencode", name), "utf8"));

function runAdapter(events: OpenCodeEvent[], active: () => string | undefined = () => "ses_1", limit = 200000) {
  const out: Signal[] = [];
  let t = 1000;
  const a = new OpenCodeAdapter((s) => out.push(s), { activeSessionID: active, contextLimit: () => limit, now: () => (t += 10) });
  for (const e of events) a.handle(e);
  return { out, a };
}

const types = (sigs: Signal[]) => sigs.map((s) => s.t);

describe("opencode adapter", () => {
  test("BasicTurnSignalSequence", () => {
    const { out } = runAdapter(fixture("basic-turn.json"));
    expect(types(out)).toEqual([
      "subagents", "reset", "turn.start", "model", "step.start",
      "delta", "delta", "delta", "tool.start", "tool.end", "step.end", "idle", "idle",
    ]);
  });

  test("ReasoningDeltaUsesPartKind / TextDeltaToSignal", () => {
    const { out } = runAdapter(fixture("basic-turn.json"));
    const deltas = out.filter((s) => s.t === "delta") as Extract<Signal, { t: "delta" }>[];
    expect(deltas.map((d) => [d.kind, d.chars])).toEqual([["reasoning", 12], ["text", 11], ["text", 1]]);
  });

  test("UserMessageDeltasIgnored", () => {
    const { out } = runAdapter(fixture("basic-turn.json"));
    const total = out.filter((s) => s.t === "delta").reduce((n, s) => n + (s as any).chars, 0);
    expect(total).toBe(24); // 12 + 11 + 1; the user prompt and the late user delta are not counted
  });

  test("UnknownPartDefaultsText", () => {
    const { out } = runAdapter([
      { type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } },
      { type: "message.part.delta", properties: { sessionID: "ses_1", messageID: "m", partID: "never-seen", field: "text", delta: "abc" } },
    ]);
    expect(out.at(-1)).toMatchObject({ t: "delta", kind: "text", chars: 3 });
  });

  test("StepFinishToUsage", () => {
    const { out } = runAdapter(fixture("basic-turn.json"));
    const end = out.find((s) => s.t === "step.end") as Extract<Signal, { t: "step.end" }>;
    expect(end.usage).toEqual({ input: 100, output: 50, reasoning: 10, cacheRead: 1000, cacheWrite: 0 });
    expect(end.finish).toBe("tool-calls");
  });

  test("PromptTokensMatchOpenCodeNormalization", () => {
    // OpenCode stores input = inputTokens − cacheRead − cacheWrite (verified in its bundled source),
    // so the prompt is input + cacheRead + cacheWrite for every provider.
    const u = usageFromTokens({ input: 100, output: 50, reasoning: 10, cache: { read: 1000, write: 20 } })!;
    expect(promptTokens(u)).toBe(1120);
    expect(usageFromTokens({ input: NaN as any })).toEqual({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 });
  });

  test("ToolLifecycleDeduped", () => {
    const { out } = runAdapter(fixture("basic-turn.json"));
    expect(out.filter((s) => s.t === "tool.start").length).toBe(1);
    expect(out.filter((s) => s.t === "tool.end").length).toBe(1);
    expect(out.find((s) => s.t === "tool.start")).toMatchObject({ callID: "call_1", tool: "bash" });
  });

  test("ModelSignalWithContextLimit", () => {
    const { out } = runAdapter(fixture("basic-turn.json"), () => "ses_1", 123456);
    const models = out.filter((s) => s.t === "model");
    expect(models.length).toBe(1); // the completed-message update doesn't re-emit
    expect(models[0]).toMatchObject({ model: { providerID: "anthropic", modelID: "claude-sonnet-4-5", contextLimit: 123456 } });
  });

  test("OtherSessionsOnlyCountSubagents", () => {
    const { out } = runAdapter([
      { type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } },
      { type: "session.status", properties: { sessionID: "ses_sub", status: { type: "busy" } } },
      { type: "message.part.delta", properties: { sessionID: "ses_sub", messageID: "x", partID: "y", field: "text", delta: "subagent text" } },
      { type: "session.status", properties: { sessionID: "ses_sub", status: { type: "idle" } } },
    ]);
    expect(out.filter((s) => s.t === "delta").length).toBe(0);
    expect(out.filter((s) => s.t === "subagents").map((s: any) => s.busy)).toEqual([0, 1, 0]);
  });

  test("SessionSwitchEmitsReset", () => {
    let active = "ses_1";
    const out: Signal[] = [];
    const a = new OpenCodeAdapter((s) => out.push(s), { activeSessionID: () => active, contextLimit: () => undefined, now: () => 0 });
    a.handle({ type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } });
    active = "ses_2";
    a.handle({ type: "session.status", properties: { sessionID: "ses_2", status: { type: "busy" } } });
    expect(out.filter((s) => s.t === "reset").map((s: any) => s.sessionKey)).toEqual(["ses_1", "ses_2"]);
  });

  test("FollowsMostRecentBusyWithoutActiveRoute", () => {
    const { out, a } = runAdapter(
      [
        { type: "session.status", properties: { sessionID: "ses_9", status: { type: "busy" } } },
        { type: "message.part.delta", properties: { sessionID: "ses_9", messageID: "m", partID: "p", field: "text", delta: "hi" } },
      ],
      () => undefined,
    );
    expect(a.session).toBe("ses_9");
    expect(out.some((s) => s.t === "delta")).toBe(true);
  });

  test("NextPathSuppressesV1Deltas", () => {
    const { out } = runAdapter([
      { type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } },
      { type: "session.next.text.delta", properties: { sessionID: "ses_1", delta: "abcd" } },
      { type: "message.part.delta", properties: { sessionID: "ses_1", messageID: "m", partID: "p", field: "text", delta: "abcd" } },
      { type: "session.next.reasoning.delta", properties: { sessionID: "ses_1", delta: "xy" } },
    ]);
    const d = out.filter((s) => s.t === "delta") as any[];
    expect(d.map((x) => [x.kind, x.chars])).toEqual([["text", 4], ["reasoning", 2]]);
  });

  test("RetryAndErrorMapped", () => {
    const { out } = runAdapter([
      { type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } },
      { type: "session.status", properties: { sessionID: "ses_1", status: { type: "retry", attempt: 2, message: "overloaded", next: 0 } } },
      { type: "session.error", properties: { sessionID: "ses_1", error: { name: "APIError", data: { message: "boom" } } } },
    ]);
    expect(out.find((s) => s.t === "retry")).toMatchObject({ attempt: 2 });
    expect(out.find((s) => s.t === "error")).toMatchObject({ message: "boom" });
  });

  test("AdapterDrivesSimEndToEnd", () => {
    const sim = createSim();
    const d = new Driver(sim, { t0: 0, maxCatchUp: 1e9 });
    let t = 0;
    const a = new OpenCodeAdapter((s) => d.push(s), { activeSessionID: () => "ses_1", contextLimit: () => 200000, now: () => (t += 100) });
    for (const e of fixture("basic-turn.json")) a.handle(e);
    d.advanceTo(t + 5000);
    expect(sim.model?.modelID).toBe("claude-sonnet-4-5");
    expect(sim.contextLimit).toBe(200000);
    expect(sim.promptTokens).toBe(1100);
    expect(sim.phase).toBe("idle");
  });
});
