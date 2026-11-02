# AGENTS.md

- Build: `npm run build` (tsc → `dist/`). ESM, NodeNext; import with `.js` suffixes.
- Style: functional. Pure builders/validators return `Result<KhalError, A>`; no thrown exceptions. Side effects only in `runKhal`.
- User-supplied values must pass `safeToken` (no leading `-`, no control chars); positionals follow `--`.
- Update README.md when tools change.
- Agents MUST ASK the user before any destructive or write operation (e.g. deleting or overwriting files, rewriting git history, changing calendars). Every MCP tool that writes (`new_event`) must say so in its description ("WRITE OPERATION … ask the user for confirmation"); read-only tools must keep working on read-only calendars.
- Nix: `flake.nix` + `nix/` (package, Home Manager module). Verify with `nix flake check --no-build`; format with `nix fmt <files>`. Update `npmDepsHash` in `nix/package.nix` when `package-lock.json` changes.
- Tests: `npm test` = `tsc -p tsconfig.typecheck.json` + `vitest run --coverage` (`src/*.test.ts`, helpers in `src/testlib.ts`, fake `khal` on PATH for effectful code). Coverage thresholds in `vitest.config.ts` (lines/statements 99, functions 98, branches 95) fail the run; `src/cli.ts` and `src/index.ts` are covered only end to end via the spawned server in `src/mcp.test.ts` (rebuilt by `vitest.global-setup.ts`) and are excluded from the thresholds. Add tests for every function you change.
- Hooks (via `nix develop`): nixfmt, biome (`biome check --write`), ripsecrets, unit tests, convco. Commit messages must be Conventional Commits; commits fail if tests fail.
