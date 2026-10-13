// Driver (SPEC §7.2): maps wall-clock ms → fixed 30 Hz ticks.
//
// Like tdef's stepGame accumulator: at most `maxCatchUp` steps per call; if
// further behind, t0 slides forward so a stalled terminal doesn't fast-forward
// the animation. Signals are queued and applied when the Sim reaches their tick.
// The caller supplies `nowMs` from the SAME clock as the signals' `ts`.

import type { Signal } from "../protocol.ts";
import { type SimState, TICK_MS, applySignal, step } from "./sim.ts";

export class Driver {
  readonly sim: SimState;
  private queue: Signal[] = [];
  private t0: number | undefined;
  private readonly maxCatchUp: number;

  constructor(sim: SimState, opts: { maxCatchUp?: number; t0?: number } = {}) {
    this.sim = sim;
    this.maxCatchUp = opts.maxCatchUp ?? 10;
    this.t0 = opts.t0;
  }

  /** The origin of the tick timeline (ms), once known. */
  get origin(): number | undefined {
    return this.t0;
  }

  push(sig: Signal): void {
    if (this.t0 === undefined) this.t0 = sig.ts - this.sim.tick * TICK_MS;
    this.queue.push(sig);
  }

  tickOf(ts: number): number {
    // Epsilon: TICK_MS is 33.33…, so a shifted t0 can land a boundary at 9.999999.
    return Math.floor((ts - (this.t0 ?? ts)) / TICK_MS + 1e-6);
  }

  /** Step the Sim up to `nowMs`. Idempotent for the same `nowMs`. Returns the number of steps taken. */
  advanceTo(nowMs: number): number {
    if (this.t0 === undefined) this.t0 = nowMs - this.sim.tick * TICK_MS;
    let target = this.tickOf(nowMs);
    let steps = target - this.sim.tick;
    if (steps > this.maxCatchUp) {
      this.t0 += (steps - this.maxCatchUp) * TICK_MS;
      target = this.sim.tick + this.maxCatchUp;
      steps = this.maxCatchUp;
    }
    this.applyDue();
    let taken = 0;
    while (this.sim.tick < target) {
      step(this.sim);
      taken++;
      this.applyDue();
    }
    return taken;
  }

  private applyDue(): void {
    if (this.queue.length === 0) return;
    let i = 0;
    while (i < this.queue.length && this.tickOf(this.queue[i].ts) <= this.sim.tick) {
      applySignal(this.sim, this.queue[i]);
      i++;
    }
    if (i > 0) this.queue.splice(0, i);
  }

  get pending(): number {
    return this.queue.length;
  }
}
