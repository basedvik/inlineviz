// Claude Code adapter. The hook sequence mirrors a real probe session (Claude Code 2.1.283,
// 2026-10-13): one general-purpose subagent + one Bash call in parallel, the subagent's own
// tool events, internal helper agents (agent_type ""), and a self-started follow-up turn.

import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeAdapter, type HookRecord, claudeContextLimit, usageFromAnthropic } from "../src/adapters/claude.ts";
import { followClaude } from "../src/adapters/claude-tail.ts";
import type { Signal } from "../src/core/protocol.ts";
import { Driver } from "../src/core/sim/driver.ts";
import { TICK_MS, createSim } from "../src/core/sim/sim.ts";
import { DEFAULT_PALETTE as PAL } from "../src/core/palette.ts";
import { DEFAULT_VIZ_OPTS as OPTS, renderViz } from "../src/core/render/viz.ts";

const S = "5ebda852-2bf4-4908-a445-4ddbe99adea5";
const TP = "/Users/x/.claude/projects/p/" + S + ".jsonl";
const SUB = "a47113dc2b2a48c08";

const PROBE: HookRecord[] = [
  { t: 1, e: "SessionStart", sid: S, tp: TP, model: "claude-haiku-4-5-20251001" },
  { t: 2, e: "UserPromptSubmit", sid: S, tp: TP },
  { t: 3, e: "PreToolUse", sid: S, tp: TP, tool: "Agent", id: "toolu_A" },
  { t: 4, e: "SubagentStart", sid: S, tp: TP, aid: SUB, at: "general-purpose" },
  { t: 5, e: "PostToolUse", sid: S, tp: TP, tool: "Agent", id: "toolu_A" },
  { t: 6, e: "PreToolUse", sid: S, tp: TP, tool: "Bash", id: "toolu_B" },
  { t: 7, e: "PostToolUse", sid: S, tp: TP, tool: "Bash", id: "toolu_B" },
  { t: 8, e: "PostToolBatch", sid: S, tp: TP },
  { t: 9, e: "PreToolUse", sid: S, tp: TP, aid: SUB, at: "general-purpose", tool: "Bash", id: "toolu_C" },
  { t: 10, e: "PostToolUse", sid: S, tp: TP, aid: SUB, at: "general-purpose", tool: "Bash", id: "toolu_C" },
  { t: 11, e: "PostToolBatch", sid: S, tp: TP, aid: SUB, at: "general-purpose" },
  { t: 12, e: "MessageDisplay", sid: S, tp: TP },
  { t: 13, e: "Stop", sid: S, tp: TP },
  { t: 14, e: "SubagentStop", sid: S, tp: TP, aid: SUB, at: "general-purpose" },
  { t: 15, e: "UserPromptSubmit", sid: S, tp: TP }, // Claude starting a turn on its own (subagent result)
  { t: 16, e: "Stop", sid: S, tp: TP },
  { t: 17, e: "SubagentStop", sid: S, tp: TP, aid: "a5957905f32d84d65", at: "" }, // internal helper: never started
];

function run(records: HookRecord[], deps: { sessionID?: string } = {}) {
  const out: Signal[] = [];
  let t = 0;
  const a = new ClaudeAdapter((s) => out.push(s), { now: () => ++t, ...deps });
  for (const r of records) a.handleHook(r);
  return { out, a };
}

const types = (sigs: Signal[]) => sigs.map((s) => (s.t === "subagents" ? `subagents:${s.busy}` : s.t));

