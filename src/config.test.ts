import { describe, expect, it } from "vitest";
import {
  configPath,
  defaultConfig,
  interpretAnswer,
  isEmail,
  parseCalendarNames,
  parseConfig,
  resolveAddress,
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

describe("configPath", () => {
  it("prefers MCP_KHAL_CONFIG, then XDG_CONFIG_HOME, then ~/.config", () => {
    expect(configPath({ MCP_KHAL_CONFIG: "/x.json", XDG_CONFIG_HOME: "/xdg" }, "/home/u")).toBe("/x.json");
    expect(configPath({ XDG_CONFIG_HOME: "/xdg" }, "/home/u")).toBe("/xdg/mcp-khal.json");
    expect(configPath({}, "/home/u")).toBe("/home/u/.config/mcp-khal.json");
  });
});

describe("parseCalendarNames", () => {
  it("returns trimmed non-empty lines", () => {
    expect(parseCalendarNames("work\n  home \n\n")).toEqual(["work", "home"]);
  });
});

describe("parseConfig / serializeConfig", () => {
  it("roundtrips a config", () => {
    const c = { khal: "/nix/store/x-khal/bin/khal", calendarEmails: { work: "me@example.com" } };
    expect(unwrap(parseConfig(serializeConfig(c)))).toEqual(c);
  });

  it("defaults khal to 'khal' and calendarEmails to empty", () => {
    expect(unwrap(parseConfig("{}"))).toEqual({ khal: "khal", calendarEmails: {} });
    expect(unwrap(parseConfig('{"calendarEmails":{"work":"me@example.com"}}'))).toEqual({
      khal: "khal",
      calendarEmails: { work: "me@example.com" },
    });
    expect(unwrap(parseConfig('{"khal":"/usr/local/bin/khal"}'))).toEqual({
      khal: "/usr/local/bin/khal",
      calendarEmails: {},
    });
  });

  it("trims the khal path", () => {
    expect(unwrap(parseConfig('{"khal":"  khal  "}')).khal).toBe("khal");
  });

  it("still reads the flat calendar -> email format of v1.0.0", () => {
    expect(unwrap(parseConfig('{"work":"me@example.com","home":"me@home.org"}'))).toEqual({
      khal: "khal",
      calendarEmails: { work: "me@example.com", home: "me@home.org" },
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
    expect(failure(parseConfig('{"khal":42}')).message).toMatch(/non-empty/);
    expect(failure(parseConfig('{"khal":"kh\\nal"}')).message).toMatch(/non-empty/);
    expect(failure(parseConfig('{"khal":"khal","typo":1}')).message).toMatch(/unknown config key 'typo'/);
  });
});

describe("resolveKhalBinary", () => {
  const config = { khal: "/from/config/khal", calendarEmails: {} };

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
