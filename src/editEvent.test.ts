import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { updateEvent, updateLines } from "./editEvent.js";
import { events, prop, unfoldLines } from "./ics.js";
import { failure, removeDir, runFail, runOk, tempDir, testSettings, unwrap } from "./testlib.js";
import { findEvent, vdirOf } from "./vdir.js";

const NOW = new Date("2030-01-01T10:00:00Z");

const ics = (extra: string[] = [], header = "DTSTART;TZID=Europe/Berlin:20301016T090000"): string[] => [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "UID:u1",
  "SUMMARY:Standup",
  "LOCATION:Room 1",
  header,
  "DTEND;TZID=Europe/Berlin:20301016T093000",
  "SEQUENCE:1",
  ...extra,
  "END:VEVENT",
  "END:VCALENDAR",
];

const main = (lines: readonly string[]) =>
  events(lines).find((e) => prop(e, "RECURRENCE-ID") === undefined) ?? [];
const base = { calendar: "work", uid: "u1" };

describe("updateLines", () => {
  it("changes text fields, removes with an empty string, and marks the event modified", () => {
    const out = unwrap(
      updateLines(
        ics(["DESCRIPTION:old"]),
        { ...base, summary: "Sync, daily", location: "", description: "a\nb" },
        NOW,
      ),
    );
    const e = main(out);
    expect(prop(e, "SUMMARY")?.value).toBe("Sync\\, daily");
    expect(prop(e, "LOCATION")).toBeUndefined();
    expect(prop(e, "DESCRIPTION")?.value).toBe("a\\nb");
    expect(prop(e, "SEQUENCE")?.value).toBe("2");
    expect(prop(e, "LAST-MODIFIED")?.value).toBe("20300101T100000Z");
    expect(prop(e, "UID")?.value).toBe("u1");
  });

  it("moves the event, keeping the time zone parameter and dropping a DURATION", () => {
    const out = unwrap(
      updateLines(ics(["DURATION:PT1H"]), { ...base, start: "2030-10-17 10:00", end: "10:45" }, NOW),
    );
    const e = main(out);
    expect(prop(e, "DTSTART")).toMatchObject({ params: ";TZID=Europe/Berlin", value: "20301017T100000" });
    expect(prop(e, "DTEND")).toMatchObject({ params: ";TZID=Europe/Berlin", value: "20301017T104500" });
    expect(prop(e, "DURATION")).toBeUndefined();
  });

  it("moves a floating event and adds a missing DTEND", () => {
    const lines = ics([], "DTSTART:20301016T090000").filter((l) => !l.startsWith("DTEND"));
    const e = main(unwrap(updateLines(lines, { ...base, start: "2030-10-16 11:00", end: "12:00" }, NOW)));
    expect(prop(e, "DTSTART")?.value).toBe("20301016T110000");
    expect(prop(e, "DTEND")?.value).toBe("20301016T120000");
  });

  it("changes only the main event of a series with exceptions", () => {
    const lines = [
      ...ics(["RRULE:FREQ=DAILY"]).slice(0, -1),
      "BEGIN:VEVENT",
      "UID:u1",
      "RECURRENCE-ID:20301017T090000",
      "SUMMARY:Special",
      "END:VEVENT",
      "END:VCALENDAR",
    ];
    const out = unwrap(updateLines(lines, { ...base, summary: "Renamed" }, NOW));
    const all = events(out);
    expect(all.map((e) => prop(e, "SUMMARY")?.value)).toEqual(["Renamed", "Special"]);
  });

  it.each([
    [{}, /nothing to change/],
    [{ start: "2030-10-17 10:00" }, /together/],
    [{ end: "10:45" }, /together/],
    [{ summary: "  " }, /summary must not be empty/],
    [{ summary: "a\u0007b" }, /control characters/],
    [{ start: "tomorrow", end: "10:00" }, /start must be/],
    [{ start: "2030-10-17 10:00", end: "10h" }, /end must be/],
    [{ start: "2030-02-31 10:00", end: "11:00" }, /not a real calendar date/],
    [{ start: "2030-10-17 10:00", end: "10:00" }, /end must be after start/],
  ])("rejects %j", (change, message) => {
    expect(failure(updateLines(ics(), { ...base, ...change }, NOW)).message).toMatch(message);
  });

  it("moves an event stored in UTC, in UTC", () => {
    const lines = ics([], "DTSTART:20301016T090000Z");
    const e = main(unwrap(updateLines(lines, { ...base, start: "2030-10-17 10:00", end: "11:00" }, NOW)));
    expect(prop(e, "DTSTART")?.value).toBe("20301017T100000Z");
    expect(prop(e, "DTEND")?.value).toBe("20301017T110000Z");
  });

  it("refuses to move all-day events and series with exceptions", () => {
    const move = { ...base, start: "2030-10-17 10:00", end: "11:00" };
    expect(failure(updateLines(ics([], "DTSTART;VALUE=DATE:20301016"), move, NOW)).message).toMatch(
      /all-day/,
    );
    expect(failure(updateLines(ics([], "DTSTART:20301016"), move, NOW)).message).toMatch(/all-day/);
    expect(failure(updateLines(ics(["EXDATE:20301017T090000"]), move, NOW)).message).toMatch(/exceptions/);
    expect(failure(updateLines(ics(["RDATE:20301017T090000"]), move, NOW)).message).toMatch(/exceptions/);
    const withOverride = [
      ...ics().slice(0, -1),
      "BEGIN:VEVENT",
      "RECURRENCE-ID:1",
      "END:VEVENT",
      "END:VCALENDAR",
    ];
    expect(failure(updateLines(withOverride, move, NOW)).message).toMatch(/exceptions/);
    // text of such a series can still change
    unwrap(updateLines(withOverride, { ...base, summary: "x" }, NOW));
  });

  it("reports a file without a DTSTART or a main event", () => {
    const move = { ...base, start: "2030-10-17 10:00", end: "11:00" };
    expect(
      failure(
        updateLines(
          ics().filter((l) => !l.startsWith("DTSTART")),
          move,
          NOW,
        ),
      ).message,
    ).toMatch(/no DTSTART/);
    expect(
      failure(updateLines(["BEGIN:VCALENDAR", "END:VCALENDAR"], { ...base, summary: "x" }, NOW)).message,
    ).toMatch(/no main event/);
  });
});

