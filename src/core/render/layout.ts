// Layout (SPEC §9.1): the single source of geometry. renderViz and the tests
// both derive every position from here (tdef's MenuRects lesson).

import type { Rect } from "../frame.ts";
import type { Arch } from "../registry.ts";

export type FullLayout = {
  mode: "full";
  box: Rect;
  grid: Rect;
  fanA: Rect;
  experts: Rect;
  hidden: Rect;
  fanB: Rect;
  /** Output nodes sit on every other row: node i is at out.y + 2*i. */
  out: Rect;
  outN: number;
  /** Row the comet travels along (just above the bottom border). */
  cometY: number;
};

export type CompactLayout = {
  mode: "compact";
  box: Rect;
  grid: Rect;
  fanA: Rect;
  experts: Rect;
  /** Output nodes sit on every other row: node i is at out.y + 2*i. */
  out: Rect;
  outN: number;
  cometY: number;
};

export type Layout = FullLayout | CompactLayout | { mode: "strip"; line: Rect } | { mode: "tiny" };

export const FULL_MIN = { w: 90, h: 18 } as const;
export const COMPACT_MIN = { w: 34, h: 10 } as const;
export const STRIP_MIN_W = 12;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// `arch` is accepted so per-architecture tweaks can live here later; the current
// geometry doesn't depend on it.
export function layout(w: number, h: number, _arch: Arch): Layout {
  w = Math.floor(w);
  h = Math.floor(h);
  if (w >= FULL_MIN.w && h >= FULL_MIN.h) return full(w, h);
  if (w >= COMPACT_MIN.w && h >= COMPACT_MIN.h) return compact(w, h);
  if (w >= STRIP_MIN_W && h >= 1) return { mode: "strip", line: { x: 0, y: 0, w, h: 1 } };
  return { mode: "tiny" };
}

function full(w: number, h: number): FullLayout {
  const ix = 1, iy = 1, iw = w - 2, ih = h - 2;
  const gw = clamp(Math.round(iw * 0.14), 8, 22);
  const gh = clamp(Math.round(ih * 0.62), 6, ih);
  const grid = { x: ix + 1, y: iy + Math.floor((ih - gh) / 2), w: gw, h: gh };
  const fanAx = grid.x + grid.w + 1;
  const fanA = { x: fanAx, y: iy, w: Math.round(iw * 0.47) - fanAx, h: ih };
  const experts = { x: fanA.x + fanA.w + 1, y: iy, w: 1, h: ih };
  const hidden = { x: experts.x + 2, y: iy, w: 1, h: ih };
  const outX = ix + iw - 2;
  const outN = Math.min(clamp(Math.round(ih * 0.4), 4, 12), Math.floor((ih + 1) / 2));
  const fanB = { x: hidden.x + 2, y: iy, w: outX - 1 - (hidden.x + 2), h: ih };
  const out = { x: outX, y: iy + Math.floor((ih - (2 * outN - 1)) / 2), w: 1, h: 2 * outN - 1 };
  return { mode: "full", box: { x: 0, y: 0, w, h }, grid, fanA, experts, hidden, fanB, out, outN, cometY: h - 2 };
}

function compact(w: number, h: number): CompactLayout {
  const ix = 1, iy = 1, iw = w - 2, ih = h - 2;
  const gw = clamp(Math.round(iw * 0.25), 6, 16);
  const gh = clamp(Math.round(ih * 0.7), 3, ih);
  const grid = { x: ix + 1, y: iy + Math.floor((ih - gh) / 2), w: gw, h: gh };
  const fanAx = grid.x + grid.w + 1;
  const fanA = { x: fanAx, y: iy, w: w - 6 - fanAx, h: ih };
  const experts = { x: w - 5, y: iy, w: 1, h: ih };
  const outN = Math.min(clamp(Math.round(ih * 0.5), 3, 8), Math.floor((ih + 1) / 2));
  const out = { x: w - 3, y: iy + Math.floor((ih - (2 * outN - 1)) / 2), w: 1, h: 2 * outN - 1 };
  return { mode: "compact", box: { x: 0, y: 0, w, h }, grid, fanA, experts, out, outN, cometY: h - 2 };
}

/** Row of output node i (nodes are spaced two rows apart). */
export function outY(L: { out: Rect }, i: number): number {
  return L.out.y + 2 * i;
}

/**
 * Position of context-grid cell i. The grid fills COLUMN-major (time flows left → right, each
 * column top → bottom), so even a small context spans several rows and the router fan leaves
 * from many rows. The single source of truth for cell geometry.
 */
export function gridCell(grid: Rect, i: number): { col: number; row: number; x: number; y: number } {
  const h = Math.max(1, grid.h);
  const col = Math.floor(i / h), row = i % h;
  return { col, row, x: grid.x + col, y: grid.y + row };
}