describe("Claude Code hook mapping (real probe sequence)", () => {
  test("ProbeSessionSignalSequence", () => {
    expect(types(run(PROBE).out)).toEqual([
      "reset", "mode", "model",
      "turn.start", "step.start",
      "tool.start", "subagents:1", "tool.end",
      "tool.start", "tool.end",
      "step.start", // PostToolBatch (main): model re-reads results
      // subagent's own tool events and batch: not in the main view
      "idle", // Stop
      "subagents:0",
      "turn.start", "step.start", "idle", // self-started follow-up turn
      // helper agent with agent_type "" never started → ignored
    ]);
  });

  test("ModeIsNonStreamingAndModelHasNoAssumedLimit", () => {
    const { out } = run(PROBE);
    expect(out.find((s) => s.t === "mode")).toMatchObject({ streaming: false });
    expect(out.find((s) => s.t === "model")).toMatchObject({ model: { providerID: "anthropic", modelID: "claude-haiku-4-5-20251001", contextLimit: undefined } });
    expect(claudeContextLimit("claude-opus-5-5[1m]")).toBe(1_000_000);
  });

  test("ToolCallIdsAndNamesComeThrough", () => {
    const starts = run(PROBE).out.filter((s) => s.t === "tool.start") as Extract<Signal, { t: "tool.start" }>[];
    expect(starts.map((s) => [s.callID, s.tool])).toEqual([["toolu_A", "Agent"], ["toolu_B", "Bash"]]);
  });

  test("FailuresAndErrors", () => {
    const { out } = run([
      { t: 1, e: "UserPromptSubmit", sid: S },
      { t: 2, e: "PreToolUse", sid: S, tool: "Bash", id: "x" },
      { t: 3, e: "PostToolUseFailure", sid: S, tool: "Bash", id: "x" },
      { t: 4, e: "StopFailure", sid: S, err: "rate_limit" },
    ]);
    expect(out.find((s) => s.t === "tool.end")).toMatchObject({ ok: false });
    expect(out.find((s) => s.t === "error")).toMatchObject({ message: "rate_limit" });
  });

  test("FollowsTheNewestActiveSession; a pinned session ignores others", () => {
    const other = "other-session";
    const { a } = run([...PROBE, { t: 20, e: "UserPromptSubmit", sid: other }]);
    expect(a.session).toBe(other);
    const pinned = run([...PROBE, { t: 20, e: "UserPromptSubmit", sid: other }], { sessionID: S });
    expect(pinned.a.session).toBe(S);
  });
});

describe("Claude Code transcript usage", () => {
  const usage = { input_tokens: 2, cache_creation_input_tokens: 21307, cache_read_input_tokens: 24925, output_tokens: 955, output_tokens_details: { thinking_tokens: 323 } };
  const block = (type: string, id = "msg_1") => ({ type: "assistant", isSidechain: false, message: { id, model: "claude-opus-5-5", stop_reason: "end_turn", usage, content: [{ type }] } });

  test("usageFromAnthropic splits thinking from visible output (input excludes cache)", () => {
    expect(usageFromAnthropic(usage)).toEqual({ input: 2, cacheRead: 24925, cacheWrite: 21307, output: 632, reasoning: 323 });
    expect(usageFromAnthropic(null)).toBeUndefined();
  });

  test("OneStepEndPerMessageDespiteRepeatedBlocks; sidechains ignored", () => {
    const out: Signal[] = [];
    const a = new ClaudeAdapter((s) => out.push(s), { now: () => 0 });
    a.handleTranscript(block("thinking"));
    a.handleTranscript(block("text"));
    a.handleTranscript({ ...block("text", "msg_side"), isSidechain: true });
    a.handleTranscript({ type: "user", message: {} });
    expect(out.filter((s) => s.t === "step.end").length).toBe(1);
    expect(out.find((s) => s.t === "step.end")).toMatchObject({ usage: { reasoning: 323, output: 632 }, finish: "end_turn" });
  });

  test("SeedFoldsHistoryIntoContextWithoutAnimating", () => {
    const out: Signal[] = [];
    const a = new ClaudeAdapter((s) => out.push(s), { now: () => 0 });
    a.seedFromTranscript([block("thinking"), block("text")]);
    expect(out.find((s) => s.t === "step.end")).toMatchObject({ usage: { input: 2 + 955, output: 0, reasoning: 0, cacheRead: 24925 } });
    a.handleTranscript(block("text")); // already seen → no duplicate
    expect(out.filter((s) => s.t === "step.end").length).toBe(1);
  });
});

