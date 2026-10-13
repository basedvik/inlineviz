import { describe, expect, test } from "bun:test";
import { type Arch, archFor, archSummary, normalizeModelID } from "../src/core/registry.ts";

const m = (modelID: string) => ({ providerID: "p", modelID });

describe("registry", () => {
  const cases: [string, Partial<Arch> & { kind: Arch["kind"] }][] = [
    ["deepseek-v3", { kind: "moe", layers: 61, experts: 256, active: 8, shared: 1 } as any],
    ["deepseek-reasoner", { kind: "moe", layers: 61 } as any],
    ["kimi-k2-instruct", { kind: "moe", layers: 61, experts: 384, active: 8, shared: 1 } as any],
    ["qwen3-235b-a22b", { kind: "moe", layers: 94, experts: 128, active: 8, shared: 0 } as any],
    ["qwen3-30b-a3b", { kind: "moe", layers: 48, experts: 128, active: 8 } as any],
    ["qwen3-coder-480b-a35b-instruct", { kind: "moe", layers: 62, experts: 160, active: 8 } as any],
    ["gpt-oss-120b", { kind: "moe", layers: 36, experts: 128, active: 4, shared: 0 } as any],
    ["gpt-oss-20b", { kind: "moe", layers: 24, experts: 32, active: 4 } as any],
    ["mixtral-8x22b-instruct", { kind: "moe", layers: 56, experts: 8, active: 2 } as any],
    ["mixtral-8x7b", { kind: "moe", layers: 32, experts: 8, active: 2 } as any],
    ["llama-4-maverick-17b-128e", { kind: "moe", layers: 48, experts: 128, active: 1, shared: 1 } as any],
    ["llama-4-scout-17b-16e", { kind: "moe", layers: 48, experts: 16, active: 1, shared: 1 } as any],
    ["glm-4.5", { kind: "moe", layers: 92, experts: 160, active: 8, shared: 1 } as any],
    ["llama-3.1-405b-instruct", { kind: "dense", layers: 126 } as any],
    ["llama-3.1-70b", { kind: "dense", layers: 80 } as any],
    ["llama3-8b", { kind: "dense", layers: 32 } as any],
    ["qwen2.5-coder-32b-instruct", { kind: "dense", layers: 64 } as any],
    ["claude-sonnet-4-5", { kind: "unknown" }],
    ["gpt-5", { kind: "unknown" }],
    ["o3-mini", { kind: "unknown" }],
    ["gemini-2.5-pro", { kind: "unknown" }],
    ["some-random-model", { kind: "unknown" }],
  ];
  for (const [id, want] of cases) {
    test(`seed row: ${id}`, () => {
      expect(archFor(m(id))).toMatchObject(want);
    });
  }

  test("ProviderPrefixStripped", () => {
    expect(normalizeModelID("Qwen/Qwen3-235B-A22B")).toBe("qwen3-235b-a22b");
    expect(archFor(m("openrouter/deepseek/deepseek-chat")).kind).toBe("moe");
  });

  test("SpecificBeforeGeneral", () => {
    expect(archFor(m("qwen3-coder-480b")).family).toBe("qwen3-coder-480b");
    expect(archFor(m("glm-4.5-air")).kind).toBe("unknown");
  });

  test("ClosedModelsUnknown", () => {
    expect(archFor(m("anthropic/claude-opus-4")).kind).toBe("unknown");
    expect(archFor(undefined).kind).toBe("unknown");
  });

  test("OverridesWin", () => {
    const o: Record<string, Arch> = { "^claude": { kind: "dense", family: "pretend", layers: 10 } };
    expect(archFor(m("claude-x"), o)).toMatchObject({ kind: "dense", layers: 10 });
    expect(archFor(m("claude-x"), { "[bad": { kind: "dense", family: "x", layers: 1 } }).kind).toBe("unknown");
  });

  test("ArchSummary", () => {
    expect(archSummary(archFor(m("qwen3-235b-a22b")))).toBe("MoE 128e/8a · 94L");
    expect(archSummary(archFor(m("llama-3.1-70b")))).toBe("dense · 80L");
    expect(archSummary(archFor(m("claude")))).toBe("arch unknown");
  });
});
