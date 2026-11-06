#!/usr/bin/env node
// The process edge of the server: the only place that reads the environment, the home directory
// and the clock for the server. Everything below receives them as `Settings` / `ServerDeps`.
import { randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Effect } from "effect";
import { preflight } from "./preflight.js";
import { createServer } from "./server.js";
import { loadSettings } from "./settings.js";
import { startupLine } from "./startup.js";

// load and validate the configuration, log it, then check it against the machine
const startup = Effect.gen(function* () {
  const settings = yield* loadSettings({ env: process.env, home: homedir(), tmpDir: tmpdir() });
  // stderr: stdout belongs to the MCP protocol
  console.error(startupLine(settings));
  yield* preflight(settings);
  return settings;
});

const settings = await Effect.runPromise(
  Effect.match(startup, {
    onFailure: (e) => {
      console.error(`mcp-khal cannot start: ${e._tag}: ${e.message}`);
      return undefined;
    },
    onSuccess: (s) => s,
  }),
);

if (settings === undefined) {
  process.exitCode = 1;
} else {
  await createServer(settings, { uid: randomUUID, now: () => new Date() }).connect(
    new StdioServerTransport(),
  );
}
