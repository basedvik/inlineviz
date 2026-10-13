// Headless playback on a virtual clock: Signals → frames at fixed ticks.
// Used by `capture`, `screens` and golden tests. Byte-identical everywhere.

import type { Frame } from "./frame.ts";
import type { Palette } from "./palette.ts";
import type { Signal } from "./protocol.ts";
import type { Arch } from "./registry.ts";
import { Driver } from "./sim/driver.ts";
import { type SimState, TICK_MS, createSim } from "./sim/sim.ts";
import { type VizOpts, renderViz } from "./render/viz.ts";

export interface PlayOpts {
  w: number;
  h: number;
  pal: Palette;
  viz: VizOpts;
  every?: number;
  limit?: number;
  sessionKey?: string;
  arch?: Record<string, Arch>;
}

/** Yields (tick, sim, frame) every `every` ticks until `limit` ticks or the end of the signals + 3 s. */
export function* play(signals: Signal[], o: PlayOpts): Generator<{ tick: number; sim: SimState; frame: Frame }> {
  const sim = createSim(o.sessionKey ?? "demo", o.arch);
  const t0 = signals.length ? signals[0].ts : 0;
  const d = new Driver(sim, { t0, maxCatchUp: Number.MAX_SAFE_INTEGER });
  for (const s of signals) d.push(s);
  const endTick = o.limit ?? (signals.length ? Math.ceil((signals[signals.length - 1].ts - t0) / TICK_MS) + 90 : 90);
  const every = Math.max(1, o.every ?? 1);
  for (let tick = 0; tick <= endTick; tick++) {
    d.advanceTo(t0 + tick * TICK_MS);
    if (tick % every === 0) yield { tick, sim, frame: renderViz(o.w, o.h, sim, o.pal, o.viz) };
  }
}

/** First tick at which each phase is entered (plus a mid-decode tick), for `screens`. */
export function phaseTicks(signals: Signal[], o: PlayOpts): { label: string; tick: number }[] {
  const seen = new Map<string, number>();
  let decodeStart = -1;
  const out: { label: string; tick: number }[] = [];
  for (const { tick, sim } of play(signals, { ...o, every: 1, w: 1, h: 1 })) {
    const key = sim.phase === "decode" ? `decode:${sim.stream}` : sim.phase;
    if (!seen.has(key)) {
      seen.set(key, tick);
      out.push({ label: key, tick: tick + (sim.phase === "prefill" ? 12 : 0) });
    }
    if (sim.phase === "decode" && decodeStart < 0) decodeStart = tick;
    if (decodeStart >= 0 && tick === decodeStart + 20) out.push({ label: "decode+20", tick });
  }
  return out;
}
