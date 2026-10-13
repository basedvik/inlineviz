// NDJSON ↔ Signals. One Signal per line; lines starting with # are comments.

import { type Signal, isSignal } from "../core/protocol.ts";

export function parseNdjsonLine(line: string): Signal | undefined {
  const s = line.trim();
  if (!s || s.startsWith("#")) return undefined;
  try {
    const v = JSON.parse(s);
    return isSignal(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

export function toNdjson(signals: Signal[]): string {
  return signals.map((s) => JSON.stringify(s)).join("\n") + "\n";
}
