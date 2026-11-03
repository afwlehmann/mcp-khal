import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Interface } from "node:readline/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, serializeConfig } from "./config.js";
import { InvalidInput } from "./errors.js";
import { configure, promptFor, runSetup, setup } from "./setup.js";
import { type FakeKhal, fakeKhal, removeDir, runFail, runOk, tempDir } from "./testlib.js";

/** A scripted readline: answers come from the queue, prompts and prefills are recorded. */
const scripted = (answers: readonly string[]) => {
  const queue = [...answers];
  const questions: string[] = [];
  const prefills: string[] = [];
  const rl = {
    question: async (q: string) => {
      questions.push(q);
      return queue.shift() ?? "";
    },
    write: (s: string) => {
      prefills.push(s);
    },
  } as unknown as Interface;
  return { rl, questions, prefills };
};

describe("promptFor", () => {
  it("prefills the configured value and keeps it on a blank answer", async () => {
    const s = scripted([""]);
    expect(await runOk(promptFor(s.rl, "work", "me@work.com"))).toBe("me@work.com");
    expect(s.prefills).toEqual(["me@work.com"]);
    expect(s.questions[0]).not.toMatch(/blank to skip/);
  });

  it("lets the user overwrite the prefilled value", async () => {
    const s = scripted(["new@work.com"]);
    expect(await runOk(promptFor(s.rl, "work", "me@work.com"))).toBe("new@work.com");
  });

  it("prefills an email-like calendar name", async () => {
    const s = scripted([""]);
    expect(await runOk(promptFor(s.rl, "me@home.org", undefined))).toBe("me@home.org");
    expect(s.prefills).toEqual(["me@home.org"]);
  });

  it("an existing mapping wins over an email-like calendar name", async () => {
    const s = scripted([""]);
    expect(await runOk(promptFor(s.rl, "me@home.org", "other@home.org"))).toBe("other@home.org");
  });

  it("offers to skip when nothing is known and returns undefined on blank", async () => {
    const s = scripted([""]);
    expect(await runOk(promptFor(s.rl, "work", undefined))).toBeUndefined();
    expect(s.prefills).toEqual([]);
    expect(s.questions[0]).toMatch(/blank to skip/);
  });

  it("re-prompts until the answer is a valid address", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const s = scripted(["nope", "still nope", "ok@x.com"]);
      expect(await runOk(promptFor(s.rl, "work", undefined))).toBe("ok@x.com");
      expect(s.questions).toHaveLength(3);
      expect(errors).toHaveBeenCalledTimes(2);
    } finally {
      errors.mockRestore();
    }
  });
});

describe("setup", () => {
  let fake: FakeKhal;
  let dir: string;

  beforeEach(async () => {
    fake = await fakeKhal({ stdout: "work\nme@home.org\n" });
    dir = await tempDir();
  });
  afterEach(async () => {
    await fake.cleanup();
    await removeDir(dir);
  });

  const io = (s: ReturnType<typeof scripted>, isTTY = true) => {
    const lines: string[] = [];
    let closed = 0;
    const rl = Object.assign(s.rl, { close: () => closed++ });
    return {
      lines,
      closed: () => closed,
      io: { isTTY, openPrompt: () => rl, log: (l: string) => lines.push(l) },
    };
  };

  it("configures every khal calendar, using saved values as defaults, and saves the result", async () => {
    const path = join(dir, "cfg.json");
    await writeFile(
      path,
      serializeConfig({ khal: "/opt/khal/bin/khal", calendarEmails: { work: "old@work.com" } }),
    );
    const s = scripted(["", ""]);
    const t = io(s);
    await runOk(setup(fake.settings({ configPath: path }), t.io));
    // the configured khal location survives a rerun of setup
    expect(await runOk(loadConfig(path))).toEqual({
      khal: "/opt/khal/bin/khal",
      calendarEmails: { work: "old@work.com", "me@home.org": "me@home.org" },
    });
    expect(s.prefills).toEqual(["old@work.com", "me@home.org"]);
    expect(t.closed()).toBe(1);
    expect(t.lines.join("\n")).toMatch(/Configuring 2 calendar\(s\)/);
    expect(t.lines.join("\n")).toMatch(/Saved 2 mapping\(s\)/);
  });

  it("never writes an MCP_KHAL_BIN override back into the config file", async () => {
    const path = join(dir, "cfg.json");
    await writeFile(path, serializeConfig({ khal: "khal", calendarEmails: {} }));
    const settings = fake.settings({ configPath: path, khalSource: "MCP_KHAL_BIN" });
    await runOk(setup(settings, io(scripted(["", ""])).io));
    expect((await runOk(loadConfig(path))).khal).toBe("khal");
  });

  it("refuses to run without a terminal", async () => {
    const e = await runFail(setup(fake.settings(), io(scripted([]), false).io));
    expect(e).toBeInstanceOf(InvalidInput);
    expect(await fake.calls()).toEqual([]);
  });

  it("fails when khal reports no calendars", async () => {
    await writeFile(join(fake.dir, "out"), "");
    const e = await runFail(setup(fake.settings(), io(scripted([])).io));
    expect(e).toBeInstanceOf(InvalidInput);
    expect(e.message).toMatch(/no calendars/);
  });

  it("does not write the config when the config file is unreadable", async () => {
    const path = join(dir, "cfg.json");
    await writeFile(path, "{ not json");
    const e = await runFail(setup(fake.settings({ configPath: path }), io(scripted([])).io));
    expect(e).toBeInstanceOf(InvalidInput);
  });
});

