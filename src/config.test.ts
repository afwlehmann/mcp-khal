import { describe, expect, it } from "vitest";
import {
  checkBinary,
  checkEnvBinary,
  configLocation,
  defaultConfig,
  interpretAnswer,
  isAlarmSetting,
  isEmail,
  parseCalendarNames,
  parseConfig,
  resolveAddress,
  resolveAlarm,
  resolveKhalBinary,
  serializeConfig,
} from "./config.js";
import { failure, unwrap } from "./testlib.js";

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

describe("checkEnvBinary", () => {
  it("accepts nothing set, a bare command name and an absolute path (trimmed)", () => {
    expect(unwrap(checkEnvBinary({}))).toBeUndefined();
    expect(unwrap(checkEnvBinary({ MCP_KHAL_BIN: "  " }))).toBeUndefined();
    expect(unwrap(checkEnvBinary({ MCP_KHAL_BIN: " khal\n" }))).toBe("khal");
    expect(unwrap(checkEnvBinary({ MCP_KHAL_BIN: " /usr/bin/khal\n" }))).toBe("/usr/bin/khal");
  });

  it.each(["./khal", "bin/khal", "../khal", "a\\b"])("never accepts the relative path %j", (v) => {
    expect(failure(checkEnvBinary({ MCP_KHAL_BIN: v }))).toEqual([
      `MCP_KHAL_BIN must be a bare command name (looked up on PATH) or an absolute path, got ${JSON.stringify(v)}`,
    ]);
  });

  it("says that ~ is not expanded", () => {
    expect(failure(checkEnvBinary({ MCP_KHAL_BIN: "~/bin/khal" }))[0]).toMatch(
      /^MCP_KHAL_BIN must not start with '~', which is not expanded; use an absolute path/,
    );
  });

  it("rejects control characters", () => {
    expect(failure(checkEnvBinary({ MCP_KHAL_BIN: "/usr/bin/kh\u0000al" }))[0]).toMatch(
      /^MCP_KHAL_BIN must be a non-empty command name or absolute path without control characters/,
    );
  });
});

describe("checkBinary", () => {
  it.each(["khal", "/usr/bin/khal", "/nix/store/x-khal/bin/khal", "/opt/My Tools/khal", "khal-2"])(
    "accepts %j",
    (v) => {
      expect(unwrap(checkBinary(v, "khal"))).toBe(v);
    },
  );

  it("trims", () => {
    expect(unwrap(checkBinary("  /usr/bin/khal \n", "khal"))).toBe("/usr/bin/khal");
    expect(unwrap(checkBinary(" khal ", "khal"))).toBe("khal");
  });

  it.each([
    "",
    "   ",
    "./khal",
    "bin/khal",
    "../khal",
    "~/bin/khal",
    "~khal",
    "khal --version",
    "-khal",
    "a\\b",
    "kh\u0000al",
  ])("rejects %j", (v) => {
    const [message] = failure(checkBinary(v, "the khal path"));
    expect(message).toMatch(/^the khal path must/);
  });

  it("explains the tilde and the relative path cases", () => {
    expect(failure(checkBinary("~/khal", "x"))[0]).toMatch(/not expanded; use an absolute path/);
    expect(failure(checkBinary("./khal", "x"))[0]).toMatch(/bare command name .* or an absolute path/);
  });
});

describe("parseCalendarNames", () => {
  it("returns trimmed non-empty lines", () => {
    expect(parseCalendarNames("work\n  home \n\n")).toEqual(["work", "home"]);
  });
});