describe("followClaude (files on disk) → Sim → frame", () => {
  test("FollowsEventsAndTranscriptLive", async () => {
    const dir = mkdtempSync(join(tmpdir(), "inlineviz-cc-"));
    const events = join(dir, "events.ndjson");
    const tp = join(dir, "session.jsonl");
    writeFileSync(tp, "");
    writeFileSync(events, JSON.stringify({ t: Date.now(), e: "SessionStart", sid: "s1", tp, model: "claude-opus-5-5" }) + "\n");

    const sim = createSim("cc");
    const d = new Driver(sim, { maxCatchUp: 1e9 });
    const f = followClaude({ events, push: (s) => d.push(s), now: Date.now, pollMs: 10 });
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    try {
      appendFileSync(events, JSON.stringify({ t: Date.now(), e: "UserPromptSubmit", sid: "s1", tp }) + "\n");
      await wait(900); // > EST_PREFILL_TICKS: Claude is "working"
      d.advanceTo(Date.now());
      expect(sim.model?.modelID).toBe("claude-opus-5-5");
      expect(sim.streaming).toBe(false);
      expect(sim.estimating).toBe(true);
      expect(renderViz(100, 30, sim, PAL, OPTS).toText()).toContain("WORKING");

      appendFileSync(tp, JSON.stringify({ type: "assistant", message: { id: "m1", model: "claude-opus-5-5", usage: { input_tokens: 5, cache_read_input_tokens: 40000, output_tokens: 300, output_tokens_details: { thinking_tokens: 100 } } } }) + "\n");
      appendFileSync(events, JSON.stringify({ t: Date.now(), e: "Stop", sid: "s1", tp }) + "\n");
      await wait(120);
      d.advanceTo(Date.now() + TICK_MS);
      expect(sim.genTotal).toBe(300);
      expect(sim.turnReasoning).toBe(100);
      expect(sim.promptTokens).toBe(40005);
      expect(sim.phase).toBe("idle");
    } finally {
      f.stop();
    }
  });
});

describe("followClaude first run", () => {
  test("ViewerStartedBeforeThePluginEverRan picks up the events file when it appears", async () => {
    const { mkdirSync } = await import("node:fs");
    const home = mkdtempSync(join(tmpdir(), "inlineviz-home-"));
    const prevData = process.env.CLAUDE_PLUGIN_DATA;
    delete process.env.CLAUDE_PLUGIN_DATA;
    const out: Signal[] = [];
    const f = followClaude({ push: (s) => out.push(s), now: Date.now, pollMs: 10, home });
    try {
      expect(f.eventsPath).toContain(join(home, ".claude", "inlineviz"));
      // The plugin runs for the first time: its data folder and events file appear.
      const dataDir = join(home, ".claude", "plugins", "data", "inlineviz-inlineviz");
      mkdirSync(dataDir, { recursive: true });
      const ev = join(dataDir, "events.ndjson");
      writeFileSync(ev, JSON.stringify({ t: Date.now(), e: "SessionStart", sid: "s9", model: "claude-opus-5-5" }) + "\n");
      appendFileSync(ev, JSON.stringify({ t: Date.now(), e: "UserPromptSubmit", sid: "s9" }) + "\n");
      await new Promise((r) => setTimeout(r, 400));
      expect(f.eventsPath).toBe(ev);
      expect(out.some((s) => s.t === "model" && s.model.modelID === "claude-opus-5-5")).toBe(true);
      expect(out.some((s) => s.t === "turn.start")).toBe(true);
    } finally {
      f.stop();
      if (prevData !== undefined) process.env.CLAUDE_PLUGIN_DATA = prevData;
    }
  });
});
