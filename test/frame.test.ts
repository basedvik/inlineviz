import { describe, expect, test } from "bun:test";
import { DEFAULT, Frame, centerEmbed, drawRoundedBox, embedSegment } from "../src/core/frame.ts";
import { BrailleCanvas, BITS } from "../src/core/render/braille.ts";
import { VT } from "./vt.ts";

describe("frame", () => {
  test("FrameSetOutOfBoundsIsNoop", () => {
    const f = new Frame(4, 3);
    f.set(-1, 0, "x", 1);
    f.set(4, 0, "x", 1);
    f.set(0, 3, "x", 1);
    f.set(0, -1, "x", 1);
    expect(f.toText()).toBe("    \n    \n    ");
  });

  test("FrameTextShape", () => {
    const f = new Frame(7, 5);
    const lines = f.toText().split("\n");
    expect(lines.length).toBe(5);
    for (const l of lines) expect([...l].length).toBe(7);
  });

  test("FrameAnsiReconstructs", () => {
    const f = new Frame(10, 3);
    f.text(1, 0, "hello", 0xff0000);
    f.text(0, 2, "⬢●○◉⣿", 0x00ff00, 0x0000ff, true);
    const vt = new VT(10, 3).write(f.toAnsi());
    expect(vt.text()).toBe(f.toText());
    expect(vt.fg[1]).toBe(0xff0000);
  });

  test("RoundedBoxCorners", () => {
    const f = new Frame(5, 3);
    drawRoundedBox(f, { x: 0, y: 0, w: 5, h: 3 }, 1);
    expect(f.toText()).toBe("╭───╮\n│   │\n╰───╯");
  });

  test("EmbedSegmentReturnsNextColumn", () => {
    const f = new Frame(12, 1);
    const next = embedSegment(f, 0, 1, "abc", "┤", "├", 1, 2);
    expect(next).toBe(6); // ┤ at 1, "abc" at 2..4, ├ at 5
    expect(f.toText()).toBe(" ┤abc├      ");
  });

  test("CenterEmbedClampsToCorners", () => {
    const f = new Frame(6, 1);
    centerEmbed(f, 0, "toolongtext", "┤", "├", 1, 2);
    expect(f.ch[0]).toBe(" ");
    expect(f.ch[1]).toBe("┤");
  });

  test("DefaultColors", () => {
    const f = new Frame(1, 1);
    expect(f.fg[0]).toBe(DEFAULT);
    expect(f.bg[0]).toBe(DEFAULT);
  });
});

describe("braille", () => {
  test("BrailleBitsMatchUnicode", () => {
    // Dot numbering: 1,2,3,7 left column; 4,5,6,8 right column.
    const expected = [
      [0x2801, 0x2808],
      [0x2802, 0x2810],
      [0x2804, 0x2820],
      [0x2840, 0x2880],
    ];
    for (let sy = 0; sy < 4; sy++) {
      for (let sx = 0; sx < 2; sx++) {
        expect(0x2800 + BITS[sy][sx]).toBe(expected[sy][sx]);
        const c = new BrailleCanvas(1, 1);
        c.plot(sx, sy, 0xffffff, 1);
        const f = new Frame(1, 1);
        c.blitTo(f, 0, 0, DEFAULT);
        expect(f.ch[0].charCodeAt(0)).toBe(expected[sy][sx]);
      }
    }
  });

  test("LineEndpointsPlotted", () => {
    const c = new BrailleCanvas(5, 2);
    c.line(0, 0, 9, 7, 1, 1);
    expect(c.mask[0] & BITS[0][0]).toBeTruthy();
    expect(c.mask[1 * 5 + 4] & BITS[3][1]).toBeTruthy();
  });

  test("LineUpToTruncates", () => {
    const full = new BrailleCanvas(10, 1);
    full.line(0, 0, 19, 0, 1, 1);
    const half = new BrailleCanvas(10, 1);
    half.line(0, 0, 19, 0, 1, 1, { upTo: 0.5 });
    const count = (c: BrailleCanvas) => [...c.mask].filter((m) => m !== 0).length;
    expect(count(full)).toBe(10);
    expect(count(half)).toBe(5);
    expect(half.mask[9]).toBe(0);
  });

  test("StippleHalvesDots", () => {
    const dots = (c: BrailleCanvas) => [...c.mask].reduce((n, m) => n + popcount(m), 0);
    const a = new BrailleCanvas(20, 1);
    a.line(0, 0, 39, 0, 1, 1);
    const b = new BrailleCanvas(20, 1);
    b.line(0, 0, 39, 0, 1, 1, { stipple: 2 });
    expect(dots(a)).toBe(40);
    expect(dots(b)).toBe(20);
  });

  test("MaxIntensityWinsColor", () => {
    const c = new BrailleCanvas(1, 1);
    c.plot(0, 0, 0x111111, 0.6);
    c.plot(1, 1, 0x222222, 0.9);
    c.plot(0, 2, 0x333333, 0.5);
    expect(c.color[0]).toBe(0x222222);
    expect(popcount(c.mask[0])).toBe(3); // all within 2× of the brightest
  });

  test("DimDotsDroppedUnderBrightLine", () => {
    // A faint mesh dot must not be promoted to the bright line's color.
    const c = new BrailleCanvas(1, 1);
    c.plot(0, 0, 0x111111, 0.1);
    c.plot(1, 1, 0x222222, 0.9);
    c.plot(0, 2, 0x333333, 0.1);
    expect(c.color[0]).toBe(0x222222);
    expect(popcount(c.mask[0])).toBe(1);
  });
});

function popcount(m: number): number {
  let n = 0;
  while (m) { n += m & 1; m >>= 1; }
  return n;
}