describe("parseConfig / serializeConfig", () => {
  it("roundtrips a config", () => {
    const c = {
      khal: "/nix/store/x-khal/bin/khal",
      defaultAlarm: "15m",
      calendars: { work: { email: "me@example.com", alarm: "1d" }, home: { alarm: "none" } },
    };
    expect(unwrap(parseConfig(serializeConfig(c)))).toEqual(c);
  });

  it("defaults khal to 'khal', the reminder to none and the calendars to empty", () => {
    expect(unwrap(parseConfig("{}"))).toEqual({ khal: "khal", defaultAlarm: "none", calendars: {} });
    expect(unwrap(parseConfig('{"khal":"/usr/local/bin/khal"}'))).toEqual({
      khal: "/usr/local/bin/khal",
      defaultAlarm: "none",
      calendars: {},
    });
  });

  it("trims the khal path", () => {
    expect(unwrap(parseConfig('{"khal":"  khal  "}')).khal).toBe("khal");
  });

  it("reads one object per calendar; every field of it is optional", () => {
    const c = unwrap(
      parseConfig(
        JSON.stringify({
          calendars: {
            both: { email: "me@example.com", alarm: "1d" },
            emailOnly: { email: "me@example.org" },
            alarmOnly: { alarm: "90m" },
            declared: {},
          },
        }),
      ),
    );
    expect(c.calendars).toEqual({
      both: { email: "me@example.com", alarm: "1d" },
      emailOnly: { email: "me@example.org" },
      alarmOnly: { alarm: "90m" },
      declared: {},
    });
    // a field that is not configured is absent, not undefined
    expect(Object.keys(c.calendars.emailOnly ?? {})).toEqual(["email"]);
    expect(Object.keys(c.calendars.declared ?? {})).toEqual([]);
  });

  it("still reads the flat calendar -> email format of v1.0.0", () => {
    expect(unwrap(parseConfig('{"work":"me@example.com","home":"me@home.org"}'))).toEqual({
      khal: "khal",
      defaultAlarm: "none",
      calendars: { work: { email: "me@example.com" }, home: { email: "me@home.org" } },
    });
  });

  it("rejects invalid JSON and non-objects", () => {
    expect(failure(parseConfig("{"))._tag).toBe("InvalidInput");
    expect(failure(parseConfig("[]"))._tag).toBe("InvalidInput");
    expect(failure(parseConfig('"khal"'))._tag).toBe("InvalidInput");
  });

  it("rejects bad khal values and unknown top-level keys", () => {
    expect(failure(parseConfig('{"khal":""}')).message).toMatch(/non-empty/);
    expect(failure(parseConfig('{"khal":42}')).message).toMatch(/must be a string, got 42/);
    expect(failure(parseConfig('{"khal":"kh\\nal"}')).message).toMatch(/non-empty/);
    expect(failure(parseConfig('{"khal":"khal","typo":1}')).message).toMatch(
      /unknown config key 'typo' \(expected 'khal', 'defaultAlarm', 'calendars'\)/,
    );
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
      /^calendars\.work must be an object like \{ "email": "me@example.com", "alarm": "15m" \}, got /,
    );
  });

  it("must be a JSON object of calendars", () => {
    for (const value of ["15m", 15, null, []])
      expect(problemsOf(value)).toMatch(/^calendars must be a JSON object of calendar name -> settings/);
  });

  it("reject unknown keys, so typos are not silently ignored", () => {
    expect(problemsOf({ work: { emial: "me@work.com" } })).toBe(
      "calendars.work has an unknown key 'emial' (expected 'email', 'alarm')",
    );
  });

  it.each(["nope", "me@", "a b@c.de", 15, null, ["a@b.co"]])("reject the address %j", (email) => {
    expect(problemsOf({ work: { email } })).toMatch(
      /^calendars\.work\.email is not a valid email address, got /,
    );
  });

  it.each(["15", "1w", "-5m", "", "5 m", "10000m", "None", 15, null, true, ["15m"], { m: 15 }])(
    "reject the reminder %j",
    (alarm) => {
      expect(problemsOf({ work: { alarm } })).toMatch(
        /^calendars\.work\.alarm must be a reminder like 30m, 2h or 1d/,
      );
    },
  );

  it("list every problem of every calendar", () => {
    const e = failure(
      parseConfig(
        JSON.stringify({
          calendars: {
            a: { email: "nope", alarm: "soon", extra: 1 },
            b: "text",
            c: { email: "me@c.org", alarm: "1d" },
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
  it("default to no reminder", () => {
    const c = unwrap(parseConfig("{}"));
    expect(c.defaultAlarm).toBe("none");
    expect(c.calendars).toEqual({});
  });

  it("read a default reminder and per-calendar reminders, including none", () => {
    const c = unwrap(
      parseConfig(
        '{"defaultAlarm":"15m","calendars":{"work":{"alarm":"1d"},"home":{"alarm":"none"},"school":{"alarm":"90m"}}}',
      ),
    );
    expect(c.defaultAlarm).toBe("15m");
    expect(c.calendars).toEqual({
      work: { alarm: "1d" },
      home: { alarm: "none" },
      school: { alarm: "90m" },
    });
  });

  it("are written even when they are the defaults, so users see where to set them", () => {
    expect(JSON.parse(serializeConfig(defaultConfig))).toEqual({
      khal: "khal",
      defaultAlarm: "none",
      calendars: {},
    });
  });

  it.each(["15", "1w", "-5m", "", "5 m", "10000m", "None", 15, null, true, ["15m"], { m: 15 }])(
    "reject an invalid defaultAlarm: %j",
    (value) => {
      const e = failure(parseConfig(JSON.stringify({ defaultAlarm: value })));
      expect(e._tag).toBe("InvalidInput");
      expect(e.message).toMatch(/^defaultAlarm must be a reminder like 30m, 2h or 1d/);
      expect(e.message).toContain(JSON.stringify(value));
    },
  );

  it("are not mistaken for the flat v1.0.0 mapping", () => {
    expect(unwrap(parseConfig('{"defaultAlarm":"15m"}')).defaultAlarm).toBe("15m");
  });
});

describe("trimming", () => {
  it("trims every string of the config before checking it", () => {
    const c = unwrap(
      parseConfig(
        JSON.stringify({
          khal: "  /usr/bin/khal\n",
          defaultAlarm: " 15m ",
          calendars: {
            " work ": { email: "  me@work.com ", alarm: "\t1d" },
            "\thome": { email: "me@home.org\n", alarm: " none " },
          },
        }),
      ),
    );
    expect(c).toEqual({
      khal: "/usr/bin/khal",
      defaultAlarm: "15m",
      calendars: {
        work: { email: "me@work.com", alarm: "1d" },
        home: { email: "me@home.org", alarm: "none" },
      },
    });
  });

  it("does not trim inside a value: '5 m' stays invalid", () => {
    expect(failure(parseConfig('{"defaultAlarm":" 5 m "}')).message).toMatch(/defaultAlarm must be/);
  });

  it("rejects names that are only whitespace", () => {
    expect(failure(parseConfig('{"calendars":{"  ":{"email":"me@work.com"}}}')).message).toMatch(
      /calendars has an empty calendar name/,
    );
  });

  it("rejects two names that only differ in whitespace", () => {
    expect(failure(parseConfig('{"calendars":{"work":{},"  work ":{}}}')).message).toMatch(
      /calendars lists calendar 'work' more than once \(names are compared after trimming\)/,
    );
  });

  it("trims the organizer and the calendar when resolving an address", () => {
    expect(unwrap(resolveAddress({ work: { email: "me@work.com" } }, "  work ", undefined))).toBe(
      "me@work.com",
    );
    expect(unwrap(resolveAddress({}, "work", "  a@b.com \n"))).toBe("a@b.com");
  });

  it("trims an explicit alarm and the calendar when resolving a reminder", () => {
    const settings = { defaultAlarm: "15m", calendars: { work: { alarm: "1d" } } };
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
          defaultAlarm: "soon",
          calendars: {
            work: { email: "nope", alarm: "1w" },
            home: { email: "me@home.org", alarm: "1d" },
          },
          typo: 1,
          another: 2,
        }),
      ),
    );
    expect(e._tag).toBe("InvalidInput");
    expect(e.message).toMatch(/^6 problems:\n/);
    for (const part of [
      "unknown config key 'typo'",
      "unknown config key 'another'",
      "config 'khal' must be a bare command name",
      "defaultAlarm must be a reminder like 30m",
      "calendars.work.email is not a valid email address",
      "calendars.work.alarm must be a reminder like 30m",
    ])
      expect(e.message).toContain(part);
    // the valid calendar is not reported
    expect(e.message).not.toContain("calendars.home");
  });

  it("reports several problems inside one calendars object", () => {
    const e = failure(
      parseConfig('{"calendars":{"a":{"alarm":"x"},"b":{"alarm":"y"},"c":{"alarm":"1d"},"":{"alarm":"2d"}}}'),
    );
    expect(e.message).toMatch(/^3 problems:/);
  });

  it("reports one problem as a plain message, without a list", () => {
    expect(failure(parseConfig('{"defaultAlarm":"soon"}')).message).toMatch(/^defaultAlarm must be/);
  });

  it("keeps the dependency between steps: not JSON means only that one problem", () => {
    expect(failure(parseConfig("{ nope")).message).toMatch(/^config is not valid JSON/);
  });

  it("also covers the flat v1.0.0 format", () => {
    expect(unwrap(parseConfig('{" work ":" me@work.com "}')).calendars).toEqual({
      work: { email: "me@work.com" },
    });
  });
});

describe("resolveAlarm", () => {
  const settings = {
    defaultAlarm: "15m",
    calendars: {
      work: { email: "me@work.com", alarm: "1d" },
      home: { alarm: "none" },
      declared: {},
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

  it("uses the calendar's reminder, then the default", () => {
    expect(resolveAlarm(settings, "work", undefined)).toBe("1d");
    expect(resolveAlarm(settings, "other", undefined)).toBe("15m");
    expect(resolveAlarm(settings, undefined, undefined)).toBe("15m");
  });

  it("falls back to the default for a calendar that is configured but has no reminder", () => {
    expect(resolveAlarm(settings, "declared", undefined)).toBe("15m");
    expect(
      resolveAlarm({ ...settings, calendars: { work: { email: "me@work.com" } } }, "work", undefined),
    ).toBe("15m");
  });

  it("lets a calendar opt out of a configured default with 'none'", () => {
    expect(resolveAlarm(settings, "home", undefined)).toBeUndefined();
  });

  it("gives no reminder when nothing is configured", () => {
    expect(resolveAlarm({ defaultAlarm: "none", calendars: {} }, "work", undefined)).toBeUndefined();
  });

  it("ignores inherited object properties as calendar names", () => {
    expect(resolveAlarm(settings, "constructor", undefined)).toBe("15m");
    expect(resolveAlarm(settings, "__proto__", undefined)).toBe("15m");
  });
});

describe("resolveKhalBinary", () => {
  const config = { khal: "/from/config/khal", defaultAlarm: "none", calendars: {} };

  it("prefers MCP_KHAL_BIN over the config, which beats the default", () => {
    expect(resolveKhalBinary({ MCP_KHAL_BIN: "/from/env/khal" }, config)).toEqual({
      binary: "/from/env/khal",
      source: "MCP_KHAL_BIN",
    });
    expect(resolveKhalBinary({}, config)).toEqual({ binary: "/from/config/khal", source: "config" });
    expect(resolveKhalBinary({}, defaultConfig)).toEqual({ binary: "khal", source: "config" });
  });

  it("ignores an empty MCP_KHAL_BIN", () => {
    expect(resolveKhalBinary({ MCP_KHAL_BIN: "" }, config).binary).toBe("/from/config/khal");
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

describe("resolveAddress", () => {
  const calendars = { work: { email: "me@work.com" }, home: { alarm: "1d" } };

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
