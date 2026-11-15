import { describe, expect, it } from "vitest";
import {
  CONFIG_KEYS,
  configLocation,
  defaultConfig,
  interpretAnswer,
  interpretPath,
  isAlarmSetting,
  isEmail,
  parseConfig,
  resolveAddress,
  resolveAlarm,
  resolveCalendar,
  serializeConfig,
} from "./config.js";
import { failure, unwrap } from "./testlib.js";

/** the (required) path of a test calendar */
const at = (name: string): string => `/cal/${name.trim()}`;

describe("calendar path", () => {
  const cfg = (calendars: unknown): string => JSON.stringify({ calendars });

  it("is read, trimmed and written back", () => {
    const config = unwrap(parseConfig(cfg({ work: { path: "  /data/work " } })));
    expect(config.calendars.work).toEqual({ path: "/data/work" });
    expect(unwrap(parseConfig(serializeConfig(config)))).toEqual(config);
  });

  it("is required: a calendar without one is rejected", () => {
    expect(failure(parseConfig(cfg({ work: {} }))).message).toMatch(
      /^calendars\.work\.path is required \(or MCP_KHAL_CALENDARS_WORK_PATH\): the absolute path of the directory of the calendar's \.ics files/,
    );
    expect(failure(parseConfig(cfg({ work: { email: "me@work.com", alarm: "1d" } }))).message).toContain(
      "calendars.work.path is required",
    );
  });

  it.each(["work/", "~/cal", "~", "", "   ", "/a\u0007b", "/a\nb", 5, null, true, ["/a"]])(
    "rejects the value %j",
    (path) => {
      const problems = failure(parseConfig(cfg({ work: { path } })));
      expect(problems.message).toContain("calendars.work.path must be an absolute path");
    },
  );

  it("rejects two calendars with the same directory, even written differently", () => {
    const e = failure(
      parseConfig(cfg({ a: { path: "/data/x" }, b: { path: "/data/x/" }, c: { path: "/y" } })),
    );
    expect(e.message).toBe("calendars a and b have the same path /data/x; each needs its own");
  });

  it("reports every bad path at once", () => {
    const e = failure(parseConfig(cfg({ a: { path: "rel" }, b: { path: "~/b" }, c: {} })));
    expect(e.message).toMatch(/^3 problems:/);
  });
});

describe("isEmail", () => {
  it("accepts plain addresses and rejects junk", () => {
    expect(isEmail("me@example.com")).toBe(true);
    expect(isEmail("work")).toBe(false);
    expect(isEmail("a b@example.com")).toBe(false);
    expect(isEmail("me@example")).toBe(false);
    expect(isEmail("a@b.com, c@d.com")).toBe(false);
  });
});

describe("configLocation", () => {
  it("prefers MCP_KHAL_CONFIG, then XDG_CONFIG_HOME, then ~/.config", () => {
    expect(
      unwrap(configLocation({ MCP_KHAL_CONFIG: "/x.json", XDG_CONFIG_HOME: "/xdg" }, "/home/u")),
    ).toEqual({
      path: "/x.json",
      source: "MCP_KHAL_CONFIG",
    });
    expect(unwrap(configLocation({ XDG_CONFIG_HOME: "/xdg" }, "/home/u"))).toEqual({
      path: "/xdg/mcp-khal.json",
      source: "XDG_CONFIG_HOME",
    });
    expect(unwrap(configLocation({}, "/home/u"))).toEqual({
      path: "/home/u/.config/mcp-khal.json",
      source: "default",
    });
  });

  it("trims the variables and treats empty or blank ones as unset", () => {
    expect(unwrap(configLocation({ MCP_KHAL_CONFIG: "  /x.json \n" }, "/h")).path).toBe("/x.json");
    expect(unwrap(configLocation({ MCP_KHAL_CONFIG: "", XDG_CONFIG_HOME: "  " }, "/h")).source).toBe(
      "default",
    );
  });

  it("rejects relative paths, which would depend on the working directory", () => {
    expect(failure(configLocation({ MCP_KHAL_CONFIG: "cfg.json" }, "/h"))).toEqual([
      'MCP_KHAL_CONFIG must be an absolute path, got "cfg.json"',
    ]);
    expect(failure(configLocation({ XDG_CONFIG_HOME: "~/.config" }, "/h"))).toEqual([
      'XDG_CONFIG_HOME must be an absolute path, got "~/.config"',
    ]);
  });
});

