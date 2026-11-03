#!/usr/bin/env node
// Entry point and process edge: `mcp-khal` starts the MCP server, `mcp-khal setup` runs the
// interactive setup. This is the only place (besides index.ts) that reads process state.
import { homedir, tmpdir } from "node:os";
import { createInterface } from "node:readline/promises";

const command = process.argv[2];

if (command === "setup") {
  const { runSetup } = await import("./setup.js");
  process.exitCode = await runSetup(
    { env: process.env, home: homedir(), tmpDir: tmpdir() },
    {
      isTTY: Boolean(process.stdin.isTTY),
      openPrompt: () => createInterface({ input: process.stdin, output: process.stdout }),
      log: (line) => console.log(line),
    },
    (line) => console.error(line),
  );
} else if (command === undefined) {
  await import("./index.js");
} else {
  console.error(`unknown command '${command}'. Usage: mcp-khal [setup]`);
  process.exitCode = 2;
}
