import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  calendarEnvName,
  ENV_DEFAULT_CALENDAR,
  envSegment,
  parseConfigValidated,
  parseConfigWithEnv,
} from "./config.js";
import { loadSettings } from "./settings.js";
import { failure, removeDir, runFail, runOk, tempDir, unwrap } from "./testlib.js";

const file = (calendars: unknown, extra: object = {}): string => JSON.stringify({ ...extra, calendars });
const problems = (json: string | undefined, env: Record<string, string>): readonly string[] =>
  failure(parseConfigWithEnv(json, env));

describe("environment variable names", () => {
  it("turn a calendar name into one segment: capitals, digits and single underscores", () => {
    expect(envSegment("work")).toBe("WORK");
    expect(envSegment("work-1")).toBe("WORK_1");
    expect(envSegment("  my cal.v2 ")).toBe("MY_CAL_V2");
    expect(envSegment("a -- b")).toBe("A_B");
    expect(envSegment("__x__")).toBe("X");
    expect(envSegment("büro")).toBe("B_RO");
  });

  it("follow one schema: MCP_KHAL_ + the key path in capitals, every part joined by a single underscore", () => {
    expect(ENV_DEFAULT_CALENDAR).toBe("MCP_KHAL_DEFAULT_CALENDAR");
    expect(calendarEnvName("work", "path")).toBe("MCP_KHAL_CALENDARS_WORK_PATH");
    expect(calendarEnvName("my-cal", "email")).toBe("MCP_KHAL_CALENDARS_MY_CAL_EMAIL");
    expect(calendarEnvName("home", "alarm")).toBe("MCP_KHAL_CALENDARS_HOME_ALARM");
  });
});

describe("environment overrides of the config file", () => {
  const base = file(
    {
      work: { path: "/cal/work", email: "me@work.com", alarm: "1d" },
      home: { path: "/cal/home" },
    },
    { defaultCalendar: "work" },
  );

  it("change nothing when no variable is set", () => {
    expect(unwrap(parseConfigWithEnv(base, {}))).toEqual(unwrap(parseConfigValidated(base)));
    expect(
      unwrap(parseConfigWithEnv(base, { PATH: "/bin", MCP_KHAL_BIN: "/x", MCP_KHAL_CONFIG: "/c.json" })),
    ).toEqual(unwrap(parseConfigValidated(base)));
  });

  it("let the default calendar come from the environment, beating the file", () => {
    const c = unwrap(parseConfigWithEnv(base, { [ENV_DEFAULT_CALENDAR]: " home " }));
    expect(c.defaultCalendar).toBe("home");
  });

  it("override path, email and alarm of a calendar of the file, field by field", () => {
    const c = unwrap(
      parseConfigWithEnv(base, {
        MCP_KHAL_CALENDARS_WORK_PATH: "/elsewhere/work",
        MCP_KHAL_CALENDARS_WORK_EMAIL: "other@work.com",
        MCP_KHAL_CALENDARS_WORK_ALARM: "30m",
        MCP_KHAL_CALENDARS_HOME_ALARM: "none",
      }),
    );
    expect(c.calendars).toEqual({
      work: { path: "/elsewhere/work", email: "other@work.com", alarm: "30m" },
      home: { path: "/cal/home", alarm: "none" },
    });
  });

  it("keep the values of the file for the fields no variable names", () => {
    const c = unwrap(parseConfigWithEnv(base, { MCP_KHAL_CALENDARS_WORK_ALARM: "2h" }));
    expect(c.calendars.work).toEqual({ path: "/cal/work", email: "me@work.com", alarm: "2h" });
  });

  it("find a calendar whose name has other characters by its normalised segment", () => {
    const json = file({ "work-1": { path: "/cal/w1" } });
    const c = unwrap(parseConfigWithEnv(json, { MCP_KHAL_CALENDARS_WORK_1_ALARM: "15m" }));
    expect(c.calendars).toEqual({ "work-1": { path: "/cal/w1", alarm: "15m" } });
  });

  it("is not confused by an underscore in the name or by a name that ends like a setting", () => {
    const json = file(
      { my_cal: { path: "/cal/a" }, "my path": { path: "/cal/b" } },
      { defaultCalendar: "my_cal" },
    );
    const c = unwrap(
      parseConfigWithEnv(json, {
        MCP_KHAL_CALENDARS_MY_CAL_ALARM: "5m",
        MCP_KHAL_CALENDARS_MY_PATH_EMAIL: "me@x.org",
      }),
    );
    expect(c.calendars).toEqual({
      my_cal: { path: "/cal/a", alarm: "5m" },
      "my path": { path: "/cal/b", email: "me@x.org" },
    });
  });

  it("can define a calendar that is not in the file, named by its segment in lower case", () => {
    const c = unwrap(
      parseConfigWithEnv(base, {
        MCP_KHAL_CALENDARS_PRIVATE_PATH: "/cal/private",
        MCP_KHAL_CALENDARS_PRIVATE_EMAIL: "me@example.org",
      }),
    );
    expect(c.calendars.private).toEqual({ path: "/cal/private", email: "me@example.org" });
    expect(Object.keys(c.calendars).sort()).toEqual(["home", "private", "work"]);
  });

  it("can be the whole configuration when there is no file", () => {
    const c = unwrap(
      parseConfigWithEnv(undefined, {
        MCP_KHAL_CALENDARS_WORK_PATH: "/cal/work",
        MCP_KHAL_CALENDARS_HOME_PATH: "/cal/home",
        [ENV_DEFAULT_CALENDAR]: "home",
      }),
    );
    expect(c).toEqual({
      defaultCalendar: "home",
      calendars: { work: { path: "/cal/work" }, home: { path: "/cal/home" } },
    });
  });

  it("with no file and no variable give the empty configuration", () => {
    expect(unwrap(parseConfigWithEnv(undefined, {}))).toEqual({ calendars: {} });
  });

  it("treat an empty or blank variable as unset", () => {
    const c = unwrap(
      parseConfigWithEnv(base, {
        [ENV_DEFAULT_CALENDAR]: "  ",
        MCP_KHAL_CALENDARS_WORK_ALARM: "",
        MCP_KHAL_CALENDARS_NOBODY_PATH: " \n",
      }),
    );
    expect(c).toEqual(unwrap(parseConfigValidated(base)));
  });

  it("replace a calendar entry of the file that is not an object", () => {
    const json = file({ work: "broken" });
    const c = unwrap(parseConfigWithEnv(json, { MCP_KHAL_CALENDARS_WORK_PATH: "/cal/work" }));
    expect(c.calendars).toEqual({ work: { path: "/cal/work" } });
  });

  it("leave a calendars value of the file that is not an object to the usual error", () => {
    const e = problems(JSON.stringify({ calendars: [] }), { MCP_KHAL_CALENDARS_WORK_PATH: "/cal/work" });
    expect(e).toEqual(["calendars must be a JSON object of calendar name -> settings"]);
  });
});

