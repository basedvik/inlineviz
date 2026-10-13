// Frame model, ported from ../tdef/render/frame.go.
//
// A Frame is a w×h grid of cells (one grapheme, fg, bg, bold). Renderers
// build a Frame; backends (ANSI blitter, OpenTUI copy) consume it. Colors are
// 0xRRGGBB ints; DEFAULT (-1) means "terminal default".

export const DEFAULT = -1;

export type Rect = { x: number; y: number; w: number; h: number };

export interface Cell {
  ch: string;
  fg: number;
  bg: number;
  bold: boolean;
}

export class Frame {
  readonly w: number;
  readonly h: number;
  readonly ch: string[];
  readonly fg: Int32Array;
  readonly bg: Int32Array;
  readonly bold: Uint8Array;

  constructor(w: number, h: number) {
    this.w = Math.max(0, Math.floor(w));
    this.h = Math.max(0, Math.floor(h));
    const n = this.w * this.h;
    this.ch = new Array<string>(n).fill(" ");
    this.fg = new Int32Array(n).fill(DEFAULT);
    this.bg = new Int32Array(n).fill(DEFAULT);
    this.bold = new Uint8Array(n);
  }

  /** Out-of-bounds writes are no-ops, like tdef's Frame.Set. */
  set(x: number, y: number, ch: string, fg: number, bg: number = DEFAULT, bold = false): void {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = y * this.w + x;
    this.ch[i] = ch;
    this.fg[i] = fg;
    this.bg[i] = bg;
    this.bold[i] = bold ? 1 : 0;
  }

  get(x: number, y: number): Cell | undefined {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return undefined;
    const i = y * this.w + x;
    return { ch: this.ch[i], fg: this.fg[i], bg: this.bg[i], bold: this.bold[i] === 1 };
  }

  /** Write a string left to right (one cell per code point), clipped to the frame. */
  text(x: number, y: number, s: string, fg: number, bg: number = DEFAULT, bold = false): number {
    for (const c of s) {
      this.set(x, y, c, fg, bg, bold);
      x++;
    }
    return x;
  }

  cellEquals(other: Frame, i: number): boolean {
    return (
      this.ch[i] === other.ch[i] &&
      this.fg[i] === other.fg[i] &&
      this.bg[i] === other.bg[i] &&
      this.bold[i] === other.bold[i]
    );
  }

  /** Plain-text dump: h lines of w cells joined by "\n" (tdef Frame.Text). */
  toText(): string {
    const lines: string[] = [];
    for (let y = 0; y < this.h; y++) {
      let s = "";
      for (let x = 0; x < this.w; x++) s += this.ch[y * this.w + x] || " ";
      lines.push(s);
    }
    return lines.join("\n");
  }

  /** Full-screen truecolor ANSI dump (tdef Frame.ANSI). Each row is positioned with CUP. */
  toAnsi(truecolor = true): string {
    let out = "\x1b[?25l\x1b[2J\x1b[H";
    let pfg = -2, pbg = -2, pbold = -1;
    for (let y = 0; y < this.h; y++) {
      // CUP per row: a bare newline would smear on a terminal wider than the frame.
      out += `\x1b[${y + 1};1H`;
      for (let x = 0; x < this.w; x++) {
        const i = y * this.w + x;
        if (this.fg[i] !== pfg) { out += sgrFg(this.fg[i], truecolor); pfg = this.fg[i]; }
        if (this.bg[i] !== pbg) { out += sgrBg(this.bg[i], truecolor); pbg = this.bg[i]; }
        if (this.bold[i] !== pbold) { out += this.bold[i] ? "\x1b[1m" : "\x1b[22m"; pbold = this.bold[i]; }
        out += this.ch[i] || " ";
      }
    }
    return out + "\x1b[0m\x1b[?25h";
  }
}

// ── color helpers ──────────────────────────────────────────────────────────

export function rgbOf(c: number): [number, number, number] {
  return [(c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff];
}

export function rgbInt(r: number, g: number, b: number): number {
  return ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff);
}

/** Nearest xterm-256 color-cube index for a 0xRRGGBB color. */
export function to256(c: number): number {
  const [r, g, b] = rgbOf(c);
  const q = (v: number) => (v < 48 ? 0 : v < 115 ? 1 : Math.min(5, Math.floor((v - 35) / 40)));
  return 16 + 36 * q(r) + 6 * q(g) + q(b);
}

export function sgrFg(c: number, truecolor = true): string {
  if (c === DEFAULT) return "\x1b[39m";
  if (!truecolor) return `\x1b[38;5;${to256(c)}m`;
  const [r, g, b] = rgbOf(c);
  return `\x1b[38;2;${r};${g};${b}m`;
}

export function sgrBg(c: number, truecolor = true): string {
  if (c === DEFAULT) return "\x1b[49m";
  if (!truecolor) return `\x1b[48;5;${to256(c)}m`;
  const [r, g, b] = rgbOf(c);
  return `\x1b[48;2;${r};${g};${b}m`;
}

// ── box + border segments (tdef drawRoundedBox / embedSegment / centerEmbed) ──

/** Rounded box ╭╮╰╯ with ─ edges and │ sides. Interior cells are untouched. */
export function drawRoundedBox(f: Frame, r: Rect, fg: number): void {
  const { x, y, w, h } = r;
  if (w < 2 || h < 2) return;
  for (let i = 1; i < w - 1; i++) {
    f.set(x + i, y, "─", fg);
    f.set(x + i, y + h - 1, "─", fg);
  }
  for (let j = 1; j < h - 1; j++) {
    f.set(x, y + j, "│", fg);
    f.set(x + w - 1, y + j, "│", fg);
  }
  f.set(x, y, "╭", fg);
  f.set(x + w - 1, y, "╮", fg);
  f.set(x, y + h - 1, "╰", fg);
  f.set(x + w - 1, y + h - 1, "╯", fg);
}

/** Writes `left text right` at (x,y); brackets in border color, text in fg. Returns next free column. */
export function embedSegment(
  f: Frame, y: number, x: number, text: string, left: string, right: string,
  border: number, fg: number, bold = false,
): number {
  f.set(x, y, left, border);
  x++;
  for (const c of text) {
    f.set(x, y, c, fg, DEFAULT, bold);
    x++;
  }
  f.set(x, y, right, border);
  return x + 1;
}

/** Centers a border segment on row y with one column of clearance from each corner. */
export function centerEmbed(
  f: Frame, y: number, text: string, left: string, right: string,
  border: number, fg: number, bold = false,
): number {
  const w = [...text].length + 2;
  let x = Math.floor((f.w - w) / 2);
  if (x + w > f.w - 1) x = f.w - 1 - w;
  if (x < 1) x = 1;
  return embedSegment(f, y, x, text, left, right, border, fg, bold);
}

/** First n code points of s. */
export function truncate(s: string, n: number): string {
  if (n <= 0) return "";
  const r = [...s];
  return r.length <= n ? s : r.slice(0, n).join("");
}

export function cpLen(s: string): number {
  return [...s].length;
}
