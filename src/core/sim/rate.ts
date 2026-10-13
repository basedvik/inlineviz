// Throughput window (SPEC §7.3): ring buffer of (tick, tokens).

export const RATE_CAP = 256;
export const RATE_WINDOW_TICKS = 60; // 2 s at 30 Hz
const MIN_SPAN_TICKS = 15;

export interface RateWindow {
  ticks: number[];
  toks: number[];
  head: number;
  size: number;
}

export function createRate(): RateWindow {
  return { ticks: new Array(RATE_CAP).fill(0), toks: new Array(RATE_CAP).fill(0), head: 0, size: 0 };
}

export function ratePush(r: RateWindow, tick: number, tokens: number): void {
  r.ticks[r.head] = tick;
  r.toks[r.head] = tokens;
  r.head = (r.head + 1) % RATE_CAP;
  if (r.size < RATE_CAP) r.size++;
}

/**
 * Tokens/sec over the last RATE_WINDOW_TICKS. The span is measured from the
 * oldest sample in the window (at least MIN_SPAN_TICKS), so the first second
 * of a stream isn't underestimated. Returns -1 when the window is empty.
 */
export function rateTps(r: RateWindow, tick: number, hz: number): number {
  let sum = 0;
  let oldest = Infinity;
  for (let k = 0; k < r.size; k++) {
    const i = (r.head - 1 - k + RATE_CAP) % RATE_CAP;
    const t = r.ticks[i];
    if (tick - t >= RATE_WINDOW_TICKS) break;
    sum += r.toks[i];
    if (t < oldest) oldest = t;
  }
  if (oldest === Infinity) return -1;
  const span = Math.max(MIN_SPAN_TICKS, tick - oldest + 1);
  return (sum * hz) / span;
}
