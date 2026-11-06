import { describe, expect, it } from "vitest";
import {
  checkBinary,
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
      calendarEmails: { work: "me@example.com" },
      defaultAlarm: "none",
      calendarAlarms: {},
    };
    expect(unwrap(parseConfig(serializeConfig(c)))).toEqual(c);
  });

  it("defaults khal to 'khal' and calendarEmails to empty", () => {
    expect(unwrap(parseConfig("{}"))).toEqual({
      khal: "khal",
      calendarEmails: {},
      defaultAlarm: "none",
      calendarAlarms: {},
    });
    expect(unwrap(parseConfig('{"calendarEmails":{"work":"me@example.com"}}'))).toEqual({
      khal: "khal",
      calendarEmails: { work: "me@example.com" },
      defaultAlarm: "none",
      calendarAlarms: {},
    });
    expect(unwrap(parseConfig('{"khal":"/usr/local/bin/khal"}'))).toEqual({
      khal: "/usr/local/bin/khal",
      calendarEmails: {},
      defaultAlarm: "none",
      calendarAlarms: {},
    });
  });

  it("trims the khal path", () => {
    expect(unwrap(parseConfig('{"khal":"  khal  "}')).khal).toBe("khal");
  });

  it("still reads the flat calendar -> email format of v1.0.0", () => {
    expect(unwrap(parseConfig('{"work":"me@example.com","home":"me@home.org"}'))).toEqual({
      khal: "khal",
      calendarEmails: { work: "me@example.com", home: "me@home.org" },
      defaultAlarm: "none",
      calendarAlarms: {},
    });
  });

  it("rejects invalid JSON and non-objects", () => {
    expect(failure(parseConfig("{"))._tag).toBe("InvalidInput");
    expect(failure(parseConfig("[]"))._tag).toBe("InvalidInput");
    expect(failure(parseConfig('"khal"'))._tag).toBe("InvalidInput");
  });

  it("rejects bad addresses, bad khal values and unknown keys", () => {
    expect(failure(parseConfig('{"work":"nope"}')).message).toMatch(/unknown config key 'work'/);
    expect(failure(parseConfig('{"calendarEmails":{"work":"nope"}}')).message).toMatch(/'work'/);
    expect(failure(parseConfig('{"calendarEmails":[]}')).message).toMatch(/calendarEmails/);
    expect(failure(parseConfig('{"khal":""}')).message).toMatch(/non-empty/);
    expect(failure(parseConfig('{"khal":42}')).message).toMatch(/must be a string, got 42/);
    expect(failure(parseConfig('{"khal":"kh\\nal"}')).message).toMatch(/non-empty/);
    expect(failure(parseConfig('{"khal":"khal","typo":1}')).message).toMatch(/unknown config key 'typo'/);
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
    expect(c.calendarAlarms).toEqual({});
  });

  it("read a default reminder and per-calendar reminders, including none", () => {
    const c = unwrap(
      parseConfig('{"defaultAlarm":"15m","calendarAlarms":{"work":"1d","home":"none","school":"90m"}}'),
    );
    expect(c.defaultAlarm).toBe("15m");
    expect(c.calendarAlarms).toEqual({ work: "1d", home: "none", school: "90m" });
  });

  it("roundtrip through serializeConfig", () => {
    const c = {
      khal: "khal",
      calendarEmails: {},
      defaultAlarm: "30m",
      calendarAlarms: { work: "2d", home: "none" },
    };
    expect(unwrap(parseConfig(serializeConfig(c)))).toEqual(c);
  });

  it("are written even when they are the defaults, so users see where to set them", () => {
    expect(JSON.parse(serializeConfig(defaultConfig))).toMatchObject({
      defaultAlarm: "none",
      calendarAlarms: {},
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

  it.each(["15", "1w", "-5m", "", "5 m", "10000m", "None", 15, null, ["15m"]])(
    "reject an invalid per-calendar reminder: %j",
    (value) => {
      const e = failure(parseConfig(JSON.stringify({ calendarAlarms: { work: "1d", broken: value } })));
      expect(e._tag).toBe("InvalidInput");
      expect(e.message).toMatch(/^calendarAlarms entry 'broken' must be a reminder like 30m/);
    },
  );

  it.each([[[]], ["15m"], [15], [null]])("reject a calendarAlarms that is not an object: %j", (value) => {
    expect(failure(parseConfig(JSON.stringify({ calendarAlarms: value }))).message).toMatch(
      /calendarAlarms must be a JSON object/,
    );
  });

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
          calendarEmails: { " work ": "  me@work.com ", "\thome": "me@home.org\n" },
          defaultAlarm: " 15m ",
          calendarAlarms: { " work": "\t1d", "home ": " none " },
        }),
      ),
    );
    expect(c).toEqual({
      khal: "/usr/bin/khal",
      calendarEmails: { work: "me@work.com", home: "me@home.org" },
      defaultAlarm: "15m",
      calendarAlarms: { work: "1d", home: "none" },
    });
  });

  it("does not trim inside a value: '5 m' stays invalid", () => {
    expect(failure(parseConfig('{"defaultAlarm":" 5 m "}')).message).toMatch(/defaultAlarm must be/);
  });

  it("rejects names that are only whitespace", () => {
    expect(failure(parseConfig('{"calendarEmails":{"  ":"me@work.com"}}')).message).toMatch(
      /calendarEmails has an empty calendar name/,
    );
  });

  it("rejects two names that only differ in whitespace", () => {
    expect(failure(parseConfig('{"calendarAlarms":{"work":"1d"," work ":"2d"}}')).message).toMatch(
      /calendarAlarms lists calendar 'work' more than once \(names are compared after trimming\)/,
    );
  });

  it("trims the organizer and the calendar when resolving an address", () => {
    expect(unwrap(resolveAddress({ work: "me@work.com" }, "  work ", undefined))).toBe("me@work.com");
    expect(unwrap(resolveAddress({}, "work", "  a@b.com \n"))).toBe("a@b.com");
  });

  it("trims an explicit alarm and the calendar when resolving a reminder", () => {
    const settings = { defaultAlarm: "15m", calendarAlarms: { work: "1d" } };
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
          calendarEmails: { work: "nope", home: "also nope" },
          defaultAlarm: "soon",
          calendarAlarms: { work: "1w", home: "1d" },
          typo: 1,
          another: 2,
        }),
      ),
    );
    expect(e._tag).toBe("InvalidInput");
    expect(e.message).toMatch(/^7 problems:\n/);
    for (const part of [
      "unknown config key 'typo'",
      "unknown config key 'another'",
      "config 'khal' must be a bare command name",
      "calendarEmails entry 'work' is not a valid email address",
      "calendarEmails entry 'home' is not a valid email address",
      "defaultAlarm must be a reminder like 30m",
      "calendarAlarms entry 'work' must be a reminder like 30m",
    ])
      expect(e.message).toContain(part);
    // the valid entry is not reported
    expect(e.message).not.toContain("calendarAlarms entry 'home'");
  });

  it("reports several problems inside one map", () => {
    const e = failure(parseConfig('{"calendarAlarms":{"a":"x","b":"y","c":"1d","":"2d"}}'));
    expect(e.message).toMatch(/^3 problems:/);
  });

  it("reports one problem as a plain message, without a list", () => {
    expect(failure(parseConfig('{"defaultAlarm":"soon"}')).message).toMatch(/^defaultAlarm must be/);
  });

  it("keeps the dependency between steps: not JSON means only that one problem", () => {
    expect(failure(parseConfig("{ nope")).message).toMatch(/^config is not valid JSON/);
  });

  it("also covers the flat v1.0.0 format", () => {
    expect(unwrap(parseConfig('{" work ":" me@work.com "}')).calendarEmails).toEqual({ work: "me@work.com" });
  });
});

