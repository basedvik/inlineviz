// Entry point for the bundled CLI (dist/inlineviz.mjs), runnable with Node 18+ or Bun.
// (cli.ts's `import.meta.main` guard only works under Bun.)
import { main } from "./cli.ts";

await main(process.argv.slice(2));
