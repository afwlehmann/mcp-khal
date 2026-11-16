import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type EditEnv,
  occurrenceDates,
  occurrencesBefore,
  requireOccurrence,
  splitSeries,
  updateEvent,
  updateInstance,
} from "./editEvent.js";
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

const exception = (date: string): string[] => [
  "BEGIN:VEVENT",
  "UID:s1",
  `RECURRENCE-ID${ZONE}:${date}T090000`,
  `DTSTART${ZONE}:${date}T100000`,
  `DTEND${ZONE}:${date}T103000`,
  "SUMMARY:Special",
  "END:VEVENT",
];

const base = { calendar: "work", uid: "s1" };
const main = (lines: readonly string[]) => events(lines).find(isMaster) ?? [];
const exceptions = (lines: readonly string[]) => events(lines).filter((e) => !isMaster(e));

describe("updateInstance", () => {
  const instance = (change: object, lines = series(), env = ENV) =>
    updateInstance(lines, { ...base, scope: "instance", date: "2030-10-20", ...change }, NOW, env);

  it("writes one exception shaped like the series and leaves the series alone", () => {
    const out = unwrap(instance({ summary: "Retro" }));
    const [only, ...more] = exceptions(out);
    expect(more).toEqual([]);
    expect(prop(only ?? [], "RECURRENCE-ID")).toMatchObject({ params: ZONE, value: "20301020T090000" });
    expect(prop(only ?? [], "DTSTART")?.value).toBe("20301020T090000");
    expect(prop(only ?? [], "DTEND")?.value).toBe("20301020T093000");
    expect(prop(only ?? [], "SUMMARY")?.value).toBe("Retro");
    expect(prop(only ?? [], "UID")?.value).toBe("s1");
    for (const gone of ["RRULE", "EXDATE", "RDATE"]) expect(prop(only ?? [], gone)).toBeUndefined();
    expect(prop(only ?? [], "DTSTAMP")?.value).toBe("20300101T100000Z");
    expect(prop(only ?? [], "SEQUENCE")).toBeUndefined();
    expect(main(out)).toEqual(main(series()));
    expect(out.at(-1)).toBe("END:VCALENDAR");
  });

  it("moves just that occurrence, to any day, keeping its RECURRENCE-ID", () => {
    const [only] = exceptions(unwrap(instance({ start: "2030-10-21 14:00", end: "15:00" })));
    expect(prop(only ?? [], "RECURRENCE-ID")?.value).toBe("20301020T090000");
    expect(prop(only ?? [], "DTSTART")).toMatchObject({ params: ZONE, value: "20301021T140000" });
    expect(prop(only ?? [], "DTEND")?.value).toBe("20301021T150000");
    expect(prop(only ?? [], "SEQUENCE")?.value).toBe("1");
  });

  it("writes an exception for a series that has no DTEND", () => {
    const noEnd = series().filter((l) => !l.startsWith("DTEND"));
    const [only] = exceptions(unwrap(instance({ summary: "x" }, noEnd)));
    expect(prop(only ?? [], "DTSTART")?.value).toBe("20301020T090000");
    expect(prop(only ?? [], "DTEND")).toBeUndefined();
  });

  it("keeps the exact length of a series with DTEND across a daylight-saving change", () => {
    const lines = series("FREQ=DAILY;COUNT=20");
    const [only] = exceptions(unwrap(instance({ summary: "Retro" }, lines)));
    expect(prop(only ?? [], "DTEND")?.value).toBe("20301020T093000");
    const [later] = exceptions(
      unwrap(
        updateInstance(lines, { ...base, scope: "instance", date: "2030-10-29", summary: "x" }, NOW, ENV),
      ),
    );
    // 27 Oct 2030 is the end of summer time: the 29th still starts at 09:00 local and lasts 30 minutes
    expect(prop(later ?? [], "DTSTART")?.value).toBe("20301029T090000");
    expect(prop(later ?? [], "DTEND")?.value).toBe("20301029T093000");
  });

  it("takes the day in the host zone and writes the RECURRENCE-ID of the original start", () => {
    const ny = series("FREQ=DAILY").map((l) =>
      l.startsWith("DTSTART")
        ? "DTSTART;TZID=America/New_York:20301101T220000"
        : l.startsWith("DTEND")
          ? "DTEND;TZID=America/New_York:20301101T230000"
          : l,
    );
    // the instance that starts 2 Nov 22:00 in New York is 3 Nov 03:00 in Berlin, the host
    const [only] = exceptions(
      unwrap(updateInstance(ny, { ...base, scope: "instance", date: "2030-11-03", summary: "x" }, NOW, ENV)),
    );
    expect(prop(only ?? [], "RECURRENCE-ID")).toMatchObject({
      params: ";TZID=America/New_York",
      value: "20301102T220000",
    });
    expect(prop(only ?? [], "DTSTART")?.value).toBe("20301102T220000");
  });

  it("keeps the length of a multi-day occurrence and handles all-day series", () => {
    const allDay = series().map((l) =>
      l.startsWith("DTSTART")
        ? "DTSTART;VALUE=DATE:20301016"
        : l.startsWith("DTEND")
          ? "DTEND;VALUE=DATE:20301018"
          : l,
    );
    const [only] = exceptions(unwrap(instance({ summary: "Trip" }, allDay)));
    expect(prop(only ?? [], "RECURRENCE-ID")).toMatchObject({ params: ";VALUE=DATE", value: "20301020" });
    expect(prop(only ?? [], "DTSTART")?.value).toBe("20301020");
    expect(prop(only ?? [], "DTEND")?.value).toBe("20301022");
  });

  it("gives a UTC series a UTC RECURRENCE-ID and a floating series a floating one", () => {
    const withStart = (start: string, end: string) =>
      series().map((l) => (l.startsWith("DTSTART") ? start : l.startsWith("DTEND") ? end : l));
    const utc = exceptions(
      unwrap(instance({ summary: "x" }, withStart("DTSTART:20301016T090000Z", "DTEND:20301016T093000Z"))),
    );
    // 09:00Z is 11:00 in Berlin on the same day
    expect(prop(utc[0] ?? [], "RECURRENCE-ID")?.value).toBe("20301020T090000Z");
    const floating = exceptions(
      unwrap(instance({ summary: "x" }, withStart("DTSTART:20301016T090000", "DTEND:20301016T093000"))),
    );
    expect(prop(floating[0] ?? [], "RECURRENCE-ID")?.value).toBe("20301020T090000");
  });

  it("changes an exception that exists instead of adding another", () => {
    const first = unwrap(instance({ summary: "Retro" }));
    const second = unwrap(instance({ location: "Hall" }, first));
    expect(exceptions(second)).toHaveLength(1);
    const [only] = exceptions(second);
    expect(prop(only ?? [], "SUMMARY")?.value).toBe("Retro");
    expect(prop(only ?? [], "LOCATION")?.value).toBe("Hall");
    // an exception of another day is not touched
    const other = series("FREQ=DAILY", exception("20301022"));
    const changed = unwrap(instance({ summary: "Retro" }, other));
    expect(exceptions(changed).map((e) => prop(e, "SUMMARY")?.value)).toEqual(["Special", "Retro"]);
  });

  it("finds an exception that was moved by the day it is shown on", () => {
    const lines = series("FREQ=DAILY", exception("20301022"));
    // the exception of the 22nd starts at 10:00 on the 22nd; ask for that day
    const out = unwrap(
      updateInstance(lines, { ...base, scope: "instance", date: "2030-10-22", summary: "Moved" }, NOW, ENV),
    );
    expect(exceptions(out)).toHaveLength(1);
    expect(prop(exceptions(out)[0] ?? [], "SUMMARY")?.value).toBe("Moved");
  });

  it("refuses what it cannot do", () => {
    const plain = series().filter((l) => !l.startsWith("RRULE"));
    expect(failure(instance({ summary: "x" }, plain)).message).toMatch(/not a recurring event/);
    expect(
      failure(updateInstance(series(), { ...base, scope: "instance", summary: "x" }, NOW, ENV)).message,
    ).toMatch(/needs the date/);
    expect(failure(updateInstance(series(), { ...base, summary: "x" }, NOW, ENV)).message).toMatch(
      /not a recurring event/,
    );
    expect(failure(instance({})).message).toMatch(/nothing to change/);
    expect(failure(instance({ summary: "x" }, ["BEGIN:VCALENDAR", "END:VCALENDAR"])).message).toMatch(
      /no main event/,
    );
    const noEnd = series().filter((l) => l !== "END:VCALENDAR");
    expect(failure(instance({ summary: "x" }, noEnd)).message).toMatch(/no END:VCALENDAR/);
    const noStart = series().filter((l) => !l.startsWith("DTSTART"));
    expect(failure(instance({ summary: "x" }, noStart)).message).toMatch(/no readable DTSTART/);
    const bad = series().map((l) => (l.startsWith("DTSTART") ? "DTSTART:soon" : l));
    expect(failure(instance({ summary: "x" }, bad)).message).toMatch(/no readable DTSTART/);
    expect(failure(instance({ summary: "x" }, series("FREQ=DAILY;COUNT=2"))).message).toMatch(
      /no occurrence on 2030-10-20/,
    );
    expect(failure(instance({ summary: "x", date: "2030-02-30" })).message).toMatch(/real date/);
  });

  it("refuses a day with several occurrences, and a time change of somebody else's event", () => {
    const hourly = series("FREQ=HOURLY;COUNT=200");
    expect(failure(instance({ summary: "x" }, hourly)).message).toMatch(/has \d+ occurrences on 2030-10-20/);
    const invited = series("FREQ=DAILY", [], ["ORGANIZER:mailto:boss@example.com"]);
    expect(failure(instance({ start: "2030-10-21 14:00", end: "15:00" }, invited)).message).toMatch(
      /only the organizer/,
    );
    unwrap(instance({ summary: "text is fine" }, invited));
  });
});

