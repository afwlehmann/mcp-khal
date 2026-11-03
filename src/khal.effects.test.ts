import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { InvalidInput, NonZeroExit, NotInstalled, Timeout } from "./errors.js";
import { execute, importIcs, listArgs, runKhal } from "./khal.js";
import { type FakeKhal, fakeKhal, removeDir, runFail, runOk, tempDir, testSettings } from "./testlib.js";

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

describe("runKhal", () => {
  let fake: FakeKhal | undefined;

  const install = async (opts: Parameters<typeof fakeKhal>[0]): Promise<FakeKhal> => {
    fake = await fakeKhal(opts);
    return fake;
  };

  afterEach(async () => {
    await fake?.cleanup();
    fake = undefined;
    vi.unstubAllEnvs();
  });

  it("returns stdout and passes argv through verbatim", async () => {
    const k = await install({ stdout: "hello\n" });
    expect(await runOk(runKhal(k.settings(), ["printcalendars", "a b", "--", "-x"]))).toBe("hello\n");
    expect(await k.calls()).toEqual([["printcalendars", "a b", "--", "-x"]]);
  });

  it("runs the executable named in the settings, not whatever is on PATH", async () => {
    const k = await install({ stdout: "from settings\n" });
    const settings = k.settings();
    // the fake khal is reachable only through settings.khal, never through PATH
    expect(settings.childEnv.PATH ?? "").not.toContain(k.dir);
    expect(await runOk(runKhal(settings, ["list"]))).toBe("from settings\n");
  });

  it("hands khal exactly the environment of the settings, never the process environment", async () => {
    const k = await install({});
    vi.stubEnv("MCP_TEST_MARK", "from-process");
    await runOk(
      runKhal(k.settings({ childEnv: { PATH: process.env.PATH, MCP_TEST_MARK: "from-settings" } }), ["list"]),
    );
    expect(await k.mark()).toBe("from-settings");
    await runOk(runKhal(k.settings(), ["list"]));
    expect(await k.mark()).toBe("unset");
  });

  it("maps a non-zero exit to NonZeroExit carrying stderr and the code", async () => {
    const k = await install({ stderr: "boom\n", exit: 2 });
    const e = await runFail(runKhal(k.settings(), ["list"]));
    expect(e).toBeInstanceOf(NonZeroExit);
    expect(e.message).toBe("boom");
    expect((e as NonZeroExit).code).toBe(2);
  });

  it("falls back to stdout when stderr is empty", async () => {
    const k = await install({ stdout: "usage text\n", exit: 1 });
    const e = await runFail(runKhal(k.settings(), ["list"]));
    expect(e).toBeInstanceOf(NonZeroExit);
    expect(e.message).toBe("usage text");
  });

  it("maps a slow khal to Timeout, using an explicit timeout", async () => {
    const k = await install({ sleep: 5 });
    const e = await runFail(runKhal(k.settings(), ["list"], 150));
    expect(e).toBeInstanceOf(Timeout);
    expect(e.message).toMatch(/150ms/);
  });

  it("takes the default timeout from the settings", async () => {
    const k = await install({ sleep: 5 });
    const e = await runFail(runKhal(k.settings({ timeoutMs: 120 }), ["list"]));
    expect(e).toBeInstanceOf(Timeout);
    expect(e.message).toMatch(/120ms/);
  });

  it("stops waiting when the fiber is interrupted", async () => {
    const k = await install({ sleep: 5 });
    const abort = new AbortController();
    const settled = Effect.runPromise(runKhal(k.settings(), ["list"]), { signal: abort.signal }).then(
      () => "completed",
      () => "interrupted",
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    abort.abort();
    expect(await settled).toBe("interrupted");
  });

  it("execute rejects invalid input without spawning khal", async () => {
    const k = await install({});
    expect(await runFail(execute(k.settings(), listArgs({ calendar: "-x" })))).toBeInstanceOf(InvalidInput);
    expect(await k.calls()).toEqual([]);
  });

  it("execute runs a valid argv", async () => {
    const k = await install({ stdout: "ok" });
    expect(await runOk(execute(k.settings(), listArgs({ range: "tomorrow" })))).toBe("ok");
    expect((await k.calls())[0]?.slice(0, 1)).toEqual(["list"]);
  });
});

describe("runKhal without khal installed", () => {
  it("maps ENOENT to NotInstalled and names the configured binary", async () => {
    const e = await runFail(runKhal(testSettings({ khal: "/does/not/exist/khal" }), ["list"]));
    expect(e).toBeInstanceOf(NotInstalled);
    expect(e.message).toMatch(/khal executable '\/does\/not\/exist\/khal' not found/);
  });
});

describe("importIcs", () => {
  let fake: FakeKhal | undefined;
  let tmp: string;

  beforeAll(async () => {
    tmp = await tempDir();
  });
  afterAll(() => removeDir(tmp));
  afterEach(async () => {
    await fake?.cleanup();
  });

  const install = async (opts: Parameters<typeof fakeKhal>[0]): Promise<FakeKhal> => {
    fake = await fakeKhal(opts);
    return fake;
  };

  it("imports a temp file into the calendar and cleans up afterwards", async () => {
    const k = await install({ stdout: "imported\n" });
    expect(await runOk(importIcs(k.settings({ tmpDir: tmp }), "work", "BEGIN:VCALENDAR\r\n"))).toBe(
      "imported\n",
    );
    const [call] = await k.calls();
    expect(call?.slice(0, 4)).toEqual(["import", "-a", "work", "--batch"]);
    expect(await k.imported()).toBe("BEGIN:VCALENDAR\r\n");
    expect(await exists(dirname(call?.[4] ?? ""))).toBe(false);
  });

  it("creates its temporary directory inside the tmpDir of the settings", async () => {
    const k = await install({});
    await runOk(importIcs(k.settings({ tmpDir: tmp }), "work", "X"));
    const [call] = await k.calls();
    expect(call?.[4]?.startsWith(join(tmp, "mcp-khal-"))).toBe(true);
  });

  it("omits -a without a calendar", async () => {
    const k = await install({});
    await runOk(importIcs(k.settings({ tmpDir: tmp }), undefined, "X"));
    const [call] = await k.calls();
    expect(call?.slice(0, 2)).toEqual(["import", "--batch"]);
  });

  it("rejects an option-like calendar", async () => {
    const k = await install({});
    expect(await runFail(importIcs(k.settings({ tmpDir: tmp }), "-x", "X"))).toBeInstanceOf(InvalidInput);
    expect(await k.calls()).toEqual([]);
  });

  it("cleans up even when khal fails", async () => {
    const k = await install({ stderr: "nope", exit: 1 });
    expect(await runFail(importIcs(k.settings({ tmpDir: tmp }), "work", "X"))).toBeInstanceOf(NonZeroExit);
    const [call] = await k.calls();
    expect(await exists(dirname(call?.[4] ?? ""))).toBe(false);
  });
});