describe("rejected environment values name the variable, not the file", () => {
  const base = file(
    { work: { path: "/cal/work" }, home: { path: "/cal/home" } },
    { defaultCalendar: "work" },
  );

  it.each([
    ["MCP_KHAL_CALENDARS_WORK_ALARM", "soon", /^MCP_KHAL_CALENDARS_WORK_ALARM must be a reminder like 30m/],
    ["MCP_KHAL_CALENDARS_WORK_ALARM", "1w", /^MCP_KHAL_CALENDARS_WORK_ALARM must be a reminder like 30m/],
    ["MCP_KHAL_CALENDARS_WORK_EMAIL", "nope", /^MCP_KHAL_CALENDARS_WORK_EMAIL is not a valid email address/],
    [
      "MCP_KHAL_CALENDARS_WORK_PATH",
      "relative/dir",
      /^MCP_KHAL_CALENDARS_WORK_PATH must be an absolute path/,
    ],
    ["MCP_KHAL_CALENDARS_WORK_PATH", "~/cal", /^MCP_KHAL_CALENDARS_WORK_PATH must be an absolute path/],
    [
      "MCP_KHAL_CALENDARS_WORK_PATH",
      "/cal/\u0001x",
      /^MCP_KHAL_CALENDARS_WORK_PATH must be an absolute path/,
    ],
    [
      ENV_DEFAULT_CALENDAR,
      "nowhere",
      /^MCP_KHAL_DEFAULT_CALENDAR 'nowhere' is not one of the configured calendars \(home, work\)/,
    ],
  ])("%s=%j", (name, value, message) => {
    expect(problems(base, { [name]: value })[0]).toMatch(message);
  });

  it("is also how a value of the file is named: by its path in the file", () => {
    const json = file({ work: { path: "/cal/work", alarm: "soon" } });
    expect(problems(json, {})[0]).toMatch(/^calendars\.work\.alarm must be a reminder/);
  });

  it("report the shared path of two calendars when a variable makes them equal", () => {
    const e = problems(base, { MCP_KHAL_CALENDARS_HOME_PATH: "/cal/work" });
    expect(e).toEqual(["calendars home and work have the same path /cal/work; each needs its own"]);
  });

  it("require a default when the environment adds a second calendar", () => {
    const json = file({ work: { path: "/cal/work" } });
    const e = problems(json, { MCP_KHAL_CALENDARS_HOME_PATH: "/cal/home" });
    expect(e[0]).toContain("several calendars are configured (home, work)");
    expect(e[0]).toContain(ENV_DEFAULT_CALENDAR);
  });

  it("ask for the path of a calendar the environment creates without one", () => {
    const e = problems(undefined, { MCP_KHAL_CALENDARS_HOME_EMAIL: "me@home.org" });
    expect(e[0]).toBe(
      "calendars.home.path is required (or MCP_KHAL_CALENDARS_HOME_PATH): the absolute path of the directory of the calendar's .ics files",
    );
  });

  it("report every problem at once, file and environment together", () => {
    const e = problems(file({ work: { path: "/cal/work", email: "nope" } }), {
      MCP_KHAL_CALENDARS_WORK_ALARM: "soon",
      MCP_KHAL_CALENDARS_WORK_COLOR: "red",
    });
    expect(e).toHaveLength(3);
    expect(e.join("\n")).toContain("MCP_KHAL_CALENDARS_WORK_COLOR is not a setting");
    expect(e.join("\n")).toContain("MCP_KHAL_CALENDARS_WORK_ALARM must be a reminder");
    expect(e.join("\n")).toContain("calendars.work.email is not a valid email address");
  });
});

