import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { defaultConfigPath, loadMapping, resolveOrganizer, saveMapping, serializeMapping } from "./config.js";
import { InvalidInput, IoError } from "./errors.js";
import { removeDir, runFail, runOk, tempDir } from "./testlib.js";

describe("config files", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await tempDir();
  });
  afterAll(() => removeDir(dir));

  it("treats a missing file as an empty mapping", async () => {
    expect(await runOk(loadMapping(join(dir, "missing.json")))).toEqual({});
  });

  it("saves (creating parent directories) and loads a mapping", async () => {
    const path = join(dir, "nested", "deeper", "cfg.json");
    const m = { work: "me@work.com", home: "me@home.org" };
    await runOk(saveMapping(path, m));
    expect(await readFile(path, "utf8")).toBe(serializeMapping(m));
    expect(await runOk(loadMapping(path))).toEqual(m);
  });

  it("reports invalid content as InvalidInput", async () => {
    const path = join(dir, "bad.json");
    await writeFile(path, '{"work": "nope"}');
    expect(await runFail(loadMapping(path))).toBeInstanceOf(InvalidInput);
  });

  it("reports other read errors as IoError", async () => {
    const asDirectory = join(dir, "a-directory");
    await mkdir(asDirectory);
    expect(await runFail(loadMapping(asDirectory))).toBeInstanceOf(IoError);
  });

  it("reports write errors as IoError", async () => {
    const file = join(dir, "plain-file");
    await writeFile(file, "x");
    expect(await runFail(saveMapping(join(file, "cfg.json"), {}))).toBeInstanceOf(IoError);
  });
});

describe("environment-driven paths", () => {
  let saved: string | undefined;
  let dir: string;

  beforeEach(async () => {
    saved = process.env.MCP_KHAL_CONFIG;
    dir = await tempDir();
  });
  afterEach(async () => {
    if (saved === undefined) delete process.env.MCP_KHAL_CONFIG;
    else process.env.MCP_KHAL_CONFIG = saved;
    await removeDir(dir);
  });

  it("defaultConfigPath honours MCP_KHAL_CONFIG", () => {
    process.env.MCP_KHAL_CONFIG = "/somewhere/cfg.json";
    expect(defaultConfigPath()).toBe("/somewhere/cfg.json");
  });

  it("resolveOrganizer reads the mapping when nothing is explicit", async () => {
    const path = join(dir, "cfg.json");
    await writeFile(path, serializeMapping({ work: "me@work.com" }));
    process.env.MCP_KHAL_CONFIG = path;
    expect(await runOk(resolveOrganizer("work", undefined))).toBe("me@work.com");
  });

  it("resolveOrganizer never touches the config for an explicit address", async () => {
    const path = join(dir, "corrupt.json");
    await writeFile(path, "{ not json");
    process.env.MCP_KHAL_CONFIG = path;
    expect(await runOk(resolveOrganizer("work", "me@x.com"))).toBe("me@x.com");
    expect(await runFail(resolveOrganizer("work", "nope"))).toBeInstanceOf(InvalidInput);
  });

  it("resolveOrganizer surfaces a corrupt config when it is needed", async () => {
    const path = join(dir, "corrupt.json");
    await writeFile(path, "{ not json");
    process.env.MCP_KHAL_CONFIG = path;
    expect(await runFail(resolveOrganizer("work", undefined))).toBeInstanceOf(InvalidInput);
  });

  it("resolveOrganizer fails for an unknown calendar", async () => {
    process.env.MCP_KHAL_CONFIG = join(dir, "missing.json");
    expect(await runFail(resolveOrganizer("work", undefined))).toBeInstanceOf(InvalidInput);
    expect(await runFail(resolveOrganizer(undefined, undefined))).toBeInstanceOf(InvalidInput);
  });
});
