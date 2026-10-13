// SPEC §16 hygiene: src/core is host-agnostic and pure.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const CORE = resolve(import.meta.dir, "..", "src", "core");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
}

describe("hygiene", () => {
  test("CoreImportsNothingOutsideCore", () => {
    for (const f of files(CORE)) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/from\s+["']([^"']+)["']/g)) {
        const spec = m[1];
        if (!spec.startsWith(".")) throw new Error(`${relative(CORE, f)} imports package ${spec}`);
        const target = resolve(join(f, ".."), spec);
        if (!target.startsWith(CORE)) throw new Error(`${relative(CORE, f)} imports outside core: ${spec}`);
      }
    }
  });

  test("CoreHasNoClockOrRandom", () => {
    for (const f of files(CORE)) {
      const src = readFileSync(f, "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      for (const bad of ["Date.now", "performance.now", "Math.random", "new Date("]) {
        if (src.includes(bad)) throw new Error(`${relative(CORE, f)} uses ${bad}`);
      }
    }
    expect(files(CORE).length).toBeGreaterThan(10);
  });
});
