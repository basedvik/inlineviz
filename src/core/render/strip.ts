// Strip mode (SPEC §9.7): one line, for narrow slots like OpenCode's
// session_prompt_right.   ◖▓▓▓▒▒░·· ⬢⬢⬡⬢⬡⬡⬢⬡~ ◉ 63t/s ⚙bash

import { type Frame } from "../frame.ts";
import { type Palette, shade } from "../palette.ts";
import { type SimState, contextView } from "../sim/sim.ts";
import { hashStr } from "./illustrate.ts";
import {
  CELL_CACHED, CELL_FRESH, CELL_REASONING, CELL_TEXT, type VizOpts, expertSlots, glyphsFor, gridModel,
  pulseSlots, pulseU, stageI,
} from "./viz.ts";

type Part = { text: string; color: number; i: number };

export function renderStrip(f: Frame, s: Readonly<SimState>, pal: Palette, opts: VizOpts): void {
  const bg = opts.bg;
  const G = glyphsFor(opts.asciiSafe);
  const t = s.tick;
  const parts: Part[][] = [];

  // Mini context bar (9 cells).
  const gm = gridModel(contextView(s), 9);
  const bar: Part[] = [{ text: "◖", color: pal.border, i: 1 }];
  for (let i = 0; i < 9; i++) {
    const k = gm.kind[i];
    let glyph = k === CELL_CACHED ? "▓" : k === CELL_FRESH ? "▒" : k === CELL_REASONING || k === CELL_TEXT ? "█" : "·";
    if (k && gm.frac[i] > 0 && gm.frac[i] < 1) glyph = " ░▒▓█"[Math.max(1, Math.ceil(gm.frac[i] * 4))];
    const color = k === CELL_CACHED ? pal.gridBlue : k === CELL_FRESH ? pal.gridBlueLt : k === CELL_REASONING ? pal.reasoning : k === CELL_TEXT ? pal.textOut : pal.gridEmpty;
    bar.push({ text: glyph, color, i: k ? 0.8 : 0.9 });
  }
  parts.push(bar);

  // 8 mini experts.
  const slots = expertSlots(s.arch, { x: 0, y: 0, w: 1, h: 8 });
  const lit = new Float32Array(slots.ys.length);
  const seed = hashStr(s.sessionKey);
  let sample = 0;
  let sampleColor = pal.output;
  for (const p of s.pulses) {
    const u = pulseU(s, p);
    if (u >= 1) continue;
    const eI = stageI(u, 0.3, 0.42, p.sweepTicks);
    if (eI > 0) for (const sl of pulseSlots(s.arch, slots, seed, p, 1)) lit[sl] = Math.max(lit[sl], eI);
    const sI = stageI(u, 0.85, 0.92, p.sweepTicks);
    if (sI > sample) { sample = sI; sampleColor = p.stream === "reasoning" ? pal.reasoning : pal.textOut; }
  }
  const ex: Part[] = [{ text: " ", color: 0, i: 0 }];
  for (let i = 0; i < slots.ys.length; i++) {
    const shimmer = s.arch.kind === "unknown" ? 0.15 + 0.08 * Math.sin(t / 10 + i) : 0.25;
    const I = Math.max(shimmer, lit[i]);
    ex.push({ text: lit[i] > 0.3 ? G.hex : G.hexOff, color: pal.hex[i % pal.hex.length], i: I });
  }
  ex.push({ text: "~", color: pal.label, i: 0.5 });
  parts.push(ex);

  parts.push([{ text: " ", color: 0, i: 0 }, { text: sample > 0.3 ? G.sample : G.node, color: sample > 0.3 ? sampleColor : pal.output, i: Math.max(0.3, sample) }]);

  if (s.tps >= 1) parts.push([{ text: ` ${s.tpsApprox ? "≈" : ""}${Math.round(s.tps)}t/s`, color: pal.text, i: 0.85 }]);
  if (s.tools.size > 0) {
    const first = [...s.tools.values()][0];
    parts.push([{ text: ` ⚙${first.tool}`, color: pal.tool, i: 1 }]);
  } else if (s.phase === "prefill") {
    parts.push([{ text: " prefill", color: pal.gridBlueLt, i: 0.8 }]);
  } else if (s.phase === "error") {
    parts.push([{ text: " ✕", color: pal.error, i: 1 }]);
  }

  // Drop whole parts from the right until the line fits.
  let x = 0;
  for (const group of parts) {
    const len = group.reduce((n, p) => n + [...p.text].length, 0);
    if (x + len > f.w) break;
    for (const p of group) x = f.text(x, 0, p.text, p.i > 0 ? shade(p.color, bg, p.i) : 0, bg);
  }
}