describe("parseConfig / serializeConfig", () => {
  it("roundtrips a config", () => {
    const c = {
      defaultCalendar: "work",
      calendars: {
        work: { path: "/cal/work", email: "me@example.com", alarm: "1d" },
        home: { path: "/cal/home", alarm: "none" },
      },
    };
    expect(unwrap(parseConfig(serializeConfig(c)))).toEqual(c);
  });

  it("defaults the default calendar to unset and the calendars to empty", () => {
    expect(unwrap(parseConfig("{}"))).toEqual({ calendars: {} });
    expect(unwrap(parseConfig("{}"))).toEqual(defaultConfig);
  });

  it("knows exactly two keys: defaultCalendar and calendars", () => {
    expect(CONFIG_KEYS).toEqual(["defaultCalendar", "calendars"]);
    expect(Object.keys(JSON.parse(serializeConfig(defaultConfig)))).toEqual(["calendars"]);
  });

  it("rejects every other top-level key as unknown, whatever its value", () => {
    for (const key of ["khal", "binary", "timeout"])
      expect(failure(parseConfig(`{"${key}":"x"}`)).message).toContain(`unknown config key '${key}'`);
  });

  it("reads one object per calendar; path is required, email and alarm are optional", () => {
    const c = unwrap(
      parseConfig(
        JSON.stringify({
          defaultCalendar: "both",
          calendars: {
            both: { path: "/cal/both", email: "me@example.com", alarm: "1d" },
            emailOnly: { path: "/cal/emailOnly", email: "me@example.org" },
            alarmOnly: { path: "/cal/alarmOnly", alarm: "90m" },
            bare: { path: "/cal/bare" },
          },
        }),
      ),
    );
    expect(c.calendars).toEqual({
      both: { path: "/cal/both", email: "me@example.com", alarm: "1d" },
      emailOnly: { path: "/cal/emailOnly", email: "me@example.org" },
      alarmOnly: { path: "/cal/alarmOnly", alarm: "90m" },
      bare: { path: "/cal/bare" },
    });
    // a field that is not configured is absent, not undefined
    expect(Object.keys(c.calendars.emailOnly ?? {}).sort()).toEqual(["email", "path"]);
    expect(Object.keys(c.calendars.bare ?? {})).toEqual(["path"]);
  });

  it("no longer reads the flat calendar -> email format of v1.0.0", () => {
    expect(failure(parseConfig('{"work":"me@example.com"}')).message).toMatch(/unknown config key 'work'/);
  });

  it("rejects invalid JSON and non-objects", () => {
    expect(failure(parseConfig("{"))._tag).toBe("InvalidInput");
    expect(failure(parseConfig("[]"))._tag).toBe("InvalidInput");
    expect(failure(parseConfig('"khal"'))._tag).toBe("InvalidInput");
    expect(failure(parseConfig("null"))._tag).toBe("InvalidInput");
  });

  it("rejects unknown top-level keys", () => {
    expect(failure(parseConfig('{"typo":1}')).message).toBe(
      "unknown config key 'typo' (expected 'defaultCalendar', 'calendars')",
    );
    expect(failure(parseConfig('{"khal":"khal","typo":1}')).message).toMatch(/unknown config key 'typo'/);
    expect(failure(parseConfig('{"work":"nope"}')).message).toMatch(/unknown config key 'work'/);
  });

  it("explains where the retired calendarEmails and calendarAlarms keys went", () => {
    expect(failure(parseConfig('{"calendarEmails":{"work":"me@work.com"}}')).message).toBe(
      'config key \'calendarEmails\' has moved into "calendars": { "<name>": { "email": "..." } }',
    );
    expect(failure(parseConfig('{"calendarAlarms":{"work":"1d"}}')).message).toBe(
      'config key \'calendarAlarms\' has moved into "calendars": { "<name>": { "alarm": "..." } }',
    );
  });
});

