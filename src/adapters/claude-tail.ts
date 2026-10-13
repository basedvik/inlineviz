// `inlineviz claude`: follow Claude Code sessions (I/O side; mapping lives in claude.ts).
//
// Tails the hook event file written by claude/hook.mjs and the followed session's transcript,
// polling byte offsets (works in Node and Bun; fs.watch is unreliable across platforms).

import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SignalSink } from "../core/protocol.ts";
import { ClaudeAdapter, type HookRecord } from "./claude.ts";

/** Where the hook writes: explicit path, the plugin data dir(s) (newest wins), or the fallback. */
export function findEventsFile(explicit?: string, home: string = homedir()): string {
  if (explicit) return explicit;
  const candidates: string[] = [];
  if (process.env.CLAUDE_PLUGIN_DATA) candidates.push(join(process.env.CLAUDE_PLUGIN_DATA, "events.ndjson"));
  const dataRoot = join(home, ".claude", "plugins", "data");
  try {
    for (const d of readdirSync(dataRoot)) if (/inlineviz/i.test(d)) candidates.push(join(dataRoot, d, "events.ndjson"));
  } catch {
    /* no plugin data yet */
  }
  candidates.push(join(home, ".claude", "inlineviz", "events.ndjson"));
  let best = candidates[candidates.length - 1];
  let bestM = -1;
  for (const c of candidates) {
    try {
      const m = statSync(c).mtimeMs;
      if (m > bestM) { bestM = m; best = c; }
    } catch {
      /* missing */
    }
  }
  return best;
}

function readRange(path: string, from: number, to: number): string {
  const len = Math.max(0, to - from);
  if (!len) return "";
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(len);
    const n = readSync(fd, buf, 0, len, from);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return -1;
  }
}

function parseLines(text: string): any[] {
  const out: any[] = [];
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s));
    } catch {
      /* partial or foreign line */
    }
  }
  return out;
}

/** Incremental line reader over a growing file (handles truncation / rotation). */
class Follower {
  private offset = 0;
  private rest = "";
  constructor(readonly path: string, startAtEnd: boolean) {
    if (startAtEnd) this.offset = Math.max(0, sizeOf(path));
  }
  poll(): any[] {
    const size = sizeOf(this.path);
    if (size < 0) return [];
    if (size < this.offset) {
      this.offset = 0;
      this.rest = "";
    }
    if (size === this.offset) return [];
    const chunk = this.rest + readRange(this.path, this.offset, size);
    this.offset = size;
    const cut = chunk.lastIndexOf("\n");
    if (cut < 0) {
      this.rest = chunk;
      return [];
    }
    this.rest = chunk.slice(cut + 1);
    return parseLines(chunk.slice(0, cut));
  }
}

export interface FollowOpts {
  events?: string;
  sessionID?: string;
  push: SignalSink;
  now(): number;
  pollMs?: number;
  /** Home folder to search (tests); defaults to the user's. */
  home?: string;
  /** Replay the in-progress turn on startup if its last event is this recent. */
  resumeWindowMs?: number;
}

export function followClaude(o: FollowOpts): { stop(): void; readonly eventsPath: string } {
  const adapter = new ClaudeAdapter(o.push, { now: o.now, sessionID: o.sessionID });
  let transcript: Follower | undefined;
  let eventsPath = "";
  let events: Follower | undefined;

  const followTranscript = () => {
    const tp = adapter.transcriptPath;
    if (!tp || transcript?.path === tp || !existsSync(tp)) return;
    // Seed context from the history already in the transcript, then follow only new lines.
    const size = sizeOf(tp);
    adapter.seedFromTranscript(parseLines(readRange(tp, Math.max(0, size - 2_000_000), size)));
    transcript = new Follower(tp, true);
  };

  /** (Re)attach to an events file: learn recent sessions, focus the latest, replay its unfinished turn. */
  const attach = (path: string) => {
    eventsPath = path;
    const size = Math.max(0, sizeOf(path));
    const recent = parseLines(readRange(path, Math.max(0, size - 512_000), size)) as HookRecord[];
    for (const r of recent) adapter.learn(r);
    const pick = o.sessionID ?? [...recent].reverse().find((r) => r.e === "UserPromptSubmit" || r.e === "SessionStart")?.sid ?? recent[recent.length - 1]?.sid;
    if (pick) {
      adapter.focus(pick);
      followTranscript();
      const mine = recent.filter((r) => r.sid === pick);
      let lastStop = -1;
      mine.forEach((r, i) => { if ((r.e === "Stop" && !r.aid) || r.e === "SessionEnd") lastStop = i; });
      const tail = mine.slice(lastStop + 1);
      const window = o.resumeWindowMs ?? 15 * 60_000;
      if (tail.length && o.now() - tail[tail.length - 1].t < window) for (const r of tail) adapter.handleHook(r);
    }
    events = new Follower(path, true);
  };
  attach(findEventsFile(o.events, o.home));

  // The plugin's data folder may not exist yet (viewer opened before the first hook ever ran),
  // or a newer one may appear (plugin reinstalled): keep looking, and switch when it changes.
  let polls = 0;
  const timer = setInterval(() => {
    if (!o.events && ++polls % 20 === 0) {
      const found = findEventsFile(undefined, o.home);
      if (found !== eventsPath && sizeOf(found) >= 0) attach(found);
    }
    for (const r of events?.poll() ?? []) {
      adapter.handleHook(r as HookRecord);
      followTranscript();
    }
    if (transcript) for (const e of transcript.poll()) adapter.handleTranscript(e);
    else followTranscript();
  }, o.pollMs ?? 100);

  return {
    get eventsPath() { return eventsPath; },
    stop: () => clearInterval(timer),
  };
}
