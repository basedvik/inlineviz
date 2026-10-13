// Signal protocol: the portability contract (SPEC §5).
//
// Every host adapter (OpenCode plugin, NDJSON stdin, SSE attach, future
// proxies) emits these. They are JSON-serializable so the same type flows
// in-process, over NDJSON, in replay files and across sockets. `ts` is epoch ms.

export type ModelRef = {
  providerID: string;
  modelID: string;
  /** Context window in tokens, when the host knows it. */
  contextLimit?: number;
};

export type Usage = {
  /** Non-cached prompt tokens. */
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
};

export type Stream = "text" | "reasoning";

export type Signal =
  | { t: "model"; ts: number; model: ModelRef }
  | { t: "turn.start"; ts: number }
  | { t: "step.start"; ts: number }
  | { t: "delta"; ts: number; kind: Stream; chars: number; tokens?: number }
  | { t: "tool.start"; ts: number; callID: string; tool: string }
  | { t: "tool.end"; ts: number; callID: string; ok: boolean }
  | { t: "step.end"; ts: number; usage?: Usage; finish?: string }
  | { t: "retry"; ts: number; attempt: number; message?: string }
  | { t: "error"; ts: number; message?: string }
  | { t: "idle"; ts: number }
  | { t: "subagents"; ts: number; busy: number }
  | { t: "reset"; ts: number; sessionKey: string };

export type SignalType = Signal["t"];
export type SignalSink = (s: Signal) => void;

const TYPES: ReadonlySet<string> = new Set<SignalType>([
  "model", "turn.start", "step.start", "delta", "tool.start", "tool.end",
  "step.end", "retry", "error", "idle", "subagents", "reset",
]);

/** Loose structural validation for Signals arriving from outside (NDJSON, sockets). */
export function isSignal(v: unknown): v is Signal {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.t !== "string" || !TYPES.has(o.t) || typeof o.ts !== "number" || !Number.isFinite(o.ts)) return false;
  switch (o.t) {
    case "model": {
      const m = o.model as Record<string, unknown> | undefined;
      return !!m && typeof m.providerID === "string" && typeof m.modelID === "string";
    }
    case "delta":
      return (o.kind === "text" || o.kind === "reasoning") && typeof o.chars === "number";
    case "tool.start":
      return typeof o.callID === "string" && typeof o.tool === "string";
    case "tool.end":
      return typeof o.callID === "string" && typeof o.ok === "boolean";
    case "retry":
      return typeof o.attempt === "number";
    case "subagents":
      return typeof o.busy === "number";
    case "reset":
      return typeof o.sessionKey === "string";
    default:
      return true;
  }
}

/** A Signal without its timestamp (distributes over the union). */
export type SignalBody = Signal extends infer S ? (S extends Signal ? Omit<S, "ts"> : never) : never;
