// OpenCode TUI plugin (SPEC §11). Renders inside OpenCode's terminal UI:
//   • sidebar_content slot (compact viz)          options.surface: "sidebar" (default) | "both"
//   • session_prompt_right slot (one-line strip)  options.surface: "strip" | "both"
//   • /viz → full-size overlay dialog; /viz-demo plays the built-in demo
//
// Register in ~/.config/opencode/tui.json:
//   { "plugin": ["file:///abs/path/to/opencodeviz", { "surface": "sidebar" }] }
//
// No JSX / Solid compiler: we call @opentui/solid's runtime (createElement,
// setProp, createComponent) directly, exactly like compiled Solid output.
// A plain `box` becomes a canvas via { live, renderAfter } (verified in
// OpenCode 1.18.32's bundled OpenTUI).

import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui";
import { RGBA } from "@opentui/core";
import { createComponent, createElement, setProp } from "@opentui/solid";
import { OPENCODE_EVENT_TYPES, OpenCodeAdapter } from "../adapters/opencode.ts";
import { FrameCopier, type RGBAFactory, rgbaToInt } from "../backends/opentui.ts";
import { demoDuration, demoSignals } from "../core/demo.ts";
import { DEFAULT_PALETTE } from "../core/palette.ts";
import type { Signal } from "../core/protocol.ts";
import type { Arch } from "../core/registry.ts";
import { type VizOpts, renderViz } from "../core/render/viz.ts";
import { Driver } from "../core/sim/driver.ts";
import { createSim } from "../core/sim/sim.ts";
import { appendFileSync } from "node:fs";

/** Opt-in geometry/debug log: OPENCODEVIZ_DEBUG=/path/to/file (SPEC §18: slot sizes). */
const DEBUG_FILE = process.env.OPENCODEVIZ_DEBUG;
const debug = (msg: Record<string, unknown>) => {
  if (!DEBUG_FILE) return;
  try { appendFileSync(DEBUG_FILE, JSON.stringify({ t: Date.now(), ...msg }) + "\n"); } catch { /* ignore */ }
};

export type VizOptions = {
  surface?: "sidebar" | "strip" | "both";
  sidebarHeight?: number;
  asciiSafe?: boolean;
  labels?: boolean;
  /** Render rate while the model is working (default 20; the Sim still runs at 30 Hz). */
  fps?: number;
  /** Idle animation rate (default 0 = static idle frame; each frame re-renders OpenCode's whole screen). */
  idleFps?: number;
  arch?: Record<string, Arch>;
};

type Box = {
  isDestroyed?: boolean;
  requestRender(): void;
};

function parseOptions(o: unknown): Required<Omit<VizOptions, "arch">> & { arch?: Record<string, Arch> } {
  const v = (o ?? {}) as VizOptions;
  return {
    surface: v.surface === "strip" || v.surface === "both" ? v.surface : "sidebar",
    sidebarHeight: typeof v.sidebarHeight === "number" && v.sidebarHeight >= 1 ? Math.floor(v.sidebarHeight) : 14,
    asciiSafe: !!v.asciiSafe,
    labels: v.labels !== false,
    fps: typeof v.fps === "number" && v.fps >= 1 ? Math.min(30, v.fps) : 20,
    idleFps: typeof v.idleFps === "number" && v.idleFps >= 0 ? Math.min(30, v.idleFps) : 0,
    arch: v.arch,
  };
}