describe("calendar objects", () => {
  const problemsOf = (calendars: unknown): string =>
    failure(parseConfig(JSON.stringify({ calendars }))).message;

  it.each([["me@work.com"], [15], [null], [true], [[]]])("must be objects, not %j", (value) => {
    expect(problemsOf({ work: value })).toMatch(
      /^calendars\.work must be an object like \{ "path": "\/home\/me\/calendars\/work", "email": "me@example.com", "alarm": "15m" \}, got /,
    );
  });

  it("must be a JSON object of calendars", () => {
    for (const value of ["15m", 15, null, []])
      expect(problemsOf(value)).toMatch(/^calendars must be a JSON object of calendar name -> settings/);
  });

  it("reject unknown keys, so typos are not silently ignored", () => {
    expect(problemsOf({ work: { path: "/w", emial: "me@work.com" } })).toBe(
      "calendars.work has an unknown key 'emial' (expected 'email', 'alarm', 'path')",
    );
  });

  it.each(["nope", "me@", "a b@c.de", 15, null, ["a@b.co"]])("reject the address %j", (email) => {
    expect(problemsOf({ work: { path: "/w", email } })).toMatch(
      /^calendars\.work\.email is not a valid email address, got /,
    );
  });

  it.each(["15", "1w", "-5m", "", "5 m", "10000m", "None", 15, null, true, ["15m"], { m: 15 }])(
    "reject the reminder %j",
    (alarm) => {
      expect(problemsOf({ work: { path: "/w", alarm } })).toMatch(
        /^calendars\.work\.alarm must be a reminder like 30m, 2h or 1d/,
      );
    },
  );

  it("list every problem of every calendar", () => {
    const e = failure(
      parseConfig(
        JSON.stringify({
          calendars: {
            a: { path: "/a", email: "nope", alarm: "soon", extra: 1 },
            b: "text",
            c: { path: "/c", email: "me@c.org", alarm: "1d" },
          },
        }),
      ),
    );
    expect(e.message).toMatch(/^4 problems:/);
    for (const part of [
      "calendars.a.email is not a valid email address",
      "calendars.a.alarm must be a reminder like 30m",
      "calendars.a has an unknown key 'extra'",
      "calendars.b must be an object",
    ])
      expect(e.message).toContain(part);
    // the valid calendar is not mentioned
    expect(e.message).not.toContain("calendars.c");
  });
});

describe("isAlarmSetting", () => {
  it.each(["none", "0m", "5m", "30m", "90m", "1d", "14d", "2h", "9999d", "05m"])("accepts %j", (s) => {
    expect(isAlarmSetting(s)).toBe(true);
  });

  it.each([
    "",
    "15",
    "m",
    "d",
    "1w",
    "1.5d",
    "-5m",
    "+5m",
    "5 m",
    " 5m",
    "5M",
    "None",
    "NONE",
    "10000m",
    "5md",
    "PT5M",
    "1d2h",
    "five minutes",
  ])("rejects %j", (s) => {
    expect(isAlarmSetting(s)).toBe(false);
  });
});

describe("reminders in the config", () => {
  it("only exist on a calendar: none unless it has an alarm", () => {
    expect(unwrap(parseConfig("{}")).calendars).toEqual({});
    expect(unwrap(parseConfig('{"calendars":{"work":{"path":"/w"}}}')).calendars).toEqual({
      work: { path: "/w" },
    });
  });

  it("are read per calendar, including none", () => {
    const c = unwrap(
      parseConfig(
        JSON.stringify({
          defaultCalendar: "work",
          calendars: {
            work: { path: "/w", alarm: "1d" },
            home: { path: "/h", alarm: "none" },
            school: { path: "/s", alarm: "90m" },
          },
        }),
      ),
    );
    expect(c.calendars).toEqual({
      work: { path: "/w", alarm: "1d" },
      home: { path: "/h", alarm: "none" },
      school: { path: "/s", alarm: "90m" },
    });
  });

  it("are not a global setting: nothing about them is written next to the calendars", () => {
    expect(JSON.parse(serializeConfig(defaultConfig))).toEqual({ calendars: {} });
  });

  it("explains that the retired defaultAlarm key is gone and what replaces it", () => {
    expect(failure(parseConfig('{"defaultAlarm":"15m"}')).message).toBe(
      `config key 'defaultAlarm' has been dropped: set "alarm" on each calendar under "calendars", and name the calendar for events without one in "defaultCalendar"`,
    );
  });
});

