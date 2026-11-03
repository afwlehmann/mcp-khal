#!/usr/bin/env node
// The process edge of the server: the only place that reads the environment, the home directory
// and the clock for the server. Everything below receives them as `Settings` / `ServerDeps`.
import { randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Effect } from "effect";
import { createServer } from "./server.js";
import { loadSettings } from "./settings.js";

const settings = await Effect.runPromise(
  Effect.match(loadSettings({ env: process.env, home: homedir(), tmpDir: tmpdir() }), {
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
