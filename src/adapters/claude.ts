// Claude Code hook records + transcript entries → Signals. Pure (no I/O).
//
// Data comes from two places, verified against Claude Code 2.1.283:
//   • Hook records written by claude/hook.mjs (compact; never prompts or tool content):
//     { t, e (hook_event_name), sid, tp (transcript_path), aid (agent_id), at (agent_type),
//       tool, id (tool_use_id), model, err }
//   • The session transcript (JSONL). Each content block of an assistant message is its own line;
//     the lines share message.id and repeat the message's FINAL usage, including
//     output_tokens_details.thinking_tokens. So usage is exact per message, but only once the
//     message finishes: Claude Code doesn't stream (MessageDisplay fires once with the whole
//     text). The adapter declares `mode streaming:false` and the Sim estimates pace (≈).
// Events with an agent_id belong to a subagent; the main view only tracks the main agent and
// counts subagents (agent_type "" are internal helpers and never fire SubagentStart).

import type { SignalSink, Usage } from "../core/protocol.ts";

export interface HookRecord {
  t: number;
  e: string;
  sid?: string;
  tp?: string;
  aid?: string;
  at?: string;
  tool?: string;
  id?: string;
  model?: string;
  err?: string;
}

export interface ClaudeDeps {
  now(): number;
  /** Follow only this session (otherwise: the most recently active one). */
  sessionID?: string;
}

/** Map an Anthropic usage block (Claude Code transcript) to Signal usage. */
export function usageFromAnthropic(u: any): Usage | undefined {
  if (!u || typeof u !== "object") return undefined;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  const out = n(u.output_tokens);
  const thinking = Math.min(out, n(u.output_tokens_details?.thinking_tokens));
  return {
    input: n(u.input_tokens),
    cacheRead: n(u.cache_read_input_tokens),
    cacheWrite: n(u.cache_creation_input_tokens),
    output: out - thinking,
    reasoning: thinking,
  };
}

export class ClaudeAdapter {
  private current: string | undefined;
  private readonly models = new Map<string, string>();
  private readonly transcripts = new Map<string, string>();
  private readonly seenMessages = new Set<string>();
  private readonly liveAgents = new Set<string>();
  private lastModel: string | undefined;

  constructor(private readonly sink: SignalSink, private readonly deps: ClaudeDeps) {}

  get session(): string | undefined {
    return this.current;
  }

  /** Transcript path of the followed session, once known. */
  get transcriptPath(): string | undefined {
    return this.current ? this.transcripts.get(this.current) : undefined;
  }

  /** Remember session facts without emitting anything (used to bootstrap from history). */
  learn(r: HookRecord): void {
    if (!r.sid) return;
    if (r.tp) this.transcripts.set(r.sid, r.tp);
    if (r.model) this.models.set(r.sid, r.model);
  }

  /** Focus a session explicitly (bootstrap). Emits reset + mode + model. */
  focus(sid: string): void {
    if (sid === this.current) return;
    this.current = sid;
    this.lastModel = undefined;
    this.liveAgents.clear();
    const ts = this.deps.now();
    this.sink({ t: "reset", ts, sessionKey: sid });
    this.sink({ t: "mode", ts, streaming: false });
    const m = this.models.get(sid);
    if (m) this.emitModel(m);
  }

  handleHook(r: HookRecord): void {
    if (!r || typeof r.e !== "string" || !r.sid) return;
    this.learn(r);
    const pinned = this.deps.sessionID;
    if (pinned && r.sid !== pinned) return;
    if (pinned && this.current !== pinned) this.focus(pinned);
    // Follow the most recently active session: a new prompt or session start moves focus.
    if (!pinned && r.sid !== this.current && (r.e === "UserPromptSubmit" || r.e === "SessionStart" || !this.current)) this.focus(r.sid);
    if (r.sid !== this.current) return;

    const ts = this.deps.now();
    const main = !r.aid;
    switch (r.e) {
      case "SessionStart":
      case "PostModelSwitch":
        if (r.model) this.emitModel(r.model);
        return;
      case "UserPromptSubmit":
        if (!main) return;
        this.sink({ t: "turn.start", ts });
        this.sink({ t: "step.start", ts });
        return;
      case "PreToolUse":
        if (main && r.id) this.sink({ t: "tool.start", ts, callID: r.id, tool: r.tool ?? "tool" });
        return;
      case "PostToolUse":
      case "PostToolUseFailure":
        if (main && r.id) this.sink({ t: "tool.end", ts, callID: r.id, ok: r.e === "PostToolUse" });
        return;
      case "PostToolBatch":
        // Every parallel tool finished: the model is about to read the results.
        if (main) this.sink({ t: "step.start", ts });
        return;
      case "SubagentStart":
        if (r.aid && r.at) {
          this.liveAgents.add(r.aid);
          this.sink({ t: "subagents", ts, busy: this.liveAgents.size });
        }
        return;
      case "SubagentStop":
        if (r.aid && this.liveAgents.delete(r.aid)) this.sink({ t: "subagents", ts, busy: this.liveAgents.size });
        return;
      case "Stop":
        if (main) this.sink({ t: "idle", ts });
        return;
      case "StopFailure":
        if (main) this.sink({ t: "error", ts, message: r.err });
        return;
      case "SessionEnd":
        this.sink({ t: "idle", ts });
        return;
    }
  }

  /** One parsed transcript line of the followed session. */
  handleTranscript(entry: any): void {
    if (!entry || entry.type !== "assistant" || entry.isSidechain) return;
    const m = entry.message;
    if (!m || typeof m.id !== "string") return;
    if (typeof m.model === "string" && !m.model.startsWith("<")) this.emitModel(m.model);
    if (this.seenMessages.has(m.id)) return; // blocks of one message repeat the same final usage
    this.seenMessages.add(m.id);
    if (this.seenMessages.size > 5000) this.seenMessages.clear();
    const usage = usageFromAnthropic(m.usage);
    if (usage) this.sink({ t: "step.end", ts: this.deps.now(), usage, finish: typeof m.stop_reason === "string" ? m.stop_reason : undefined });
  }

  /**
   * Seed context from the last assistant message already in the transcript (history), without
   * animating it: its output is part of the context now, so it's folded into the prompt.
   */
  seedFromTranscript(entries: any[]): void {
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e?.type !== "assistant" || e.isSidechain || !e.message?.usage) continue;
      if (typeof e.message.id === "string") this.seenMessages.add(e.message.id);
      if (typeof e.message.model === "string" && !e.message.model.startsWith("<")) this.emitModel(e.message.model);
      const u = usageFromAnthropic(e.message.usage)!;
      this.sink({
        t: "step.end",
        ts: this.deps.now(),
        usage: { input: u.input + u.output + u.reasoning, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, output: 0, reasoning: 0 },
      });
      for (const x of entries) if (x?.type === "assistant" && typeof x.message?.id === "string") this.seenMessages.add(x.message.id);
      return;
    }
  }

  private emitModel(model: string): void {
    if (model === this.lastModel) return;
    this.lastModel = model;
    this.sink({ t: "model", ts: this.deps.now(), model: { providerID: "anthropic", modelID: model, contextLimit: claudeContextLimit(model) } });
  }
}

/**
 * Claude Code's `[1m]` model suffix marks the 1M-token context window. Otherwise the window isn't
 * reported anywhere we can read, so it's left unknown and the HUD shows "~200k" (approximate).
 */
export function claudeContextLimit(model: string): number | undefined {
  return /\[1m\]/i.test(model) ? 1_000_000 : undefined;
}
