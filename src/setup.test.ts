import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Interface } from "node:readline/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { interpretPath, loadConfig, serializeConfig } from "./config.js";
import { InvalidInput } from "./errors.js";
import {
  configure,
  interpretName,
  promptCalendar,
  promptDefaultCalendar,
  promptFor,
  promptPath,
  runSetup,
  setup,
} from "./setup.js";
import { failure, removeDir, runFail, runOk, tempDir, testSettings, unwrap } from "./testlib.js";

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

/** Silences (and records) the messages that explain a rejected answer. */
const quiet = () => vi.spyOn(console, "error").mockImplementation(() => {});

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
    const errors = quiet();
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

describe("promptPath", () => {
  it("prefills the configured folder and keeps it on a blank answer", async () => {
    const s = scripted([""]);
    expect(await runOk(promptPath(s.rl, "work", "/data/work", []))).toBe("/data/work");
    expect(s.prefills).toEqual(["/data/work"]);
    expect(s.questions[0]).toContain("'work'");
  });

  it("is required: a blank answer without a configured folder asks again", async () => {
    const errors = quiet();
    try {
      const s = scripted(["", "  ", "/data/work"]);
      expect(await runOk(promptPath(s.rl, "work", undefined, []))).toBe("/data/work");
      expect(s.questions).toHaveLength(3);
      expect(s.prefills).toEqual([]);
      expect(errors).toHaveBeenCalledTimes(2);
    } finally {
      errors.mockRestore();
    }
  });

  it("re-prompts until the answer is an absolute path that no other calendar uses", async () => {
    const errors = quiet();
    try {
      const s = scripted(["~/cal", "relative/dir", "/data/home/", " /data/work "]);
      expect(await runOk(promptPath(s.rl, "work", undefined, ["/data/home"]))).toBe("/data/work");
      expect(s.questions).toHaveLength(4);
      expect(errors).toHaveBeenCalledTimes(3);
    } finally {
      errors.mockRestore();
    }
  });
});

describe("interpretPath", () => {
  it("keeps the fallback on blank and rejects unusable paths", () => {
    expect(unwrap(interpretPath("  ", "/a", []))).toBe("/a");
    expect(unwrap(interpretPath("", undefined, []))).toBeUndefined();
    expect(failure(interpretPath("a\u0007b", undefined, []))).toMatch(/not an absolute path/);
    expect(failure(interpretPath("relative", undefined, []))).toMatch(/not an absolute path/);
    expect(failure(interpretPath("/x", undefined, ["/x/../x"]))).toMatch(/already the path of another/);
  });
});

describe("interpretName", () => {
  it("blank finishes, a new name is trimmed", () => {
    expect(unwrap(interpretName("   ", ["a"]))).toBeUndefined();
    expect(unwrap(interpretName(" work ", ["a"]))).toBe("work");
  });

  it("rejects a name that is already configured", () => {
    expect(failure(interpretName("a", ["a"]))).toMatch(/'a' is already configured/);
    expect(failure(interpretName(" a ", ["a"]))).toMatch(/already configured/);
  });

  it("rejects control characters", () => {
    expect(failure(interpretName("a\u0007b", []))).toMatch(/control characters/);
  });
});

describe("promptCalendar", () => {
  it("asks the folder, then the address, and keeps the reminder", async () => {
    const s = scripted(["/data/new", "new@y.com"]);
    const result = await runOk(
      promptCalendar(s.rl, "a", { path: "/data/old", email: "old@y.com", alarm: "30m" }, []),
    );
    expect(result).toEqual({ path: "/data/new", email: "new@y.com", alarm: "30m" });
    expect(s.prefills).toEqual(["/data/old", "old@y.com"]);
    expect(s.questions[0]).toMatch(/Folder/);
    expect(s.questions[1]).toMatch(/email/);
  });

  it("leaves out the address when it is skipped", async () => {
    const s = scripted(["/data/a", ""]);
    expect(await runOk(promptCalendar(s.rl, "a", undefined, []))).toEqual({ path: "/data/a" });
  });
});

