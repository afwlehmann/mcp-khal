import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Config, serializeConfig } from "./config.js";
import { InvalidInput } from "./errors.js";
import { buildSettings, checkTimezone, loadSettings } from "./settings.js";
import { failure, removeDir, runFail, runOk, tempDir, unwrap } from "./testlib.js";

describe("buildSettings", () => {
  const config: Config = { calendars: { work: { path: "/cal/work", email: "me@work.com" } } };
  const build = (c: Config = config) =>
    buildSettings({ config: c, configPath: "/c.json", timezone: "Europe/Berlin" });

  it("takes the calendars from the config and remembers where it is", () => {
    expect(build()).toEqual({
      calendars: config.calendars,
      configPath: "/c.json",
      configSource: "default",
      configFound: true,
      timezone: "Europe/Berlin",
    });
  });

  it("carries the default calendar and the per-calendar settings into the settings", () => {
    const calendars = {
      work: { path: "/cal/work", email: "me@work.com", alarm: "1d" },
      home: { path: "/cal/home", alarm: "none" },
    };
    const s = build({ defaultCalendar: "work", calendars });
    expect(s.defaultCalendar).toBe("work");
    expect(s.calendars).toEqual(calendars);
  });

  it("has no default calendar when the config names none", () => {
    expect("defaultCalendar" in build()).toBe(false);
  });

  it("records the source and whether the file was found", () => {
    const s = buildSettings({
      config,
      configPath: "/c.json",
      configSource: "MCP_KHAL_CONFIG",
      configFound: false,
      timezone: "UTC",
    });
    expect(s).toMatchObject({ configSource: "MCP_KHAL_CONFIG", configFound: false });
  });
});

describe("checkTimezone", () => {
  it.each(["UTC", "Europe/Berlin", "  Asia/Tokyo \n"])("accepts %j", (zone) => {
    expect(unwrap(checkTimezone(zone))).toBe(zone.trim());
  });

  it.each(["", "   ", "Not/AZone", "Mars"])("rejects %j", (zone) => {
    expect(failure(checkTimezone(zone))[0]).toMatch(/host time zone must be a known IANA zone/);
  });
});

