// Architecture discovery (host side: does network I/O; parsing lives in core/archparse.ts).
//
// Order, most exact first (the user's `arch` override is applied later, in the Sim):
//   1. The serving runtime at the provider's baseURL: OpenAI-compatible `GET /models` meta
//      (mlx-serve: layers + is_moe), then Ollama `POST /api/show` (only if `GET /api/version`
//      answers like Ollama).
//   2. Hugging Face `config.json`, when the modelID looks like a repo ID (`org/name`): the full
//      shape if the server gave none, otherwise only the attention-layer pattern (if it agrees).
// Privacy: no API keys or auth headers are ever sent. The only thing that leaves the user's own
// servers is the model ID, in the Hugging Face URL (disable with lookup "server" or "off").
// Results (including misses) are cached: hits for 7 days, misses for 1 day.

import { archFromHFConfig, archFromOllamaShow, archFromServerMeta, looksLikeHFRepo, mergeArch } from "../core/archparse.ts";
import type { Arch } from "../core/registry.ts";

export type ArchLookup = "all" | "server" | "off";

export interface DiscoverDeps {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  lookup: ArchLookup;
  now(): number;
  timeoutMs?: number;
  cache?: { get(key: string): unknown; set(key: string, value: unknown): void };
  log?: (msg: Record<string, unknown>) => void;
}

export interface DiscoverInput {
  providerID: string;
  modelID: string;
  /** Provider baseURL from OpenCode's config (custom / local providers), if any. */
  baseURL?: string;
}

const DAY = 24 * 3600 * 1000;
const TTL_HIT = 7 * DAY;
const TTL_MISS = DAY;

type Cached = { at: number; arch?: Arch };

export async function discoverArch(input: DiscoverInput, deps: DiscoverDeps): Promise<Arch | undefined> {
  if (deps.lookup === "off") return undefined;
  const key = `inlineviz.arch:${input.providerID}/${input.modelID}`;
  const cached = deps.cache?.get(key) as Cached | undefined;
  if (cached && typeof cached.at === "number" && deps.now() - cached.at < (cached.arch ? TTL_HIT : TTL_MISS)) {
    deps.log?.({ tag: "arch", modelID: input.modelID, from: "cache", arch: cached.arch ?? null });
    return cached.arch;
  }

  const timeout = deps.timeoutMs ?? 4000;
  const getJson = async (url: string, init?: RequestInit): Promise<any> => {
    try {
      const res = await deps.fetch(url, { ...init, signal: AbortSignal.timeout(timeout) });
      if (!res.ok) return undefined;
      return await res.json();
    } catch {
      return undefined;
    }
  };

  let server: ReturnType<typeof archFromServerMeta> | undefined;
  const base = input.baseURL?.replace(/\/+$/, "");
  if (base && /^https?:\/\//.test(base)) {
    const list = await getJson(`${base}/models`);
    const entry = Array.isArray(list?.data) ? list.data.find((m: any) => m?.id === input.modelID) : undefined;
    if (entry?.meta) server = archFromServerMeta(entry.meta);
    if (!server?.arch) {
      const origin = new URL(base).origin;
      const version = await getJson(`${origin}/api/version`);
      if (version && typeof version.version === "string") {
        const show = await getJson(`${origin}/api/show`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: input.modelID }),
        });
        const o = archFromOllamaShow(show);
        if (o) server = { arch: o, layers: o.kind === "unknown" ? undefined : o.layers };
      }
    }
  }

  // Hugging Face: the shape when the server couldn't give one, or, when it could, just the
  // attention pattern (servers don't report it), and only if HF agrees on kind and layer count.
  let hf: Arch | undefined;
  if (deps.lookup === "all" && looksLikeHFRepo(input.modelID)) {
    hf = archFromHFConfig(await getJson(`https://huggingface.co/${input.modelID}/raw/main/config.json`));
  }

  let arch = mergeArch(server, hf);
  if (arch && server?.arch && hf && hf.kind === arch.kind && arch.kind !== "unknown" && hf.kind !== "unknown" &&
      hf.layers === arch.layers && hf.fullAttention && !arch.fullAttention) {
    arch = { ...arch, fullAttention: hf.fullAttention };
  }
  deps.cache?.set(key, { at: deps.now(), ...(arch ? { arch } : {}) } satisfies Cached);
  deps.log?.({ tag: "arch", modelID: input.modelID, from: arch?.source ?? "none", arch: arch ?? null });
  return arch;
}
