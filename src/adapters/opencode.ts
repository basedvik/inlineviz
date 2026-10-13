// OpenCode events → Signals (SPEC §11.2). Pure-ish: no I/O, injected clock.
//
// Used by the TUI plugin (api.event.on) and by `opencodeviz attach` (SSE),
// so both hosts share one mapping. Primary path is OpenCode's stable v1
// events (the same ones opencode-tps-meter uses); the experimental
// session.next.* / session.* delta events are feature-detected per session.
//
// Token semantics (verified in OpenCode 1.18.32's bundled source): for every
// provider, OpenCode stores tokens.input = inputTokens − cacheRead − cacheWrite
// and tokens.output = outputTokens − reasoning. So `input` already excludes
// cached tokens, matching Signal.Usage.

import type { SignalSink, Stream, Usage } from "../core/protocol.ts";

export interface OpenCodeDeps {
  /** Session the user is looking at (TUI route), if any. */
  activeSessionID(): string | undefined;
  contextLimit(providerID: string, modelID: string): number | undefined;
  now(): number;
}

export type OpenCodeEvent = { type: string; properties?: any };

/** Event types the adapter understands (api.event.on has no wildcard). */
export const OPENCODE_EVENT_TYPES = [
  "session.status",
  "session.idle",
  "session.error",
  "message.updated",
  "message.part.updated",
  "message.part.delta",
  // Experimental fast path (feature-detected).
  "session.next.text.delta",
  "session.next.reasoning.delta",
  "session.text.delta",
  "session.reasoning.delta",
] as const;

const NEXT_DELTA: Record<string, Stream> = {
  "session.next.text.delta": "text",
  "session.next.reasoning.delta": "reasoning",
  "session.text.delta": "text",
  "session.reasoning.delta": "reasoning",
};

type TokensLike = { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } };

export function usageFromTokens(t: TokensLike | undefined): Usage | undefined {
  if (!t) return undefined;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, v) : 0);
  return { input: n(t.input), output: n(t.output), reasoning: n(t.reasoning), cacheRead: n(t.cache?.read), cacheWrite: n(t.cache?.write) };
}

export class OpenCodeAdapter {
  private current: string | undefined;
  private followed: string | undefined;
  private readonly roles = new Map<string, string>();
  /** Assistant messages still in progress (no time.completed). */
  private readonly live = new Set<string>();
  private readonly partKind = new Map<string, string>();
  /** Characters already counted per part (deltas + full-text updates). */
  private readonly seen = new Map<string, number>();
  private readonly toolStarted = new Set<string>();
  private readonly toolEnded = new Set<string>();
  private readonly busy = new Map<string, boolean>();
  private readonly nextPath = new Set<string>();
  private lastModelKey: string | undefined;
  private lastSubagents = -1;

  constructor(private readonly sink: SignalSink, private readonly deps: OpenCodeDeps) {}

  /** The session currently being visualized. */
  get session(): string | undefined {
    return this.current;
  }

  /** Re-check focus without an event (e.g. the user switched sessions in the TUI). */
  sync(): void {
    this.focus(undefined);
  }

  handle(ev: OpenCodeEvent): void {
    const p = ev.properties ?? {};
    const sid: string | undefined = p.sessionID ?? p.info?.sessionID ?? p.part?.sessionID;
    // Capture before trackBusy updates it: busy → busy is not a new turn.
    const wasBusy = sid ? this.busy.get(sid) ?? false : false;
    if (ev.type === "session.status" && sid) this.trackBusy(sid, p.status?.type === "busy" || p.status?.type === "retry");
    if (ev.type === "session.idle" && sid) this.trackBusy(sid, false);
    if (!this.focus(sid)) return;
    const ts = this.deps.now();

    switch (ev.type) {
      case "session.status": {
        const type = p.status?.type;
        if (type === "busy" && !wasBusy) this.sink({ t: "turn.start", ts });
        else if (type === "retry") this.sink({ t: "retry", ts, attempt: Number(p.status.attempt ?? 1), message: p.status.message });
        else if (type === "idle") this.sink({ t: "idle", ts });
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
        if (!info?.id) return;
        this.roles.set(info.id, info.role);
        if (info.role !== "assistant") return;
        if (info.time?.completed) this.live.delete(info.id);
        else this.live.add(info.id);
        if (info.providerID && info.modelID) {
          const key = `${info.providerID}/${info.modelID}`;
          if (key !== this.lastModelKey) {
            this.lastModelKey = key;
            this.sink({
              t: "model",
              ts,
              model: { providerID: info.providerID, modelID: info.modelID, contextLimit: this.deps.contextLimit(info.providerID, info.modelID) },
            });
          }
        }
        return;
      }
      case "message.part.updated": {
        const part = p.part;
        if (!part?.type) return;
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
            if (part.synthetic || part.ignored) return;
            if (!this.live.has(part.messageID) || this.roles.get(part.messageID) !== "assistant") return;
            if (sid && this.nextPath.has(sid)) return;
            // Some providers update the full text instead of streaming deltas: count the growth.
            const len = typeof part.text === "string" ? part.text.length : 0;
            const before = this.seen.get(part.id) ?? 0;
            if (len > before) {
              this.seen.set(part.id, len);
              this.sink({ t: "delta", ts, kind: part.type, chars: len - before });
            }
            return;
          }
          case "tool": {
            const callID: string = part.callID ?? part.id;
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
        if (p.field !== "text" || typeof p.delta !== "string" || !p.delta.length) return;
        if (this.roles.get(p.messageID) === "user") return;
        if (sid && this.nextPath.has(sid)) return;
        const kind = this.partKind.get(p.partID) === "reasoning" ? "reasoning" : "text";
        this.seen.set(p.partID, (this.seen.get(p.partID) ?? 0) + p.delta.length);
        this.sink({ t: "delta", ts, kind, chars: p.delta.length });
        return;
      }
      default: {
        const kind = NEXT_DELTA[ev.type];
        if (!kind || typeof p.delta !== "string" || !p.delta.length) return;
        if (sid) this.nextPath.add(sid);
        this.sink({ t: "delta", ts, kind, chars: p.delta.length });
      }
    }
  }

  /** Decide which session to follow; emits `reset` on a switch. Returns whether `sid` is the focused one. */
  private focus(sid: string | undefined): boolean {
    const target = this.deps.activeSessionID() ?? this.followed;
    if (target && target !== this.current) {
      this.current = target;
      this.lastModelKey = undefined;
      this.sink({ t: "reset", ts: this.deps.now(), sessionKey: target });
    }
    if (!sid) return false;
    return sid === this.current;
  }

  private trackBusy(sid: string, busy: boolean): void {
    this.busy.set(sid, busy);
    if (busy && !this.deps.activeSessionID()) this.followed = sid;
    let others = 0;
    for (const [id, b] of this.busy) if (b && id !== (this.deps.activeSessionID() ?? this.followed)) others++;
    if (others !== this.lastSubagents) {
      this.lastSubagents = others;
      this.sink({ t: "subagents", ts: this.deps.now(), busy: others });
    }
  }
}

function errorMessage(e: unknown): string | undefined {
  if (!e || typeof e !== "object") return undefined;
  const o = e as Record<string, any>;
  return String(o.data?.message ?? o.message ?? o.name ?? "error");
}
