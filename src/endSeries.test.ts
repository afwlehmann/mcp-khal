import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EditEnv } from "./editEvent.js";
import { endSeries, endSeriesLines } from "./endSeries.js";
import { events, isMaster, prop, props, unfoldLines } from "./ics.js";
import { failure, removeDir, runFail, runOk, tempDir, testSettings, unwrap } from "./testlib.js";

const NOW = new Date("2030-01-01T10:00:00Z");
const ZONE = ";TZID=Europe/Berlin";
const ENV: EditEnv = { hostZone: "Europe/Berlin", me: "me@example.com" };

const series = (rule = "FREQ=DAILY;COUNT=10", extra: string[] = [], inside: string[] = []): string[] => [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "UID:s1",
  "SUMMARY:Standup",
  `DTSTART${ZONE}:20301016T090000`,
  `DTEND${ZONE}:20301016T093000`,
  `RRULE:${rule}`,
  ...inside,
  "END:VEVENT",
  ...extra,
  "END:VCALENDAR",
];

const exception = (date: string, start = "100000"): string[] => [
  "BEGIN:VEVENT",
  "UID:s1",
  `RECURRENCE-ID${ZONE}:${date}T090000`,
  `DTSTART${ZONE}:${date}T${start}`,
  "SUMMARY:Special",
  "END:VEVENT",
];

const base = { calendar: "work", uid: "s1" };
const main = (lines: readonly string[]) => events(lines).find(isMaster) ?? [];

describe("endSeriesLines", () => {
  const end = (lastDate: string, lines = series(), env = ENV) =>
    endSeriesLines(lines, { ...base, lastDate }, NOW, env);

  it("ends the rule with its last instance (a UTC value for a zoned start), replacing COUNT", () => {
    const out = unwrap(end("2030-10-19"));
    // 09:00 in Berlin on 19 Oct 2030 (CEST) is 07:00Z
    expect(prop(main(out), "RRULE")?.value).toBe("FREQ=DAILY;UNTIL=20301019T070000Z");
    expect(prop(main(out), "SEQUENCE")?.value).toBe("1");
    expect(prop(main(out), "SUMMARY")?.value).toBe("Standup");
  });

  it("uses the type of DTSTART for UNTIL: UTC, floating or a date", () => {
    const withStart = (start: string, end: string) =>
      series().map((l) => (l.startsWith("DTSTART") ? start : l.startsWith("DTEND") ? end : l));
    const until = (lines: string[]) => prop(main(unwrap(end("2030-10-19", lines))), "RRULE")?.value;
    expect(until(withStart("DTSTART:20301016T090000Z", "DTEND:20301016T093000Z"))).toBe(
      "FREQ=DAILY;UNTIL=20301019T090000Z",
    );
    expect(until(withStart("DTSTART:20301016T090000", "DTEND:20301016T093000"))).toBe(
      "FREQ=DAILY;UNTIL=20301019T090000",
    );
    expect(until(withStart("DTSTART;VALUE=DATE:20301016", "DTEND;VALUE=DATE:20301017"))).toBe(
      "FREQ=DAILY;UNTIL=20301019",
    );
  });

  it("drops exceptions after the last day and keeps the others", () => {
    const lines = series("FREQ=DAILY", [...exception("20301018"), ...exception("20301022")]);
    const out = unwrap(end("2030-10-19", lines));
    const kept = events(out).filter((e) => !isMaster(e));
    expect(kept.map((e) => prop(e, "RECURRENCE-ID")?.value)).toEqual(["20301018T090000"]);
  });

  it("drops an exception that was moved from before the end to after it, and one moved the other way", () => {
    const moved = [
      "BEGIN:VEVENT",
      "UID:s1",
      `RECURRENCE-ID${ZONE}:20301018T090000`,
      `DTSTART${ZONE}:20301025T090000`,
      "END:VEVENT",
    ];
    const back = [
      "BEGIN:VEVENT",
      "UID:s1",
      `RECURRENCE-ID${ZONE}:20301024T090000`,
      `DTSTART${ZONE}:20301017T150000`,
      "END:VEVENT",
    ];
    const out = unwrap(end("2030-10-19", series("FREQ=DAILY", [...moved, ...back])));
    expect(events(out).filter((e) => !isMaster(e))).toEqual([]);
  });

  it("drops the dates RDATE adds and EXDATE excludes after the end, and keeps the earlier ones", () => {
    const inside = [
      `RDATE${ZONE}:20301018T120000,20301101T120000`,
      `EXDATE${ZONE}:20301017T090000,20301103T090000`,
      "RDATE;VALUE=DATE:20301120",
      "EXDATE;VALUE=PERIOD:20301130T090000/PT1H",
    ];
    const m = main(unwrap(end("2030-10-19", series("FREQ=DAILY", [], inside))));
    expect(props(m, "RDATE").map((p) => p.value)).toEqual(["20301018T120000"]);
    expect(props(m, "EXDATE").map((p) => p.value)).toEqual(["20301017T090000"]);
  });

  it("bounds the rule at its own last instance, not at a date RDATE added (UNTIL must not extend a COUNT)", () => {
    const inside = [`RDATE${ZONE}:20301019T180000`];
    const m = main(unwrap(end("2030-10-19", series("FREQ=DAILY;COUNT=2", [], inside))));
    expect(prop(m, "RRULE")?.value).toBe("FREQ=DAILY;UNTIL=20301017T070000Z");
    expect(props(m, "RDATE").map((p) => p.value)).toEqual(["20301019T180000"]);
  });

  it("takes the day in the host zone: 22:00 in New York is already the next day in Berlin", () => {
    const ny = series("FREQ=DAILY").map((l) =>
      l.startsWith("DTSTART")
        ? "DTSTART;TZID=America/New_York:20301101T220000"
        : l.startsWith("DTEND")
          ? "DTEND;TZID=America/New_York:20301101T230000"
          : l,
    );
    // the instance of 2 Nov 22:00 New York (EDT) is 3 Nov 03:00 in Berlin (CET): the 3rd is its day
    const out = unwrap(end("2030-11-03", ny));
    expect(prop(main(out), "RRULE")?.value).toBe("FREQ=DAILY;UNTIL=20301103T020000Z");
  });

  it("accepts the first occurrence as the last one (a one-day series)", () => {
    expect(prop(main(unwrap(end("2030-10-16"))), "RRULE")?.value).toBe("FREQ=DAILY;UNTIL=20301016T070000Z");
  });

  it("puts FREQ first and never keeps COUNT and UNTIL together", () => {
    const out = unwrap(end("2030-10-19", series("COUNT=10;BYDAY=MO,TU,WE,TH,FR,SA,SU;FREQ=DAILY")));
    expect(prop(main(out), "RRULE")?.value).toBe(
      "FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR,SA,SU;UNTIL=20301019T070000Z",
    );
  });

  it("refuses what it cannot do", () => {
    expect(failure(end("2030-10-15")).message).toMatch(/remove the whole event/);
    expect(failure(end("soon")).message).toMatch(/real date/);
    expect(
      failure(
        end(
          "2030-10-19",
          series().filter((l) => !l.startsWith("RRULE")),
        ),
      ).message,
    ).toMatch(/not a recurring event/);
    expect(failure(end("2030-10-19", ["BEGIN:VCALENDAR", "END:VCALENDAR"])).message).toMatch(/no main event/);
    expect(
      failure(
        end(
          "2030-10-19",
          series().map((l) => l.replace("Europe/Berlin", "Mars/Base")),
        ),
      ).message,
    ).toMatch(/unknown time zone/);
  });

  it("keeps what it cannot read: a listed date or an exception it cannot place", () => {
    const bad = ["BEGIN:VEVENT", "UID:s1", "RECURRENCE-ID:soon", "SUMMARY:Odd", "END:VEVENT"];
    const out = unwrap(end("2030-10-19", series("FREQ=DAILY", bad, ["EXDATE:soon"])));
    expect(prop(main(out), "EXDATE")?.value).toBe("soon");
    expect(events(out).filter((e) => !isMaster(e))).toHaveLength(1);
  });

  it("refuses a series without DTSTART", () => {
    expect(
      failure(
        end(
          "2030-10-19",
          series().filter((l) => !l.startsWith("DTSTART")),
        ),
      ).message,
    ).toMatch(/not a recurring event/);
  });

  it("refuses to end a series somebody else organizes", () => {
    const invited = series("FREQ=DAILY", [], ["ORGANIZER:mailto:boss@example.com"]);
    expect(failure(end("2030-10-19", invited)).message).toMatch(/only the organizer/);
    const own = series("FREQ=DAILY", [], ["ORGANIZER:mailto:ME@example.com", "SEQUENCE:4"]);
    expect(prop(main(unwrap(end("2030-10-19", own))), "SEQUENCE")?.value).toBe("5");
  });
});

