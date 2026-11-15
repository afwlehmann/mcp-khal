import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InvalidInput } from "./errors.js";
import { checkVdirs, preflight } from "./preflight.js";
import { failure, runFail, runOk, type Sandbox, sandbox, testSettings, unwrap } from "./testlib.js";

// root can write to a directory whatever its mode
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

describe("preflight", () => {
  let box: Sandbox;

  beforeEach(async () => {
    box = await sandbox();
  });
  afterEach(() => box.cleanup());

  it("passes when every calendar path is a readable and writable directory", async () => {
    const given = await box.settings(["work", "home"], { defaultCalendar: "work" });
    expect(await runOk(preflight(given))).toEqual(given);
  });

  it("does not need a default calendar for a single calendar", async () => {
    await runOk(preflight(await box.settings(["work"])));
  });

  it("does not require the default config file to exist", async () => {
    await runOk(preflight(await box.settings(["work"], { configSource: "default", configFound: false })));
    await runOk(
      preflight(await box.settings(["work"], { configSource: "XDG_CONFIG_HOME", configFound: false })),
    );
  });

  it("requires a config file that MCP_KHAL_CONFIG names explicitly", async () => {
    const e = await runFail(
      preflight(
        await box.settings(["work"], {
          configSource: "MCP_KHAL_CONFIG",
          configFound: false,
          configPath: "/x/cfg.json",
        }),
      ),
    );
    expect(e).toBeInstanceOf(InvalidInput);
    expect(e.message).toBe("MCP_KHAL_CONFIG points to /x/cfg.json, which does not exist");
  });

  it("accepts an MCP_KHAL_CONFIG file that exists", async () => {
    await runOk(
      preflight(await box.settings(["work"], { configSource: "MCP_KHAL_CONFIG", configFound: true })),
    );
  });

  it("refuses to start without any calendar and points to setup", async () => {
    const e = await runFail(preflight(testSettings({ configPath: join(box.dir, "cfg.json") })));
    expect(e).toBeInstanceOf(InvalidInput);
    expect(e.message).toContain("no calendars are configured");
    expect(e.message).toContain(join(box.dir, "cfg.json"));
    expect(e.message).toContain("mcp-khal setup");
  });

  it("names a calendar whose path does not exist", async () => {
    const missing = join(box.dir, "missing");
    const e = await runFail(preflight(testSettings({ calendars: { work: { path: missing } } })));
    expect(e.message).toBe(`calendars.work.path ${missing} is not a directory that can be read and written`);
  });

  it("names a calendar whose path is a file, not a directory", async () => {
    const file = join(box.dir, "file");
    await writeFile(file, "x");
    const e = await runFail(preflight(testSettings({ calendars: { work: { path: file } } })));
    expect(e.message).toContain(`calendars.work.path ${file} is not a directory`);
  });

  it.skipIf(isRoot)("names a calendar whose path cannot be written", async () => {
    const path = await box.vdir("ro");
    await chmod(path, 0o555);
    try {
      const e = await runFail(preflight(testSettings({ calendars: { ro: { path } } })));
      expect(e.message).toContain(
        `calendars.ro.path ${path} is not a directory that can be read and written`,
      );
    } finally {
      await chmod(path, 0o755);
    }
  });

  it("reports every problem at once when several things are wrong, paths sorted by name", async () => {
    const file = join(box.dir, "file");
    await writeFile(file, "x");
    const e = await runFail(
      preflight(
        testSettings({
          configSource: "MCP_KHAL_CONFIG",
          configFound: false,
          configPath: "/x/cfg.json",
          calendars: {
            work: { path: join(box.dir, "missing") },
            home: { path: file },
          },
        }),
      ),
    );
    expect(e.message).toMatch(/^3 problems:/);
    expect(e.message).toContain("MCP_KHAL_CONFIG points to /x/cfg.json");
    expect(e.message).toContain("calendars.home.path");
    expect(e.message).toContain("calendars.work.path");
    expect(e.message.indexOf("calendars.home")).toBeLessThan(e.message.indexOf("calendars.work"));
  });

  it("reports a missing config file and the lack of calendars together", async () => {
    const e = await runFail(
      preflight(
        testSettings({ configSource: "MCP_KHAL_CONFIG", configFound: false, configPath: "/x/c.json" }),
      ),
    );
    expect(e.message).toMatch(/^2 problems:/);
    expect(e.message).toContain("does not exist");
    expect(e.message).toContain("no calendars are configured");
  });
});

describe("checkVdirs", () => {
  let box: Sandbox;

  beforeEach(async () => {
    box = await sandbox();
  });
  afterEach(() => box.cleanup());

  it("is valid for writable directories and for no calendars at all", async () => {
    unwrap(await runOk(checkVdirs(await box.settings(["a", "b"]))));
    unwrap(await runOk(checkVdirs(testSettings())));
  });

  it("lists one problem per bad calendar", async () => {
    const bad = testSettings({
      calendars: { b: { path: join(box.dir, "nope-b") }, a: { path: join(box.dir, "nope-a") } },
    });
    const problems = failure(await runOk(checkVdirs(bad)));
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain("calendars.a.path");
    expect(problems[1]).toContain("calendars.b.path");
  });
});
