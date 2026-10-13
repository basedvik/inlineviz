// Frame → OpenTUI OptimizedBuffer (SPEC §11.4).
//
// Cells are written with setCellWithAlphaBlending; DEFAULT backgrounds become
// fully transparent so the host panel's own background shows through. RGBA
// objects are cached per color int: never allocate colors per cell per frame.

import { DEFAULT, type Frame } from "../core/frame.ts";

export interface RGBALike {
  toInts(): [number, number, number, number];
}
export interface RGBAFactory {
  fromInts(r: number, g: number, b: number, a?: number): RGBALike;
}
export interface CellBuffer {
  setCellWithAlphaBlending(x: number, y: number, char: string, fg: any, bg: any, attributes?: number): void;
}

const BOLD = 1; // OpenTUI TextAttributes.BOLD

export function rgbaToInt(c: RGBALike | undefined, fallback: number): number {
  if (!c || typeof c.toInts !== "function") return fallback;
  const [r, g, b] = c.toInts();
  return ((r & 255) << 16) | ((g & 255) << 8) | (b & 255);
}

export class FrameCopier {
  private readonly cache = new Map<number, RGBALike>();
  private readonly transparent: RGBALike;

  constructor(private readonly RGBA: RGBAFactory) {
    this.transparent = RGBA.fromInts(0, 0, 0, 0);
  }

  private rgba(c: number): RGBALike {
    let v = this.cache.get(c);
    if (!v) {
      v = this.RGBA.fromInts((c >> 16) & 255, (c >> 8) & 255, c & 255, 255);
      this.cache.set(c, v);
    }
    return v;
  }

  /** Copy `f` to the buffer at (ox, oy). DEFAULT fg uses `defaultFg`. */
  copy(buf: CellBuffer, f: Frame, ox: number, oy: number, defaultFg: number): void {
    for (let y = 0; y < f.h; y++) {
      for (let x = 0; x < f.w; x++) {
        const i = y * f.w + x;
        const ch = f.ch[i] || " ";
        const fg = f.fg[i] === DEFAULT ? defaultFg : f.fg[i];
        const bg = f.bg[i] === DEFAULT ? this.transparent : this.rgba(f.bg[i]);
        buf.setCellWithAlphaBlending(ox + x, oy + y, ch, this.rgba(fg), bg, f.bold[i] ? BOLD : 0);
      }
    }
  }
}
