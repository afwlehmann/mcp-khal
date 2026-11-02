import { execFileSync } from "node:child_process";

/** The MCP/CLI tests spawn dist/cli.js, so make sure dist/ matches src/. */
export default function setup(): void {
  execFileSync("npm", ["run", "build", "--silent"], { stdio: "inherit" });
}
