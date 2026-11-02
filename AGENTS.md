# AGENTS.md

- Build: `npm run build` (tsc → `dist/`). ESM, NodeNext; import with `.js` suffixes.
- Style: functional. Pure builders/validators return `Result<KhalError, A>`; no thrown exceptions. Side effects only in `runKhal`.
- User-supplied values must pass `safeToken` (no leading `-`, no control chars); positionals follow `--`.
- Update README.md when tools change.
