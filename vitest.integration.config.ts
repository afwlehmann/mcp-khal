import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

// Integration tests run against the real khal from `nix develop` (see src/khal.integration.test.ts).
// Even vitest's own cache lives in the temp directory, nothing is written into the repository.
export default defineConfig({
  cacheDir: join(tmpdir(), "mcp-khal-vitest-integration-cache"),
  test: {
    include: ["src/**/*.integration.test.ts"],
    pool: "forks",
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
