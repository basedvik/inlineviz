// Deterministic simulation (SPEC §7).
//
// SimState only holds *real* data derived from Signals plus the animation
// bookkeeping (pulses, flashes) that the renderer reads. All mutation is
// deterministic: the same initial state and the same sequence of
// (applySignal at tick, step) calls produce identical state. There is no clock
// here; time enters only through Driver (driver.ts), which calls step() once
// per 1/30 s.

import type { ModelRef, Signal, Stream, Usage } from "../protocol.ts";
import { type Arch, UNKNOWN, archFor } from "../registry.ts";
import { type RateWindow, createRate, ratePush, rateTps } from "./rate.ts";

export const TICK_HZ = 30;
export const TICK_MS = 1000 / TICK_HZ;

export type Phase = "idle" | "prefill" | "decode" | "tool" | "retry" | "error";

export const DEFAULT_CONTEXT = 200_000;
export const IDLE_TIMEOUT_TICKS = 90; // 3 s after step.end with nothing running
export const ERROR_TICKS = 36;
export const PULSE_MIN_GAP = 3; // ≤ 10 pulses/s
export const MAX_PULSES = 6;
export const FLASH_TTL = 45;
const CALIB_MIN_EST = 20;

export interface Pulse {
  index: number;
  bornTick: number;
  tokens: number;
  stream: Stream;
  sweepTicks: number;
}

export interface Flash {
  kind: "error" | "toolFail";
  bornTick: number;
}

/** Run-length record of generated tokens this turn, in emission order. */
export interface GenRun {
  stream: Stream;
  tokens: number;
}

export interface SimState {
  tick: number;
  sessionKey: string;
  phase: Phase;
  phaseTick: number;
  stream: Stream;
  model?: ModelRef;
  arch: Arch;
  archOverrides?: Readonly<Record<string, Arch>>;
  contextLimit: number;
  contextApprox: boolean;

  turnTick?: number;
  prefillTick?: number;
  ttftTicks?: number;
  stepOpen: boolean;
  stepStartTick: number;
  stepRawEst: number;
  stepTokens: number;
  stepGenStart: number;
  lastFinish?: string;

  tools: Map<string, { tool: string; startTick: number }>;
  toolsCalled: number;

  usage?: Usage;
  /** Prompt tokens of the latest usage (input + cacheRead + cacheWrite). */
  promptTokens?: number;
  /** Generated-token offset that the latest usage's prompt already excludes. */
  promptGenBase: number;

  generated: GenRun[];
  genTotal: number;
  turnReasoning: number;
  turnText: number;

  bank: number;
  draining: boolean;
  tps: number;
  tpsApprox: boolean;
  lastDeltaTick: number;
  calib: Map<string, number>;

  pulses: Pulse[];
  flashes: Flash[];
  nextPulseIndex: number;
  lastEmitTick: number;
  lastSignalTick: number;

  retryAttempt?: number;
  subagentsBusy: number;
  rate: RateWindow;
}

export function createSim(sessionKey = "default", archOverrides?: Readonly<Record<string, Arch>>): SimState {
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
    tools: new Map(),
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
    lastDeltaTick: -1_000_000,
    calib: new Map(),
    pulses: [],
    flashes: [],
    nextPulseIndex: 0,
    lastEmitTick: -1_000_000,
    lastSignalTick: 0,
    subagentsBusy: 0,
    rate: createRate(),
  };
}

/** Prompt size for the context grid. `Usage.input` excludes cached tokens by protocol contract. */
export function promptTokens(u: Usage): number {
  return u.input + u.cacheRead + u.cacheWrite;
}

function setPhase(s: SimState, p: Phase): void {
  if (s.phase === p) return;
  s.phase = p;
  s.phaseTick = s.tick;
}

function calibKey(s: SimState): string {
  return s.model?.modelID ?? "?";
}

function addGenerated(s: SimState, stream: Stream, tokens: number): void {
  if (tokens <= 0) return;
  const last = s.generated[s.generated.length - 1];
  if (last && last.stream === stream) last.tokens += tokens;
  else s.generated.push({ stream, tokens });
  s.genTotal += tokens;
  if (stream === "reasoning") s.turnReasoning += tokens;
  else s.turnText += tokens;
}

function spawnPulse(s: SimState, tokens: number): void {
  const sweep = Math.max(9, Math.min(20, Math.round(270 / Math.max(s.tps, 1))));
  s.pulses.push({ index: s.nextPulseIndex++, bornTick: s.tick, tokens, stream: s.stream, sweepTicks: sweep });
  s.bank -= tokens;
  if (s.bank < 1e-9) s.bank = 0;
  s.lastEmitTick = s.tick;
  addGenerated(s, s.stream, tokens);
}

/** Leaving decode: emit whatever is left in the bank as one final pulse. */
function flushBank(s: SimState): void {
  if (s.bank >= 0.5) spawnPulse(s, s.bank);
  else s.bank = 0;
}

