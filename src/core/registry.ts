// Architecture registry (SPEC §8): model ID → real shape from public model cards.
//
// Ordered rules, first match wins, so specific rules come before general ones.
// Values come from HF config.json / model cards as of 2026-10; entries marked
// `note: "verify"` were not re-checked against the source.

import type { ModelRef } from "./protocol.ts";

/** Where an Arch came from, most exact first. */
export type ArchSource = "override" | "server" | "hf" | "table";

export type Arch =
  | { kind: "moe"; family: string; layers: number; experts: number; active: number; shared: number; note?: string; source?: ArchSource; fullAttention?: number[] }
  | { kind: "dense"; family: string; layers: number; note?: string; source?: ArchSource; fullAttention?: number[] }
  | { kind: "unknown"; family: string; note?: string; source?: ArchSource };

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

/**
 * Resolve a model's architecture: user override → discovered (server / Hugging Face) → curated
 * table → unknown. `discovered` is keyed by the raw modelID.
 */
export function archFor(
  model: ModelRef | undefined,
  overrides?: Readonly<Record<string, Arch>>,
  discovered?: ReadonlyMap<string, Arch>,
): Arch {
  if (!model) return UNKNOWN;
  const id = normalizeModelID(model.modelID);
  if (overrides) {
    for (const [pat, arch] of Object.entries(overrides)) {
      try {
        if (new RegExp(pat, "i").test(id) || new RegExp(pat, "i").test(model.modelID)) return { ...arch, source: "override" } as Arch;
      } catch {
        /* invalid user regex: ignore */
      }
    }
  }
  const found = discovered?.get(model.modelID);
  if (found && found.kind !== "unknown") return found;
  for (const r of RULES) if (r.re.test(id)) return { ...r.arch, source: "table" } as Arch;
  return UNKNOWN;
}

// Trailing tokens that don't help tell models apart at a glance: precision / quantization /
// packaging / finetune-flavor suffixes. Stripped repeatedly from the END only.
const NOISE_SUFFIX =
  /-(?:bf16|fp16|f16|fp32|fp8|f8|int8|int4|w\d+a\d+|\d+(?:\.\d+)?bpw|\d+-?bits?|q\d+(?:_k)?(?:_[a-z0-9]+)*|iq\d+[a-z0-9_]*|awq|gptq|exl2|gguf|mlx|serve|mixed(?:-\d+)*|dwq|ud|mtp|instruct|chat|it|hf|uncensored|abliterated|heretic|preserved|native)$/i;

/**
 * A compact display name for narrow layouts: provider prefix and noise suffixes removed,
 * e.g. "mlx-community/Qwen3.8-27B-bf16" → "qwen3.8-27b",
 * "ddalcu/Qwen3.8-Flash-Next-MLX-Serve-mixed-4-8bit" → "qwen3.8-flash-next".
 */
export function shortModelName(modelID: string): string {
  let s = normalizeModelID(modelID);
  for (let i = 0; i < 12; i++) {
    const next = s.replace(NOISE_SUFFIX, "");
    if (next === s || next.length < 4) break;
    s = next;
  }
  return s;
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
