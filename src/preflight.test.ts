import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InvalidInput } from "./errors.js";
import { checkCalendars, preflight, unknownCalendars } from "./preflight.js";
import {
  type FakeKhal,
  failure,
  fakeKhal,
  removeDir,
  runFail,
  runOk,
  tempDir,
  testSettings,
  unwrap,
} from "./testlib.js";

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

describe("checkCalendars", () => {
  const settings = (overrides = {}) => testSettings(overrides);

  it("returns the configured default calendar when khal has it", () => {
    expect(unwrap(checkCalendars(settings({ defaultCalendar: "work" }), ["home", "work"]))).toBe("work");
  });

  it("makes the only calendar the default when none is configured", () => {
    expect(unwrap(checkCalendars(settings(), ["work"]))).toBe("work");
    expect(unwrap(checkCalendars(settings({ defaultCalendar: "work" }), ["work"]))).toBe("work");
  });

  it("requires a default calendar when khal has several: nothing is guessed", () => {
    expect(failure(checkCalendars(settings(), ["work", "home"]))).toEqual([
      'khal has several calendars (home, work): set "defaultCalendar" to the one new events go to when a call names no calendar',
    ]);
  });

  it("does not depend on the order in which khal reports its calendars", () => {
    const messages = [
      ["work", "home", "school"],
      ["school", "work", "home"],
      ["home", "school", "work"],
    ].map((names) => failure(checkCalendars(settings(), names)));
    expect(new Set(messages.map((m) => m[0])).size).toBe(1);
    expect(messages[0]?.[0]).toContain("(home, school, work)");
    // and the result for a configured default is the same whatever the order
    for (const names of [
      ["a", "b"],
      ["b", "a"],
    ])
      expect(unwrap(checkCalendars(settings({ defaultCalendar: "b" }), names))).toBe("b");
  });

  it("rejects a default calendar that khal does not have, listing the ones it has", () => {
    expect(failure(checkCalendars(settings({ defaultCalendar: "wrok" }), ["work", "home"]))).toEqual([
      "defaultCalendar 'wrok' does not exist in khal (khal has: home, work)",
    ]);
    expect(failure(checkCalendars(settings({ defaultCalendar: "other" }), ["work"]))).toEqual([
      "defaultCalendar 'other' does not exist in khal (khal has: work)",
    ]);
  });

  it("says so when khal has no calendars at all", () => {
    expect(failure(checkCalendars(settings(), []))).toEqual([
      "khal has no calendars: there is nowhere to create events",
    ]);
  });

  it("names the configured calendars that khal does not know, sorted, with the ones it has", () => {
    const s = settings({
      defaultCalendar: "work",
      calendars: { work: {}, zzz: { alarm: "1d" }, wrok: { email: "me@work.com" } },
    });
    expect(failure(checkCalendars(s, ["work", "home"]))).toEqual([
      "the config names calendars that khal does not know: wrok, zzz (khal has: home, work)",
    ]);
  });

  it("reports an unknown calendar and a missing default together", () => {
    const s = settings({ calendars: { typo: {} } });
    expect(failure(checkCalendars(s, ["work", "home"]))).toHaveLength(2);
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

  /** khal has two calendars, so the default calendar is configured unless a test says otherwise */
  const settings = (overrides = {}) => fake.settings({ tmpDir: dir, defaultCalendar: "work", ...overrides });

  it("passes when khal runs, the calendars exist and the temporary directory is writable", async () => {
    const ready = await runOk(
      preflight(
        settings({
          calendars: { work: { email: "me@work.com", alarm: "1d" }, home: { alarm: "none" } },
        }),
      ),
    );
    expect(ready.defaultCalendar).toBe("work");
    // it asks khal for its version and for its calendars, nothing else
    expect((await fake.calls()).map((c) => c[0])).toEqual(["--version", "printcalendars"]);
  });

  it("returns the settings unchanged when the default calendar is configured", async () => {
    const given = settings({ calendars: { work: { email: "me@work.com" } } });
    expect(await runOk(preflight(given))).toEqual(given);
  });

  it("works out the default calendar when khal has only one, and changes nothing else", async () => {
    const one = await fakeKhal({ stdout: "work\n" });
    try {
      const given = one.settings({ tmpDir: dir, calendars: { work: { alarm: "1d" } } });
      expect("defaultCalendar" in given).toBe(false);
      expect(await runOk(preflight(given))).toEqual({ ...given, defaultCalendar: "work" });
    } finally {
      await one.cleanup();
    }
  });

  it("refuses to start when khal has several calendars and no default calendar is configured", async () => {
    const e = await runFail(preflight(fake.settings({ tmpDir: dir })));
    expect(e).toBeInstanceOf(InvalidInput);
    expect(e.message).toBe(
      'khal has several calendars (home, work): set "defaultCalendar" to the one new events go to when a call names no calendar',
    );
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

  it("names the calendars that khal does not know, whatever they configure, and lists what khal has", async () => {
    const e = await runFail(
      preflight(
        settings({
          calendars: {
            work: { email: "me@work.com" },
            wrok: { email: "me@work.com" },
            home: { alarm: "1d" },
            hmoe: { alarm: "none" },
          },
        }),
      ),
    );
    expect(e).toBeInstanceOf(InvalidInput);
    expect(e.message).toBe(
      "the config names calendars that khal does not know: hmoe, wrok (khal has: home, work)",
    );
  });

  it("rejects a default calendar that khal does not have", async () => {
    const e = await runFail(preflight(settings({ defaultCalendar: "wrok" })));
    expect(e.message).toBe("defaultCalendar 'wrok' does not exist in khal (khal has: home, work)");
  });

  it("says so when khal has no calendars at all", async () => {
    const empty = await fakeKhal({ stdout: "" });
    try {
      const e = await runFail(preflight(empty.settings({ tmpDir: dir })));
      expect(e.message).toBe("khal has no calendars: there is nowhere to create events");
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
          calendars: { x: { email: "a@b.co" } },
        }),
      ),
    );
    expect(e.message).toMatch(
      /^khal \(\/does\/not\/exist\/khal, from MCP_KHAL_BIN\) cannot be run: NotInstalled: khal executable '\/does\/not\/exist\/khal' not found/,
    );
    // one problem: the calendar checks are skipped, not reported a second time
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