function startTurn(s: SimState): void {
  // Fold the previous turn's output into the prompt: it's history now.
  if (s.promptTokens !== undefined) s.promptTokens += Math.max(0, s.genTotal - s.promptGenBase);
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

function beginPrefill(s: SimState): void {
  s.prefillTick = s.tick;
  s.ttftTicks = undefined;
  setPhase(s, "prefill");
}

/** Apply one Signal at the current tick. Deterministic; mutates `s`. */
export function applySignal(s: SimState, sig: Signal): void {
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
      if (s.stepOpen) return; // duplicate
      if (s.phase === "idle" || s.phase === "error") startTurn(s);
      s.stepOpen = true;
      s.stepStartTick = s.tick;
      s.stepRawEst = 0;
      s.stepTokens = 0;
      s.stepGenStart = s.genTotal;
      if (s.phase !== "prefill") beginPrefill(s);
      s.retryAttempt = undefined;
      return;
    }
    case "delta": {
      const raw = sig.tokens ?? sig.chars / 4;
      if (!(raw > 0)) return;
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
      if (r >= 0) s.tps = r;
      if (s.phase === "tool") return; // stay in TOOL until every tool ends
      if (s.phase === "prefill" && s.prefillTick !== undefined) s.ttftTicks = s.tick - s.prefillTick;
      if (s.phase === "idle" || s.phase === "error") startTurn(s);
      s.retryAttempt = undefined;
      setPhase(s, "decode");
      return;
    }
    case "tool.start": {
      if (s.tools.has(sig.callID)) return;
      s.tools.set(sig.callID, { tool: sig.tool, startTick: s.tick });
      s.toolsCalled++;
      if (s.phase === "decode") flushBank(s);
      setPhase(s, "tool");
      return;
    }
    case "tool.end": {
      if (!s.tools.delete(sig.callID)) return;
      if (!sig.ok) s.flashes.push({ kind: "toolFail", bornTick: s.tick });
      if (s.tools.size === 0 && s.phase === "tool") beginPrefill(s);
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
        // Degraded path (SPEC §7.4): usage but no deltas → animate the reported output.
        if (s.stepTokens === 0 && observed > 0) {
          const secs = Math.max(1, s.tick - s.stepStartTick) / TICK_HZ;
          s.tps = observed / secs;
          s.tpsApprox = true;
          s.bank += observed;
          s.stream = u.output >= u.reasoning ? "text" : "reasoning";
          s.draining = true;
          if (s.phase === "prefill" && s.prefillTick !== undefined) s.ttftTicks = undefined;
          setPhase(s, "decode");
        }
      }
      if (!s.draining && s.phase === "decode") flushBank(s);
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
      if (!s.draining) flushBank(s);
      s.tools.clear();
      s.stepOpen = false;
      if (s.phase !== "error") setPhase(s, "idle");
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

/** Advance exactly one tick. */
export function step(s: SimState): void {
  s.tick++;
  const t = s.tick;

  // Pulse emitter (SPEC §9.3).
  const emitting = s.phase === "decode" || s.draining;
  if (emitting && s.bank >= 1 && t - s.lastEmitTick >= PULSE_MIN_GAP && s.pulses.length < MAX_PULSES) {
    const per = Math.max(1, Math.ceil(s.tps / 10));
    const take = Math.min(s.bank, s.bank > per * 4 ? Math.ceil(s.bank / 4) : per);
    spawnPulse(s, take);
  }
  if (s.draining && s.bank < 1) {
    if (s.bank > 0) spawnPulse(s, s.bank);
    s.draining = false;
  }

  // Expire animation records. Pulses live 1.5 sweeps (the extra half is the landing flash).
  if (s.pulses.length) s.pulses = s.pulses.filter((p) => t - p.bornTick <= p.sweepTicks * 1.5);
  if (s.flashes.length) s.flashes = s.flashes.filter((f) => t - f.bornTick <= FLASH_TTL);

  // Throughput decays once deltas stop.
  if (!s.tpsApprox && t - s.lastDeltaTick > 30 && s.tps > 0) {
    s.tps *= 0.9;
    if (s.tps < 1) s.tps = 0;
  }

  // Phase timeouts.
  if (s.phase === "error" && t - s.phaseTick >= ERROR_TICKS) setPhase(s, "idle");
  if (
    s.phase !== "idle" && s.phase !== "error" && s.phase !== "retry" &&
    !s.stepOpen && s.tools.size === 0 && !s.draining && s.bank < 1 &&
    t - s.lastSignalTick >= IDLE_TIMEOUT_TICKS
  ) {
    setPhase(s, "idle");
  }
}

// ── derived views (pure helpers for the renderer) ─────────────────────────

/** Tokens of pulses still in flight (not yet landed in the grid). */
export function inflightTokens(s: Readonly<SimState>): number {
  let n = 0;
  for (const p of s.pulses) if (s.tick - p.bornTick < p.sweepTicks) n += p.tokens;
  return n;
}

export interface ContextView {
  limit: number;
  approx: boolean;
  cached: number;
  fresh: number;
  /** Landed generated runs since the latest usage's prompt (reasoning/text in order). */
  generated: GenRun[];
  used: number;
  known: boolean;
}

/** What the context grid should show right now. */
export function contextView(s: Readonly<SimState>): ContextView {
  const known = s.promptTokens !== undefined && s.usage !== undefined;
  const cached = known ? s.usage!.cacheRead : 0;
  const fresh = known ? Math.max(0, s.promptTokens! - s.usage!.cacheRead) : 0;
  // Generated tokens after the prompt base, minus those still flying.
  let skip = s.promptGenBase;
  let remaining = Math.max(0, s.genTotal - s.promptGenBase - inflightTokens(s));
  const gen: GenRun[] = [];
  for (const r of s.generated) {
    let n = r.tokens;
    if (skip > 0) {
      const d = Math.min(skip, n);
      skip -= d;
      n -= d;
    }
    if (n <= 0 || remaining <= 0) continue;
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
    known,
  };
}
