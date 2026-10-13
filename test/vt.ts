// Minimal ANSI screen-state reconstructor (test helper).
//
// tdef's retrospective: grepping blit output for literal strings gives false
// negatives because a diff blit fragments text across cursor moves. Instead,
// replay the byte stream into a virtual screen and compare whole screens.
// Supports what our backends emit: CUP (H), ED 2J, SGR (m: fg/bg tracked),
// private modes (?…h/l, ignored).

import { DEFAULT } from "../src/core/frame.ts";

export class VT {
  readonly w: number;
  readonly h: number;
  readonly ch: string[];
  readonly fg: number[];
  x = 0;
  y = 0;
  private curFg = DEFAULT;

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.ch = new Array(w * h).fill(" ");
    this.fg = new Array(w * h).fill(DEFAULT);
  }

  write(s: string): this {
    const cps = [...s];
    for (let i = 0; i < cps.length; i++) {
      const c = cps[i];
      if (c === "\x1b" && cps[i + 1] === "[") {
        let j = i + 2;
        let params = "";
        while (j < cps.length && !/[A-Za-z]/.test(cps[j])) params += cps[j++];
        this.csi(params, cps[j]);
        i = j;
        continue;
      }
      if (c === "\n") { this.y++; this.x = 0; continue; }
      if (c === "\r") { this.x = 0; continue; }
      if (this.x < this.w && this.y < this.h) {
        const k = this.y * this.w + this.x;
        this.ch[k] = c;
        this.fg[k] = this.curFg;
      }
      this.x++;
    }
    return this;
  }

  private csi(params: string, final: string): void {
    if (params.startsWith("?")) return;
    const nums = params.split(";").map((p) => (p === "" ? 0 : Number(p)));
    switch (final) {
      case "H":
        this.y = Math.max(0, (nums[0] || 1) - 1);
        this.x = Math.max(0, (nums[1] || 1) - 1);
        break;
      case "J":
        if (nums[0] === 2) { this.ch.fill(" "); this.fg.fill(DEFAULT); }
        break;
      case "m": {
        for (let k = 0; k < nums.length; k++) {
          const n = nums[k];
          if (n === 0 || n === 39) this.curFg = DEFAULT;
          else if (n === 38 && nums[k + 1] === 2) { this.curFg = (nums[k + 2] << 16) | (nums[k + 3] << 8) | nums[k + 4]; k += 4; }
          else if (n === 38 && nums[k + 1] === 5) { this.curFg = 0x1000000 + nums[k + 2]; k += 2; }
          else if (n === 48) { k += nums[k + 1] === 2 ? 4 : 2; }
        }
        break;
      }
    }
  }

  text(): string {
    const lines: string[] = [];
    for (let y = 0; y < this.h; y++) lines.push(this.ch.slice(y * this.w, (y + 1) * this.w).join(""));
    return lines.join("\n");
  }
}
