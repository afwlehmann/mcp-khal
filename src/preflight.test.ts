import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InvalidInput } from "./errors.js";
import { preflight, unknownCalendars } from "./preflight.js";
import { type FakeKhal, fakeKhal, removeDir, runFail, runOk, tempDir } from "./testlib.js";

describe("unknownCalendars", () => {
  it("returns the configured names that khal does not have", () => {
    expect(unknownCalendars(["work", "typo", "other"], ["work", "home"])).toEqual(["typo", "other"]);
    expect(unknownCalendars([], ["work"])).toEqual([]);
    expect(unknownCalendars(["work"], ["work"])).toEqual([]);
  });

  it("compares exactly: case matters", () => {
    expect(unknownCalendars(["Work"], ["work"])).toEqual(["Work"]);
  });
});

describe("preflight", () => {
  let fake: FakeKhal;
  let dir: string;

  beforeEach(async () => {
    fake = await fakeKhal({ stdout: "work\nhome\n" });
    dir = await tempDir();
  });
  afterEach(async () => {
    await fake.cleanup();
    await removeDir(dir);
  });

  const settings = (overrides = {}) => fake.settings({ tmpDir: dir, ...overrides });

  it("passes when khal runs, the calendars exist and the temporary directory is writable", async () => {
    await runOk(
      preflight(
        settings({
          calendarEmails: { work: "me@work.com" },
          calendarAlarms: { home: "none", work: "1d" },
        }),
      ),
    );
    // it asks khal for its version and for its calendars, nothing else
    expect((await fake.calls()).map((c) => c[0])).toEqual(["--version", "printcalendars"]);
  });

  it("passes with nothing configured at all", async () => {
    await runOk(preflight(settings()));
  });

  it("does not require the default config file to exist", async () => {
    await runOk(preflight(settings({ configSource: "default", configFound: false })));
    await runOk(preflight(settings({ configSource: "XDG_CONFIG_HOME", configFound: false })));
  });

  it("requires a config file that MCP_KHAL_CONFIG names explicitly", async () => {
    const e = await runFail(
      preflight(settings({ configSource: "MCP_KHAL_CONFIG", configFound: false, configPath: "/x/cfg.json" })),
    );
    expect(e).toBeInstanceOf(InvalidInput);
    expect(e.message).toBe("MCP_KHAL_CONFIG points to /x/cfg.json, which does not exist");
  });

  it("names the calendars that khal does not know, from both maps, and lists what khal has", async () => {
    const e = await runFail(
      preflight(
        settings({
          calendarEmails: { work: "me@work.com", wrok: "me@work.com" },
          calendarAlarms: { home: "1d", hmoe: "none" },
        }),
      ),
    );
    expect(e).toBeInstanceOf(InvalidInput);
    expect(e.message).toBe(
      "the config names calendars that khal does not know: wrok, hmoe (khal has: work, home)",
    );
  });

  it("says so when khal has no calendars at all", async () => {
    const empty = await fakeKhal({ stdout: "" });
    try {
      const e = await runFail(
        preflight(empty.settings({ tmpDir: dir, calendarEmails: { work: "me@work.com" } })),
      );
      expect(e.message).toMatch(/khal does not know: work \(khal has: none\)/);
    } finally {
      await empty.cleanup();
    }
  });

  it("reports a khal that cannot be run, and does not ask it for calendars", async () => {
    const e = await runFail(
      preflight(
        settings({
          khal: "/does/not/exist/khal",
          khalSource: "MCP_KHAL_BIN",
          calendarEmails: { x: "a@b.co" },
        }),
      ),
    );
    expect(e.message).toMatch(
      /^khal \(\/does\/not\/exist\/khal, from MCP_KHAL_BIN\) cannot be run: NotInstalled: khal executable '\/does\/not\/exist\/khal' not found/,
    );
    // one problem: the calendar check is skipped, not reported a second time
    expect(e.message).not.toMatch(/problems:/);
    expect(e.message).not.toMatch(/calendars/);
  });

  it("reports a khal that exits with an error", async () => {
    const broken = await fakeKhal({ stderr: "no config found", exit: 3 });
    try {
      const e = await runFail(preflight(broken.settings({ tmpDir: dir })));
      expect(e.message).toMatch(/cannot be run: NonZeroExit: no config found/);
    } finally {
      await broken.cleanup();
    }
  });

  it("reports a khal that runs but cannot list its calendars", async () => {
    const half = await fakeKhal({
      stdout: "work\n",
      stderr: "cannot read the khal config",
      failOn: "printcalendars",
    });
    try {
      const e = await runFail(preflight(half.settings({ tmpDir: dir })));
      expect(e.message).toBe("khal cannot list its calendars: NonZeroExit: cannot read the khal config");
    } finally {
      await half.cleanup();
    }
  });

  it("reports a temporary directory that is missing", async () => {
    const e = await runFail(preflight(settings({ tmpDir: join(dir, "no-such-dir") })));
    expect(e.message).toMatch(/the temporary directory .*no-such-dir does not exist or is not writable/);
  });

  it("reports every problem at once when several things are wrong", async () => {
    const e = await runFail(
      preflight(
        settings({
          khal: "/does/not/exist/khal",
          tmpDir: join(dir, "no-such-dir"),
          configSource: "MCP_KHAL_CONFIG",
          configFound: false,
          configPath: "/x/cfg.json",
        }),
      ),
    );
    expect(e.message).toMatch(/^3 problems:/);
    expect(e.message).toContain("MCP_KHAL_CONFIG points to /x/cfg.json");
    expect(e.message).toContain("does not exist or is not writable");
    expect(e.message).toContain("cannot be run");
  });
});
