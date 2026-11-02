# AGENTS.md

- Build: `npm run build` (tsc → `dist/`). ESM, NodeNext; import with `.js` suffixes.
- Style: functional. Pure builders/validators return `Result<KhalError, A>`; no thrown exceptions. Side effects only in `runKhal`.
- User-supplied values must pass `safeToken` (no leading `-`, no control chars); positionals follow `--`.
- Update README.md when tools change.
- Nix: `flake.nix` + `nix/` (package, Home Manager module). Verify with `nix flake check --no-build`; format with `nix fmt <files>`. Update `npmDepsHash` in `nix/package.nix` when `package-lock.json` changes.
- Tests: `npm test` (`node:test`, `src/*.test.ts`, helpers in `src/testlib.ts`; compiled via `tsconfig.test.json` to `dist-test/`). Add tests for every pure builder/validator you change.
- Hooks (via `nix develop`): nixfmt, biome (`biome check --write`), ripsecrets, unit tests, convco. Commit messages must be Conventional Commits; commits fail if tests fail.
