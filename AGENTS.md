# AGENTS.md

- Build: `npm run build` (tsc → `dist/`). ESM, NodeNext; import with `.js` suffixes.
- Style: functional. Pure builders/validators return `Result<KhalError, A>`; no thrown exceptions. Side effects only in `runKhal`.
- User-supplied values must pass `safeToken` (no leading `-`, no control chars); positionals follow `--`.
- Update README.md when tools change.
- No function reads `process.env`, the home/tmp directory, the clock, random values or the config file itself. `src/index.ts` and `src/cli.ts` (the process edge) read them once and pass them on: environment and config become a `Settings` object (`src/settings.ts`), the uid and clock are injected (`ServerDeps`). Keep functions pure where possible; tests build `Settings` with `testSettings` / `FakeKhal.settings()` instead of mutating global state.
- Agents MUST ASK the user before any destructive or write operation (e.g. deleting or overwriting files, rewriting git history, changing calendars). Every MCP tool that writes (`new_event`) must say so in its description ("WRITE OPERATION … ask the user for confirmation"); read-only tools must keep working on read-only calendars.
- Nix: `flake.nix` + `nix/` (package, Home Manager module). Verify with `nix flake check --no-build`; format with `nix fmt <files>`. Update `npmDepsHash` in `nix/package.nix` when `package-lock.json` changes, which includes every version bump (the lockfile carries the root version). The version also lives in `src/server.ts`.
- Tests: `npm test` = `tsc -p tsconfig.typecheck.json` + `vitest run --coverage` (`src/*.test.ts`, helpers in `src/testlib.ts`, fake `khal` on PATH for effectful code). Coverage thresholds in `vitest.config.ts` (lines/statements 99, functions 98, branches 95) fail the run; `src/cli.ts` and `src/index.ts` are covered only end to end via the spawned server in `src/mcp.test.ts` (rebuilt by `vitest.global-setup.ts`) and are excluded from the thresholds. Add tests for every function you change.
- CI: `.github/workflows/ci.yml` (nix flake check + build on Linux/macOS, npm build/test, convco on PRs). A tag `vX.Y.Z` creates a GitHub release and must equal the `package.json` version; never create or push tags without asking the user.
- Hooks (via `nix develop`): nixfmt, biome (`biome check --write`), ripsecrets, unit tests, convco. Commit messages must be Conventional Commits; commits fail if tests fail.