describe("vdir and updateEvent", () => {
  let dir: string;
  let vdir: string;
  const settings = () => testSettings({ calendars: { work: { path: vdir } } });

  beforeEach(async () => {
    dir = await tempDir();
    vdir = join(dir, "work");
    await mkdir(vdir);
    await writeFile(join(vdir, "a.ics"), `${ics().join("\r\n")}\r\n`);
    await writeFile(join(vdir, "b.ics"), `${ics().join("\r\n").replace("UID:u1", "UID:u2")}\r\n`);
    await writeFile(join(vdir, "notes.txt"), "UID:u1");
  });
  afterEach(() => removeDir(dir));

  it("finds the event by uid, only among .ics files", async () => {
    expect((await runOk(findEvent(settings(), "work", " u2 "))).file).toBe(join(vdir, "b.ics"));
  });

  it("says why an event cannot be found", async () => {
    expect((await runFail(findEvent(settings(), "work", "nope"))).message).toBe(
      "no event with uid 'nope' in calendar 'work'",
    );
    expect((await runFail(findEvent(settings(), "bare", "u1"))).message).toMatch(
      /is not configured \(configured: work\)/,
    );
    expect((await runFail(findEvent(settings(), "other", "u1"))).message).toMatch(
      /is not configured \(configured: work\)/,
    );
    expect((await runFail(findEvent(settings(), "  ", "u1"))).message).toMatch(/must be a calendar name/);
    expect((await runFail(findEvent(settings(), "work", "a\u0007"))).message).toMatch(
      /uid must not be empty/,
    );
    expect((await runFail(findEvent(settings(), "work", " "))).message).toMatch(/uid must not be empty/);
  });

  it("reports an unreadable vdir as an I/O error", async () => {
    const s = testSettings({ calendars: { work: { path: join(dir, "missing") } } });
    expect((await runFail(findEvent(s, "work", "u1")))._tag).toBe("IoError");
  });

  it("vdirOf returns the path or the reason", () => {
    expect(vdirOf(settings(), " work ")).toBe(vdir);
  });

  it("rewrites only the event's file, atomically, and leaves no temporary file", async () => {
    const before = await readFile(join(vdir, "b.ics"), "utf8");
    const out = await runOk(updateEvent(settings(), { ...base, summary: "Plan A/B" }, "n1", NOW));
    expect(out).toMatch(/^Updated event u1 in calendar work\./);
    expect(out).toMatch(/WARNING: .*CalDAV/);
    const after = unfoldLines(await readFile(join(vdir, "a.ics"), "utf8"));
    expect(prop(main(after), "SUMMARY")?.value).toBe("Plan A/B");
    expect(await readFile(join(vdir, "b.ics"), "utf8")).toBe(before);
    expect((await readdir(vdir)).sort()).toEqual(["a.ics", "b.ics", "notes.txt"]);
  });

  it("gives no warning for a harmless title and writes nothing when the change is invalid", async () => {
    expect(await runOk(updateEvent(settings(), { ...base, summary: "Plan" }, "n1", NOW))).not.toMatch(
      /WARNING/,
    );
    const before = await readFile(join(vdir, "a.ics"), "utf8");
    expect((await runFail(updateEvent(settings(), { ...base, start: "x" }, "n1", NOW)))._tag).toBe(
      "InvalidInput",
    );
    expect(await readFile(join(vdir, "a.ics"), "utf8")).toBe(before);
    expect(await runOk(updateEvent(settings(), { ...base, location: "Hall" }, "n1", NOW))).toMatch(
      /^Updated/,
    );
  });
});
