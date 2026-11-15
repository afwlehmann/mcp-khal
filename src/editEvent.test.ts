import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type EditEnv, organizerNote, type UpdateParams, updateEvent, updateLines } from "./editEvent.js";
import { events, prop, unfoldLines } from "./ics.js";
import { failure, removeDir, runFail, runOk, tempDir, testSettings, unwrap } from "./testlib.js";
import { findEvent, vdirOf } from "./vdir.js";

const NOW = new Date("2030-01-01T10:00:00Z");
const ENV: EditEnv = { hostZone: "Europe/Berlin", me: "me@example.com" };

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
const update = (lines: readonly string[], p: Partial<UpdateParams>, env = ENV) =>
  updateLines(lines, { ...base, ...p }, NOW, env);

describe("updateLines", () => {
  it("changes text fields, removes with an empty string; a text change is no revision", () => {
    const out = unwrap(
      update(ics(["DESCRIPTION:old"]), { summary: "Sync, daily", location: "", description: "a\nb" }),
    );
    const e = main(out);
    expect(prop(e, "SUMMARY")?.value).toBe("Sync\\, daily");
    expect(prop(e, "LOCATION")).toBeUndefined();
    expect(prop(e, "DESCRIPTION")?.value).toBe("a\\nb");
    expect(prop(e, "SEQUENCE")?.value).toBe("1");
    expect(prop(e, "LAST-MODIFIED")?.value).toBe("20300101T100000Z");
    expect(prop(e, "DTSTAMP")?.value).toBe("20300101T100000Z");
    expect(prop(e, "UID")?.value).toBe("u1");
  });

  it("works without an environment when only text changes", () => {
    const out = unwrap(updateLines(ics(), { ...base, summary: "x" }, NOW));
    expect(prop(main(out), "SUMMARY")?.value).toBe("x");
  });

  it("drops the vendor's copy of the description only when the description changes", () => {
    const lines = ics(["DESCRIPTION:old", "X-ALT-DESC;FMTTYPE=text/html:<p>old</p>"]);
    expect(prop(main(unwrap(update(lines, { summary: "s" }))), "X-ALT-DESC")).toBeDefined();
    expect(prop(main(unwrap(update(lines, { description: "new" }))), "X-ALT-DESC")).toBeUndefined();
  });

  it("moves the event (times are the host zone's), keeping the zone parameter and dropping a DURATION", () => {
    const out = unwrap(update(ics(["DURATION:PT1H"]), { start: "2030-10-17 10:00", end: "10:45" }));
    const e = main(out);
    expect(prop(e, "DTSTART")).toMatchObject({ params: ";TZID=Europe/Berlin", value: "20301017T100000" });
    expect(prop(e, "DTEND")).toMatchObject({ params: ";TZID=Europe/Berlin", value: "20301017T104500" });
    expect(prop(e, "DURATION")).toBeUndefined();
    expect(prop(e, "SEQUENCE")?.value).toBe("2");
  });

  it("converts the host time into the zone of a TZID event", () => {
    const lines = ics().map((l) => l.replaceAll("Europe/Berlin", "America/New_York"));
    const e = main(unwrap(update(lines, { start: "2030-10-17 10:00", end: "10:45" })));
    // 10:00 in Berlin (CEST) is 04:00 in New York (EDT)
    expect(prop(e, "DTSTART")?.value).toBe("20301017T040000");
    expect(prop(e, "DTEND")?.value).toBe("20301017T044500");
  });

  it("moves a floating event and adds a missing DTEND", () => {
    const lines = ics([], "DTSTART:20301016T090000").filter((l) => !l.startsWith("DTEND"));
    const e = main(unwrap(update(lines, { start: "2030-10-16 11:00", end: "12:00" })));
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
    const out = unwrap(update(lines, { summary: "Renamed" }));
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
    [{ organizer: "x@example.com", summary: "s" }, /organizer of an event cannot be changed/],
  ])("rejects %j", (change, message) => {
    expect(failure(update(ics(), change)).message).toMatch(message);
  });

  it("moves an event stored in UTC to the UTC instant of the host time", () => {
    const lines = ics([], "DTSTART:20301016T090000Z");
    const e = main(unwrap(update(lines, { start: "2030-10-17 10:00", end: "11:00" })));
    // 10:00 in Berlin on 17 Oct 2030 is 08:00Z (CEST), and the value stays a UTC value without TZID
    expect(prop(e, "DTSTART")?.value).toBe("20301017T080000Z");
    expect(prop(e, "DTEND")?.value).toBe("20301017T090000Z");
  });

  it("refuses to move all-day events and series with exceptions", () => {
    const move = { start: "2030-10-17 10:00", end: "11:00" };
    expect(failure(update(ics([], "DTSTART;VALUE=DATE:20301016"), move)).message).toMatch(/all-day/);
    expect(failure(update(ics([], "DTSTART:20301016"), move)).message).toMatch(/all-day/);
    expect(failure(update(ics(["EXDATE:20301017T090000"]), move)).message).toMatch(/exceptions/);
    expect(failure(update(ics(["RDATE:20301017T090000"]), move)).message).toMatch(/exceptions/);
    const withOverride = [
      ...ics().slice(0, -1),
      "BEGIN:VEVENT",
      "RECURRENCE-ID:1",
      "END:VEVENT",
      "END:VCALENDAR",
    ];
    expect(failure(update(withOverride, move)).message).toMatch(/exceptions/);
    // text of such a series can still change
    unwrap(update(withOverride, { summary: "x" }));
  });

  it("refuses a move to a day the repeat rule does not name, and allows one it does", () => {
    const weekly = ics(["RRULE:FREQ=WEEKLY;BYDAY=WE"], "DTSTART;TZID=Europe/Berlin:20301016T090000");
    // 16 Oct 2030 is a Wednesday: Thursday the 17th breaks the rule, the 23rd keeps it
    expect(failure(update(weekly, { start: "2030-10-17 10:00", end: "11:00" })).message).toMatch(
      /does not fit the repeat rule \(FREQ=WEEKLY;BYDAY=WE\)/,
    );
    const ok = main(unwrap(update(weekly, { start: "2030-10-23 10:00", end: "11:00" })));
    expect(prop(ok, "DTSTART")?.value).toBe("20301023T100000");
    const monthly = ics(["RRULE:FREQ=MONTHLY;BYDAY=3WE;BYMONTH=10,11"]);
    expect(unwrap(update(monthly, { start: "2030-10-16 10:00", end: "11:00" })).length).toBeGreaterThan(0);
    expect(failure(update(monthly, { start: "2030-10-23 10:00", end: "11:00" })).message).toMatch(
      /repeat rule/,
    );
    const last = ics(["RRULE:FREQ=MONTHLY;BYDAY=-1WE;BYMONTHDAY=-1,25"]);
    expect(failure(update(last, { start: "2030-10-30 10:00", end: "11:00" })).message).toMatch(/repeat rule/);
    expect(
      failure(update(ics(["RRULE:FREQ=YEARLY;BYMONTH=3"]), { start: "2030-10-16 10:00", end: "11:00" }))
        .message,
    ).toMatch(/repeat rule/);
    expect(
      failure(update(ics(["RRULE:FREQ=MONTHLY;BYMONTHDAY=1"]), { start: "2030-10-16 10:00", end: "11:00" }))
        .message,
    ).toMatch(/repeat rule/);
  });

  it("reports a file without a DTSTART or a main event", () => {
    const move = { start: "2030-10-17 10:00", end: "11:00" };
    expect(
      failure(
        update(
          ics().filter((l) => !l.startsWith("DTSTART")),
          move,
        ),
      ).message,
    ).toMatch(/no DTSTART/);
    expect(failure(update(["BEGIN:VCALENDAR", "END:VCALENDAR"], { summary: "x" })).message).toMatch(
      /no main event/,
    );
    expect(failure(update(ics([], "DTSTART:soon"), move)).message).toMatch(/no readable DTSTART/);
  });

  it("refuses to change the time of an event somebody else organizes, but changes its text", () => {
    const invited = ics(["ORGANIZER:mailto:boss@example.com"]);
    const move = { start: "2030-10-17 10:00", end: "11:00" };
    expect(failure(update(invited, move)).message).toMatch(/organized by boss@example.com, not by you/);
    expect(failure(update(invited, move, { ...ENV, me: undefined })).message).toMatch(
      /no address is configured/,
    );
    const renamed = unwrap(update(invited, { summary: "mine" }));
    expect(prop(main(renamed), "SEQUENCE")?.value).toBe("1");
    // the organizer may move it, in any spelling of the address
    const own = ics(["ORGANIZER:MAILTO:Me@Example.com"]);
    expect(prop(main(unwrap(update(own, move))), "SEQUENCE")?.value).toBe("2");
    expect(organizerNote(invited, ENV)).toMatch(/boss@example.com organizes this event and is not told/);
    expect(organizerNote(own, ENV)).toBeUndefined();
    expect(organizerNote(ics(), ENV)).toBeUndefined();
    expect(organizerNote(["BEGIN:VCALENDAR", "END:VCALENDAR"], ENV)).toBeUndefined();
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

  it("tells the user when an event somebody else organizes was changed", async () => {
    const lines = ics(["ORGANIZER:mailto:boss@example.com"]).join("\r\n");
    await writeFile(join(vdir, "a.ics"), `${lines}\r\n`);
    const out = await runOk(updateEvent(settings(), { ...base, summary: "Plan" }, "n1", NOW));
    expect(out).toMatch(/boss@example.com organizes this event and is not told/);
  });
});