describe("defaultCalendar", () => {
  const two = { a: { path: "/a" }, b: { path: "/b" } };

  it("is read and trimmed", () => {
    const json = '{"defaultCalendar":"  work \\n","calendars":{"work":{"path":"/w"}}}';
    expect(unwrap(parseConfig(json)).defaultCalendar).toBe("work");
  });

  it("is optional: absent when not configured, and only written when set", () => {
    const c = unwrap(parseConfig("{}"));
    expect("defaultCalendar" in c).toBe(false);
    expect(Object.keys(JSON.parse(serializeConfig(c)) as object)).toEqual(["calendars"]);
    expect(Object.keys(JSON.parse(serializeConfig({ ...c, defaultCalendar: "work" })) as object)).toEqual([
      "defaultCalendar",
      "calendars",
    ]);
  });

  it("is optional with exactly one calendar: that one is meant", () => {
    const c = unwrap(parseConfig('{"calendars":{"work":{"path":"/w"}}}'));
    expect(c.defaultCalendar).toBeUndefined();
    expect("defaultCalendar" in c).toBe(false);
  });

  it("is required when there are several calendars, and they are named sorted", () => {
    expect(failure(parseConfig(JSON.stringify({ calendars: { ...two, "0": { path: "/0" } } }))).message).toBe(
      'several calendars are configured (0, a, b): set "defaultCalendar" (or MCP_KHAL_DEFAULT_CALENDAR) to the one new events go to when a call names no calendar',
    );
  });

  it("is accepted with several calendars when it names one of them", () => {
    expect(
      unwrap(parseConfig(JSON.stringify({ defaultCalendar: "b", calendars: two }))).defaultCalendar,
    ).toBe("b");
  });

  it("must be one of the configured calendars", () => {
    expect(failure(parseConfig(JSON.stringify({ defaultCalendar: "work", calendars: two }))).message).toBe(
      "defaultCalendar 'work' is not one of the configured calendars (a, b)",
    );
    expect(failure(parseConfig('{"defaultCalendar":"work"}')).message).toBe(
      "defaultCalendar 'work' is not one of the configured calendars (none)",
    );
  });

  it("is compared exactly, and inherited object properties are not calendars", () => {
    expect(failure(parseConfig(JSON.stringify({ defaultCalendar: "A", calendars: two }))).message).toContain(
      "is not one of the configured calendars",
    );
    expect(failure(parseConfig('{"defaultCalendar":"constructor"}')).message).toContain(
      "is not one of the configured calendars",
    );
  });

  it.each([42, null, true, ["work"], { a: 1 }])("rejects the non-string %j", (value) => {
    expect(failure(parseConfig(JSON.stringify({ defaultCalendar: value }))).message).toBe(
      `defaultCalendar must be a calendar name (a string), got ${JSON.stringify(value)}`,
    );
  });

  it("rejects an empty name, also after trimming, and control characters", () => {
    for (const value of ["", "   ", "\t"])
      expect(failure(parseConfig(JSON.stringify({ defaultCalendar: value }))).message).toBe(
        "defaultCalendar has an empty calendar name",
      );
    expect(failure(parseConfig('{"defaultCalendar":"wo\\u0001rk"}')).message).toMatch(
      /^defaultCalendar has a calendar name with control characters/,
    );
  });

  it("is reported together with the other problems, not instead of them", () => {
    const e = failure(
      parseConfig(JSON.stringify({ defaultCalendar: 42, calendars: { work: { path: "rel" } } })),
    );
    expect(e.message).toMatch(/^2 problems:/);
  });
});

describe("resolveCalendar", () => {
  const several = {
    defaultCalendar: "work",
    calendars: { work: { path: at("work") }, home: { path: at("home") } },
  };
  const only = { calendars: { home: { path: at("home") } } };

  it("prefers the calendar of the call, trimmed, over the default calendar", () => {
    expect(resolveCalendar(several, " home ")).toBe("home");
    expect(resolveCalendar(only, "other")).toBe("other");
  });

  it("falls back to the default calendar", () => {
    expect(resolveCalendar(several, undefined)).toBe("work");
  });

  it("falls back to the only calendar when there is no default", () => {
    expect(resolveCalendar(only, undefined)).toBe("home");
  });

  it("gives nothing without a calendar, and never guesses among several", () => {
    expect(resolveCalendar({ calendars: {} }, undefined)).toBeUndefined();
    expect(resolveCalendar({ calendars: several.calendars }, undefined)).toBeUndefined();
  });

  it("keeps a blank calendar of the call blank, so it is rejected instead of silently replaced", () => {
    expect(resolveCalendar(several, "  ")).toBe("");
  });
});

