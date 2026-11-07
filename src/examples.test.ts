import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CONFIG_KEYS, parseConfig } from "./config.js";
import { unwrap } from "./testlib.js";

const example = async (name: string): Promise<string> =>
  readFile(fileURLToPath(new URL(`../examples/${name}`, import.meta.url)), "utf8");

describe("examples/mcp-khal.json", () => {
  it("is a valid config, so the documentation can never drift from the parser", async () => {
    const config = unwrap(parseConfig(await example("mcp-khal.json")));
    expect(config).toEqual({
      khal: "khal",
      defaultCalendar: "work",
      calendars: {
        work: { email: "me@example.com", alarm: "1d" },
        private: { email: "me@example.org", alarm: "none" },
        school: { alarm: "90m" },
      },
    });
  });

  it("uses every key the config knows", async () => {
    const keys = Object.keys(JSON.parse(await example("mcp-khal.json")) as object).sort();
    expect(keys).toEqual([...CONFIG_KEYS].sort());
  });
});
