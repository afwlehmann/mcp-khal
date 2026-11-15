import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  occurrenceDates,
  occurrencesBefore,
  requireOccurrence,
  seriesInfo,
  splitSeries,
  updateEvent,
  updateInstance,
} from "./editEvent.js";
import { events, isMaster, prop, unfoldLines } from "./ics.js";
import { failure, removeDir, runFail, runOk, tempDir, testSettings, unwrap } from "./testlib.js";

const NOW = new Date("2030-01-01T10:00:00Z");
const ZONE = ";TZID=Europe/Berlin";

const series = (rule = "FREQ=DAILY;COUNT=10", extra: string[] = []): string[] => [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "UID:s1",
  "SUMMARY:Standup",
  `DTSTART${ZONE}:20301016T090000`,
  `DTEND${ZONE}:20301016T093000`,
  `RRULE:${rule}`,
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
  const instance = (change: object, lines = series()) =>
    updateInstance(lines, { ...base, scope: "instance", date: "2030-10-20", ...change }, NOW);

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
    expect(prop(only ?? [], "SEQUENCE")?.value).toBe("1");
    expect(main(out)).toEqual(main(series()));
    expect(out.at(-1)).toBe("END:VCALENDAR");
  });

  it("moves just that occurrence, to any day, keeping its RECURRENCE-ID", () => {
    const [only] = exceptions(unwrap(instance({ start: "2030-10-21 14:00", end: "15:00" })));
    expect(prop(only ?? [], "RECURRENCE-ID")?.value).toBe("20301020T090000");
    expect(prop(only ?? [], "DTSTART")).toMatchObject({ params: ZONE, value: "20301021T140000" });
    expect(prop(only ?? [], "DTEND")?.value).toBe("20301021T150000");
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

  it("changes an exception that exists instead of adding another", () => {
    const first = unwrap(instance({ summary: "Retro" }));
    const second = unwrap(instance({ location: "Hall" }, first));
    expect(exceptions(second)).toHaveLength(1);
    const [only] = exceptions(second);
    expect(prop(only ?? [], "SUMMARY")?.value).toBe("Retro");
    expect(prop(only ?? [], "LOCATION")?.value).toBe("Hall");
    expect(prop(only ?? [], "SEQUENCE")?.value).toBe("2");
    // an exception of another day is not touched
    const other = series("FREQ=DAILY", exception("20301022"));
    const changed = unwrap(instance({ summary: "Retro" }, other));
    expect(exceptions(changed).map((e) => prop(e, "SUMMARY")?.value)).toEqual(["Special", "Retro"]);
  });

  it("refuses what it cannot do", () => {
    const plain = series().filter((l) => !l.startsWith("RRULE"));
    expect(failure(instance({ summary: "x" }, plain)).message).toMatch(/not a recurring event/);
    expect(
      failure(updateInstance(series(), { ...base, scope: "instance", summary: "x" }, NOW)).message,
    ).toMatch(/needs the date/);
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
  });
});

describe("splitSeries", () => {
  const split = (change: object, lines = series(), before: number | undefined = 3, date = "2030-10-19") =>
    splitSeries(lines, { ...base, scope: "from_date", date, ...change }, "new@mcp-khal", NOW, before);

  it("ends the old series before the day and starts the rest as a new series", () => {
    const { original, created } = unwrap(split({ summary: "Sync" }));
    expect(prop(main(original), "RRULE")?.value).toBe("FREQ=DAILY;UNTIL=20301019T065959Z");
    expect(prop(main(original), "SUMMARY")?.value).toBe("Standup");
    expect(prop(main(original), "SEQUENCE")?.value).toBe("1");

    const next = main(created);
    expect(prop(next, "UID")?.value).toBe("new@mcp-khal");
    expect(prop(next, "RRULE")?.value).toBe("FREQ=DAILY;COUNT=7");
    expect(prop(next, "SUMMARY")?.value).toBe("Sync");
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
    const open = unwrap(split({ summary: "x" }, series("FREQ=WEEKLY;BYDAY=WE"), undefined, "2030-10-23"));
    expect(prop(main(open.created), "RRULE")?.value).toBe("FREQ=WEEKLY;BYDAY=WE");
    const bounded = unwrap(split({ summary: "x" }, series("FREQ=DAILY;UNTIL=20301101T000000Z"), undefined));
    expect(prop(main(bounded.created), "RRULE")?.value).toBe("FREQ=DAILY;UNTIL=20301101T000000Z");
    expect(prop(main(bounded.original), "RRULE")?.value).toBe("FREQ=DAILY;UNTIL=20301019T065959Z");
  });

  it("leaves exceptions before the day with the old series", () => {
    const lines = series("FREQ=DAILY;COUNT=10", exception("20301017"));
    const { original, created } = unwrap(split({ summary: "x" }, lines));
    expect(exceptions(original)).toHaveLength(1);
    expect(exceptions(created)).toHaveLength(0);
  });

  it("refuses what would be wrong", () => {
    const message = (r: ReturnType<typeof split>) => failure(r).message;
    expect(message(split({ summary: "x" }, series(), 3, "2030-10-16"))).toMatch(/first occurrence/);
    expect(message(split({ summary: "x" }, series(), 3, "2030-10-01"))).toMatch(/first occurrence/);
    expect(message(split({ start: "2030-10-20 10:00", end: "11:00" }))).toMatch(/not the date/);
    expect(message(split({ summary: "x" }, series("FREQ=DAILY;COUNT=10", exception("20301021"))))).toMatch(
      /exceptions on or after/,
    );
    expect(
      message(
        split(
          { summary: "x" },
          series("FREQ=DAILY;COUNT=10", [])
            .map((l) => (l.startsWith("RRULE") ? "EXDATE:20301025T090000\nRRULE:FREQ=DAILY;COUNT=10" : l))
            .flatMap((l) => l.split("\n")),
        ),
      ),
    ).toMatch(/exceptions on or after/);
    expect(message(split({ summary: "x" }, series(), 10))).toMatch(/no occurrences left/);
    expect(
      message(
        split(
          { summary: "x" },
          series().filter((l) => !l.startsWith("RRULE")),
        ),
      ),
    ).toMatch(/not a recurring event/);
    expect(message(split({}))).toMatch(/nothing to change/);
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
  });
});

