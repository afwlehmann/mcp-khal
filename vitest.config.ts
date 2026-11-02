import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // builds dist/ so the MCP/CLI tests can spawn the real server
    globalSetup: ["./vitest.global-setup.ts"],
    // test files run in isolated processes, so PATH/env mutations cannot leak between files
    pool: "forks",
    testTimeout: 20_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // cli.ts and index.ts only run in a spawned child process (see mcp.test.ts), which v8 coverage
      // in the test worker cannot observe; they are exercised end to end instead.
      exclude: ["src/**/*.test.ts", "src/testlib.ts", "src/cli.ts", "src/index.ts"],
      reporter: ["text", "html"],
      thresholds: { lines: 99, statements: 99, functions: 98, branches: 95 },
    },
  },
});
