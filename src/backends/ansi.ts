// ANSI backend (SPEC §13.2), modeled on ../tdef/tui/term.go + app.go blitTo.
//
// Blitter: diffs a Frame against the previous one and emits only changed
// cells (CUP + SGR + glyph), tracking the pen so escapes are only written when
// position/colors change. A size change or reset() forces a full redraw.
// Terminal: raw mode + alt screen + hidden cursor, always restored.

import { DEFAULT, type Frame, sgrBg, sgrFg } from "../core/frame.ts";
import type { Palette } from "../core/palette.ts";
import { type VizOpts, renderViz } from "../core/render/viz.ts";
import type { Driver } from "../core/sim/driver.ts";

/** Glyphs we trust to occupy exactly one column; after anything else the pen re-syncs with CUP. */
function narrow(c: string): boolean {
  const cp = c.codePointAt(0) ?? 32;
  return (
    cp < 0x7f || cp === 0xb7 || cp === 0x2022 || cp === 0x2219 ||
    (cp >= 0x2500 && cp <= 0x25ff) || (cp >= 0x2800 && cp <= 0x28ff)
  );
}

export class Blitter {
  private prev: Frame | undefined;
  constructor(private readonly truecolor = true) {}

  reset(): void {
    this.prev = undefined;
  }

  /** Returns the bytes to write for `f`, clipped to termW×termH. */
  blit(f: Frame, termW = f.w, termH = f.h): string {
    const full = !this.prev || this.prev.w !== f.w || this.prev.h !== f.h;
    let out = "\x1b[?2026h";
    if (full) out += "\x1b[0m\x1b[2J\x1b[H";
    let px = -1, py = -1, pfg = -2, pbg = -2, pbold = -1;
    const W = Math.min(f.w, termW), H = Math.min(f.h, termH);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * f.w + x;
        if (!full && this.prev!.cellEquals(f, i)) continue;
        if (px !== x || py !== y) {
          out += `\x1b[${y + 1};${x + 1}H`;
          px = x;
          py = y;
        }
        if (f.fg[i] !== pfg) { out += sgrFg(f.fg[i], this.truecolor); pfg = f.fg[i]; }
        if (f.bg[i] !== pbg) { out += sgrBg(f.bg[i], this.truecolor); pbg = f.bg[i]; }
        if (f.bold[i] !== pbold) { out += f.bold[i] ? "\x1b[1m" : "\x1b[22m"; pbold = f.bold[i]; }
        const ch = f.ch[i] || " ";
        out += ch;
        px = narrow(ch) ? px + 1 : -1;
      }
    }
    this.prev = f;
    return out + "\x1b[0m\x1b[?2026l";
  }
}

export function detectTruecolor(env: Record<string, string | undefined> = process.env): boolean {
  const ct = (env.COLORTERM ?? "").toLowerCase();
  return ct === "truecolor" || ct === "24bit";
}

export interface InteractiveOpts {
  driver: Driver;
  pal: Palette;
  viz: VizOpts;
  fps: number;
  onKey?: (key: string) => void;
  onExit?: () => void;
}

/** Full-screen render loop until q / Ctrl-C. The terminal is always restored. */
export function runInteractive(o: InteractiveOpts): void {
  const out = process.stdout;
  const inp = process.stdin;
  if (!out.isTTY) {
    process.stderr.write("inlineviz: interactive mode needs a TTY (try `capture` or `screens` for headless output)\n");
    process.exit(2);
  }
  const blitter = new Blitter(detectTruecolor());
  let resized = true;
  let closed = false;
  let viz = { ...o.viz };
  let frameNo = 0;

  const restore = () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    try { o.onExit?.(); } catch { /* ignore */ }
    try { if (inp.isTTY) inp.setRawMode(false); } catch { /* ignore */ }
    out.write("\x1b[0m\x1b[?25h\x1b[?1049l");
  };
  const quit = (code = 0) => {
    restore();
    process.exit(code);
  };

  process.on("exit", restore);
  process.on("SIGINT", () => quit(130));
  process.on("SIGTERM", () => quit(143));
  process.on("uncaughtException", (e) => {
    restore();
    process.stderr.write(`inlineviz: ${e?.stack ?? e}\n`);
    process.exit(1);
  });
  // Resize is a pure notifier (tdef's SIGWINCH race fix): the loop reads the size.
  out.on("resize", () => { resized = true; });

  out.write("\x1b[?1049h\x1b[?25l\x1b[2J");
  if (inp.isTTY) {
    inp.setRawMode(true);
    inp.resume();
    inp.setEncoding("utf8");
    inp.on("data", (k: string) => {
      if (k === "q" || k === "\x03") quit(0);
      else if (k === "l") viz = { ...viz, labels: !viz.labels };
      else o.onKey?.(k);
    });
  }

  const tickMs = 1000 / Math.max(1, Math.min(60, o.fps));
  const timer = setInterval(() => {
    if (closed) return;
    if (resized) {
      resized = false;
      blitter.reset();
    }
    o.driver.advanceTo(Date.now());
    const s = o.driver.sim;
    // Idle: 10 fps is plenty for the breathing animation.
    frameNo++;
    if (s.phase === "idle" && s.pulses.length === 0 && frameNo % 3 !== 0) return;
    const w = out.columns || 80, h = out.rows || 24;
    out.write(blitter.blit(renderViz(w, h, s, o.pal, { ...viz, bg: DEFAULT }), w, h));
  }, tickMs);
}