describe("variables that look like settings but are none", () => {
  const base = file({ work: { path: "/cal/work" } });
  const expected =
    /is not a setting \(expected MCP_KHAL_CALENDARS_<NAME>_PATH, MCP_KHAL_CALENDARS_<NAME>_EMAIL or MCP_KHAL_CALENDARS_<NAME>_ALARM/;

  it.each([
    "MCP_KHAL_CALENDARS_WORK_COLOR",
    "MCP_KHAL_CALENDARS_WORK",
    "MCP_KHAL_CALENDARS_PATH",
    "MCP_KHAL_CALENDARS__PATH",
    "MCP_KHAL_CALENDARS_work_PATH",
    "MCP_KHAL_CALENDARS_WORK__PATH",
    "MCP_KHAL_CALENDARS_WORK_path",
    "MCP_KHAL_CALENDARS_WORK_PATH_",
    "MCP_KHAL_CALENDARS__WORK__PATH",
  ])("%s is reported", (name) => {
    const e = problems(base, { [name]: "/x" });
    expect(e).toHaveLength(1);
    expect(e[0]).toContain(name);
    expect(e[0]).toMatch(expected);
  });

  it("are ignored when empty, like every other unset variable", () => {
    expect(unwrap(parseConfigWithEnv(base, { MCP_KHAL_CALENDARS_WORK_COLOR: "" }))).toEqual(
      unwrap(parseConfigValidated(base)),
    );
  });

  it("are not the business of other MCP_KHAL_ variables, which are left alone", () => {
    expect(
      unwrap(
        parseConfigWithEnv(base, { MCP_KHAL_BIN: "/x", MCP_KHAL_ANYTHING: "y", MCP_KHAL_CALENDARS: "z" }),
      ),
    ).toEqual(unwrap(parseConfigValidated(base)));
  });

  it("are reported when two calendars of the file share one segment", () => {
    const json = file({ "a-b": { path: "/cal/1" }, "a b": { path: "/cal/2" } }, { defaultCalendar: "a-b" });
    const e = problems(json, { MCP_KHAL_CALENDARS_A_B_ALARM: "15m" });
    expect(e).toEqual([
      "MCP_KHAL_CALENDARS_A_B_ALARM is ambiguous: the calendars a b and a-b all map to A_B; rename one of them",
    ]);
    // without a variable for that segment nothing is wrong
    expect(unwrap(parseConfigWithEnv(json, {})).calendars).toBeDefined();
  });
});

describe("loadSettings with the environment", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await tempDir();
  });
  afterAll(() => removeDir(dir));

  const input = (env: Record<string, string | undefined>) => ({ env, home: dir, timezone: "Europe/Berlin" });

  it("works without any file when the environment holds the calendars", async () => {
    const work = join(dir, "work");
    await mkdir(work, { recursive: true });
    const s = await runOk(
      loadSettings(input({ MCP_KHAL_CONFIG: join(dir, "absent.json"), MCP_KHAL_CALENDARS_WORK_PATH: work })),
    );
    expect(s.calendars).toEqual({ work: { path: work } });
    expect(s.configFound).toBe(false);
  });

  it("lets a variable beat the file", async () => {
    const path = join(dir, "cfg.json");
    await writeFile(path, file({ work: { path: "/cal/work", alarm: "1d" } }));
    const s = await runOk(
      loadSettings(input({ MCP_KHAL_CONFIG: path, MCP_KHAL_CALENDARS_WORK_ALARM: "15m" })),
    );
    expect(s.calendars.work).toEqual({ path: "/cal/work", alarm: "15m" });
    expect(s.configFound).toBe(true);
  });

  it("fails with the variable's name when its value is wrong", async () => {
    const e = await runFail(
      loadSettings(input({ MCP_KHAL_CONFIG: join(dir, "absent.json"), MCP_KHAL_CALENDARS_WORK_PATH: "rel" })),
    );
    expect(e.message).toContain("MCP_KHAL_CALENDARS_WORK_PATH must be an absolute path");
  });
});
