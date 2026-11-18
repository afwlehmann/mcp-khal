import { chmod, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { calendarNameProblem, MAX_NAME, parseConfig } from "./config.js";
import { paramsOf, setProp } from "./ics.js";
import { interpretName } from "./setup.js";
import { failure, runFail, testSettings } from "./testlib.js";
import { createEvent, vdirOf, writeEvent } from "./vdir.js";

describe("paramsOf on long values", () => {
  it("splits at commas outside quotes", () => {
    expect(paramsOf(';X=a,"b,c",d;Y="q"')).toEqual([
      { name: "X", values: ["a", "b,c", "d"] },
      { name: "Y", values: ["q"] },
    ]);
  });

  it("is linear: 200k commas finish quickly", () => {
    const start = performance.now();
    const [p] = paramsOf(`;X=${",".repeat(200_000)}`);
    expect(p?.values).toHaveLength(200_001);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});

describe("setProp placement", () => {
  const event = [
    "BEGIN:VEVENT",
    "UID:u1",
    "SUMMARY:x",
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    "DESCRIPTION:r",
    "TRIGGER:-PT15M",
    "END:VALARM",
    "END:VEVENT",
  ];

  it("inserts new properties before a nested VALARM, leaving it untouched", () => {
    const out = setProp(
      setProp(event, "LAST-MODIFIED", "LAST-MODIFIED:20300101T000000Z"),
      "SEQUENCE",
      "SEQUENCE:1",
    );
    expect(out).toEqual([
      "BEGIN:VEVENT",
      "UID:u1",
      "SUMMARY:x",
      "LAST-MODIFIED:20300101T000000Z",
      "SEQUENCE:1",
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      "DESCRIPTION:r",
      "TRIGGER:-PT15M",
      "END:VALARM",
      "END:VEVENT",
    ]);
  });

  it("appends before END:VEVENT when there is no nested component", () => {
    expect(setProp(["BEGIN:VEVENT", "UID:u", "END:VEVENT"], "SEQUENCE", "SEQUENCE:1")).toEqual([
      "BEGIN:VEVENT",
      "UID:u",
      "SEQUENCE:1",
      "END:VEVENT",
    ]);
  });
});

describe("writeEvent through a symlink", () => {
  it("updates the target and keeps the link", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-khal-link-"));
    try {
      const real = join(dir, "real.ics");
      const link = join(dir, "link.ics");
      const old = ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:u1", "SUMMARY:old", "END:VEVENT", "END:VCALENDAR"];
      await writeFile(real, `${old.join("\r\n")}\r\n`);
      const linked = await symlink(real, link).then(
        () => true,
        () => false,
      );
      if (!linked) return; // symlinks unsupported here
      const next = old.map((l) => (l === "SUMMARY:old" ? "SUMMARY:new" : l));
      await Effect.runPromise(writeEvent(link, next));
      expect(await readlink(link)).toBe(real);
      expect(await readFile(real, "utf8")).toContain("SUMMARY:new");
      expect(await realpath(link)).toBe(await realpath(real));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("one calendar name rule", () => {
  const long = "a".repeat(MAX_NAME + 1);
  const cfg = (name: string) => JSON.stringify({ calendars: { [name]: { path: "/cal/x" } } });

  it.each(["a\u0085b", "a b", "a b", "a\u0000b", "a\u007fb", long])(
    "is rejected by predicate, config, setup prompt and vdir: %j",
    (name) => {
      expect(calendarNameProblem(name)).toBeDefined();
      expect(failure(parseConfig(cfg(name))).message).toMatch(
        /calendar name (with control characters|longer than 255)/,
      );
      expect(failure(interpretName(name, []))).toMatch(/^a calendar name must not/);
      expect(typeof vdirOf(testSettings({ calendars: { x: { path: "/cal/x" } } }), name)).not.toBe("string");
    },
  );

  it.each(["a b", "a b", "a\u0000b", "a\u007fb", long])(
    "is rejected by predicate, config, setup prompt and vdir: %j",
    (name) => {
      expect(calendarNameProblem(name)).toBeDefined();
      expect(failure(parseConfig(cfg(name))).message).toMatch(
        /calendar name (with control characters|longer than 255)/,
      );
      expect(failure(interpretName(name, []))).toMatch(/^a calendar name must not/);
      expect(typeof vdirOf(testSettings({ calendars: { x: { path: "/cal/x" } } }), name)).not.toBe("string");
    },
  );

  it("accepts an ordinary name of the maximum length", () => {
    expect(calendarNameProblem("a".repeat(MAX_NAME))).toBeUndefined();
  });
});

describe("writing into a calendar directory that is not writable", () => {
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:x",
    "BEGIN:VEVENT",
    "UID:u",
    "END:VEVENT",
    "END:VCALENDAR",
  ];

  it.skipIf(isRoot)("fails with a message that names the directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-khal-ro-"));
    await chmod(dir, 0o555);
    try {
      const created = await runFail(createEvent(join(dir, "u.ics"), lines));
      expect(created.message).toContain(`the calendar directory ${dir} is not writable`);
      const written = await runFail(writeEvent(join(dir, "u.ics"), lines));
      expect(written.message).toContain("is not writable");
    } finally {
      await chmod(dir, 0o755);
      await rm(dir, { recursive: true, force: true });
    }
  });
});
