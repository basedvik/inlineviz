// Palette as data (SPEC §9.6), taken from the reference image (hero-neural-net.png).
// Colors are 0xRRGGBB; intensities blend toward the background.

import { DEFAULT } from "./frame.ts";

export const DEFAULT_PALETTE = {
  border: 0x4b5263,
  label: 0x8b93a1,
  text: 0xd7dae0,
  gridBlue: 0x3b6a9a,
  gridBlueLt: 0x7fa7cf,
  gridEmpty: 0x3a3f4b,
  attendDot: 0xf28c28,
  route: 0x5b93c7,
  hex: [0xe8706a, 0xc8404f, 0xa9d18e, 0x4fa3ae] as readonly number[],
  hidden: 0x4a8cc7,
  meshPink: 0xe07aa0,
  meshBlue: 0x8db8d8,
  output: 0xb7cde3,
  reasoning: 0xa78bfa,
  textOut: 0xf5b455,
  tool: 0x4fa3ae,
  warn: 0xf5b455,
  error: 0xe5484d,
  /** Background assumed when the terminal default is unknown. */
  bg: 0x16181d,
};

export type Palette = typeof DEFAULT_PALETTE;

const LEVELS = 32;

/**
 * Blend `color` over `bg` at intensity `i` (0..1), with gamma i^0.8 and
 * quantized to 33 levels so the diff blit sees stable values.
 */
export function shade(color: number, bg: number, i: number): number {
  if (!(i > 0)) return bg === DEFAULT ? DEFAULT : bg;
  if (i >= 1) return color;
  const t = Math.round(Math.pow(i, 0.8) * LEVELS) / LEVELS;
  const b = bg === DEFAULT ? DEFAULT_PALETTE.bg : bg;
  const r = ((color >> 16) & 0xff) * t + ((b >> 16) & 0xff) * (1 - t);
  const g = ((color >> 8) & 0xff) * t + ((b >> 8) & 0xff) * (1 - t);
  const bl = (color & 0xff) * t + (b & 0xff) * (1 - t);
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(bl);
}
