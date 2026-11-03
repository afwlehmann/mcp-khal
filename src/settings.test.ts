import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serializeConfig } from "./config.js";
import { InvalidInput } from "./errors.js";
import { buildSettings, DEFAULT_TIMEOUT_MS, loadSettings } from "./settings.js";
import { removeDir, runFail, runOk, tempDir } from "./testlib.js";

describe("buildSettings", () => {
  const config = { khal: "/cfg/khal", calendarEmails: { work: "me@work.com" } };
  const build = (env: Record<string, string | undefined>) =>
    buildSettings({ env, config, configPath: "/c.json", tmpDir: "/tmp/x" });

  it("takes the khal binary from the config and remembers where it came from", () => {
    const s = build({ PATH: "/bin" });
    expect(s).toMatchObject({
      khal: "/cfg/khal",
      khalSource: "config",
      calendarEmails: { work: "me@work.com" },
      configPath: "/c.json",
      tmpDir: "/tmp/x",
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
  });

  it("lets MCP_KHAL_BIN override the config", () => {
    expect(build({ MCP_KHAL_BIN: "/env/khal" })).toMatchObject({
      khal: "/env/khal",
      khalSource: "MCP_KHAL_BIN",
    });
  });

  it("ignores an empty MCP_KHAL_BIN", () => {
    expect(build({ MCP_KHAL_BIN: "" })).toMatchObject({ khal: "/cfg/khal", khalSource: "config" });
  });

  it("builds the environment for khal from the given env, forcing a UTF-8 locale", () => {
    expect(build({ PATH: "/bin", LC_ALL: "de_DE" }).childEnv).toEqual({ PATH: "/bin", LC_ALL: "C.UTF-8" });
  });

  it("does not read process.env", () => {
    expect(build({}).childEnv).toEqual({ LC_ALL: "C.UTF-8" });
  });
});

describe("loadSettings", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await tempDir();
  });
  afterAll(() => removeDir(dir));

  const input = (env: Record<string, string | undefined>) => ({ env, home: dir, tmpDir: "/tmp/x" });

  it("reads the config file named by MCP_KHAL_CONFIG exactly once into the settings", async () => {
    const path = join(dir, "cfg.json");
    await writeFile(path, serializeConfig({ khal: "/cfg/khal", calendarEmails: { work: "me@work.com" } }));
    const s = await runOk(loadSettings(input({ MCP_KHAL_CONFIG: path })));
    expect(s).toMatchObject({ khal: "/cfg/khal", calendarEmails: { work: "me@work.com" }, configPath: path });
  });

  it("falls back to XDG_CONFIG_HOME and then ~/.config", async () => {
    expect((await runOk(loadSettings(input({ XDG_CONFIG_HOME: "/xdg" })))).configPath).toBe(
      "/xdg/mcp-khal.json",
    );
    expect((await runOk(loadSettings(input({})))).configPath).toBe(join(dir, ".config", "mcp-khal.json"));
  });

  it("uses the defaults when there is no config file", async () => {
    const s = await runOk(loadSettings(input({ MCP_KHAL_CONFIG: join(dir, "missing.json") })));
    expect(s).toMatchObject({ khal: "khal", khalSource: "config", calendarEmails: {} });
  });

  it("applies MCP_KHAL_BIN on top of the file", async () => {
    const path = join(dir, "cfg2.json");
    await writeFile(path, serializeConfig({ khal: "/cfg/khal", calendarEmails: {} }));
    const s = await runOk(loadSettings(input({ MCP_KHAL_CONFIG: path, MCP_KHAL_BIN: "/env/khal" })));
    expect(s).toMatchObject({ khal: "/env/khal", khalSource: "MCP_KHAL_BIN" });
  });

  it("fails on a corrupt config instead of starting with guesses", async () => {
    const path = join(dir, "corrupt.json");
    await writeFile(path, "{ not json");
    expect(await runFail(loadSettings(input({ MCP_KHAL_CONFIG: path })))).toBeInstanceOf(InvalidInput);
  });
});
