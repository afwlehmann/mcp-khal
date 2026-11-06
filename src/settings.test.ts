import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serializeConfig } from "./config.js";
import { InvalidInput } from "./errors.js";
import { buildSettings, DEFAULT_TIMEOUT_MS, loadSettings } from "./settings.js";
import { removeDir, runFail, runOk, tempDir } from "./testlib.js";

describe("buildSettings", () => {
  const config = {
    khal: "/cfg/khal",
    calendarEmails: { work: "me@work.com" },
    defaultAlarm: "none",
    calendarAlarms: {},
  };
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

  it("carries the configured reminders into the settings", () => {
    const s = buildSettings({
      env: {},
      config: {
        ...config,
        defaultAlarm: "15m",
        calendarAlarms: { work: "1d", home: "none" },
      },
      configPath: "/c.json",
      tmpDir: "/tmp/x",
    });
    expect(s.defaultAlarm).toBe("15m");
    expect(s.calendarAlarms).toEqual({ work: "1d", home: "none" });
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
    await writeFile(
      path,
      serializeConfig({
        khal: "/cfg/khal",
        calendarEmails: { work: "me@work.com" },
        defaultAlarm: "none",
        calendarAlarms: {},
      }),
    );
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
    await writeFile(
      path,
      serializeConfig({ khal: "/cfg/khal", calendarEmails: {}, defaultAlarm: "none", calendarAlarms: {} }),
    );
    const s = await runOk(loadSettings(input({ MCP_KHAL_CONFIG: path, MCP_KHAL_BIN: "/env/khal" })));
    expect(s).toMatchObject({ khal: "/env/khal", khalSource: "MCP_KHAL_BIN" });
  });

  it("reads default and per-calendar reminders from the file", async () => {
    const path = join(dir, "alarms.json");
    await writeFile(path, '{"defaultAlarm":"15m","calendarAlarms":{"work":"1d","home":"none"}}');
    const s = await runOk(loadSettings(input({ MCP_KHAL_CONFIG: path })));
    expect(s.defaultAlarm).toBe("15m");
    expect(s.calendarAlarms).toEqual({ work: "1d", home: "none" });
  });

  it.each([
    ['{"defaultAlarm":"15"}', /defaultAlarm must be a reminder like 30m, 2h or 1d/],
    ['{"defaultAlarm":"1w"}', /defaultAlarm must be/],
    ['{"defaultAlarm":15}', /defaultAlarm must be/],
    ['{"calendarAlarms":{"work":"soon"}}', /calendarAlarms entry 'work' must be/],
    ['{"calendarAlarms":{"work":"1d","home":"-5m"}}', /calendarAlarms entry 'home' must be/],
    ['{"calendarAlarms":"15m"}', /calendarAlarms must be a JSON object/],
  ])("refuses to start with an invalid reminder in the config: %s", async (content, message) => {
    const path = join(dir, "bad-alarm.json");
    await writeFile(path, content);
    const e = await runFail(loadSettings(input({ MCP_KHAL_CONFIG: path })));
    expect(e).toBeInstanceOf(InvalidInput);
    expect(e.message).toMatch(message);
  });

  it("records where the config path came from and whether the file exists", async () => {
    const present = join(dir, "present.json");
    await writeFile(present, "{}");
    const found = await runOk(loadSettings(input({ MCP_KHAL_CONFIG: present })));
    expect(found).toMatchObject({ configSource: "MCP_KHAL_CONFIG", configFound: true });
    const missing = await runOk(loadSettings(input({ MCP_KHAL_CONFIG: join(dir, "nope.json") })));
    expect(missing).toMatchObject({ configSource: "MCP_KHAL_CONFIG", configFound: false });
    expect(await runOk(loadSettings(input({ XDG_CONFIG_HOME: "/xdg" })))).toMatchObject({
      configSource: "XDG_CONFIG_HOME",
    });
    expect(await runOk(loadSettings(input({})))).toMatchObject({ configSource: "default" });
  });

  it("trims the environment variables it reads", async () => {
    const path = join(dir, "trim.json");
    await writeFile(path, "{}");
    const s = await runOk(
      loadSettings(input({ MCP_KHAL_CONFIG: `  ${path}\n`, MCP_KHAL_BIN: "  /env/khal \t" })),
    );
    expect(s).toMatchObject({ configPath: path, khal: "/env/khal", khalSource: "MCP_KHAL_BIN" });
  });

  it("treats a blank MCP_KHAL_BIN as unset", async () => {
    const s = await runOk(
      loadSettings(input({ MCP_KHAL_CONFIG: join(dir, "none.json"), MCP_KHAL_BIN: "  " })),
    );
    expect(s).toMatchObject({ khal: "khal", khalSource: "config" });
  });

  it.each([
    [{ MCP_KHAL_BIN: "./khal" }, /MCP_KHAL_BIN must be a bare command name/],
    [{ MCP_KHAL_BIN: "~/bin/khal" }, /MCP_KHAL_BIN must not start with '~'/],
    [{ MCP_KHAL_CONFIG: "relative/cfg.json" }, /MCP_KHAL_CONFIG must be an absolute path/],
    [{ XDG_CONFIG_HOME: "relative" }, /XDG_CONFIG_HOME must be an absolute path/],
  ])("refuses to start with an invalid environment: %j", async (env, message) => {
    const e = await runFail(loadSettings(input(env)));
    expect(e).toBeInstanceOf(InvalidInput);
    expect(e.message).toMatch(message);
  });

  it("refuses a relative temporary directory", async () => {
    const e = await runFail(loadSettings({ env: {}, home: dir, tmpDir: "tmp" }));
    expect(e.message).toMatch(/temporary directory must be an absolute path/);
  });

  it("reports the problems of the environment and of the config file together", async () => {
    const path = join(dir, "both.json");
    await writeFile(path, '{"khal":"./khal","defaultAlarm":"soon","typo":1}');
    const e = await runFail(
      loadSettings({ env: { MCP_KHAL_CONFIG: path, MCP_KHAL_BIN: "~/khal" }, home: dir, tmpDir: "tmp" }),
    );
    expect(e.message).toMatch(/^5 problems:/);
    for (const part of [
      "MCP_KHAL_BIN must not start with '~'",
      "temporary directory must be an absolute path",
      "unknown config key 'typo'",
      "config 'khal' must be a bare command name",
      "defaultAlarm must be a reminder",
    ])
      expect(e.message).toContain(part);
  });

  it("reports a bad location together with the other environment problems, without reading a file", async () => {
    const e = await runFail(
      loadSettings({
        env: { MCP_KHAL_CONFIG: "rel.json", MCP_KHAL_BIN: "./khal" },
        home: dir,
        tmpDir: "/tmp/x",
      }),
    );
    expect(e.message).toMatch(/^2 problems:/);
    expect(e.message).toContain("MCP_KHAL_CONFIG must be an absolute path");
    expect(e.message).toContain("MCP_KHAL_BIN must be a bare command name");
  });

  it("fails on a corrupt config instead of starting with guesses", async () => {
    const path = join(dir, "corrupt.json");
    await writeFile(path, "{ not json");
    expect(await runFail(loadSettings(input({ MCP_KHAL_CONFIG: path })))).toBeInstanceOf(InvalidInput);
  });
});
