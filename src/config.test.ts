import assert from "node:assert/strict";
import { describe, it } from "node:test";
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
    assert.ok(isEmail("me@example.com"));
    assert.ok(!isEmail("work"));
    assert.ok(!isEmail("a b@example.com"));
    assert.ok(!isEmail("me@example"));
    assert.ok(!isEmail("a@b.com, c@d.com"));
  });
});

describe("configPath", () => {
  it("prefers MCP_KHAL_CONFIG, then XDG_CONFIG_HOME, then ~/.config", () => {
    assert.equal(configPath({ MCP_KHAL_CONFIG: "/x.json", XDG_CONFIG_HOME: "/xdg" }, "/home/u"), "/x.json");
    assert.equal(configPath({ XDG_CONFIG_HOME: "/xdg" }, "/home/u"), "/xdg/mcp-khal.json");
    assert.equal(configPath({}, "/home/u"), "/home/u/.config/mcp-khal.json");
  });
});

describe("parseCalendarNames", () => {
  it("returns trimmed non-empty lines", () => {
    assert.deepEqual(parseCalendarNames("work\n  home \n\n"), ["work", "home"]);
  });
});

describe("parseMapping / serializeMapping", () => {
  it("roundtrips a valid mapping", () => {
    const m = { work: "me@example.com" };
    assert.deepEqual(unwrap(parseMapping(serializeMapping(m))), m);
  });

  it("rejects invalid JSON, non-objects and bad addresses", () => {
    assert.equal(failure(parseMapping("{"))._tag, "InvalidInput");
    assert.equal(failure(parseMapping("[]"))._tag, "InvalidInput");
    assert.equal(failure(parseMapping('{"work":"nope"}'))._tag, "InvalidInput");
  });
});

describe("interpretAnswer", () => {
  it("blank keeps the fallback (or skips)", () => {
    assert.equal(unwrap(interpretAnswer("  ", "me@example.com")), "me@example.com");
    assert.equal(unwrap(interpretAnswer("", undefined)), undefined);
  });

  it("accepts a valid address and rejects an invalid one", () => {
    assert.equal(unwrap(interpretAnswer(" you@example.com ", "me@example.com")), "you@example.com");
    assert.equal(typeof failure(interpretAnswer("nope", undefined)), "string");
  });
});

describe("resolveAddress", () => {
  const mapping = { work: "me@work.com" };

  it("prefers explicit over mapping over email-like calendar name", () => {
    assert.equal(unwrap(resolveAddress(mapping, "work", "x@y.com")), "x@y.com");
    assert.equal(unwrap(resolveAddress(mapping, "work")), "me@work.com");
    assert.equal(unwrap(resolveAddress({}, "me@home.com")), "me@home.com");
  });

  it("fails without any known address", () => {
    assert.equal(failure(resolveAddress({}, "work"))._tag, "InvalidInput");
    assert.equal(failure(resolveAddress({}, undefined))._tag, "InvalidInput");
  });

  it("rejects an invalid explicit address", () => {
    assert.equal(failure(resolveAddress(mapping, "work", "nope"))._tag, "InvalidInput");
  });

  it("ignores inherited object properties", () => {
    assert.equal(failure(resolveAddress({}, "constructor"))._tag, "InvalidInput");
  });
});
