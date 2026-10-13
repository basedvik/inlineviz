// Architecture discovery: pure parsers against REAL metadata (fixtures fetched 2026-10-13 from
// huggingface.co and the user's mlx-serve), plus the discovery chain with a fake fetch.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { discoverArch } from "../src/adapters/discover.ts";
import { archFromHFConfig, archFromOllamaShow, archFromServerMeta, looksLikeHFRepo, mergeArch } from "../src/core/archparse.ts";
import { isSignal } from "../src/core/protocol.ts";
import { archFor } from "../src/core/registry.ts";
import { DEFAULT_PALETTE as PAL } from "../src/core/palette.ts";
import { DEFAULT_VIZ_OPTS as OPTS, renderViz } from "../src/core/render/viz.ts";
import { applySignal, createSim } from "../src/core/sim/sim.ts";

const fx = (name: string) => JSON.parse(readFileSync(join(import.meta.dir, "fixtures", name), "utf8"));
const hf = (repo: string) => fx(`hf/${repo.replace("/", "_")}.json`);

describe("archFromHFConfig (real configs)", () => {
  test("Qwen3.8-27B bf16 is dense, 64 layers, hybrid attention (16 full-attention layers)", () => {
    const a = archFromHFConfig(hf("mlx-community/Qwen3.8-27B-bf16"))!;
    expect(a).toMatchObject({ kind: "dense", layers: 64, source: "hf" });
    expect(a.kind !== "unknown" && a.fullAttention).toEqual([4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 60, 64]);
  });

  test("Qwen3.8 Flash-Next is MoE 512 experts / 10 active / shared, 48 layers", () => {
    expect(archFromHFConfig(hf("ddalcu/Qwen3.8-Flash-Next-MLX-Serve-mixed-4-8bit"))).toMatchObject({
      kind: "moe", layers: 48, experts: 512, active: 10, shared: 1, source: "hf",
    });
  });

  test("DeepSeek-V3 matches its model card (61L, 256 routed, 8 active, 1 shared)", () => {
    expect(archFromHFConfig(hf("deepseek-ai/DeepSeek-V3"))).toMatchObject({ kind: "moe", layers: 61, experts: 256, active: 8, shared: 1 });
  });

  test("Qwen3-30B-A3B matches the registry table (48L, 128e, 8a)", () => {
    const parsed = archFromHFConfig(hf("Qwen/Qwen3-30B-A3B"));
    expect(parsed).toMatchObject({ kind: "moe", layers: 48, experts: 128, active: 8 });
    expect(archFor({ providerID: "p", modelID: "qwen3-30b-a3b" })).toMatchObject({ kind: "moe", layers: 48, experts: 128, active: 8 });
  });

  test("Mixtral-style keys and junk input", () => {
    expect(archFromHFConfig({ num_hidden_layers: 32, num_local_experts: 8, num_experts_per_tok: 2, model_type: "mixtral" }))
      .toMatchObject({ kind: "moe", layers: 32, experts: 8, active: 2, shared: 0 });
    expect(archFromHFConfig({ hidden_size: 1 })).toBeUndefined();
    expect(archFromHFConfig(null)).toBeUndefined();
    expect(archFromHFConfig("nope")).toBeUndefined();
  });
});

describe("server metadata", () => {
  test("mlx-serve meta (real): dense 64L for the 27B", () => {
    const meta = fx("mlxserve-models.json").data[0].meta;
    expect(archFromServerMeta(meta)).toMatchObject({ arch: { kind: "dense", layers: 64, source: "server" }, layers: 64, isMoe: false });
  });

  test("mlx-serve MoE meta is partial (needs experts from elsewhere)", () => {
    const r = archFromServerMeta({ architecture: "qwen4_exp", num_layers: 48, is_moe: true });
    expect(r.arch).toBeUndefined();
    expect(r).toMatchObject({ layers: 48, isMoe: true });
  });

  test("llama.cpp meta has no layer count → nothing", () => {
    expect(archFromServerMeta({ n_vocab: 248320, n_ctx_train: 262144, n_embd: 2048, n_params: 35505251456 })).toEqual({});
  });

  test("Ollama /api/show model_info (GGUF keys)", () => {
    expect(archFromOllamaShow({ model_info: { "general.architecture": "qwen3moe", "qwen3moe.block_count": 48, "qwen3moe.expert_count": 128, "qwen3moe.expert_used_count": 8 } }))
      .toMatchObject({ kind: "moe", layers: 48, experts: 128, active: 8, shared: 0, source: "server" });
    expect(archFromOllamaShow({ model_info: { "general.architecture": "llama", "llama.block_count": 32 } })).toMatchObject({ kind: "dense", layers: 32 });
    expect(archFromOllamaShow({})).toBeUndefined();
  });

  test("mergeArch: server layers + HF experts; server 'dense' wins; contradiction → undefined", () => {
    const moeHF = archFromHFConfig(hf("ddalcu/Qwen3.8-Flash-Next-MLX-Serve-mixed-4-8bit"))!;
    expect(mergeArch({ layers: 48, isMoe: true }, moeHF)).toMatchObject({ kind: "moe", layers: 48, experts: 512 });
    expect(mergeArch({ layers: 64, isMoe: false }, moeHF)).toMatchObject({ kind: "dense", layers: 64, source: "server" });
    const denseHF = archFromHFConfig(hf("mlx-community/Qwen3.8-27B-bf16"))!;
    expect(mergeArch({ layers: 64, isMoe: true }, denseHF)).toBeUndefined();
    expect(mergeArch(undefined, undefined)).toBeUndefined();
  });

  test("looksLikeHFRepo", () => {
    expect(looksLikeHFRepo("mlx-community/Qwen3.8-27B-bf16")).toBe(true);
    expect(looksLikeHFRepo("qwen3.8-27b")).toBe(false);
    expect(looksLikeHFRepo("a/b/c")).toBe(false);
    expect(looksLikeHFRepo("../etc")).toBe(false);
  });
});

