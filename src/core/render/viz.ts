// renderViz (SPEC §9): a PURE function of (w, h, sim, palette, opts) → Frame.
//
// No clock, no Math.random, no I/O. Time is `sim.tick`; every fade is computed
// analytically from (tick − bornTick), and every illustrative choice is seeded
// from state via illustrate.ts. Geometry comes only from layout().

import { DEFAULT, Frame, type Rect, cpLen, drawRoundedBox, embedSegment, truncate } from "../frame.ts";
import { type Palette, shade } from "../palette.ts";
import { type Arch, archSummary, normalizeModelID } from "../registry.ts";
import { type ContextView, type Pulse, type SimState, TICK_HZ, contextView } from "../sim/sim.ts";
import { BrailleCanvas } from "./braille.ts";
import { hash32, hashStr, mulberry32, pickK, pickRecent } from "./illustrate.ts";
import { type CompactLayout, type FullLayout, layout, outY } from "./layout.ts";
import { renderStrip } from "./strip.ts";

export interface VizOpts {
  /** Show the honesty label (always kept in full/compact; this only controls extra legend). */
  labels: boolean;
  /** ⬢→◆, ⬡→◇, ◉→@ for terminals with ambiguous-width glyphs. */
  asciiSafe: boolean;
  /** Background to blend toward (0xRRGGBB) or DEFAULT. */
  bg: number;
}

export const DEFAULT_VIZ_OPTS: VizOpts = { labels: true, asciiSafe: false, bg: DEFAULT };

export const SPINNER = "⠁⠂⠄⡀⢀⠠⠐⠈";
const TAU = 5; // ticks: fade time constant for meshes / nodes
const LAND_TAU = 8; // ticks: landing flash

export function glyphsFor(asciiSafe: boolean) {
  return {
    hex: asciiSafe ? "◆" : "⬢",
    hexOff: asciiSafe ? "◇" : "⬡",
    shared: asciiSafe ? "◆" : "◈",
    sample: asciiSafe ? "@" : "◉",
    node: "●",
    nodeOff: "○",
    dense: "┃",
  };
}

/** 1 inside [a,b] of pulse progress u, 0 before, exponential fade after. */
export function stageI(u: number, a: number, b: number, sweep: number): number {
  if (u < a) return 0;
  if (u <= b) return 1;
  return Math.exp(-((u - b) * sweep) / TAU);
}

/** Which output node pulse p samples (seeded). */
export function sampleIndex(seed: number, p: Pulse, outN: number): number {
  return Math.floor(mulberry32(hash32(seed, p.index, 23))() * outN);
}

export function pulseU(s: Readonly<SimState>, p: Pulse): number {
  return (s.tick - p.bornTick) / p.sweepTicks;
}

// ── expert slots (bucketing, SPEC §9.2) ───────────────────────────────────

export interface Slots {
  ys: number[];
  shared: number;
  perSlot: number;
  experts: number;
}

export function expertSlots(arch: Arch, col: Rect): Slots {
  const rows = col.h;
  let count: number;
  let shared = 0;
  let perSlot = 1;
  let experts = rows;
  if (arch.kind === "moe") {
    shared = Math.min(arch.shared, Math.max(0, rows - 1));
    experts = arch.experts;
    const avail = Math.max(1, rows - shared);
    perSlot = arch.experts <= avail ? 1 : Math.ceil(arch.experts / avail);
    count = shared + Math.ceil(arch.experts / perSlot);
  } else {
    count = rows;
  }
  count = Math.max(1, Math.min(count, rows));
  const spacing = Math.max(1, Math.floor(rows / count));
  const offset = Math.max(0, Math.floor((rows - ((count - 1) * spacing + 1)) / 2));
  const ys: number[] = [];
  for (let i = 0; i < count; i++) ys.push(col.y + offset + i * spacing);
  return { ys, shared, perSlot, experts };
}

/** Slot indices lit for pulse p at `layer` (shared experts always included). */
export function pulseSlots(arch: Arch, slots: Slots, seed: number, p: Pulse, layer: number): number[] {
  const rng = mulberry32(hash32(seed, p.index, layer, 7));
  if (arch.kind === "moe") {
    const set = new Set<number>();
    for (let i = 0; i < slots.shared; i++) set.add(i);
    for (const e of pickK(arch.experts, arch.active, rng)) set.add(slots.shared + Math.floor(e / slots.perSlot));
    return [...set].filter((i) => i < slots.ys.length);
  }
  if (arch.kind === "dense") return slots.ys.map((_, i) => i);
  return pickK(slots.ys.length, Math.min(3, slots.ys.length), rng);
}

