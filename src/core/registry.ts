// Architecture registry (SPEC §8): model ID → real shape from public model cards.
//
// Ordered rules, first match wins, so specific rules come before general ones.
// Values come from HF config.json / model cards as of 2026-10; entries marked
// `note: "verify"` were not re-checked against the source.

import type { ModelRef } from "./protocol.ts";

export type Arch =
  | { kind: "moe"; family: string; layers: number; experts: number; active: number; shared: number; note?: string }
  | { kind: "dense"; family: string; layers: number; note?: string }
  | { kind: "unknown"; family: string; note?: string };

type Rule = { re: RegExp; arch: Arch };

const moe = (family: string, layers: number, experts: number, active: number, shared: number, note?: string): Arch =>
  ({ kind: "moe", family, layers, experts, active, shared, ...(note ? { note } : {}) });
const dense = (family: string, layers: number, note?: string): Arch =>
  ({ kind: "dense", family, layers, ...(note ? { note } : {}) });
const unknown = (family: string, note?: string): Arch => ({ kind: "unknown", family, ...(note ? { note } : {}) });

export const RULES: readonly Rule[] = [
  { re: /deepseek.*(v3|r1|chat|reasoner)/, arch: moe("deepseek-v3", 61, 256, 8, 1, "first 3 layers dense") },
  { re: /kimi-k2/, arch: moe("kimi-k2", 61, 384, 8, 1) },
  { re: /qwen3-coder.*480b/, arch: moe("qwen3-coder-480b", 62, 160, 8, 0) },
  { re: /qwen3.*235b/, arch: moe("qwen3-235b", 94, 128, 8, 0) },
  { re: /qwen3.*30b-a3b/, arch: moe("qwen3-30b-a3b", 48, 128, 8, 0) },
  { re: /gpt-oss-120b/, arch: moe("gpt-oss-120b", 36, 128, 4, 0) },
  { re: /gpt-oss-20b/, arch: moe("gpt-oss-20b", 24, 32, 4, 0) },
  { re: /mixtral.*8x22b/, arch: moe("mixtral-8x22b", 56, 8, 2, 0) },
  { re: /mixtral.*8x7b/, arch: moe("mixtral-8x7b", 32, 8, 2, 0) },
  { re: /llama-4-maverick/, arch: moe("llama-4-maverick", 48, 128, 1, 1, "alternating dense/MoE layers") },
  { re: /llama-4-scout/, arch: moe("llama-4-scout", 48, 16, 1, 1) },
  { re: /glm-4\.5(?!-air)/, arch: moe("glm-4.5", 92, 160, 8, 1, "verify") },
  { re: /llama-?3.*405b/, arch: dense("llama-3-405b", 126) },
  { re: /llama-?3.*70b/, arch: dense("llama-3-70b", 80) },
  { re: /llama-?3.*8b/, arch: dense("llama-3-8b", 32) },
  { re: /qwen2\.5-coder.*32b/, arch: dense("qwen2.5-coder-32b", 64) },
  { re: /claude|gpt-[45]|^o[134]|gemini|grok/, arch: unknown("closed", "closed weights") },
];

export const UNKNOWN: Arch = unknown("unknown");

/** Lowercase and strip any `provider/` prefix: "Qwen/Qwen3-235B-A22B" → "qwen3-235b-a22b". */
export function normalizeModelID(id: string): string {
  const s = id.toLowerCase();
  const i = s.lastIndexOf("/");
  return i >= 0 ? s.slice(i + 1) : s;
}

export function archFor(model: ModelRef | undefined, overrides?: Readonly<Record<string, Arch>>): Arch {
  if (!model) return UNKNOWN;
  const id = normalizeModelID(model.modelID);
  if (overrides) {
    for (const [pat, arch] of Object.entries(overrides)) {
      try {
        if (new RegExp(pat, "i").test(id)) return arch;
      } catch {
        /* invalid user regex: ignore */
      }
    }
  }
  for (const r of RULES) if (r.re.test(id)) return r.arch;
  return UNKNOWN;
}

/** Short header text: "MoE 128e/8a · 94L", "dense · 80L", "arch unknown". */
export function archSummary(a: Arch): string {
  switch (a.kind) {
    case "moe":
      return `MoE ${a.experts}e/${a.active}a · ${a.layers}L`;
    case "dense":
      return `dense · ${a.layers}L`;
    default:
      return "arch unknown";
  }
}