/** Fake fetch over a URL → JSON map; records every URL and init it was called with. */
function fakeFetch(routes: Record<string, unknown>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (!(url in routes)) return new Response("nope", { status: 404 });
    return new Response(JSON.stringify(routes[url]), { status: 200 });
  };
  return { f, calls };
}

describe("discoverArch chain", () => {
  const HF_27B = "https://huggingface.co/mlx-community/Qwen3.8-27B-bf16/raw/main/config.json";
  const HF_FN = "https://huggingface.co/ddalcu/Qwen3.8-Flash-Next-MLX-Serve-mixed-4-8bit/raw/main/config.json";

  test("mlx-serve answers (dense) → server shape wins; HF only adds the attention pattern", async () => {
    const { f } = fakeFetch({ "http://studio:11234/v1/models": fx("mlxserve-models.json"), [HF_27B]: hf("mlx-community/Qwen3.8-27B-bf16") });
    const a = await discoverArch({ providerID: "flashnext", modelID: "mlx-community/Qwen3.8-27B-bf16", baseURL: "http://studio:11234/v1" }, { fetch: f, lookup: "all", now: () => 0 });
    expect(a).toMatchObject({ kind: "dense", layers: 64, source: "server" });
    expect(a!.kind !== "unknown" && a!.fullAttention?.length).toBe(16);
  });

  test("HF attention pattern is ignored when HF disagrees with the server", async () => {
    const { f } = fakeFetch({
      "http://studio:11234/v1/models": { data: [{ id: "mlx-community/Qwen3.8-27B-bf16", meta: { num_layers: 60, is_moe: false } }] },
      [HF_27B]: hf("mlx-community/Qwen3.8-27B-bf16"),
    });
    const a = await discoverArch({ providerID: "p", modelID: "mlx-community/Qwen3.8-27B-bf16", baseURL: "http://studio:11234/v1" }, { fetch: f, lookup: "all", now: () => 0 });
    expect(a).toMatchObject({ kind: "dense", layers: 60 });
    expect(a!.kind !== "unknown" && a!.fullAttention).toBeUndefined();
  });

  test("lookup 'server': mlx-serve shape without any Hugging Face request", async () => {
    const { f, calls } = fakeFetch({ "http://studio:11234/v1/models": fx("mlxserve-models.json") });
    const a = await discoverArch({ providerID: "p", modelID: "mlx-community/Qwen3.8-27B-bf16", baseURL: "http://studio:11234/v1" }, { fetch: f, lookup: "server", now: () => 0 });
    expect(a).toMatchObject({ kind: "dense", layers: 64 });
    expect(calls.some((c) => c.url.includes("huggingface"))).toBe(false);
  });

  test("server says MoE (partial) → Hugging Face fills in experts", async () => {
    const { f } = fakeFetch({
      "http://studio:11234/v1/models": { data: [{ id: "ddalcu/Qwen3.8-Flash-Next-MLX-Serve-mixed-4-8bit", meta: { num_layers: 48, is_moe: true } }] },
      [HF_FN]: hf("ddalcu/Qwen3.8-Flash-Next-MLX-Serve-mixed-4-8bit"),
    });
    const a = await discoverArch({ providerID: "flashnext", modelID: "ddalcu/Qwen3.8-Flash-Next-MLX-Serve-mixed-4-8bit", baseURL: "http://studio:11234/v1/" }, { fetch: f, lookup: "all", now: () => 0 });
    expect(a).toMatchObject({ kind: "moe", layers: 48, experts: 512, active: 10, shared: 1 });
  });

  test("lookup 'server' never contacts Hugging Face; 'off' contacts nothing", async () => {
    const a = fakeFetch({ [HF_27B]: hf("mlx-community/Qwen3.8-27B-bf16") });
    expect(await discoverArch({ providerID: "x", modelID: "mlx-community/Qwen3.8-27B-bf16" }, { fetch: a.f, lookup: "server", now: () => 0 })).toBeUndefined();
    expect(a.calls.length).toBe(0);
    const b = fakeFetch({});
    expect(await discoverArch({ providerID: "x", modelID: "m", baseURL: "http://h/v1" }, { fetch: b.f, lookup: "off", now: () => 0 })).toBeUndefined();
    expect(b.calls.length).toBe(0);
  });

  test("Ollama path only POSTs after /api/version identifies Ollama; no auth headers sent", async () => {
    const { f, calls } = fakeFetch({
      "http://box:11434/v1/models": { data: [{ id: "qwen3:30b-a3b" }] },
      "http://box:11434/api/version": { version: "0.12.0" },
      "http://box:11434/api/show": { model_info: { "qwen3moe.block_count": 48, "qwen3moe.expert_count": 128, "qwen3moe.expert_used_count": 8 } },
    });
    const a = await discoverArch({ providerID: "ollama", modelID: "qwen3:30b-a3b", baseURL: "http://box:11434/v1" }, { fetch: f, lookup: "all", now: () => 0 });
    expect(a).toMatchObject({ kind: "moe", experts: 128, source: "server" });
    expect(calls.map((c) => c.url)).toEqual(["http://box:11434/v1/models", "http://box:11434/api/version", "http://box:11434/api/show"]);
    for (const c of calls) expect(JSON.stringify(c.init?.headers ?? {})).not.toMatch(/authorization|api-key/i);
  });

  test("network failure → undefined, and the miss is cached (no refetch within a day)", async () => {
    const cache = new Map<string, unknown>();
    const c = { get: (k: string) => cache.get(k), set: (k: string, v: unknown) => void cache.set(k, v) };
    let n = 0;
    const boom = async () => { n++; throw new Error("offline"); };
    const deps = { fetch: boom as any, lookup: "all" as const, cache: c };
    expect(await discoverArch({ providerID: "x", modelID: "org/model", baseURL: "http://h/v1" }, { ...deps, now: () => 0 })).toBeUndefined();
    const first = n;
    expect(await discoverArch({ providerID: "x", modelID: "org/model", baseURL: "http://h/v1" }, { ...deps, now: () => 3600_000 })).toBeUndefined();
    expect(n).toBe(first);
    await discoverArch({ providerID: "x", modelID: "org/model", baseURL: "http://h/v1" }, { ...deps, now: () => 2 * 86_400_000 });
    expect(n).toBeGreaterThan(first);
  });

  test("a cached hit is returned without fetching", async () => {
    const cache = new Map<string, unknown>([["inlineviz.arch:p/org/m", { at: 0, arch: { kind: "dense", family: "x", layers: 7, source: "hf" } }]]);
    const { f, calls } = fakeFetch({});
    const a = await discoverArch({ providerID: "p", modelID: "org/m" }, { fetch: f, lookup: "all", now: () => 1000, cache: { get: (k) => cache.get(k), set: () => {} } });
    expect(a).toMatchObject({ layers: 7 });
    expect(calls.length).toBe(0);
  });
});