describe("splitSeries", () => {
  const split = (change: object, lines = series(), date = "2030-10-19", env = ENV) =>
    splitSeries(lines, { ...base, scope: "from_date", date, ...change }, "new", NOW, env);

  it("ends the old series before the day and starts the rest as a new series", () => {
    const { original, created } = unwrap(split({ summary: "Sync" }));
    // the last instance before the 19th is the 18th, 09:00 CEST = 07:00Z
    expect(prop(main(original), "RRULE")?.value).toBe("FREQ=DAILY;UNTIL=20301018T070000Z");
    expect(prop(main(original), "SUMMARY")?.value).toBe("Standup");
    expect(prop(main(original), "SEQUENCE")?.value).toBe("1");

    const next = main(created);
    expect(prop(next, "UID")?.value).toBe("new");
    expect(prop(next, "RRULE")?.value).toBe("FREQ=DAILY;COUNT=7");
    expect(prop(next, "SUMMARY")?.value).toBe("Sync");
    expect(prop(next, "SEQUENCE")?.value).toBe("0");
    expect(prop(next, "DTSTART")).toMatchObject({ params: ZONE, value: "20301019T090000" });
    expect(prop(next, "DTEND")?.value).toBe("20301019T093000");
    expect(created).toContain("VERSION:2.0");
    expect(events(created)).toHaveLength(1);
  });

  it("changes the time of day from that day on", () => {
    const { created } = unwrap(split({ start: "2030-10-19 11:00", end: "11:45" }));
    expect(prop(main(created), "DTSTART")?.value).toBe("20301019T110000");
    expect(prop(main(created), "DTEND")?.value).toBe("20301019T114500");
  });

  it("keeps a rule without COUNT as it is, and an UNTIL of the old rule for the new series", () => {
    const open = unwrap(split({ summary: "x" }, series("FREQ=WEEKLY;BYDAY=WE"), "2030-10-23"));
    expect(prop(main(open.created), "RRULE")?.value).toBe("FREQ=WEEKLY;BYDAY=WE");
    const bounded = unwrap(split({ summary: "x" }, series("FREQ=DAILY;UNTIL=20301101T000000Z")));
    expect(prop(main(bounded.created), "RRULE")?.value).toBe("FREQ=DAILY;UNTIL=20301101T000000Z");
    expect(prop(main(bounded.original), "RRULE")?.value).toBe("FREQ=DAILY;UNTIL=20301018T070000Z");
  });

  it("counts every instance of the rule before the day: excluded ones and several per day too", () => {
    const excluded = series("FREQ=DAILY;COUNT=10", [], [`EXDATE${ZONE}:20301017T090000`]);
    expect(prop(main(unwrap(split({ summary: "x" }, excluded)).created), "RRULE")?.value).toBe(
      "FREQ=DAILY;COUNT=7",
    );
    const hourly = series("FREQ=HOURLY;INTERVAL=12;COUNT=10");
    // two instances per day, 16 and 17 Oct and the 18th: 6 before the 19th, 4 left
    expect(prop(main(unwrap(split({ summary: "x" }, hourly)).created), "RRULE")?.value).toBe(
      "FREQ=HOURLY;INTERVAL=12;COUNT=4",
    );
  });

  it("leaves exceptions before the day with the old series", () => {
    const lines = series("FREQ=DAILY;COUNT=10", exception("20301017"));
    const { original, created } = unwrap(split({ summary: "x" }, lines));
    expect(exceptions(original)).toHaveLength(1);
    expect(exceptions(created)).toHaveLength(0);
  });

  it("takes the day in the host zone", () => {
    const ny = series("FREQ=DAILY;COUNT=10").map((l) =>
      l.startsWith("DTSTART")
        ? "DTSTART;TZID=America/New_York:20301101T220000"
        : l.startsWith("DTEND")
          ? "DTEND;TZID=America/New_York:20301101T230000"
          : l,
    );
    // the host day 4 Nov (Berlin) starts with the New York instance of 3 Nov 22:00 (EST)
    const { created } = unwrap(split({ summary: "x" }, ny, "2030-11-04"));
    expect(prop(main(created), "DTSTART")?.value).toBe("20301103T220000");
    // 1 Nov, 2 Nov and 3 Nov 22:00 NY fall on the host days 2, 3 and 4 Nov: two before the 4th
    expect(prop(main(created), "RRULE")?.value).toBe("FREQ=DAILY;COUNT=8");
  });

  it("refuses what would be wrong", () => {
    const message = (r: ReturnType<typeof split>) => failure(r).message;
    expect(message(split({ summary: "x" }, series(), "2030-10-16"))).toMatch(/first occurrence/);
    expect(message(split({ summary: "x" }, series(), "2030-10-01"))).toMatch(/first occurrence/);
    expect(message(split({ start: "2030-10-20 10:00", end: "11:00" }))).toMatch(/not the date/);
    expect(message(split({ summary: "x" }, series("FREQ=DAILY;COUNT=10", exception("20301021"))))).toMatch(
      /exceptions on or after/,
    );
    expect(
      message(split({ summary: "x" }, series("FREQ=DAILY;COUNT=10", [], [`EXDATE${ZONE}:20301025T090000`]))),
    ).toMatch(/exceptions on or after/);
    expect(
      message(split({ summary: "x" }, series("FREQ=DAILY;COUNT=10", [], [`RDATE${ZONE}:20301025T090000`]))),
    ).toMatch(/exceptions on or after/);
    expect(message(split({ summary: "x" }, series("FREQ=DAILY;COUNT=3")))).toMatch(/no occurrences left/);
    expect(
      message(
        split(
          { summary: "x" },
          series().filter((l) => !l.startsWith("RRULE")),
        ),
      ),
    ).toMatch(/not a recurring event/);
    expect(message(split({}))).toMatch(/nothing to change/);
    expect(
      message(
        split(
          { summary: "x" },
          series().filter((l) => !l.startsWith("DTSTART")),
        ),
      ),
    ).toMatch(/not a recurring event/);
    expect(message(split({ summary: "x" }, ["BEGIN:VCALENDAR", "END:VCALENDAR"]))).toMatch(/no main event/);
    expect(
      message(
        split(
          { summary: "x" },
          series().map((l) => (l.startsWith("DTSTART") ? "DTSTART:soon" : l)),
        ),
      ),
    ).toMatch(/not a recurring event/);
    const zone = series().map((l) => l.replace("Europe/Berlin", "Mars/Base"));
    expect(message(split({ summary: "x" }, zone))).toMatch(/unknown time zone/);
    const invited = series("FREQ=DAILY", [], ["ORGANIZER:mailto:boss@example.com"]);
    expect(message(split({ summary: "x" }, invited))).toMatch(/only the organizer/);
    // a day the rule does not name cannot start a new series
    expect(message(split({ summary: "x" }, series("FREQ=WEEKLY"), "2030-10-18"))).toMatch(
      /repeat rule has no occurrence on that day/,
    );
  });
});