describe("endSeries", () => {
  let dir: string;
  let vdir: string;
  const settings = () => testSettings({ calendars: { work: { path: vdir } } });

  beforeEach(async () => {
    dir = await tempDir();
    vdir = join(dir, "work");
    await mkdir(vdir);
    await writeFile(join(vdir, "s1.ics"), `${series().join("\r\n")}\r\n`);
  });
  afterEach(async () => {
    await removeDir(dir);
  });

  it("ends the series in its file when the day is an occurrence", async () => {
    const out = await runOk(endSeries(settings(), { ...base, lastDate: "2030-10-19" }, NOW));
    expect(out).toBe("Ended event s1 in calendar work: its last occurrence is on 2030-10-19.\n");
    const lines = unfoldLines(await readFile(join(vdir, "s1.ics"), "utf8"));
    expect(prop(main(lines), "RRULE")?.value).toBe("FREQ=DAILY;UNTIL=20301019T070000Z");
  });

  it("changes nothing for a day that is no occurrence or an unknown event", async () => {
    const before = await readFile(join(vdir, "s1.ics"), "utf8");
    // COUNT=10 from 16 Oct ends on 25 Oct, so the 26th is no occurrence
    expect((await runFail(endSeries(settings(), { ...base, lastDate: "2030-10-26" }, NOW))).message).toBe(
      "event s1 has no occurrence on 2030-10-26",
    );
    expect(
      (await runFail(endSeries(settings(), { ...base, uid: "nope", lastDate: "2030-10-19" }, NOW))).message,
    ).toMatch(/no event with uid 'nope'/);
    expect(await readFile(join(vdir, "s1.ics"), "utf8")).toBe(before);
  });

  it("refuses a day excluded by EXDATE", async () => {
    const lines = series().flatMap((l) =>
      l.startsWith("RRULE") ? [`EXDATE${ZONE}:20301019T090000`, l] : [l],
    );
    await writeFile(join(vdir, "s1.ics"), `${lines.join("\r\n")}\r\n`);
    expect((await runFail(endSeries(settings(), { ...base, lastDate: "2030-10-19" }, NOW))).message).toBe(
      "event s1 has no occurrence on 2030-10-19",
    );
  });

  it("rejects a bad date", async () => {
    expect((await runFail(endSeries(settings(), { ...base, lastDate: "20301019" }, NOW))).message).toMatch(
      /real date/,
    );
  });
});
