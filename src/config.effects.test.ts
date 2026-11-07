import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultConfig, loadConfig, saveConfig, serializeConfig } from "./config.js";
import { InvalidInput, IoError } from "./errors.js";
import { removeDir, runFail, runOk, tempDir } from "./testlib.js";

describe("config files", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await tempDir();
  });
  afterAll(() => removeDir(dir));

  it("treats a missing file as the default configuration", async () => {
    expect(await runOk(loadConfig(join(dir, "missing.json")))).toEqual(defaultConfig);
  });

  it("saves (creating parent directories) and loads a config", async () => {
    const path = join(dir, "nested", "deeper", "cfg.json");
    const c = {
      khal: "/opt/khal/bin/khal",
      calendars: { work: { email: "me@work.com" }, home: { email: "me@home.org" } },
    };
    await runOk(saveConfig(path, c));
    expect(await readFile(path, "utf8")).toBe(serializeConfig(c));
    expect(await runOk(loadConfig(path))).toEqual(c);
  });

  it("loads a flat v1.0.0 mapping", async () => {
    const path = join(dir, "legacy.json");
    await writeFile(path, '{"work":"me@work.com"}');
    expect(await runOk(loadConfig(path))).toEqual({
      khal: "khal",
      calendars: { work: { email: "me@work.com" } },
    });
  });

  it("reports invalid content as InvalidInput", async () => {
    const path = join(dir, "bad.json");
    await writeFile(path, '{"work": "nope"}');
    expect(await runFail(loadConfig(path))).toBeInstanceOf(InvalidInput);
  });

  it("reports other read errors as IoError", async () => {
    const asDirectory = join(dir, "a-directory");
    await mkdir(asDirectory);
    expect(await runFail(loadConfig(asDirectory))).toBeInstanceOf(IoError);
  });

  it("reports write errors as IoError", async () => {
    const file = join(dir, "plain-file");
    await writeFile(file, "x");
    expect(await runFail(saveConfig(join(file, "cfg.json"), defaultConfig))).toBeInstanceOf(IoError);
  });
});