const tui: TuiPlugin = async (api: TuiPluginApi, options) => {
  const opts = parseOptions(options);
  const sim = createSim("opencode", opts.arch);
  const driver = new Driver(sim);
  const pal = DEFAULT_PALETTE;
  // Prefer our own @opentui/core import; fall back to the host's RGBA class (SPEC §18).
  const RGBAClass: RGBAFactory =
    typeof (RGBA as any)?.fromInts === "function" ? (RGBA as any) : ((api.theme.current.background as any).constructor as RGBAFactory);
  const copier = new FrameCopier(RGBAClass);
  const disposers: (() => void)[] = [];
  const boxes = new Set<Box>();
  const lastGeo = new Map<string, string>();
  const perf = new Map<string, { n: number; ms: number; since: number }>();

  // Demo mode suppresses live signals until the demo finishes.
  let demoUntil = 0;
  const push = (s: Signal) => {
    if (Date.now() < demoUntil) return;
    driver.push(s);
  };

  const activeSessionID = () => {
    const r = api.route.current as { name: string; params?: Record<string, unknown> };
    return r.name === "session" && typeof r.params?.sessionID === "string" ? (r.params.sessionID as string) : undefined;
  };
  const contextLimit = (providerID: string, modelID: string) =>
    (api.state.provider.find((p) => p.id === providerID)?.models as any)?.[modelID]?.limit?.context as number | undefined;

  const adapter = new OpenCodeAdapter(push, { activeSessionID, contextLimit, now: Date.now });

  // Seed model + context from what OpenCode already knows when focus lands on a session.
  let seeded: string | undefined;
  const seed = () => {
    const sid = adapter.session;
    if (!sid || sid === seeded) return;
    // Messages may not be loaded yet when focus lands: mark seeded only once
    // an assistant message is found, and retry from the pacing interval otherwise.
    try {
      const msgs = api.state.session.messages(sid) as any[];
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m?.role !== "assistant" || !m.providerID || !m.modelID) continue;
        seeded = sid;
        const ts = Date.now();
        push({ t: "model", ts, model: { providerID: m.providerID, modelID: m.modelID, contextLimit: contextLimit(m.providerID, m.modelID) } });
        const t = m.tokens;
        if (t && (t.input || t.cache?.read)) {
          // Prior output is part of the context now: fold it into the prompt, emit no output (no replay animation).
          push({
            t: "step.end",
            ts,
            usage: { input: (t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0), output: 0, reasoning: 0, cacheRead: t.cache?.read ?? 0, cacheWrite: t.cache?.write ?? 0 },
          });
        }
        break;
      }
    } catch {
      /* state not ready; the next event fills it in */
    }
  };

  for (const type of OPENCODE_EVENT_TYPES) {
    try {
      disposers.push(api.event.on(type as any, (e: any) => {
        adapter.handle(e);
        seed();
      }));
    } catch {
      /* event type not known to this build */
    }
  }

  const themeInt = (key: "background" | "backgroundPanel" | "text") =>
    rgbaToInt((api.theme.current as any)[key] as any, key === "text" ? 0xd7dae0 : pal.bg);

  function VizBox(size: { width?: number | string; height?: number | string }, bgKey: "background" | "backgroundPanel", tag: string) {
    const el = createElement("box") as any;
    setProp(el, "flexShrink", 0);
    if (size.width !== undefined) setProp(el, "width", size.width);
    else setProp(el, "flexGrow", 1);
    if (size.height !== undefined) setProp(el, "height", size.height);
    setProp(el, "renderAfter", function (this: any, buffer: any) {
      const w = Math.floor(this.width ?? 0), h = Math.floor(this.height ?? 0);
      const geo = `${this.screenX ?? this.x},${this.screenY ?? this.y},${w}x${h}`;
      if (DEBUG_FILE && geo !== lastGeo.get(tag)) {
        lastGeo.set(tag, geo);
        const par = this.parent;
        debug({ tag, x: this.x, y: this.y, screenX: this.screenX, screenY: this.screenY, w, h,
          parent: par ? { x: par.x, y: par.y, w: par.width, h: par.height } : null,
          renderer: { w: (api.renderer as any).width, h: (api.renderer as any).height } });
      }
      // Never draw past the screen; if this box overflows (dialogs are placed by the host),
      // shrink it once to fit and let the layout reflow.
      const rw = Math.floor((api.renderer as any).width ?? w), rh = Math.floor((api.renderer as any).height ?? h);
      const sx = Math.floor(this.screenX ?? this.x ?? 0), sy = Math.floor(this.screenY ?? this.y ?? 0);
      const fitH = rh - sy - 2;
      if (tag === "overlay" && h > fitH && fitH >= 8) queueMicrotask(() => setProp(el, "height", fitH));
      const dw = Math.min(w, rw - sx), dh = Math.min(h, rh - sy);
      if (dw < 1 || dh < 1) return;
      const tStart = DEBUG_FILE ? performance.now() : 0;
      driver.advanceTo(Date.now());
      const viz: VizOpts = { labels: opts.labels, asciiSafe: opts.asciiSafe, bg: themeInt(bgKey) };
      const frame = renderViz(dw, dh, sim, pal, viz);
      copier.copy(buffer, frame, sx, sy, themeInt("text"));
      if (DEBUG_FILE) {
        const st = perf.get(tag) ?? { n: 0, ms: 0, since: Date.now() };
        st.n++;
        st.ms += performance.now() - tStart;
        if (Date.now() - st.since >= 2000) {
          debug({ tag, frames: st.n, fps: +(st.n / ((Date.now() - st.since) / 1000)).toFixed(1), msPerFrame: +(st.ms / st.n).toFixed(3), cells: dw * dh });
          st.n = 0; st.ms = 0; st.since = Date.now();
        }
        perf.set(tag, st);
      }
    });
    boxes.add(el as Box);
    return el;
  }

  // Frame pacing. Every requestRender re-renders OpenCode's whole screen, so we
  // drive it ourselves instead of `live` (which renders at the host's max fps):
  // `fps` (default 20) while active, `idleFps` (default 0 = static frame) while idle.
  // Measured idle CPU (devlog): tps-meter alone 1.48%; + opencodeviz static idle 2.15%;
  // + 2 fps idle breathing 8.5%; the original `live` + 10 fps idle was 16%.
  const ACTIVE_MS = 1000 / opts.fps;
  const idleMs = opts.idleFps > 0 ? 1000 / opts.idleFps : Infinity;
  let lastRender = 0;
  let lastFocusCheck = 0;
  let wasActive = true;
  const pace = setInterval(() => {
    const now = Date.now();
    if (now - lastFocusCheck >= 100) {
      lastFocusCheck = now;
      adapter.sync();
      seed();
    }
    const active = sim.phase !== "idle" || sim.pulses.length > 0 || driver.pending > 0 || sim.bank >= 1;
    const due = active ? ACTIVE_MS : wasActive ? 0 : idleMs; // one final frame when going idle
    wasActive = active;
    if (now - lastRender < due) return;
    lastRender = now;
    for (const b of boxes) {
      if (b.isDestroyed) {
        boxes.delete(b);
        continue;
      }
      b.requestRender();
    }
  }, ACTIVE_MS);
  disposers.push(() => clearInterval(pace));

  // Slots.
  const slots: Record<string, (ctx: unknown, props: any) => any> = {};
  if (opts.surface === "sidebar" || opts.surface === "both") {
    slots.sidebar_content = () => VizBox({ height: opts.sidebarHeight }, "backgroundPanel", "sidebar");
  }
  if (opts.surface === "strip" || opts.surface === "both") {
    slots.session_prompt_right = () => VizBox({ height: 1, width: 28 }, "background", "strip");
  }
  api.slots.register({ order: 50, slots } as any);

  // /viz overlay + /viz-demo.
  let overlayOpen = false;
  const closeOverlay = () => {
    overlayOpen = false;
    api.ui.dialog.clear();
  };
  const toggleOverlay = () => {
    if (overlayOpen) return closeOverlay();
    overlayOpen = true;
    // Dialog content is placed by the host (observed: starting mid-screen), so start modest; VizBox shrinks to fit.
    const height = Math.max(12, Math.floor(((api.renderer as any).height ?? 40) * 0.45));
    api.ui.dialog.replace(
      () =>
        createComponent(api.ui.Dialog as any, {
          size: "xlarge",
          onClose: () => { overlayOpen = false; api.ui.dialog.clear(); },
          get children() {
            return VizBox({ height }, "backgroundPanel", "overlay");
          },
        }),
      () => { overlayOpen = false; },
    );
    try { api.ui.dialog.setSize("xlarge"); } catch { /* older hosts */ }
  };
  let demoTimers: ReturnType<typeof setTimeout>[] = [];
  const playDemo = () => {
    for (const t of demoTimers) clearTimeout(t);
    demoTimers = [];
    const t0 = Date.now();
    demoUntil = t0 + demoDuration("all");
    driver.push({ t: "reset", ts: t0, sessionKey: "demo" });
    for (const s of demoSignals("all", t0)) demoTimers.push(setTimeout(() => driver.push({ ...s, ts: Date.now() }), s.ts - t0));
    demoTimers.push(setTimeout(() => {
      demoUntil = 0;
      seeded = undefined;
      driver.push({ t: "reset", ts: Date.now(), sessionKey: adapter.session ?? "opencode" });
      seed();
    }, demoDuration("all")));
    if (!overlayOpen) toggleOverlay();
  };
  disposers.push(() => demoTimers.forEach(clearTimeout));

  const commands = [
    { name: "opencodeviz.toggle", title: "Toggle model visualizer", slashName: "viz", category: "View", run: toggleOverlay },
    { name: "opencodeviz.demo", title: "Model visualizer: play demo", slashName: "viz-demo", category: "View", run: playDemo },
  ];
  let registered = false;
  try {
    const km: any = (api as any).keymap;
    if (km && typeof km.registerLayer === "function") {
      const off = km.registerLayer({ commands: commands.map((c) => ({ ...c, namespace: "palette" })) });
      if (typeof off === "function") disposers.push(off);
      registered = true;
    }
  } catch {
    /* fall back below */
  }
  if (!registered && api.command) {
    const off = api.command.register(() =>
      commands.map((c) => ({ title: c.title, value: c.name, category: c.category, slash: { name: c.slashName }, onSelect: () => c.run() })),
    );
    disposers.push(off);
  }

  api.lifecycle.onDispose(() => {
    for (const d of disposers) {
      try { d(); } catch { /* ignore */ }
    }
    boxes.clear();
  });
};

const plugin: TuiPluginModule = { id: "opencodeviz", tui };
export default plugin;
