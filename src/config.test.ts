import { describe, expect, it } from "vitest";
import {
  configPath,
  interpretAnswer,
  isEmail,
  parseCalendarNames,
  parseMapping,
  resolveAddress,
  serializeMapping,
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

describe("parseMapping / serializeMapping", () => {
  it("roundtrips a valid mapping", () => {
    const m = { work: "me@example.com" };
    expect(unwrap(parseMapping(serializeMapping(m)))).toEqual(m);
  });

  it("rejects invalid JSON, non-objects and bad addresses", () => {
    expect(failure(parseMapping("{"))._tag).toBe("InvalidInput");
    expect(failure(parseMapping("[]"))._tag).toBe("InvalidInput");
    expect(failure(parseMapping('{"work":"nope"}'))._tag).toBe("InvalidInput");
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