describe("seriesInfo", () => {
  it("reports COUNT and the first day", () => {
    expect(unwrap(seriesInfo(series()))).toEqual({ count: 10, startIso: "2030-10-16" });
    expect(unwrap(seriesInfo(series("FREQ=DAILY")))).toEqual({ count: undefined, startIso: "2030-10-16" });
  });

  it("refuses a plain event and a file without events", () => {
    expect(failure(seriesInfo(series().filter((l) => !l.startsWith("RRULE")))).message).toMatch(
      /not a recurring/,
    );
    expect(failure(seriesInfo(["BEGIN:VCALENDAR", "END:VCALENDAR"])).message).toMatch(/no main event/);
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

  it("lists dates in the zone of the event, not of the host", () => {
    const { lines, host } = ny("FREQ=DAILY;COUNT=3");
    // 22:00 in New York is already the next day in Berlin
    expect(unwrap(occurrenceDates(lines, "2030-11-01", "2030-12-01", host))).toEqual([
      "2030-11-01",
      "2030-11-02",
      "2030-11-03",
    ]);
  });

  it("honours EXDATE, COUNT and UNTIL", () => {
    const ex = ny("FREQ=DAILY;COUNT=5", ["EXDATE;TZID=America/New_York:20301103T220000"]);
    expect(unwrap(occurrenceDates(ex.lines, "2030-11-01", "2030-12-01", ex.host))).toEqual([
      "2030-11-01",
      "2030-11-02",
      "2030-11-04",
      "2030-11-05",
    ]);
    // 22:00 on 2 Nov in New York (EDT, UTC-4) is 02:00Z on 3 Nov: UTC UNTIL is an instant, inclusive
    const until = ny("FREQ=DAILY;UNTIL=20301103T020000Z");
    expect(unwrap(occurrenceDates(until.lines, "2030-11-01", "2030-12-01", until.host))).toEqual([
      "2030-11-01",
      "2030-11-02",
    ]);
    const before = ny("FREQ=DAILY;UNTIL=20301103T015959Z");
    expect(unwrap(occurrenceDates(before.lines, "2030-11-01", "2030-12-01", before.host))).toEqual([
      "2030-11-01",
    ]);
    // 23:59:59Z on 2 Nov is only 19:59:59 in New York, before the 22:00 occurrence of that day
    const early = ny("FREQ=DAILY;UNTIL=20301102T235959Z");
    expect(unwrap(occurrenceDates(early.lines, "2030-11-01", "2030-12-01", early.host))).toEqual([
      "2030-11-01",
    ]);
    expect(failure(requireOccurrence(ex.lines, "s1", "2030-11-03", ex.host)).message).toBe(
      "event s1 has no occurrence on 2030-11-03",
    );
    expect(failure(requireOccurrence(ex.lines, "s1", "2030-11-06", ex.host)).message).toMatch(
      /no occurrence/,
    );
    unwrap(requireOccurrence(ex.lines, "s1", "2030-11-02", ex.host));
  });

  it("keeps the local time across the DST change of New York (3 Nov 2030)", () => {
    const { lines, host } = ny("FREQ=DAILY;COUNT=5");
    unwrap(requireOccurrence(lines, "s1", "2030-11-03", host));
    unwrap(requireOccurrence(lines, "s1", "2030-11-04", host));
    expect(unwrap(occurrencesBefore(lines, "2030-11-01", "2030-11-04", host))).toBe(3);
  });

  it("counts occurrences before a date, honouring EXDATE", () => {
    const { lines, host } = ny("FREQ=DAILY;COUNT=10", ["EXDATE;TZID=America/New_York:20301102T220000"]);
    expect(unwrap(occurrencesBefore(lines, "2030-11-01", "2030-11-05", host))).toBe(3);
    expect(unwrap(occurrencesBefore(lines, "2030-11-05", "2030-11-05", host))).toBe(0);
  });

  it("reports bad input as a failure", () => {
    const empty = ["BEGIN:VCALENDAR", "END:VCALENDAR"];
    expect(failure(occurrenceDates(empty, "2030-11-01", "2030-11-02", "Europe/Berlin")).message).toMatch(
      /no main event/,
    );
    expect(failure(occurrenceDates(series(), "2030-02-30", "2030-12-01", "Europe/Berlin")).message).toMatch(
      /real dates/,
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
    expect(out).toMatch(/new series with uid n1@mcp-khal\./);
    expect((await readdir(vdir)).sort()).toEqual(["n1@mcp-khal.ics", "s1.ics"]);
    expect(prop(main(await stored("s1.ics")), "RRULE")?.value).toBe("FREQ=DAILY;UNTIL=20301019T065959Z");
    const created = await stored("n1@mcp-khal.ics");
    expect(prop(main(created), "RRULE")?.value).toBe("FREQ=DAILY;COUNT=7");
    expect(prop(main(created), "UID")?.value).toBe("n1@mcp-khal");
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
    expect(prop(main(await stored("n1@mcp-khal.ics")), "RRULE")?.value).toBe("FREQ=DAILY");
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
