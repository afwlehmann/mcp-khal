import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { endSeries, endSeriesLines } from "./endSeries.js";
import { events, isMaster, prop, unfoldLines } from "./ics.js";
import { failure, fakeKhal, removeDir, runFail, runOk, tempDir, unwrap } from "./testlib.js";

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
  "SUMMARY:Special",
  "END:VEVENT",
];

const base = { calendar: "work", uid: "s1" };
const main = (lines: readonly string[]) => events(lines).find(isMaster) ?? [];

describe("endSeriesLines", () => {
  const end = (lastDate: string, lines = series()) => endSeriesLines(lines, { ...base, lastDate }, NOW);

  it("ends the rule one second before the next day, replacing COUNT", () => {
    const out = unwrap(end("2030-10-19"));
    expect(prop(main(out), "RRULE")?.value).toBe("FREQ=DAILY;UNTIL=20301020T065959Z");
    expect(prop(main(out), "SEQUENCE")?.value).toBe("1");
    expect(prop(main(out), "SUMMARY")?.value).toBe("Standup");
  });

  it("drops exceptions after the last day and keeps the others", () => {
    const lines = series("FREQ=DAILY", [...exception("20301018"), ...exception("20301022")]);
    const out = unwrap(end("2030-10-19", lines));
    const kept = events(out).filter((e) => !isMaster(e));
    expect(kept.map((e) => prop(e, "RECURRENCE-ID")?.value)).toEqual(["20301018T090000"]);
  });

  it("accepts the first occurrence as the last one (a one-day series)", () => {
    expect(prop(main(unwrap(end("2030-10-16"))), "RRULE")?.value).toBe("FREQ=DAILY;UNTIL=20301017T065959Z");
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
});

describe("endSeries", () => {
  let dir: string;
  let vdir: string;
  let cleanups: (() => Promise<void>)[] = [];

  const khalLists = async (days: string[]) => {
    const record = (day: string) =>
      [
        ...["work", day, "09:00", day, "09:30", "Standup", "", "", "", "s1"],
        ...["", "False", "False", "", ""],
      ].join("\u001f");
    const fake = await fakeKhal({ stdout: days.map((d) => `${record(d)}\u001e\n`).join("") });
    cleanups = [...cleanups, fake.cleanup];
    return fake.settings({ calendars: { work: { path: vdir } } });
  };

  beforeEach(async () => {
    dir = await tempDir();
    vdir = join(dir, "work");
    await mkdir(vdir);
    await writeFile(join(vdir, "s1.ics"), `${series().join("\r\n")}\r\n`);
  });
  afterEach(async () => {
    await Promise.all(cleanups.map((c) => c()));
    cleanups = [];
    await removeDir(dir);
  });

  it("ends the series in its file once khal lists the day", async () => {
    const s = await khalLists(["2030-10-19"]);
    const out = await runOk(endSeries(s, { ...base, lastDate: "2030-10-19" }, NOW));
    expect(out).toBe("Ended event s1 in calendar work: its last occurrence is on 2030-10-19.\n");
    const lines = unfoldLines(await readFile(join(vdir, "s1.ics"), "utf8"));
    expect(prop(main(lines), "RRULE")?.value).toBe("FREQ=DAILY;UNTIL=20301020T065959Z");
  });

  it("changes nothing for a day that is no occurrence or an unknown event", async () => {
    const before = await readFile(join(vdir, "s1.ics"), "utf8");
    const s = await khalLists(["2030-10-21"]);
    expect((await runFail(endSeries(s, { ...base, lastDate: "2030-10-19" }, NOW))).message).toBe(
      "event s1 has no occurrence on 2030-10-19",
    );
    expect(
      (await runFail(endSeries(s, { ...base, uid: "nope", lastDate: "2030-10-19" }, NOW))).message,
    ).toMatch(/no event with uid 'nope'/);
    expect(await readFile(join(vdir, "s1.ics"), "utf8")).toBe(before);
  });

  it("rejects a bad date before asking khal anything", async () => {
    const s = await khalLists([]);
    expect((await runFail(endSeries(s, { ...base, lastDate: "20301019" }, NOW))).message).toMatch(
      /real date/,
    );
  });
});