describe("trimming", () => {
  it("trims every string of the config before checking it", () => {
    const c = unwrap(
      parseConfig(
        JSON.stringify({
          defaultCalendar: " work ",
          calendars: {
            " work ": { path: " /cal/work\n", email: "  me@work.com ", alarm: "\t1d" },
            "\thome": { path: "\t/cal/home", email: "me@home.org\n", alarm: " none " },
          },
        }),
      ),
    );
    expect(c).toEqual({
      defaultCalendar: "work",
      calendars: {
        work: { path: "/cal/work", email: "me@work.com", alarm: "1d" },
        home: { path: "/cal/home", email: "me@home.org", alarm: "none" },
      },
    });
  });

  it("does not trim inside a value: '5 m' stays invalid", () => {
    expect(failure(parseConfig('{"calendars":{"work":{"path":"/w","alarm":" 5 m "}}}')).message).toMatch(
      /calendars\.work\.alarm must be/,
    );
  });

  it("rejects names that are only whitespace", () => {
    expect(failure(parseConfig('{"calendars":{"  ":{"path":"/w","email":"me@work.com"}}}')).message).toMatch(
      /calendars has an empty calendar name/,
    );
  });

  it("rejects two names that only differ in whitespace", () => {
    expect(
      failure(parseConfig('{"calendars":{"work":{"path":"/a"},"  work ":{"path":"/b"}}}')).message,
    ).toMatch(/calendars lists calendar 'work' more than once \(names are compared after trimming\)/);
  });

  it("trims the organizer and the calendar when resolving an address", () => {
    expect(
      unwrap(resolveAddress({ work: { path: at("work"), email: "me@work.com" } }, "  work ", undefined)),
    ).toBe("me@work.com");
    expect(unwrap(resolveAddress({}, "work", "  a@b.com \n"))).toBe("a@b.com");
  });

  it("trims an explicit alarm and the calendar when resolving a reminder", () => {
    const settings = { calendars: { work: { path: at("work"), alarm: "1d" } } };
    expect(resolveAlarm(settings, " work ", undefined)).toBe("1d");
    expect(resolveAlarm(settings, "work", " 5m ")).toBe("5m");
    expect(resolveAlarm(settings, "work", " none ")).toBeUndefined();
  });
});

describe("reporting all problems at once", () => {
  it("lists every invalid value of the file, not only the first", () => {
    const e = failure(
      parseConfig(
        JSON.stringify({
          khal: "./khal",
          defaultCalendar: 42,
          calendars: {
            work: { path: "/w", email: "nope", alarm: "1w" },
            home: { path: "/h", email: "me@home.org", alarm: "1d" },
          },
          typo: 1,
          another: 2,
        }),
      ),
    );
    expect(e._tag).toBe("InvalidInput");
    expect(e.message).toMatch(/^6 problems:\n/);
    for (const part of [
      "unknown config key 'khal'",
      "unknown config key 'typo'",
      "unknown config key 'another'",
      "defaultCalendar must be a calendar name (a string), got 42",
      "calendars.work.email is not a valid email address",
      "calendars.work.alarm must be a reminder like 30m",
    ])
      expect(e.message).toContain(part);
    // the valid calendar is not reported
    expect(e.message).not.toContain("calendars.home");
  });

  it("reports several problems inside one calendars object", () => {
    const e = failure(
      parseConfig(
        JSON.stringify({
          calendars: {
            a: { path: "/a", alarm: "x" },
            b: { path: "/b", alarm: "y" },
            c: { path: "/c", alarm: "1d" },
            "": { path: "/e", alarm: "2d" },
          },
        }),
      ),
    );
    expect(e.message).toMatch(/^3 problems:/);
  });

  it("reports one problem as a plain message, without a list", () => {
    expect(failure(parseConfig('{"defaultCalendar":42}')).message).toMatch(
      /^defaultCalendar must be a calendar name/,
    );
  });

  it("keeps the dependency between steps: not JSON means only that one problem", () => {
    expect(failure(parseConfig("{ nope")).message).toMatch(/^config is not valid JSON/);
  });
});