describe("promptDefaultCalendar", () => {
  const names = ["home", "work"];

  it("prefills the configured default calendar and keeps it on a blank answer", async () => {
    const s = scripted([""]);
    expect(await runOk(promptDefaultCalendar(s.rl, names, "home"))).toBe("home");
    expect(s.prefills).toEqual(["home"]);
  });

  it("lists the calendars to choose from and trims the answer", async () => {
    const s = scripted(["  work "]);
    expect(await runOk(promptDefaultCalendar(s.rl, names, undefined))).toBe("work");
    expect(s.questions[0]).toContain("home, work");
    expect(s.prefills).toEqual([]);
  });

  it("does not prefill a configured calendar that is not among the calendars", async () => {
    const s = scripted(["home"]);
    expect(await runOk(promptDefaultCalendar(s.rl, names, "gone"))).toBe("home");
    expect(s.prefills).toEqual([]);
  });

  it("is required: a blank answer without a prefilled value asks again", async () => {
    const spy = quiet();
    try {
      const s = scripted(["", "nope", "home"]);
      expect(await runOk(promptDefaultCalendar(s.rl, names, undefined))).toBe("home");
      expect(s.questions).toHaveLength(3);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("configure", () => {
  it("asks folder and address of each existing calendar, sorted by name, with saved values prefilled", async () => {
    // a: folder, address; b: folder, address; then no more calendars
    const s = scripted(["/data/a2", "a@y.com", "", "", ""]);
    const result = await runOk(
      configure(s.rl, { b: { path: "/data/b", email: "b@y.com", alarm: "1d" }, a: { path: "/data/a" } }),
    );
    expect(result).toEqual({
      a: { path: "/data/a2", email: "a@y.com" },
      b: { path: "/data/b", email: "b@y.com", alarm: "1d" },
    });
    expect(s.prefills).toEqual(["/data/a", "/data/b", "b@y.com"]);
    expect(s.questions).toHaveLength(5);
    expect(s.questions[4]).toMatch(/another calendar/);
  });

  it("adds new calendars (name, folder, address) until the name is blank", async () => {
    const s = scripted(["work", "/data/work", "me@work.com", "home", "/data/home", "", ""]);
    const result = await runOk(configure(s.rl, {}));
    expect(result).toEqual({
      work: { path: "/data/work", email: "me@work.com" },
      home: { path: "/data/home" },
    });
    expect(s.questions[0]).toMatch(/first calendar/);
    expect(s.questions[3]).toMatch(/another calendar/);
  });

  it("needs at least one calendar: a blank first name asks again", async () => {
    const errors = quiet();
    try {
      const s = scripted(["", "  ", "work", "/data/work", "", ""]);
      const result = await runOk(configure(s.rl, {}));
      expect(result).toEqual({ work: { path: "/data/work" } });
      expect(errors).toHaveBeenCalledTimes(2);
      expect(s.questions.filter((q) => /first calendar/.test(q))).toHaveLength(3);
    } finally {
      errors.mockRestore();
    }
  });

  it("rejects a name or folder that is already taken and asks again", async () => {
    const errors = quiet();
    try {
      // "a" is taken; the folder of b may not be /data/a; control characters in a name are refused
      // answers: a's folder and address (kept), then the names and the folder of the new calendar
      const s = scripted(["", "", "a", "b\u0007", "b", "/data/a", "/data/b", "", ""]);
      const result = await runOk(configure(s.rl, { a: { path: "/data/a" } }));
      expect(result).toEqual({ a: { path: "/data/a" }, b: { path: "/data/b" } });
      expect(errors).toHaveBeenCalledTimes(3);
    } finally {
      errors.mockRestore();
    }
  });

  it("an existing calendar cannot take the folder of another existing one", async () => {
    const errors = quiet();
    try {
      // a (sorted first) tries b's folder, then keeps its own; then its address, b's two answers, no more
      const s = scripted(["/data/b", "/data/a", "", "", "", ""]);
      const result = await runOk(configure(s.rl, { a: { path: "/data/a" }, b: { path: "/data/b" } }));
      expect(result).toEqual({ a: { path: "/data/a" }, b: { path: "/data/b" } });
      expect(errors).toHaveBeenCalledTimes(1);
    } finally {
      errors.mockRestore();
    }
  });
});

describe("setup", () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await tempDir();
    path = join(dir, "cfg.json");
  });
  afterEach(() => removeDir(dir));

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

  it("builds a first configuration with a single calendar and asks for no default calendar", async () => {
    const s = scripted(["work", join(dir, "work"), "me@work.com", ""]);
    const t = io(s);
    await runOk(setup(testSettings({ configPath: path }), t.io));
    expect(await runOk(loadConfig(path))).toEqual({
      calendars: { work: { path: join(dir, "work"), email: "me@work.com" } },
    });
    expect(s.questions).toHaveLength(4);
    expect(t.closed()).toBe(1);
    expect(t.lines.join("\n")).toMatch(/Saved 1 calendar\(s\)/);
  });

  it("asks for the default calendar when there are several, until it is one of them", async () => {
    const errors = quiet();
    try {
      const s = scripted([
        "work",
        join(dir, "work"),
        "",
        "home",
        join(dir, "home"),
        "",
        "",
        "nope",
        "  ",
        "home",
      ]);
      await runOk(setup(testSettings({ configPath: path }), io(s).io));
      const saved = await runOk(loadConfig(path));
      expect(saved.defaultCalendar).toBe("home");
      expect(Object.keys(saved.calendars).sort()).toEqual(["home", "work"]);
      expect(s.questions).toHaveLength(10);
      expect(errors).toHaveBeenCalledTimes(2);
    } finally {
      errors.mockRestore();
    }
  });

  it("uses the saved values as defaults, keeps the reminders and confirms the default calendar", async () => {
    await writeFile(
      path,
      serializeConfig({
        defaultCalendar: "work",
        calendars: {
          work: { path: "/data/work", email: "old@work.com", alarm: "1d" },
          home: { path: "/data/home", alarm: "none" },
        },
      }),
    );
    // home: folder, address; work: folder, address; no more calendars; default calendar
    const s = scripted(["", "", "", "", "", ""]);
    await runOk(setup(testSettings({ configPath: path }), io(s).io));
    expect(await runOk(loadConfig(path))).toEqual({
      defaultCalendar: "work",
      calendars: {
        work: { path: "/data/work", email: "old@work.com", alarm: "1d" },
        home: { path: "/data/home", alarm: "none" },
      },
    });
    expect(s.prefills).toEqual(["/data/home", "/data/work", "old@work.com", "work"]);
  });

  it("refuses a file with a key of an earlier version and leaves it untouched", async () => {
    const before = JSON.stringify({
      khal: "/opt/khal/bin/khal",
      calendars: { work: { path: "/data/work" } },
    });
    await writeFile(path, before);
    const e = await runFail(setup(testSettings({ configPath: path }), io(scripted([])).io));
    expect(e.message).toContain("unknown config key 'khal'");
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("can add a calendar to an existing configuration", async () => {
    await writeFile(path, serializeConfig({ calendars: { work: { path: "/data/work" } } }));
    const s = scripted(["", "", "home", "/data/home", "", "", "work"]);
    await runOk(setup(testSettings({ configPath: path }), io(s).io));
    expect(await runOk(loadConfig(path))).toEqual({
      defaultCalendar: "work",
      calendars: { work: { path: "/data/work" }, home: { path: "/data/home" } },
    });
  });

  it("refuses to run without a terminal and writes nothing", async () => {
    const e = await runFail(setup(testSettings({ configPath: path }), io(scripted([]), false).io));
    expect(e).toBeInstanceOf(InvalidInput);
    expect(e.message).toMatch(/interactive terminal/);
    expect(await readFile(path, "utf8").catch(() => undefined)).toBeUndefined();
  });

  it("does not write the config when the config file is unreadable", async () => {
    await writeFile(path, "{ not json");
    const e = await runFail(setup(testSettings({ configPath: path }), io(scripted([])).io));
    expect(e).toBeInstanceOf(InvalidInput);
    expect(await readFile(path, "utf8")).toBe("{ not json");
  });
});

describe("runSetup", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await tempDir();
  });
  afterEach(() => removeDir(dir));

  const input = (config: string) => ({
    env: { MCP_KHAL_CONFIG: config, PATH: process.env.PATH },
    home: dir,
    timezone: "Europe/Berlin",
  });

  it("returns 0 after saving the calendars at the path named by the environment it is given", async () => {
    const s = scripted(["work", join(dir, "work"), "me@work.com", ""]);
    const lines: string[] = [];
    const rl = Object.assign(s.rl, { close: () => {} });
    const code = await runSetup(
      input(join(dir, "cfg.json")),
      { isTTY: true, openPrompt: () => rl, log: (l) => lines.push(l) },
      () => {},
    );
    expect(code).toBe(0);
    expect(await runOk(loadConfig(join(dir, "cfg.json")))).toEqual({
      calendars: { work: { path: join(dir, "work"), email: "me@work.com" } },
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
