import { access } from "node:fs/promises";
import { dirname } from "node:path";
import { Effect } from "effect";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { InvalidInput, NonZeroExit, NotInstalled, Timeout } from "./errors.js";
import { execute, importIcs, listArgs, runKhal } from "./khal.js";
import { type FakeKhal, fakeKhal, prependPath, removeDir, runFail, runOk, tempDir } from "./testlib.js";

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

describe("runKhal", () => {
  let fake: FakeKhal | undefined;
  let restore: (() => void) | undefined;

  const install = async (opts: Parameters<typeof fakeKhal>[0]): Promise<FakeKhal> => {
    fake = await fakeKhal(opts);
    restore = prependPath(fake.dir);
    return fake;
  };

  afterEach(async () => {
    restore?.();
    await fake?.cleanup();
    fake = undefined;
    restore = undefined;
  });

  it("returns stdout and passes argv through verbatim", async () => {
    const k = await install({ stdout: "hello\n" });
    expect(await runOk(runKhal(["printcalendars", "a b", "--", "-x"]))).toBe("hello\n");
    expect(await k.calls()).toEqual([["printcalendars", "a b", "--", "-x"]]);
  });

  it("maps a non-zero exit to NonZeroExit carrying stderr and the code", async () => {
    await install({ stderr: "boom\n", exit: 2 });
    const e = await runFail(runKhal(["list"]));
    expect(e).toBeInstanceOf(NonZeroExit);
    expect(e.message).toBe("boom");
    expect((e as NonZeroExit).code).toBe(2);
  });

  it("falls back to stdout when stderr is empty", async () => {
    await install({ stdout: "usage text\n", exit: 1 });
    const e = await runFail(runKhal(["list"]));
    expect(e).toBeInstanceOf(NonZeroExit);
    expect(e.message).toBe("usage text");
  });

  it("maps a slow khal to Timeout", async () => {
    await install({ sleep: 5 });
    const e = await runFail(runKhal(["list"], 150));
    expect(e).toBeInstanceOf(Timeout);
    expect(e.message).toMatch(/150ms/);
  });

  it("stops waiting when the fiber is interrupted", async () => {
    await install({ sleep: 5 });
    const abort = new AbortController();
    const settled = Effect.runPromise(runKhal(["list"]), { signal: abort.signal }).then(
      () => "completed",
      () => "interrupted",
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    abort.abort();
    expect(await settled).toBe("interrupted");
  });

  it("execute rejects invalid input without spawning khal", async () => {
    const k = await install({});
    expect(await runFail(execute(listArgs({ calendar: "-x" })))).toBeInstanceOf(InvalidInput);
    expect(await k.calls()).toEqual([]);
  });

  it("execute runs a valid argv", async () => {
    const k = await install({ stdout: "ok" });
    expect(await runOk(execute(listArgs({ range: "tomorrow" })))).toBe("ok");
    expect((await k.calls())[0]?.slice(0, 1)).toEqual(["list"]);
  });
});

describe("runKhal without khal installed", () => {
  let restore: (() => void) | undefined;
  let empty: string | undefined;

  beforeEach(async () => {
    empty = await tempDir();
    const old = process.env.PATH;
    process.env.PATH = empty;
    restore = () => {
      if (old === undefined) delete process.env.PATH;
      else process.env.PATH = old;
    };
  });

  afterAll(async () => {
    restore?.();
    if (empty) await removeDir(empty);
  });

  it("maps ENOENT to NotInstalled", async () => {
    expect(await runFail(runKhal(["list"]))).toBeInstanceOf(NotInstalled);
  });
});

describe("importIcs", () => {
  let fake: FakeKhal | undefined;
  let restore: (() => void) | undefined;

  const install = async (opts: Parameters<typeof fakeKhal>[0]): Promise<FakeKhal> => {
    fake = await fakeKhal(opts);
    restore = prependPath(fake.dir);
    return fake;
  };

  afterEach(async () => {
    restore?.();
    await fake?.cleanup();
  });

  it("imports a temp file into the calendar and cleans up afterwards", async () => {
    const k = await install({ stdout: "imported\n" });
    expect(await runOk(importIcs("work", "BEGIN:VCALENDAR\r\n"))).toBe("imported\n");
    const [call] = await k.calls();
    expect(call?.slice(0, 4)).toEqual(["import", "-a", "work", "--batch"]);
    expect(await k.imported()).toBe("BEGIN:VCALENDAR\r\n");
    expect(await exists(dirname(call?.[4] ?? ""))).toBe(false);
  });

  it("omits -a without a calendar", async () => {
    const k = await install({});
    await runOk(importIcs(undefined, "X"));
    const [call] = await k.calls();
    expect(call?.slice(0, 2)).toEqual(["import", "--batch"]);
  });

  it("rejects an option-like calendar", async () => {
    const k = await install({});
    expect(await runFail(importIcs("-x", "X"))).toBeInstanceOf(InvalidInput);
    expect(await k.calls()).toEqual([]);
  });

  it("cleans up even when khal fails", async () => {
    const k = await install({ stderr: "nope", exit: 1 });
    expect(await runFail(importIcs("work", "X"))).toBeInstanceOf(NonZeroExit);
    const [call] = await k.calls();
    expect(await exists(dirname(call?.[4] ?? ""))).toBe(false);
  });
});