// ── context grid model ────────────────────────────────────────────────────

export const CELL_EMPTY = 0, CELL_CACHED = 1, CELL_FRESH = 2, CELL_REASONING = 3, CELL_TEXT = 4;

export interface GridModel {
  kind: Uint8Array;
  frac: Float32Array;
  nFilled: number;
  tokensPerCell: number;
}

export function gridModel(cv: ContextView, cells: number): GridModel {
  const kind = new Uint8Array(cells);
  const frac = new Float32Array(cells);
  const tpc = Math.max(1, Math.ceil(cv.limit / Math.max(1, cells)));
  // Segment boundaries in token space.
  const segs: { end: number; kind: number }[] = [];
  let acc = 0;
  if (cv.cached > 0) segs.push({ end: (acc += cv.cached), kind: CELL_CACHED });
  if (cv.fresh > 0) segs.push({ end: (acc += cv.fresh), kind: CELL_FRESH });
  for (const r of cv.generated) segs.push({ end: (acc += r.tokens), kind: r.stream === "reasoning" ? CELL_REASONING : CELL_TEXT });
  const used = Math.min(acc, tpc * cells);
  const segAt = (tok: number) => {
    for (const s of segs) if (tok < s.end) return s.kind;
    return segs.length ? segs[segs.length - 1].kind : CELL_EMPTY;
  };
  let nFilled = 0;
  for (let i = 0; i < cells; i++) {
    const start = i * tpc;
    if (used <= start) continue;
    nFilled++;
    if (used < start + tpc) {
      kind[i] = segAt(used - 1e-6);
      frac[i] = (used - start) / tpc;
    } else {
      kind[i] = segAt(start + tpc / 2);
      frac[i] = 1;
    }
  }
  return { kind, frac, nFilled, tokensPerCell: tpc };
}

// ── formatting ────────────────────────────────────────────────────────────