describe("occurrence checks on the stored lines", () => {
  const ny = (rule: string, extra: string[] = []) => ({
    host: "Europe/Berlin",
    lines: [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:s1",
      "DTSTART;TZID=America/New_York:20301101T220000",
      "DTEND;TZID=America/New_York:20301101T230000",
      `RRULE:${rule}`,
      ...extra,
      "END:VEVENT",
      "END:VCALENDAR",
    ],
  });

  it("lists dates in the host zone, the ones the tools show", () => {
    const { lines, host } = ny("FREQ=DAILY;COUNT=3");
    // 22:00 in New York is already the next day in Berlin
    expect(unwrap(occurrenceDates(lines, "2030-11-01", "2030-12-01", host))).toEqual([
      "2030-11-02",
      "2030-11-03",
      "2030-11-04",
    ]);
  });

  it("honours EXDATE, COUNT and UNTIL", () => {
    const ex = ny("FREQ=DAILY;COUNT=5", ["EXDATE;TZID=America/New_York:20301103T220000"]);
    // the instance of 3 Nov 22:00 New York (EST) is 4 Nov 04:00 in Berlin
    expect(unwrap(occurrenceDates(ex.lines, "2030-11-01", "2030-12-01", ex.host))).toEqual([
      "2030-11-02",
      "2030-11-03",
      "2030-11-05",
      "2030-11-06",
    ]);
    // 22:00 on 2 Nov in New York (EDT, UTC-4) is 02:00Z on 3 Nov: UTC UNTIL is an instant, inclusive
    const until = ny("FREQ=DAILY;UNTIL=20301103T020000Z");
    expect(unwrap(occurrenceDates(until.lines, "2030-11-01", "2030-12-01", until.host))).toEqual([
      "2030-11-02",
      "2030-11-03",
    ]);
    const before = ny("FREQ=DAILY;UNTIL=20301103T015959Z");
    expect(unwrap(occurrenceDates(before.lines, "2030-11-01", "2030-12-01", before.host))).toEqual([
      "2030-11-02",
    ]);
    expect(failure(requireOccurrence(ex.lines, "s1", "2030-11-04", ex.host)).message).toBe(
      "event s1 has no occurrence on 2030-11-04",
    );
    expect(failure(requireOccurrence(ex.lines, "s1", "2030-11-09", ex.host)).message).toMatch(
      /no occurrence/,
    );
    unwrap(requireOccurrence(ex.lines, "s1", "2030-11-03", ex.host));
  });

  it("counts every instance before a day, also the excluded ones", () => {
    const { lines, host } = ny("FREQ=DAILY;COUNT=10", ["EXDATE;TZID=America/New_York:20301102T220000"]);
    expect(unwrap(occurrencesBefore(lines, "2030-11-05", host))).toBe(3);
    expect(unwrap(occurrencesBefore(lines, "2030-11-02", host))).toBe(0);
    expect(unwrap(occurrencesBefore(lines, "2030-10-01", host))).toBe(0);
  });

  it("reports bad input as a failure", () => {
    const empty = ["BEGIN:VCALENDAR", "END:VCALENDAR"];
    expect(failure(occurrenceDates(empty, "2030-11-01", "2030-11-02", "Europe/Berlin")).message).toMatch(
      /no main event/,
    );
    expect(failure(occurrenceDates(series(), "2030-02-30", "2030-12-01", "Europe/Berlin")).message).toMatch(
      /real dates/,
    );
    expect(failure(requireOccurrence(series(), "s1", "2030-02-30", "Europe/Berlin")).message).toMatch(
      /real date/,
    );
    expect(failure(occurrencesBefore(empty, "2030-11-01", "Europe/Berlin")).message).toMatch(/no DTSTART/);
    expect(failure(occurrencesBefore(series(), "2030-11-01", "Mars/Base")).message).toMatch(
      /unknown time zone/,
    );
  });
});