describe("loadSettings", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await tempDir();
  });
  afterAll(() => removeDir(dir));

  const input = (env: Record<string, string | undefined>) => ({
    env,
    home: dir,
    timezone: "Europe/Berlin",
  });

  it("reads the config file named by MCP_KHAL_CONFIG exactly once into the settings", async () => {
    const path = join(dir, "cfg.json");
    await writeFile(
      path,
      serializeConfig({ calendars: { work: { path: "/cal/work", email: "me@work.com" } } }),
    );
    const s = await runOk(loadSettings(input({ MCP_KHAL_CONFIG: path })));
    expect(s).toMatchObject({
      calendars: { work: { path: "/cal/work", email: "me@work.com" } },
      configPath: path,
    });
  });

  it("falls back to XDG_CONFIG_HOME and then ~/.config", async () => {
    expect((await runOk(loadSettings(input({ XDG_CONFIG_HOME: "/xdg" })))).configPath).toBe(
      "/xdg/mcp-khal.json",
    );
    expect((await runOk(loadSettings(input({})))).configPath).toBe(join(dir, ".config", "mcp-khal.json"));
  });

  it("uses the defaults when there is no config file", async () => {
    const s = await runOk(loadSettings(input({ MCP_KHAL_CONFIG: join(dir, "missing.json") })));
    expect(s).toMatchObject({ calendars: {} });
    expect("defaultCalendar" in s).toBe(false);
  });

  it("reads the default calendar and the per-calendar settings from the file", async () => {
    const path = join(dir, "alarms.json");
    await writeFile(
      path,
      '{"defaultCalendar":"work","calendars":{"work":{"path":"/cal/work","email":"me@work.com","alarm":"1d"},"home":{"path":"/cal/home","alarm":"none"}}}',
    );
    const s = await runOk(loadSettings(input({ MCP_KHAL_CONFIG: path })));
    expect(s.defaultCalendar).toBe("work");
    expect(s.calendars).toEqual({
      work: { path: "/cal/work", email: "me@work.com", alarm: "1d" },
      home: { path: "/cal/home", alarm: "none" },
    });
  });

  it("rejects a 'khal' key in the file like any other unknown key", async () => {
    const path = join(dir, "old.json");
    await writeFile(path, '{"khal":"/opt/khal","calendars":{"work":{"path":"/cal/work"}}}');
    const e = await runFail(loadSettings(input({ MCP_KHAL_CONFIG: path })));
    expect(e.message).toContain("unknown config key 'khal'");
  });

  it("does not read any variable but the location of the config file", async () => {
    const path = join(dir, "bin.json");
    await writeFile(path, "{}");
    const s = await runOk(loadSettings(input({ MCP_KHAL_CONFIG: path, MCP_KHAL_BIN: "/opt/khal" })));
    expect(s).toEqual({
      calendars: {},
      configPath: path,
      configSource: "MCP_KHAL_CONFIG",
      configFound: true,
      timezone: "Europe/Berlin",
    });
  });

  it.each([
    ['{"defaultCalendar":15}', /defaultCalendar must be a calendar name/],
    ['{"defaultCalendar":"  "}', /defaultCalendar has an empty calendar name/],
    ['{"defaultAlarm":"15m"}', /config key 'defaultAlarm' has been dropped/],
    ['{"typo":1}', /unknown config key 'typo'/],
    ['{"calendars":{"work":{"path":"/c/w","alarm":"soon"}}}', /calendars\.work\.alarm must be/],
    [
      '{"calendars":{"work":{"path":"/c/w","alarm":"1d"},"home":{"path":"/c/h","alarm":"-5m"}},"defaultCalendar":"work"}',
      /calendars\.home\.alarm must be/,
    ],
    ['{"calendars":{"work":{"path":"/c/w","email":"nope"}}}', /calendars\.work\.email is not a valid email/],
    ['{"calendars":{"work":{"email":"me@work.com"}}}', /calendars\.work\.path is required/],
    ['{"calendars":{"work":{"path":"relative/dir"}}}', /calendars\.work\.path must be an absolute path/],
    ['{"calendars":{"work":{"path":"~/cal"}}}', /calendars\.work\.path must be an absolute path/],
    ['{"calendars":{"work":{"path":"/c/w"},"home":{"path":"/c/w"}},"defaultCalendar":"work"}', /same path/],
    ['{"calendars":{"work":{"path":"/c/w"},"home":{"path":"/c/h"}}}', /several calendars are configured/],
    [
      '{"defaultCalendar":"nope","calendars":{"work":{"path":"/c/w"}}}',
      /not one of the configured calendars/,
    ],
    ['{"calendars":"15m"}', /calendars must be a JSON object/],
    ['{"calendars":{"work":"15m"}}', /calendars\.work must be an object/],
  ])("refuses to start with an invalid config: %s", async (content, message) => {
    const path = join(dir, "bad.json");
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
    const s = await runOk(loadSettings(input({ MCP_KHAL_CONFIG: `  ${path}\n` })));
    expect(s.configPath).toBe(path);
  });

  it.each([
    [{ MCP_KHAL_CONFIG: "relative/cfg.json" }, /MCP_KHAL_CONFIG must be an absolute path/],
    [{ XDG_CONFIG_HOME: "relative" }, /XDG_CONFIG_HOME must be an absolute path/],
  ])("refuses to start with an invalid environment: %j", async (env, message) => {
    const e = await runFail(loadSettings(input(env)));
    expect(e).toBeInstanceOf(InvalidInput);
    expect(e.message).toMatch(message);
  });

  it.each(["UTC", "Europe/Berlin", "America/New_York", "  Asia/Tokyo \n"])(
    "accepts the host time zone %j",
    async (zone) => {
      const s = await runOk(loadSettings({ ...input({}), timezone: zone }));
      expect(s.timezone).toBe(zone.trim());
    },
  );

  it.each(["", "   ", "Not/AZone", "Mars"])("refuses the host time zone %j", async (zone) => {
    const e = await runFail(loadSettings({ ...input({}), timezone: zone }));
    expect(e).toBeInstanceOf(InvalidInput);
    expect(e.message).toMatch(/host time zone must be a known IANA zone/);
  });

  it("reports the problems of the environment and of the config file together", async () => {
    const path = join(dir, "both.json");
    await writeFile(path, '{"typo":1,"defaultAlarm":"soon","calendars":{"work":{"alarm":"soon"}}}');
    const e = await runFail(
      loadSettings({ env: { MCP_KHAL_CONFIG: path }, home: dir, timezone: "Not/AZone" }),
    );
    expect(e.message).toMatch(/^5 problems:/);
    for (const part of [
      "host time zone must be a known IANA zone",
      "unknown config key 'typo'",
      "config key 'defaultAlarm' has been dropped",
      "calendars.work.alarm must be",
      "calendars.work.path is required",
    ])
      expect(e.message).toContain(part);
  });

  it("reports a bad location together with a bad time zone, without reading a file", async () => {
    const e = await runFail(
      loadSettings({ env: { MCP_KHAL_CONFIG: "rel.json" }, home: dir, timezone: "Mars" }),
    );
    expect(e.message).toMatch(/^2 problems:/);
    expect(e.message).toContain("MCP_KHAL_CONFIG must be an absolute path");
    expect(e.message).toContain("host time zone must be a known IANA zone");
  });

  it("fails on a corrupt config instead of starting with guesses", async () => {
    const path = join(dir, "corrupt.json");
    await writeFile(path, "{ not json");
    expect(await runFail(loadSettings(input({ MCP_KHAL_CONFIG: path })))).toBeInstanceOf(InvalidInput);
  });
});