describe("resolveAlarm", () => {
  const settings = {
    calendars: {
      work: { path: "/cal/work", email: "me@work.com", alarm: "1d" },
      home: { path: "/cal/home", alarm: "none" },
      declared: { path: "/cal/declared" },
    },
  };

  it("prefers an explicit alarm over everything", () => {
    expect(resolveAlarm(settings, "work", "30m")).toBe("30m");
    expect(resolveAlarm(settings, "home", "30m")).toBe("30m");
    expect(resolveAlarm(settings, undefined, "2h")).toBe("2h");
  });

  it("lets an explicit 'none' suppress a configured reminder for this event", () => {
    expect(resolveAlarm(settings, "work", "none")).toBeUndefined();
    expect(resolveAlarm(settings, undefined, "none")).toBeUndefined();
  });

  it("uses the calendar's own reminder", () => {
    expect(resolveAlarm(settings, "work", undefined)).toBe("1d");
  });

  it("gives no reminder for a calendar that has none, 'none', or that is not configured", () => {
    expect(resolveAlarm(settings, "declared", undefined)).toBeUndefined();
    expect(resolveAlarm(settings, "home", undefined)).toBeUndefined();
    expect(resolveAlarm(settings, "other", undefined)).toBeUndefined();
    expect(resolveAlarm(settings, undefined, undefined)).toBeUndefined();
    expect(resolveAlarm({ calendars: {} }, "work", undefined)).toBeUndefined();
  });

  it("ignores inherited object properties as calendar names", () => {
    expect(resolveAlarm(settings, "constructor", undefined)).toBeUndefined();
    expect(resolveAlarm(settings, "__proto__", undefined)).toBeUndefined();
  });
});

describe("interpretAnswer", () => {
  it("blank keeps the fallback (or skips)", () => {
    expect(unwrap(interpretAnswer("  ", "me@example.com"))).toBe("me@example.com");
    expect(unwrap(interpretAnswer("", undefined))).toBeUndefined();
  });

  it("accepts a valid address and rejects an invalid one", () => {
    expect(unwrap(interpretAnswer(" you@example.com ", "me@example.com"))).toBe("you@example.com");
    expect(typeof failure(interpretAnswer("nope", undefined))).toBe("string");
  });
});

describe("interpretPath", () => {
  it("blank keeps the fallback (or skips)", () => {
    expect(unwrap(interpretPath("  ", "/cal/work", []))).toBe("/cal/work");
    expect(unwrap(interpretPath("", undefined, []))).toBeUndefined();
  });

  it("accepts an absolute path, trimmed", () => {
    expect(unwrap(interpretPath(" /cal/new \n", "/cal/old", ["/cal/other"]))).toBe("/cal/new");
  });

  it.each(["cal/work", "~/cal", "~", "./cal", "/a\u0007b"])("rejects %j", (answer) => {
    expect(failure(interpretPath(answer, undefined, []))).toBe(
      `'${answer}' is not an absolute path (no '~', no relative path)`,
    );
  });

  it("rejects a path another calendar already uses, however it is written", () => {
    expect(failure(interpretPath("/cal/work/", undefined, ["/cal/home", "/cal/work"]))).toBe(
      "'/cal/work/' is already the path of another calendar",
    );
  });
});

describe("resolveAddress", () => {
  const calendars = {
    work: { path: "/cal/work", email: "me@work.com" },
    home: { path: "/cal/home", alarm: "1d" },
  };

  it("prefers explicit over the calendar's address over an email-like calendar name", () => {
    expect(unwrap(resolveAddress(calendars, "work", "x@y.com"))).toBe("x@y.com");
    expect(unwrap(resolveAddress(calendars, "work"))).toBe("me@work.com");
    expect(unwrap(resolveAddress({}, "me@home.com"))).toBe("me@home.com");
  });

  it("fails without any known address, also for a calendar that has only a reminder", () => {
    expect(failure(resolveAddress({}, "work"))._tag).toBe("InvalidInput");
    expect(failure(resolveAddress({}, undefined))._tag).toBe("InvalidInput");
    expect(failure(resolveAddress(calendars, "home")).message).toMatch(
      /no address known for calendar 'home'/,
    );
  });

  it("rejects an invalid explicit address", () => {
    expect(failure(resolveAddress(calendars, "work", "nope"))._tag).toBe("InvalidInput");
  });

  it("ignores inherited object properties", () => {
    expect(failure(resolveAddress({}, "constructor"))._tag).toBe("InvalidInput");
  });
});
