# inlineviz — Claude Code plugin

This folder is the Claude Code plugin (kept separate from the repo root so installs stay tiny:
no package.json, no dependencies). Install it from the repo's marketplace:

```text
/plugin marketplace add basedvik/inlineviz
/plugin install inlineviz@inlineviz
```

`dist/inlineviz.mjs` is a copy of the repo's `dist/inlineviz.mjs`, refreshed by `bun run build:cli`.
See the main README for what it shows and what it records.
