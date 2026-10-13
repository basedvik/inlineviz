#!/bin/sh
# inlineviz hook launcher: run the recorder with whichever JS runtime exists. Always exits 0.
D="$(dirname "$0")"
if command -v node >/dev/null 2>&1; then node "$D/hook.mjs"
elif command -v bun >/dev/null 2>&1; then bun "$D/hook.mjs"
fi
exit 0
