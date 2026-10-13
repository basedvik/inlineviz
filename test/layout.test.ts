// Written BEFORE src/core/render/layout.ts (tdef retro: "write the vertical
// budget as a test with exact expected rows first"). Expected rects were
// computed by hand from the SPEC §9.1 formulas.

import { describe, expect, test } from "bun:test";
import type { Rect } from "../src/core/frame.ts";
import { type Layout, layout } from "../src/core/render/layout.ts";
import { archFor } from "../src/core/registry.ts";

const moe = archFor({ providerID: "p", modelID: "qwen3-235b-a22b" });
const R = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });

describe("layout exact budgets", () => {
  test("LayoutExact_90x30 (full)", () => {
    const L = layout(90, 30, moe);
    expect(L.mode).toBe("full");
    if (L.mode !== "full") return;
    expect(L.box).toEqual(R(0, 0, 90, 30));
    expect(L.grid).toEqual(R(2, 6, 12, 17));
    expect(L.fanA).toEqual(R(15, 1, 26, 28));
    expect(L.experts).toEqual(R(42, 1, 1, 28));
    expect(L.hidden).toEqual(R(44, 1, 1, 28));
    expect(L.fanB).toEqual(R(46, 1, 40, 28));
    expect(L.out).toEqual(R(87, 4, 1, 21)); // 11 nodes, every other row
    expect(L.cometY).toBe(28);
  });

  test("LayoutExact_137x45 (full)", () => {
    const L = layout(137, 45, moe);
    expect(L.mode).toBe("full");
    if (L.mode !== "full") return;
    expect(L.grid).toEqual(R(2, 9, 19, 27));
    expect(L.fanA).toEqual(R(22, 1, 41, 43));
    expect(L.experts).toEqual(R(64, 1, 1, 43));
    expect(L.hidden).toEqual(R(66, 1, 1, 43));
    expect(L.fanB).toEqual(R(68, 1, 65, 43));
    expect(L.out).toEqual(R(134, 11, 1, 23)); // 12 nodes
  });

  test("LayoutExact_62x19 (compact)", () => {
    const L = layout(62, 19, moe);
    expect(L.mode).toBe("compact");
    if (L.mode !== "compact") return;
    expect(L.grid).toEqual(R(2, 3, 15, 12));
    expect(L.fanA).toEqual(R(18, 1, 38, 17));
    expect(L.experts).toEqual(R(57, 1, 1, 17));
    expect(L.out).toEqual(R(59, 2, 1, 15)); // 8 nodes
  });

  test("LayoutExact_40x14 (compact, ~OpenCode sidebar)", () => {
    const L = layout(40, 14, moe);
    expect(L.mode).toBe("compact");
    if (L.mode !== "compact") return;
    expect(L.grid).toEqual(R(2, 3, 10, 8));
    expect(L.fanA).toEqual(R(13, 1, 21, 12));
    expect(L.experts).toEqual(R(35, 1, 1, 12));
    expect(L.out).toEqual(R(37, 1, 1, 11)); // 6 nodes
  });

  test("LayoutModesByThreshold", () => {
    expect(layout(90, 18, moe).mode).toBe("full");
    expect(layout(89, 18, moe).mode).toBe("compact");
    expect(layout(90, 17, moe).mode).toBe("compact");
    expect(layout(34, 10, moe).mode).toBe("compact");
    expect(layout(33, 10, moe).mode).toBe("strip");
    expect(layout(34, 9, moe).mode).toBe("strip");
    expect(layout(12, 1, moe).mode).toBe("strip");
    expect(layout(11, 40, moe).mode).toBe("tiny");
    expect(layout(1, 1, moe).mode).toBe("tiny");
  });
});

function regions(L: Layout): Rect[] {
  if (L.mode === "full") return [L.grid, L.fanA, L.experts, L.hidden, L.fanB, L.out];
  if (L.mode === "compact") return [L.grid, L.fanA, L.experts, L.out];
  return [];
}

const inside = (r: Rect, b: Rect) => r.x >= b.x + 1 && r.y >= b.y + 1 && r.x + r.w <= b.x + b.w - 1 && r.y + r.h <= b.y + b.h - 1;
const disjointX = (a: Rect, b: Rect) => a.x + a.w <= b.x || b.x + b.w <= a.x;

describe("layout properties", () => {
  test("LayoutRegionsInsideBox / LayoutRegionsDisjoint / positive sizes (w∈[1,220], h∈[1,70])", () => {
    for (let w = 1; w <= 220; w++) {
      for (let h = 1; h <= 70; h++) {
        const L = layout(w, h, moe);
        if (L.mode === "strip") {
          expect(L.line.w).toBe(w);
          continue;
        }
        if (L.mode === "tiny") continue;
        const rs = regions(L);
        for (const r of rs) {
          if (!(r.w >= 1 && r.h >= 1) || !inside(r, L.box)) throw new Error(`${w}x${h} ${L.mode}: bad region ${JSON.stringify(r)}`);
        }
        // Regions are columns laid left to right: pairwise disjoint in x.
        for (let i = 0; i < rs.length; i++) {
          for (let j = i + 1; j < rs.length; j++) {
            if (!disjointX(rs[i], rs[j])) throw new Error(`${w}x${h}: overlap ${JSON.stringify(rs[i])} ${JSON.stringify(rs[j])}`);
          }
        }
        if (L.cometY !== L.box.y + L.box.h - 2) throw new Error(`${w}x${h}: comet row`);
      }
    }
  });
});