describe("arch signal → Sim → HUD", () => {
  const model = { providerID: "flashnext", modelID: "mlx-community/Qwen3.8-27B-bf16", contextLimit: 262144 };
  const arch = archFromHFConfig(hf("mlx-community/Qwen3.8-27B-bf16"))!;

  test("isSignal accepts arch signals", () => {
    expect(isSignal({ t: "arch", ts: 1, modelID: "m", arch })).toBe(true);
    expect(isSignal({ t: "arch", ts: 1, modelID: "m", arch: { kind: "bogus" } })).toBe(false);
  });

  test("discovered arch replaces 'unknown' and shows provenance in the HUD", () => {
    const s = createSim("t");
    applySignal(s, { t: "model", ts: 0, model });
    expect(s.arch.kind).toBe("unknown");
    applySignal(s, { t: "arch", ts: 0, modelID: model.modelID, arch });
    expect(s.arch).toMatchObject({ kind: "dense", layers: 64 });
    const top = renderViz(110, 30, s, PAL, OPTS).toText().split("\n")[0];
    expect(top).toContain("dense · 64L · via HF");
    expect(renderViz(110, 30, s, PAL, OPTS).toText()).not.toContain("architecture unknown");
  });

  test("user override still wins over discovery; discovery survives a session reset", () => {
    const s = createSim("t", { "qwen3\\.8-27b": { kind: "dense", family: "mine", layers: 99 } });
    applySignal(s, { t: "arch", ts: 0, modelID: model.modelID, arch });
    applySignal(s, { t: "model", ts: 0, model });
    expect(s.arch).toMatchObject({ layers: 99, source: "override" });
    const s2 = createSim("t");
    applySignal(s2, { t: "arch", ts: 0, modelID: model.modelID, arch });
    applySignal(s2, { t: "reset", ts: 0, sessionKey: "other" });
    applySignal(s2, { t: "model", ts: 0, model });
    expect(s2.arch).toMatchObject({ kind: "dense", layers: 64 });
  });
});
