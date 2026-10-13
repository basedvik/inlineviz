// Pure parsers that turn real model metadata into an Arch (no I/O; the host
// fetches, these interpret). Sources, most exact first:
//   • Hugging Face config.json            → layers, experts, active, shared, attention pattern
//   • Ollama /api/show model_info          → layers, experts, active, shared (GGUF keys)
//   • OpenAI-compatible /v1/models `meta`  → mlx-serve: num_layers + is_moe; llama.cpp: nothing usable
// See mergeArch for how a partial server answer combines with Hugging Face.

import type { Arch } from "./registry.ts";

type Json = Record<string, any>;

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);
const first = (...vs: unknown[]): number | undefined => {
  for (const v of vs) {
    const n = num(v);
    if (n !== undefined) return n;
  }
  return undefined;
};

/** 1-based indices of full-attention layers from a HF `layer_types` list (hybrid-attention models). */
function fullAttention(layerTypes: unknown): number[] | undefined {
  if (!Array.isArray(layerTypes) || !layerTypes.length) return undefined;
  const idx = layerTypes.flatMap((t, i) => (typeof t === "string" && /full/i.test(t) ? [i + 1] : []));
  // Only interesting when the model actually mixes attention types.
  return idx.length && idx.length < layerTypes.length ? idx : undefined;
}

/** Hugging Face `config.json` (handles multimodal `text_config` wrappers). */
export function archFromHFConfig(cfg: unknown, family?: string): Arch | undefined {
  if (!cfg || typeof cfg !== "object") return undefined;
  const top = cfg as Json;
  const t: Json = top.text_config && typeof top.text_config === "object" ? top.text_config : top;
  const pick = (...keys: string[]) => first(...keys.map((k) => t[k]), ...keys.map((k) => top[k]));
  const layers = pick("num_hidden_layers", "n_layer", "num_layers", "n_layers");
  if (!layers) return undefined;
  const fam = family ?? String(t.model_type ?? top.model_type ?? "hf");
  const experts = pick("num_experts", "num_local_experts", "n_routed_experts", "moe_num_experts", "n_experts");
  const active = pick("num_experts_per_tok", "num_selected_experts", "moe_top_k", "moe_topk", "top_k_experts");
  const fa = fullAttention(t.layer_types ?? top.layer_types);
  if (experts && experts > 1 && active) {
    const shared =
      first(t.n_shared_experts, t.num_shared_experts, top.n_shared_experts) ??
      (num(t.shared_expert_intermediate_size ?? top.shared_expert_intermediate_size) ? 1 : 0);
    return { kind: "moe", family: fam, layers, experts, active, shared, source: "hf", ...(fa ? { fullAttention: fa } : {}) };
  }
  return { kind: "dense", family: fam, layers, source: "hf", ...(fa ? { fullAttention: fa } : {}) };
}

/** Ollama `/api/show` response (`model_info` uses GGUF keys like `qwen3moe.block_count`). */
export function archFromOllamaShow(show: unknown, family?: string): Arch | undefined {
  const info = (show as Json)?.model_info;
  if (!info || typeof info !== "object") return undefined;
  const find = (suffix: string) => {
    for (const [k, v] of Object.entries(info as Json)) if (k.endsWith(suffix)) return num(v);
    return undefined;
  };
  const layers = find(".block_count");
  if (!layers) return undefined;
  const arch = String((info as Json)["general.architecture"] ?? family ?? "ollama");
  const experts = find(".expert_count");
  const active = find(".expert_used_count");
  if (experts && experts > 1 && active) {
    return { kind: "moe", family: family ?? arch, layers, experts, active, shared: find(".expert_shared_count") ?? 0, source: "server" };
  }
  return { kind: "dense", family: family ?? arch, layers, source: "server" };
}

/**
 * The `meta` object of an OpenAI-compatible `/v1/models` entry. mlx-serve reports `num_layers` +
 * `is_moe` (exact for dense; MoE still needs expert counts from elsewhere). llama.cpp's meta has
 * no layer count, so it yields nothing.
 */
export function archFromServerMeta(meta: unknown, family?: string): { arch?: Arch; layers?: number; isMoe?: boolean } {
  if (!meta || typeof meta !== "object") return {};
  const m = meta as Json;
  const layers = first(m.num_layers, m.n_layer, m.num_hidden_layers, m.block_count);
  const isMoe = typeof m.is_moe === "boolean" ? m.is_moe : undefined;
  const experts = first(m.num_experts, m.expert_count);
  const active = first(m.num_experts_per_tok, m.expert_used_count);
  const fam = family ?? String(m.architecture ?? "server");
  if (layers && experts && experts > 1 && active) {
    return { arch: { kind: "moe", family: fam, layers, experts, active, shared: first(m.n_shared_experts, m.expert_shared_count) ?? 0, source: "server" }, layers, isMoe: true };
  }
  if (layers && isMoe === false) return { arch: { kind: "dense", family: fam, layers, source: "server" }, layers, isMoe };
  return { layers, isMoe };
}

/**
 * Combine a (possibly partial) server answer with Hugging Face. The server describes what is
 * actually loaded, so it wins on layer count; Hugging Face fills in expert details it lacks.
 * A server that says "dense" wins over an HF config that says MoE, and vice versa.
 */
export function mergeArch(server: ReturnType<typeof archFromServerMeta> | undefined, hf: Arch | undefined): Arch | undefined {
  if (server?.arch) return server.arch;
  if (!hf) return undefined;
  if (hf.kind === "unknown") return hf;
  const layers = server?.layers ?? hf.layers;
  if (server?.isMoe === false) return { kind: "dense", family: hf.family, layers, source: "server", ...(hf.fullAttention ? { fullAttention: hf.fullAttention } : {}) };
  if (server?.isMoe === true && hf.kind === "dense") return undefined; // contradictory; don't guess
  return { ...hf, layers };
}

/** Does this model ID look like a Hugging Face repo ID (`org/name`)? */
export function looksLikeHFRepo(modelID: string): boolean {
  return /^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/.test(modelID) && !modelID.includes("..");
}