describe("updateEvent with a scope (occurrences come from the stored file)", () => {
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

  const stored = async (name: string) => unfoldLines(await readFile(join(vdir, name), "utf8"));

  it("scope instance writes an exception into the same file", async () => {
    const out = await runOk(
      updateEvent(
        settings(),
        { ...base, scope: "instance", date: "2030-10-20", summary: "Retro" },
        "n1",
        NOW,
      ),
    );
    expect(out).toMatch(/^Updated the occurrence on 2030-10-20 of event s1 in calendar work\./);
    expect(exceptions(await stored("s1.ics"))).toHaveLength(1);
    expect(await readdir(vdir)).toEqual(["s1.ics"]);
  });

  it("scope from_date writes the new series first and ends the old one", async () => {
    const out = await runOk(
      updateEvent(
        settings(),
        { ...base, scope: "from_date", date: "2030-10-19", summary: "Sync" },
        "n1",
        NOW,
      ),
    );
    expect(out).toMatch(/new series with uid n1\./);
    expect((await readdir(vdir)).sort()).toEqual(["n1.ics", "s1.ics"]);
    expect(prop(main(await stored("s1.ics")), "RRULE")?.value).toBe("FREQ=DAILY;UNTIL=20301018T070000Z");
    const created = await stored("n1.ics");
    expect(prop(main(created), "RRULE")?.value).toBe("FREQ=DAILY;COUNT=7");
    expect(prop(main(created), "UID")?.value).toBe("n1");
    expect(props(main(created), "UID")).toHaveLength(1);
  });

  it("scope from_date counts nothing for a series without COUNT", async () => {
    await writeFile(join(vdir, "s1.ics"), `${series("FREQ=DAILY").join("\r\n")}\r\n`);
    await runOk(
      updateEvent(
        settings(),
        { ...base, scope: "from_date", date: "2030-10-19", summary: "Sync" },
        "n1",
        NOW,
      ),
    );
    expect(prop(main(await stored("n1.ics")), "RRULE")?.value).toBe("FREQ=DAILY");
  });

  it("refuses a day that is no occurrence and changes nothing", async () => {
    const before = await readFile(join(vdir, "s1.ics"), "utf8");
    for (const date of ["2030-10-15", "2030-10-26"]) {
      for (const scope of ["instance", "from_date"] as const) {
        const e = await runFail(updateEvent(settings(), { ...base, scope, date, summary: "x" }, "n1", NOW));
        expect(e.message).toBe(`event s1 has no occurrence on ${date}`);
      }
    }
    expect(await readFile(join(vdir, "s1.ics"), "utf8")).toBe(before);
    expect(await readdir(vdir)).toEqual(["s1.ics"]);
  });

  it("refuses an excluded day", async () => {
    const lines = series("FREQ=DAILY;COUNT=10").flatMap((l) =>
      l.startsWith("RRULE") ? [`EXDATE${ZONE}:20301020T090000`, l] : [l],
    );
    await writeFile(join(vdir, "s1.ics"), `${lines.join("\r\n")}\r\n`);
    const e = await runFail(
      updateEvent(settings(), { ...base, scope: "instance", date: "2030-10-20", summary: "x" }, "n1", NOW),
    );
    expect(e.message).toBe("event s1 has no occurrence on 2030-10-20");
  });

  it("checks scope and date before anything else", async () => {
    const message = async (p: object) =>
      (await runFail(updateEvent(settings(), { ...base, summary: "x", ...p }, "n1", NOW))).message;
    expect(await message({ scope: "instance" })).toMatch(/needs the date/);
    expect(await message({ scope: "from_date", date: "20301020" })).toMatch(/real date/);
    expect(await message({ scope: "all", date: "2030-10-20" })).toMatch(/only for scope/);
    expect(await message({ date: "2030-10-20" })).toMatch(/only for scope/);
  });
});
