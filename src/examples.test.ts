import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseConfig, serializeConfig } from "./config.js";
import { unwrap } from "./testlib.js";

const example = async (name: string): Promise<string> =>
  readFile(fileURLToPath(new URL(`../examples/${name}`, import.meta.url)), "utf8");

describe("examples/mcp-khal.json", () => {
  it("is a valid config, so the documentation can never drift from the parser", async () => {
    const config = unwrap(parseConfig(await example("mcp-khal.json")));
    expect(config).toEqual({
      khal: "khal",
      calendarEmails: { work: "me@example.com", private: "me@example.org" },
      defaultAlarm: "15m",
      calendarAlarms: { work: "1d", private: "none", school: "90m" },
    });
  });

  it("uses every key the config knows", async () => {
    const keys = Object.keys(JSON.parse(await example("mcp-khal.json")) as object).sort();
    expect(keys).toEqual(Object.keys(JSON.parse(serializeConfig(unwrap(parseConfig("{}"))))).sort());
  });
});
