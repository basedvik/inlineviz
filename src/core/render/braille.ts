// Braille sub-pixel canvas (SPEC §10.2).
//
// Each terminal cell is a 2×4 grid of dots → U+2800 + mask. One cell has one
// fg color, so the highest-intensity contributor wins the color while all
// contributors above a threshold OR their dots in.

import { type Frame } from "../frame.ts";
import { shade } from "../palette.ts";

export const BITS: readonly (readonly number[])[] = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
];

const DOT_THRESHOLD = 0.04;
/** Contributors dimmer than this fraction of a cell's brightest one don't add dots. */
const DOMINANCE = 0.5;

export interface LineOpts {
  /** 0..1 — draw only the first fraction of the line (progressive reveal). */
  upTo?: number;
  /** Plot every Nth point (2 = dotted texture). */
  stipple?: number;
}

export class BrailleCanvas {
  readonly cw: number;
  readonly ch: number;
  readonly mask: Uint8Array;
  readonly inten: Float32Array;
  readonly color: Int32Array;

  constructor(cw: number, ch: number) {
    this.cw = Math.max(0, cw);
    this.ch = Math.max(0, ch);
    const n = this.cw * this.ch;
    this.mask = new Uint8Array(n);
    this.inten = new Float32Array(n);
    this.color = new Int32Array(n);
  }

  get pw(): number { return this.cw * 2; }
  get ph(): number { return this.ch * 4; }

  plot(sx: number, sy: number, color: number, i: number): void {
    if (sx < 0 || sy < 0 || sx >= this.cw * 2 || sy >= this.ch * 4 || i < DOT_THRESHOLD) return;
    const c = (sy >> 2) * this.cw + (sx >> 1);
    const bit = BITS[sy & 3][sx & 1];
    const cur = this.inten[c];
    // One fg color per braille char: a bright line must not promote faint mesh
    // dots sharing its cell, so much-dimmer contributors are dropped.
    if (i * DOMINANCE > cur) {
      this.mask[c] = bit;
      this.inten[c] = i;
      this.color[c] = color;
    } else if (i >= cur * DOMINANCE) {
      this.mask[c] |= bit;
      if (i > cur) {
        this.inten[c] = i;
        this.color[c] = color;
      }
    }
  }

  /** Integer DDA line in sub-pixel coordinates. */
  line(x0: number, y0: number, x1: number, y1: number, color: number, i: number, opts: LineOpts = {}): void {
    x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    const upTo = opts.upTo === undefined ? 1 : Math.max(0, Math.min(1, opts.upTo));
    const last = Math.floor(n * upTo);
    const st = Math.max(1, opts.stipple ?? 1);
    if (n === 0) {
      if (upTo > 0) this.plot(x0, y0, color, i);
      return;
    }
    for (let k = 0; k <= last; k += st) {
      this.plot(Math.round(x0 + ((x1 - x0) * k) / n), Math.round(y0 + ((y1 - y0) * k) / n), color, i);
    }
  }

  /** Write non-empty braille cells into the frame at (ox, oy). */
  blitTo(f: Frame, ox: number, oy: number, bg: number): void {
    for (let y = 0; y < this.ch; y++) {
      for (let x = 0; x < this.cw; x++) {
        const c = y * this.cw + x;
        if (this.mask[c] === 0) continue;
        f.set(ox + x, oy + y, String.fromCharCode(0x2800 + this.mask[c]), shade(this.color[c], bg, this.inten[c]), bg);
      }
    }
  }
}