export function fmtK(n: number): string {
  n = Math.max(0, n);
  if (n < 1000) return `${Math.round(n)}`;
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

const secs = (ticks: number) => `${(ticks / TICK_HZ).toFixed(1)}s`;

// ── main entry ────────────────────────────────────────────────────────────

export function renderViz(w: number, h: number, sim: Readonly<SimState>, pal: Palette, opts: VizOpts = DEFAULT_VIZ_OPTS): Frame {
  const f = new Frame(w, h);
  const L = layout(w, h, sim.arch);
  if (L.mode === "tiny") {
    f.set(Math.floor(f.w / 2), Math.floor(f.h / 2), "·", shade(pal.label, opts.bg, 0.7));
    return f;
  }
  if (L.mode === "strip") {
    renderStrip(f, sim, pal, opts);
    return f;
  }
  drawScene(f, L, sim, pal, opts);
  return f;
}

type BoxLayout = FullLayout | CompactLayout;

function drawScene(f: Frame, L: BoxLayout, s: Readonly<SimState>, pal: Palette, opts: VizOpts): void {
  const bg = opts.bg;
  const t = s.tick;
  const G = glyphsFor(opts.asciiSafe);
  const seed = hashStr(s.sessionKey);
  const arch = s.arch;
  const full = L.mode === "full";
  const sh = (c: number, i: number) => shade(c, bg, i);

  const idle = s.phase === "idle";
  const base = idle ? 0.06 + (0.06 * (1 + Math.sin((2 * Math.PI * t) / 120))) / 2 : 0.1;

  // ── context grid ──
  const g = L.grid;
  const cells = g.w * g.h;
  const cv = contextView(s);
  const gm = gridModel(cv, cells);
  const gridI = new Float32Array(cells);
  const gridGlyph: string[] = new Array(cells).fill("·");
  const gridColor = new Int32Array(cells).fill(pal.gridEmpty);
  for (let i = 0; i < cells; i++) {
    const k = gm.kind[i];
    const partial = gm.frac[i] > 0 && gm.frac[i] < 1;
    switch (k) {
      case CELL_CACHED: gridGlyph[i] = "▓"; gridColor[i] = pal.gridBlue; gridI[i] = 0.75; break;
      case CELL_FRESH: gridGlyph[i] = "▒"; gridColor[i] = pal.gridBlueLt; gridI[i] = 0.7; break;
      case CELL_REASONING: gridGlyph[i] = "█"; gridColor[i] = pal.reasoning; gridI[i] = 0.85; break;
      case CELL_TEXT: gridGlyph[i] = "█"; gridColor[i] = pal.textOut; gridI[i] = 0.85; break;
      default: gridI[i] = 0.9;
    }
    if (k !== CELL_EMPTY && partial) gridGlyph[i] = " ░▒▓█"[Math.max(1, Math.ceil(gm.frac[i] * 4))];
  }
  // Prefill wave over fresh cells (or a faint wash over empties before the first usage).
  if (s.phase === "prefill") {
    const since = t - (s.prefillTick ?? t);
    const bx = ((since % 27) / 27) * (g.w + 6) - 3;
    const anyFresh = gm.kind.some((k) => k === CELL_FRESH);
    for (let i = 0; i < cells; i++) {
      const d = Math.abs((i % g.w) - bx);
      if (d >= 2.5) continue;
      const boost = 1 - (d / 2.5) * 0.5;
      if (gm.kind[i] === CELL_FRESH) gridI[i] = Math.max(gridI[i], boost);
      else if (!anyFresh && gm.kind[i] === CELL_EMPTY && Math.floor(i / g.w) < Math.max(2, g.h / 3)) {
        gridGlyph[i] = "░"; gridColor[i] = pal.gridBlueLt; gridI[i] = 0.5 * boost;
      }
    }
  }

  // ── columns ──
  const slots = expertSlots(arch, L.experts);
  const expertI = new Float32Array(slots.ys.length);
  const expertBase = arch.kind === "unknown" ? 0.12 + 0.06 * Math.sin(t / 10) : 0.22;
  for (let i = 0; i < slots.ys.length; i++) {
    expertI[i] = arch.kind === "unknown" ? Math.max(0.06, expertBase + 0.05 * Math.sin(t / 10 + i * 0.7)) : expertBase;
  }
  const hiddenRows = full ? (L as FullLayout).hidden.h : 0;
  const hiddenI = new Float32Array(hiddenRows);
  const outN = L.outN;
  const outI = new Float32Array(outN);
  const outBase = s.phase === "tool" ? 0.12 : 0.25;
  outI.fill(outBase);
  let sampled = -1;
  let sampledColor = pal.textOut;
  let sampledI = 0;

  // ── braille fans ──
  const fanA = new BrailleCanvas(L.fanA.w, L.fanA.h);
  const fanB = full ? new BrailleCanvas((L as FullLayout).fanB.w, (L as FullLayout).fanB.h) : undefined;
  const ay = (yAbs: number) => (yAbs - L.fanA.y) * 4 + 2;
  const ax1 = L.fanA.w * 2 - 1;

  // Static router mesh (stable per layout).
  {
    const rng = mulberry32(hash32(L.box.w, L.box.h, hashStr(arch.family), 11));
    for (let r = 0; r < g.h; r++) {
      if (rng() >= 0.4) continue;
      for (const sl of pickK(slots.ys.length, Math.min(2, slots.ys.length), rng)) {
        fanA.line(0, ay(g.y + r), ax1, ay(slots.ys[sl]), pal.route, base);
      }
    }
  }
  // Static logit mesh: every 3rd hidden row → every output, stippled.
  if (fanB && full) {
    const FL = L as FullLayout;
    const by = (yAbs: number) => (yAbs - FL.fanB.y) * 4 + 2;
    const bx1 = FL.fanB.w * 2 - 1;
    // Sparse on purpose: a full bipartite mesh saturates braille into a solid ⣿ block.
    for (let r = 1; r < FL.hidden.h; r += 4) {
      for (let o = 0; o < outN; o++) {
        fanB.line(0, by(FL.hidden.y + r), bx1, by(outY(FL, o)), (r + o) % 2 ? pal.meshPink : pal.meshBlue, base * 0.8, { stipple: 2 });
      }
    }
  }

  // Idle spark: one faint packet along a random router line every 3 s.
  if (idle) {
    const cyc = Math.floor(t / 90);
    const ph = (t % 90) / 30;
    if (ph < 1 && g.h > 0 && slots.ys.length > 0) {
      const rng = mulberry32(hash32(seed, cyc, 17));
      const r = Math.floor(rng() * g.h);
      const sl = Math.floor(rng() * slots.ys.length);
      fanA.line(0, ay(g.y + r), ax1, ay(slots.ys[sl]), pal.route, 0.35 * (1 - ph), { upTo: ph });
    }
  }

  // Prefill: bursts of routing from everywhere + expert shimmer.
  if (s.phase === "prefill") {
    for (let j = 0; j < 3; j++) {
      const b = Math.floor(t / 3) - j;
      const age = t - b * 3;
      const rng = mulberry32(hash32(seed, b, 13));
      const I = 0.45 * Math.exp(-age / 4);
      for (let n = 0; n < 6 && g.h > 0; n++) {
        const r = Math.floor(rng() * g.h);
        const sl = Math.floor(rng() * slots.ys.length);
        fanA.line(0, ay(g.y + r), ax1, ay(slots.ys[sl]), pal.route, I);
      }
    }
    for (let i = 0; i < slots.ys.length; i++) {
      if (hash32(seed, i, Math.floor(t / 2), 19) / 4294967296 < 0.6) {
        expertI[i] = Math.max(expertI[i], 0.35 + 0.15 * Math.sin(t / 4 + i));
      }
    }
  }

  // Decode pulses (SPEC §9.3). Pulses keep animating through tool/idle until they expire.
  let newest: Pulse | undefined;
  let landed: Pulse | undefined;
  const attendByPulse: { born: number; cells: number[]; i: number }[] = [];
  for (const p of s.pulses) {
    const u = pulseU(s, p);
    if (u < 1 && (!newest || p.bornTick >= newest.bornTick)) newest = p;
    if (u >= 1 && (!landed || p.bornTick >= landed.bornTick)) landed = p;
    if (u >= 1) continue;
    const sweep = p.sweepTicks;
    const rng = mulberry32(hash32(seed, p.index, 3));
    const color = p.stream === "reasoning" ? pal.reasoning : pal.textOut;
    const layers = arch.kind === "unknown" ? 1 : arch.layers;
    const layer = 1 + Math.min(layers - 1, Math.floor(u * layers));

    // attend + route
    const m = 2 + Math.floor(rng() * 3);
    const att = pickRecent(gm.nFilled, m, rng);
    const aI = stageI(u, 0, 0.3, sweep);
    attendByPulse.push({ born: p.bornTick, cells: att, i: aI });
    const routeLayer = u < 0.3 ? 0 : layer;
    const lit = pulseSlots(arch, slots, seed, p, routeLayer);
    if (att.length && lit.length) {
      const n = Math.max(att.length, Math.min(lit.length, 8));
      const lineI = 0.9 * aI;
      for (let l = 0; l < n; l++) {
        const cell = att[l % att.length];
        const sl = lit[l % lit.length];
        fanA.line(0, ay(g.y + Math.floor(cell / g.w)), ax1, ay(slots.ys[sl]), pal.route, lineI, { upTo: Math.min(1, u / 0.3) });
      }
    }
    // experts fire
    const eI = stageI(u, 0.3, 0.42, sweep);
    if (eI > 0) for (const sl of lit) expertI[sl] = Math.max(expertI[sl], arch.kind === "unknown" ? 0.55 * eI : eI);

    // hidden + project (full only)
    let litHidden: number[] = [];
    if (full) {
      const FL = L as FullLayout;
      const hI = stageI(u, 0.42, 0.52, sweep);
      const hr = mulberry32(hash32(seed, p.index, 5));
      for (let r = 0; r < FL.hidden.h; r++) if (hr() < 0.35) litHidden.push(r);
      if (hI > 0) for (const r of litHidden) hiddenI[r] = Math.max(hiddenI[r], hI);
      const pI = stageI(u, 0.52, 0.85, sweep);
      if (pI > 0 && fanB) {
        const by = (yAbs: number) => (yAbs - FL.fanB.y) * 4 + 2;
        const bx1 = FL.fanB.w * 2 - 1;
        const upTo = Math.min(1, (u - 0.52) / 0.33);
        // Project to the node that will be sampled plus three others.
        const targets = new Set<number>([sampleIndex(seed, p, outN), ...pickK(outN, Math.min(3, outN), mulberry32(hash32(seed, p.index, 31)))]);
        for (const r of litHidden.slice(0, 3)) {
          for (const o of targets) {
            fanB.line(0, by(FL.hidden.y + r), bx1, by(outY(FL, o)), (r + o) % 2 ? pal.meshPink : pal.meshBlue, 0.8 * pI, { upTo });
          }
        }
      }
    }
    // sample
    const sI = stageI(u, 0.85, 0.92, sweep);
    if (sI > 0) {
      const o = sampleIndex(seed, p, outN);
      if (sI >= sampledI) { sampled = o; sampledColor = color; sampledI = sI; }
      outI[o] = Math.max(outI[o], sI);
    }
    // comet back to the grid
    if (u >= 0.92) {
      const fr = Math.min(1, (u - 0.92) / 0.08);
      const startX = L.out.x - 1;
      const endX = g.x + g.w;
      const hx = Math.round(startX + (endX - startX) * fr);
      const tail = ["•", "∙", "·"];
      for (let k = 0; k < 3; k++) {
        const x = hx + k;
        if (x > startX) break;
        f.set(x, L.cometY, tail[k], sh(color, 1 - k * 0.3), bg);
      }
    }
  }
  // Attention dots: newest pulse only, so overlapping pulses don't paint the grid orange.
  const attended = new Map<number, number>();
  const newestAttend = attendByPulse.filter((a) => a.i > 0.05).sort((a, b) => b.born - a.born)[0];
  if (newestAttend) for (const c of newestAttend.cells) attended.set(c, newestAttend.i);

  // Landing flash on the frontier cell.
  if (landed && gm.nFilled > 0) {
    const age = s.tick - (landed.bornTick + landed.sweepTicks);
    const I = Math.exp(-age / LAND_TAU);
    const c = gm.nFilled - 1;
    gridI[c] = Math.max(gridI[c], I);
  }

  // ── draw fans ──
  fanA.blitTo(f, L.fanA.x, L.fanA.y, bg);
  if (fanB && full) fanB.blitTo(f, (L as FullLayout).fanB.x, (L as FullLayout).fanB.y, bg);

  // ── draw grid ──
  for (let i = 0; i < cells; i++) {
    const x = g.x + (i % g.w);
    const y = g.y + Math.floor(i / g.w);
    const a = attended.get(i);
    if (a !== undefined && a > 0.05 && gm.kind[i] !== CELL_EMPTY) f.set(x, y, "●", sh(pal.attendDot, Math.max(0.35, a)), bg);
    else f.set(x, y, gridGlyph[i], sh(gridColor[i], gridI[i]), bg);
  }

  // ── draw expert column ──
  for (let i = 0; i < slots.ys.length; i++) {
    const hue = pal.hex[hash32(i, 29) % pal.hex.length];
    let ch: string;
    if (arch.kind === "dense") ch = G.dense;
    else if (arch.kind === "unknown") ch = G.hexOff;
    else ch = i < slots.shared ? G.shared : G.hex;
    const color = arch.kind === "dense" ? pal.hidden : arch.kind === "unknown" ? pal.label : hue;
    f.set(L.experts.x, slots.ys[i], ch, sh(color, expertI[i]), bg);
  }

  // ── hidden column (full) ──
  if (full) {
    const FL = L as FullLayout;
    for (let r = 0; r < FL.hidden.h; r++) {
      const on = hiddenI[r] > 0.3;
      f.set(FL.hidden.x, FL.hidden.y + r, on ? G.node : G.nodeOff, sh(pal.hidden, Math.max(0.3, hiddenI[r])), bg);
    }
  }

  // ── output column ──
  for (let o = 0; o < outN; o++) {
    if (o === sampled) f.set(L.out.x, outY(L, o), G.sample, sh(sampledColor, Math.max(0.5, sampledI)), bg);
    else f.set(L.out.x, outY(L, o), G.node, sh(pal.output, outI[o]), bg);
  }
  if (!full && sampled >= 0) f.set(L.out.x - 1, outY(L, sampled), "─", sh(sampledColor, sampledI), bg);

  // ── border + HUD ──
  let borderColor = pal.border;
  if (s.phase === "error") {
    const e = Math.exp(-(t - s.phaseTick) / 12);
    borderColor = mixColor(pal.border, pal.error, e);
  }
  const fail = s.flashes.find((fl) => fl.kind === "toolFail");
  drawRoundedBox(f, L.box, borderColor);
  drawHud(f, L, s, pal, opts, newest, cv, borderColor, fail ? Math.exp(-(t - fail.bornTick) / 10) : 0);
}

function mixColor(a: number, b: number, t: number): number {
  t = Math.max(0, Math.min(1, t));
  const ch = (sh: number) => Math.round(((a >> sh) & 0xff) * (1 - t) + ((b >> sh) & 0xff) * t);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

// ── HUD segments in the border (tdef embedSegment, btop style) ─────────────

interface Seg {
  text: string;
  fg: number;
  side: "l" | "r";
  prio: number;
  bold?: boolean;
  /** Can be truncated down to this many code points. */
  minLen?: number;
}

export function placeSegs(f: Frame, y: number, segs: Seg[], x0: number, x1: number, border: number): Seg[] {
  const avail = x1 - x0 + 1;
  const order = [...segs].sort((a, b) => b.prio - a.prio);
  const chosen = new Set<Seg>();
  const width = new Map<Seg, number>();
  let used = 0;
  for (const sg of order) {
    const need = cpLen(sg.text) + 2 + (chosen.size ? 1 : 0);
    if (used + need <= avail) {
      chosen.add(sg);
      width.set(sg, cpLen(sg.text));
      used += need;
    } else if (sg.minLen !== undefined) {
      const room = avail - used - 2 - (chosen.size ? 1 : 0);
      if (room >= sg.minLen) {
        chosen.add(sg);
        width.set(sg, room);
        used += room + 2 + (chosen.size > 1 ? 1 : 0);
      }
    }
  }
  const left = segs.filter((sg) => chosen.has(sg) && sg.side === "l");
  const right = segs.filter((sg) => chosen.has(sg) && sg.side === "r");
  let x = x0;
  for (const sg of left) {
    const txt = truncate(sg.text, width.get(sg)!);
    x = embedSegment(f, y, x, txt, "┤", "├", border, sg.fg, sg.bold) + 1;
  }
  let xr = x1;
  for (let i = right.length - 1; i >= 0; i--) {
    const sg = right[i];
    const txt = truncate(sg.text, width.get(sg)!);
    const start = xr - (cpLen(txt) + 2) + 1;
    embedSegment(f, y, start, txt, "┤", "├", border, sg.fg, sg.bold);
    xr = start - 2;
  }
  return [...chosen];
}

export function honestyLabel(arch: Arch, full: boolean): string {
  if (arch.kind === "unknown") return full ? "architecture unknown" : "arch unknown";
  return full ? "illustrative routing" : "illustrative";
}

function drawHud(
  f: Frame, L: BoxLayout, s: Readonly<SimState>, pal: Palette, opts: VizOpts,
  newest: Pulse | undefined, cv: ContextView, border: number, failI: number,
): void {
  const full = L.mode === "full";
  const t = s.tick;
  const bg = opts.bg;
  const dim = (c: number, i = 0.85) => shade(c, bg, i);
  const arch = s.arch;

  // Phase segment.
  let phaseText: string;
  let phaseColor = pal.text;
  const tps = s.tps >= 1 ? `${s.tpsApprox ? "≈" : ""}${Math.round(s.tps)}${full ? " tok/s" : "t/s"}` : "";
  switch (s.phase) {
    case "idle":
      phaseText = "○ idle";
      phaseColor = dim(pal.label, 0.8);
      break;
    case "prefill": {
      const since = t - (s.prefillTick ?? t);
      phaseText = full ? `▸ PREFILL  ttft ${secs(since)}` : `▸ PREFILL ${secs(since)}`;
      phaseColor = pal.gridBlueLt;
      break;
    }
    case "decode": {
      const label = s.stream === "reasoning" ? (full ? "REASONING" : "THINK") : "DECODE";
      phaseColor = s.stream === "reasoning" ? pal.reasoning : pal.textOut;
      if (full) {
        let lay = "";
        if (arch.kind === "unknown") lay = "L ?";
        else if (newest) {
          const u = pulseU(s, newest);
          lay = `L ${1 + Math.min(arch.layers - 1, Math.floor(u * arch.layers))}/${arch.layers}`;
        } else lay = `L –/${arch.layers}`;
        const ttft = s.ttftTicks !== undefined ? `  ttft ${secs(s.ttftTicks)}` : "";
        phaseText = `▸ ${label}  ${lay}${tps ? "  " + tps : ""}${ttft}`;
      } else {
        phaseText = `▸ ${label}${tps ? " " + tps : ""}`;
      }
      break;
    }
    case "tool":
      phaseText = "⚙ TOOL";
      phaseColor = pal.tool;
      break;
    case "retry":
      phaseText = `RETRY #${s.retryAttempt ?? 1}`;
      phaseColor = Math.floor(t / 15) % 2 ? pal.warn : dim(pal.warn, 0.5);
      break;
    case "error":
      phaseText = "✕ ERROR";
      phaseColor = pal.error;
      break;
  }

  const modelName = s.model ? normalizeModelID(s.model.modelID) : "no model yet";
  const top: Seg[] = [
    { text: full ? `${modelName} · ${archSummary(arch)}` : modelName, fg: pal.text, side: "l", prio: 2, minLen: 6 },
    { text: phaseText, fg: phaseColor, side: "r", prio: 3, bold: true },
  ];
  if (s.subagentsBusy > 0) top.push({ text: `+${s.subagentsBusy} agents`, fg: pal.label, side: "l", prio: 1 });
  placeSegs(f, L.box.y, top, L.box.x + 2, L.box.x + L.box.w - 3, border);

  // Bottom: ctx, think/out, tool badge, honesty label.
  const bottom: Seg[] = [];
  const label = honestyLabel(arch, full);
  bottom.push({ text: label, fg: dim(pal.label, 0.75), side: "r", prio: 10 });
  if (s.tools.size > 0) {
    let first: { tool: string; startTick: number } | undefined;
    for (const v of s.tools.values()) if (!first || v.startTick < first.startTick) first = v;
    const more = s.tools.size > 1 ? ` +${s.tools.size - 1}` : "";
    const spin = SPINNER[Math.floor(t / 3) % SPINNER.length];
    bottom.push({
      text: `⚙ ${first!.tool}${more} ${secs(t - first!.startTick)} ${spin}`,
      fg: failI > 0.2 ? pal.error : pal.tool,
      side: "l",
      prio: 6,
      minLen: 6,
    });
  } else if (failI > 0.2) {
    bottom.push({ text: "⚙ tool failed", fg: pal.error, side: "l", prio: 6 });
  }
  bottom.push({ text: ctxText(cv, full), fg: dim(pal.gridBlueLt), side: "l", prio: 4, minLen: 5 });
  if (full && (s.turnReasoning > 0 || s.turnText > 0)) {
    bottom.push({ text: `think ~${fmtK(s.turnReasoning)} · out ~${fmtK(s.turnText)}`, fg: dim(pal.label), side: "l", prio: 3 });
  }
  placeSegs(f, L.box.y + L.box.h - 1, bottom, L.box.x + 2, L.box.x + L.box.w - 3, border);
}

export function ctxText(cv: ContextView, full: boolean): string {
  const lim = `${cv.approx ? "~" : ""}${fmtK(cv.limit)}`;
  if (!cv.known) {
    if (cv.used === 0) return full ? `ctx ? / ${lim}` : `ctx ?`;
    return full ? `ctx ? + ${fmtK(cv.used)} new / ${lim}` : `ctx ?+${fmtK(cv.used)}`;
  }
  const pct = cv.cached + cv.fresh > 0 ? Math.round((cv.cached / (cv.cached + cv.fresh)) * 100) : 0;
  if (!full) return `ctx ${fmtK(cv.used)}/${lim}`;
  const n = 8;
  const toCells = (v: number) => Math.round((v / Math.max(1, cv.limit)) * n);
  const c = Math.min(n, toCells(cv.cached));
  const fr = Math.min(n - c, toCells(cv.fresh));
  const gen = Math.min(n - c - fr, toCells(cv.used - cv.cached - cv.fresh));
  const bar = "▓".repeat(c) + "▒".repeat(fr) + "█".repeat(gen) + "·".repeat(n - c - fr - gen);
  return `ctx ${bar} ${pct}% cached · ${fmtK(cv.used)}/${lim}`;
}
