#!/usr/bin/env node
// Entry point: `mcp-khal` starts the MCP server, `mcp-khal setup` runs the interactive setup.
const command = process.argv[2];

if (command === "setup") {
  const { runSetup } = await import("./setup.js");
  process.exitCode = await runSetup();
} else if (command === undefined) {
  await import("./index.js");
} else {
  console.error(`unknown command '${command}'. Usage: mcp-khal [setup]`);
  process.exitCode = 2;
}