describe("runSetup", () => {
  let fake: FakeKhal;
  let dir: string;

  beforeEach(async () => {
    fake = await fakeKhal({ stdout: "work\n" });
    dir = await tempDir();
  });
  afterEach(async () => {
    await fake.cleanup();
    await removeDir(dir);
  });

  const input = (config: string) => ({
    env: { MCP_KHAL_CONFIG: config, MCP_KHAL_BIN: join(fake.dir, "khal"), PATH: process.env.PATH },
    home: dir,
    tmpDir: dir,
  });

  it("returns 0 after saving the mapping at the path named by the environment it is given", async () => {
    const s = scripted(["me@work.com"]);
    const lines: string[] = [];
    const rl = Object.assign(s.rl, { close: () => {} });
    const code = await runSetup(
      input(join(dir, "cfg.json")),
      { isTTY: true, openPrompt: () => rl, log: (l) => lines.push(l) },
      () => {},
    );
    expect(code).toBe(0);
    expect(await runOk(loadConfig(join(dir, "cfg.json")))).toEqual({
      khal: "khal",
      calendarEmails: { work: "me@work.com" },
    });
    expect(lines).toHaveLength(2);
  });

  it("returns 1 and reports the error when not on a terminal", async () => {
    const errors: string[] = [];
    const code = await runSetup(
      input(join(dir, "cfg.json")),
      { isTTY: false, openPrompt: () => scripted([]).rl, log: () => {} },
      (l) => errors.push(l),
    );
    expect(code).toBe(1);
    expect(errors[0]).toMatch(/^InvalidInput: setup needs an interactive/);
  });

  it("returns 1 when the config cannot be loaded", async () => {
    const path = join(dir, "corrupt.json");
    await writeFile(path, "{ not json");
    const errors: string[] = [];
    const code = await runSetup(
      input(path),
      { isTTY: true, openPrompt: () => scripted([]).rl, log: () => {} },
      (l) => errors.push(l),
    );
    expect(code).toBe(1);
    expect(errors[0]).toMatch(/^InvalidInput:/);
  });
});

describe("configure", () => {
  it("prefills from the existing mapping, updates answers and skips blanks", async () => {
    const s = scripted(["", "b@y.com", ""]);
    const result = await runOk(configure(s.rl, ["a", "b", "c"], { a: "a@y.com" }));
    expect(result).toEqual({ a: "a@y.com", b: "b@y.com" });
    expect(s.questions).toHaveLength(3);
    expect(s.prefills).toEqual(["a@y.com"]);
  });

  it("keeps mappings for calendars that no longer exist", async () => {
    const s = scripted([""]);
    const result = await runOk(configure(s.rl, ["a"], { a: "a@y.com", gone: "g@y.com" }));
    expect(result).toEqual({ a: "a@y.com", gone: "g@y.com" });
  });
});