describe("resolveAlarm", () => {
  const settings = { defaultAlarm: "15m", calendarAlarms: { work: "1d", home: "none" } };

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

  it("lets a calendar opt out of a configured default with 'none'", () => {
    expect(resolveAlarm(settings, "home", undefined)).toBeUndefined();
  });

  it("gives no reminder when nothing is configured", () => {
    expect(resolveAlarm({ defaultAlarm: "none", calendarAlarms: {} }, "work", undefined)).toBeUndefined();
  });

  it("ignores inherited object properties as calendar names", () => {
    expect(resolveAlarm(settings, "constructor", undefined)).toBe("15m");
    expect(resolveAlarm(settings, "__proto__", undefined)).toBe("15m");
  });
});

describe("resolveKhalBinary", () => {
  const config = { khal: "/from/config/khal", calendarEmails: {}, defaultAlarm: "none", calendarAlarms: {} };

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
  const mapping = { work: "me@work.com" };

  it("prefers explicit over mapping over email-like calendar name", () => {
    expect(unwrap(resolveAddress(mapping, "work", "x@y.com"))).toBe("x@y.com");
    expect(unwrap(resolveAddress(mapping, "work"))).toBe("me@work.com");
    expect(unwrap(resolveAddress({}, "me@home.com"))).toBe("me@home.com");
  });

  it("fails without any known address", () => {
    expect(failure(resolveAddress({}, "work"))._tag).toBe("InvalidInput");
    expect(failure(resolveAddress({}, undefined))._tag).toBe("InvalidInput");
  });

  it("rejects an invalid explicit address", () => {
    expect(failure(resolveAddress(mapping, "work", "nope"))._tag).toBe("InvalidInput");
  });

  it("ignores inherited object properties", () => {
    expect(failure(resolveAddress({}, "constructor"))._tag).toBe("InvalidInput");
  });
});
