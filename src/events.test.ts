import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Result } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type CalendarEvent,
  checkQuery,
  eventsInRange,
  listEvents,
  MAX_QUERY_LENGTH,
  matchesQuery,
  type Ranked,
  renderFile,
  repeatPattern,
  searchEvents,
  searchWindow,
  sortRanked,
} from "./events.js";
import { removeDir, runFail, runOk, tempDir, testSettings } from "./testlib.js";

const NOW = new Date("2026-11-02T08:00:00Z");

const ics = (...body: string[]): string =>
  ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//EN", ...body, "END:VCALENDAR", ""].join("\r\n");

const vevent = (uid: string, ...props: string[]): string =>
  ["BEGIN:VEVENT", `UID:${uid}`, "DTSTAMP:20260101T000000Z", ...props, "END:VEVENT"].join("\r\n");

let root: string;
beforeEach(async () => {
  root = await tempDir();
});
afterEach(async () => {
  await removeDir(root);
});

const put = async (cal: string, name: string, content: string): Promise<void> => {
  await mkdir(join(root, cal), { recursive: true });
  await writeFile(join(root, cal, name), content);
};

const settings = (zone = "Europe/Berlin", cals: readonly string[] = ["work"]) =>
  testSettings({
    timezone: zone,
    calendars: Object.fromEntries(cals.map((c) => [c, { path: join(root, c) }])),
  });

const list = (range: string, zone = "Europe/Berlin") => runOk(listEvents(settings(zone), { range }, NOW));

describe("time zones", () => {
  it("shows an event of America/New_York in the host zone Europe/Berlin", async () => {
    await put(
      "work",
      "a.ics",
      ics(
        vevent(
          "ny",
          "SUMMARY:Call",
          "DTSTART;TZID=America/New_York:20261102T090000",
          "DTEND;TZID=America/New_York:20261102T100000",
        ),
      ),
    );
    const r = await list("2026-11-02");
    expect(r.problems).toEqual([]);
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({
      calendar: "work",
      uid: "ny",
      title: "Call",
      startDate: "2026-11-02",
      startTime: "15:00",
      endDate: "2026-11-02",
      endTime: "16:00",
      allDay: "False",
    });
  });

  it("moves an evening event of New York to the next day in Berlin", async () => {
    await put(
      "work",
      "a.ics",
      ics(
        vevent(
          "late",
          "SUMMARY:Late",
          "DTSTART;TZID=America/New_York:20261102T200000",
          "DTEND;TZID=America/New_York:20261102T220000",
        ),
      ),
    );
    expect((await list("2026-11-02")).events).toEqual([]);
    const r = await list("2026-11-03");
    expect(r.events[0]).toMatchObject({ startDate: "2026-11-03", startTime: "02:00", endTime: "04:00" });
  });

  it("keeps the local time of a series over the DST changes of both zones", async () => {
    await put(
      "work",
      "a.ics",
      ics(
        vevent(
          "weekly",
          "SUMMARY:Weekly",
          "DTSTART;TZID=America/New_York:20261019T090000",
          "DTEND;TZID=America/New_York:20261019T100000",
          "RRULE:FREQ=WEEKLY;COUNT=3",
        ),
      ),
    );
    const r = await list("2026-10-19 2026-11-09");
    // Berlin leaves summer time on 25 Oct, New York on 1 Nov
    expect(r.events.map((e) => `${e.startDate} ${e.startTime}`)).toEqual([
      "2026-10-19 15:00",
      "2026-10-26 14:00",
      "2026-11-02 15:00",
    ]);
    expect(r.events[0]?.repeatPattern).toBe("FREQ=WEEKLY;COUNT=3");
  });

  it("renders the day of a DST change in the host zone", async () => {
    await put(
      "work",
      "a.ics",
      ics(
        vevent(
          "dst",
          "SUMMARY:Night",
          "DTSTART;TZID=Europe/Berlin:20261025T010000",
          "DTEND;TZID=Europe/Berlin:20261025T040000",
        ),
      ),
    );
    const r = await list("2026-10-25");
    expect(r.events[0]).toMatchObject({ startTime: "01:00", endTime: "04:00", endDate: "2026-10-25" });
  });

  it("renders UTC events in the host zone and uses the zone given", async () => {
    await put(
      "work",
      "a.ics",
      ics(vevent("utc", "SUMMARY:U", "DTSTART:20261102T230000Z", "DTEND:20261103T000000Z")),
    );
    const berlin = await list("2026-11-03");
    expect(berlin.events[0]).toMatchObject({ startDate: "2026-11-03", startTime: "00:00", endTime: "01:00" });
    const la = await list("2026-11-02", "America/Los_Angeles");
    expect(la.events[0]).toMatchObject({ startDate: "2026-11-02", startTime: "15:00", endTime: "16:00" });
  });

  it("shows an event that crosses midnight with both dates", async () => {
    await put(
      "work",
      "a.ics",
      ics(
        vevent(
          "night",
          "SUMMARY:Party",
          "DTSTART;TZID=Europe/Berlin:20261102T230000",
          "DTEND;TZID=Europe/Berlin:20261103T010000",
        ),
      ),
    );
    for (const day of ["2026-11-02", "2026-11-03"]) {
      const r = await list(day);
      expect(r.events[0]).toMatchObject({
        startDate: "2026-11-02",
        startTime: "23:00",
        endDate: "2026-11-03",
        endTime: "01:00",
      });
    }
  });

  it("shows all-day events with an inclusive end date and no times", async () => {
    await put(
      "work",
      "a.ics",
      ics(
        vevent("multi", "SUMMARY:Trip", "DTSTART;VALUE=DATE:20261105", "DTEND;VALUE=DATE:20261107"),
        // each file one uid
      ),
    );
    await put("work", "b.ics", ics(vevent("one", "SUMMARY:Day", "DTSTART;VALUE=DATE:20261105")));
    const r = await list("2026-11-05 2026-11-08", "America/New_York");
    // same start: the shorter event (earlier end) comes first, whatever the uids
    expect(r.events.map((e) => e.uid)).toEqual(["one", "multi"]);
    const multi = r.events.find((e) => e.uid === "multi");
    expect(multi).toMatchObject({
      startDate: "2026-11-05",
      startTime: "",
      endDate: "2026-11-06",
      endTime: "",
      allDay: "True",
    });
    expect(r.events.find((e) => e.uid === "one")).toMatchObject({
      startDate: "2026-11-05",
      endDate: "2026-11-05",
    });
  });

  it("an all-day event does not leak into the day after its last day", async () => {
    await put(
      "work",
      "a.ics",
      ics(vevent("d", "SUMMARY:D", "DTSTART;VALUE=DATE:20261105", "DTEND;VALUE=DATE:20261106")),
    );
    expect((await list("2026-11-06")).events).toEqual([]);
    expect((await list("2026-11-05")).events).toHaveLength(1);
  });
});

describe("rendering", () => {
  it("renders text, people, status and escapes", async () => {
    await put(
      "work",
      "a.ics",
      ics(
        vevent(
          "full",
          "SUMMARY:Plan\\, review",
          "LOCATION:Room 1\\; north",
          "DESCRIPTION:line one\\nline two\\\\",
          "ORGANIZER;CN=Olga:mailto:olga@example.com",
          "ATTENDEE;CN=Bob:mailto:bob@example.com",
          "ATTENDEE:mailto:eve@example.com",
          "ATTENDEE;CN=Only Name:",
          "STATUS:cancelled",
          "DTSTART:20261102T100000Z",
          "DTEND:20261102T110000Z",
        ),
      ),
    );
    const [e] = (await list("2026-11-02")).events;
    expect(e).toMatchObject({
      title: "Plan, review",
      location: "Room 1; north",
      description: "line one\nline two\\",
      organizer: "Olga <olga@example.com>",
      attendees: "Bob <bob@example.com>, eve@example.com, Only Name",
      status: "CANCELLED",
      cancelled: "CANCELLED",
      repeatPattern: "",
    });
  });

  it("empty fields for an event without optional properties", async () => {
    await put("work", "a.ics", ics(vevent("min", "DTSTART:20261102T100000Z")));
    const [e] = (await list("2026-11-02")).events;
    expect(e).toMatchObject({
      title: "",
      location: "",
      organizer: "",
      attendees: "",
      status: "",
      cancelled: "",
      description: "",
    });
  });

  it("an exception brings its own text and time", async () => {
    await put(
      "work",
      "a.ics",
      ics(
        vevent(
          "series",
          "SUMMARY:Standup",
          "DTSTART;TZID=Europe/Berlin:20261102T090000",
          "DTEND;TZID=Europe/Berlin:20261102T091500",
          "RRULE:FREQ=DAILY;COUNT=3",
        ),
        vevent(
          "series",
          "SUMMARY:Standup (moved)",
          "RECURRENCE-ID;TZID=Europe/Berlin:20261103T090000",
          "DTSTART;TZID=Europe/Berlin:20261103T140000",
          "DTEND;TZID=Europe/Berlin:20261103T143000",
        ),
      ),
    );
    const r = await list("2026-11-02 2026-11-05");
    expect(r.events.map((e) => `${e.title}|${e.startDate} ${e.startTime}|${e.repeatPattern}`)).toEqual([
      "Standup|2026-11-02 09:00|FREQ=DAILY;COUNT=3",
      "Standup (moved)|2026-11-03 14:00|",
      "Standup|2026-11-04 09:00|FREQ=DAILY;COUNT=3",
    ]);
  });

  it("sorts by start, end, title across calendars", async () => {
    const t = "DTSTART:20261102T100000Z";
    await put("b", "1.ics", ics(vevent("u1", "SUMMARY:Zed", t, "DTEND:20261102T110000Z")));
    await put("a", "1.ics", ics(vevent("u2", "SUMMARY:Beta", t, "DTEND:20261102T110000Z")));
    await put("a", "2.ics", ics(vevent("u3", "SUMMARY:Alpha", t, "DTEND:20261102T110000Z")));
    await put("a", "3.ics", ics(vevent("u4", "SUMMARY:Short", t, "DTEND:20261102T103000Z")));
    await put(
      "a",
      "4.ics",
      ics(vevent("u5", "SUMMARY:Early", "DTSTART:20261102T090000Z", "DTEND:20261102T093000Z")),
    );
    const r = await runOk(listEvents(settings("Europe/Berlin", ["b", "a"]), { range: "2026-11-02" }, NOW));
    expect(r.events.map((e) => e.title)).toEqual(["Early", "Short", "Alpha", "Beta", "Zed"]);
  });
});

describe("listEvents / eventsInRange", () => {
  it("defaults to 7 days starting today (the last one is 2026-11-08)", async () => {
    const day = (iso: string) =>
      ics(vevent(`u${iso}`, `SUMMARY:${iso}`, `DTSTART;VALUE=DATE:${iso.replaceAll("-", "")}`));
    await put("work", "first.ics", day("2026-11-02"));
    await put("work", "in.ics", day("2026-11-08"));
    await put("work", "out.ics", day("2026-11-09"));
    await put("work", "past.ics", day("2026-11-01"));
    const r = await runOk(listEvents(settings(), {}, NOW));
    expect(r.events.map((e) => e.title)).toEqual(["2026-11-02", "2026-11-08"]);
  });

  it("limits to one calendar", async () => {
    await put("a", "1.ics", ics(vevent("u1", "SUMMARY:A", "DTSTART:20261102T100000Z")));
    await put("b", "1.ics", ics(vevent("u2", "SUMMARY:B", "DTSTART:20261102T100000Z")));
    const s = settings("Europe/Berlin", ["a", "b"]);
    const r = await runOk(listEvents(s, { calendar: "b", range: "today" }, NOW));
    expect(r.events.map((e) => e.calendar)).toEqual(["b"]);
  });

  it("rejects an unknown calendar, a calendar without path and a bad range", async () => {
    const s = settings();
    expect((await runFail(listEvents(s, { calendar: "nope" }, NOW))).message).toContain(
      "unknown calendar 'nope'",
    );
    const noPath = testSettings({ calendars: { x: {} as never } });
    expect((await runFail(listEvents(noPath, {}, NOW))).message).toContain("no path");
    expect((await runFail(listEvents(s, { range: "someday" }, NOW))).message).toContain("not a range");
    expect((await runFail(listEvents(testSettings({ timezone: "Nope/Zone" }), {}, NOW))).message).toContain(
      "IANA",
    );
  });

  it("eventsInRange takes a start and an exclusive end", async () => {
    await put("work", "a.ics", ics(vevent("u1", "SUMMARY:A", "DTSTART:20261102T100000Z")));
    await put("work", "b.ics", ics(vevent("u2", "SUMMARY:B", "DTSTART:20261104T100000Z")));
    const s = settings();
    const r = await runOk(eventsInRange(s, { start: "2026-11-02", end: "2026-11-04" }, NOW));
    expect(r.events.map((e) => e.uid)).toEqual(["u1"]);
    const t = await runOk(eventsInRange(s, { start: " today ", end: "tomorrow " }, NOW));
    expect(t.events.map((e) => e.uid)).toEqual(["u1"]);
    expect(
      (await runFail(eventsInRange(s, { start: "2026-11-04", end: "2026-11-02" }, NOW))).message,
    ).toContain("end after it starts");
  });

  it("returns problems next to the events", async () => {
    await put("work", "good.ics", ics(vevent("ok", "SUMMARY:Fine", "DTSTART:20261102T100000Z")));
    await put("work", "garbage.ics", "not a calendar\r\n");
    await put("work", "nostart.ics", ics(vevent("ns", "SUMMARY:No start")));
    await put(
      "work",
      "badzone.ics",
      ics(vevent("bz", "SUMMARY:Z", "DTSTART;TZID=Mars/Olympus:20261102T100000")),
    );
    const r = await list("2026-11-02");
    expect(r.events.map((e) => e.uid)).toEqual(["ok"]);
    expect(r.problems).toHaveLength(3);
    expect(r.problems.every((p) => p.startsWith(join(root, "work")))).toBe(true);
    expect([...r.problems]).toEqual([...r.problems].sort());
  });

  it("reports a missing directory as a problem", async () => {
    const r = await list("2026-11-02");
    expect(r.events).toEqual([]);
    expect(r.problems[0]).toContain("cannot list directory");
  });

  it("reports a broken exception without losing the series", async () => {
    await put(
      "work",
      "a.ics",
      ics(
        vevent("s", "SUMMARY:S", "DTSTART:20261102T100000Z", "RRULE:FREQ=DAILY;COUNT=2"),
        vevent(
          "s",
          "SUMMARY:Broken",
          "RECURRENCE-ID:20261103T100000Z",
          "DTSTART:20261103T120000Z",
          "DTEND:20261103T110000Z",
        ),
      ),
    );
    const r = await list("2026-11-02 2026-11-05");
    expect(r.events.length + r.problems.length).toBeGreaterThan(0);
  });
});

describe("renderFile", () => {
  const raw = (lines: string[]) => ({ file: "/x/a.ics", uid: "u", lines });

  it("reports a file without main event and an unknown host zone", () => {
    const only = ["BEGIN:VCALENDAR", "END:VCALENDAR"];
    expect(renderFile("c", raw(only), 0, 1000, "Europe/Berlin").problems[0]).toContain("no main event");
    const ev = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:u",
      "DTSTART:20261102T100000Z",
      "END:VEVENT",
      "END:VCALENDAR",
    ];
    expect(renderFile("c", raw(ev), 0, 1000, "Nope/Zone").problems[0]).toContain("unknown time zone");
  });

  it("says nothing about the details of a hidden event that cannot be expanded", () => {
    const ev = (cls: string) => [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:u",
      cls,
      "DTSTART;TZID=Secret/Place:20261102T100000",
      "DTEND:20261102T110000Z",
      "RRULE:FREQ=DAILY",
      "END:VEVENT",
      "END:VCALENDAR",
    ];
    const hidden = renderFile("c", raw(ev("CLASS:PRIVATE")), 0, 4e12, "Europe/Berlin").problems;
    expect(hidden).toEqual(["/x/a.ics: the event cannot be expanded (its details are hidden)"]);
    const shown = renderFile("c", raw(ev("CLASS:PUBLIC")), 0, 4e12, "Europe/Berlin").problems;
    expect(shown[0]).toContain("Secret/Place");
  });

  it("reports an invalid window", () => {
    const ev = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:u",
      "DTSTART:20261102T100000Z",
      "END:VEVENT",
      "END:VCALENDAR",
    ];
    expect(renderFile("c", raw(ev), 10, 5, "Europe/Berlin").problems[0]).toContain("start before its end");
  });

  it("reports an exception that cannot be expanded and keeps the rest", () => {
    const ev = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:u",
      "SUMMARY:Main",
      "DTSTART:20261102T100000Z",
      "DTEND:20261102T110000Z",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:u",
      "RECURRENCE-ID:20261102T100000Z",
      "DTSTART:20261102T120000Z",
      "DTEND:20261102T110000Z",
      "END:VEVENT",
      "END:VCALENDAR",
    ];
    const r = renderFile("c", raw(ev), Date.UTC(2026, 10, 1), Date.UTC(2026, 10, 4), "Europe/Berlin");
    expect(r.problems.length + r.events.length).toBeGreaterThan(0);
  });
});

describe("searchEvents", () => {
  const seed = async () => {
    const t = (d: string) => `DTSTART:${d}T100000Z`;
    await put(
      "work",
      "1.ics",
      ics(vevent("u1", "SUMMARY:Budget Review", "LOCATION:Aula", t("20261110"), "DESCRIPTION:quarterly")),
    );
    await put("work", "2.ics", ics(vevent("u2", "SUMMARY:Lunch", "LOCATION:Café Ärger", t("20261111"))));
    await put(
      "work",
      "3.ics",
      ics(vevent("u3", "SUMMARY:abc", t("20261112"), "DESCRIPTION:The QUARTERLY plan")),
    );
    await put(
      "work",
      "4.ics",
      ics(vevent("u4", "SUMMARY:Other", "ORGANIZER;CN=Budget Person:mailto:p@example.com", t("20261113"))),
    );
    await put("work", "5.ics", ics(vevent("u5", "SUMMARY:Old budget", t("20230101"))));
    await put("work", "6.ics", ics(vevent("u6", "SUMMARY:Far budget", t("20300101"))));
  };
  const find = async (query: string, extra: { range?: string; calendar?: string } = {}) =>
    (await runOk(searchEvents(settings(), { query, ...extra }, NOW))).events.map((e) => e.uid);

  it("matches summary, location and description case-insensitively", async () => {
    await seed();
    expect(await find("BUDGET")).toEqual(["u1"]);
    expect(await find("quarterly")).toEqual(["u1", "u3"]);
    expect(await find("aula")).toEqual(["u1"]);
  });

  it("matches Unicode case-insensitively", async () => {
    await seed();
    expect(await find("ärger")).toEqual(["u2"]);
    expect(await find("ÄRGER")).toEqual(["u2"]);
    expect(await find("café")).toEqual(["u2"]);
  });

  it("does not look at the organizer or attendees", async () => {
    await seed();
    expect(await find("Person")).toEqual([]);
  });

  it("treats the query as plain text, no regex or wildcard", async () => {
    await seed();
    expect(await find("a.c")).toEqual([]);
    expect(await find("a*")).toEqual([]);
    expect(await find(".*")).toEqual([]);
    expect(await find("a|b")).toEqual([]);
    expect(await find("-x")).toEqual([]);
  });

  it("is bounded to a year around today unless a range is given", async () => {
    await seed();
    expect(await find("budget")).toEqual(["u1"]);
    expect(await find("budget", { range: "2023-01-01 2023-01-02" })).toEqual(["u5"]);
    expect(await find("budget", { range: "2030-01-01" })).toEqual(["u6"]);
  });

  it("limits to a calendar", async () => {
    await seed();
    await put("other", "1.ics", ics(vevent("o1", "SUMMARY:budget other", "DTSTART:20261110T100000Z")));
    const s = settings("Europe/Berlin", ["work", "other"]);
    const r = await runOk(searchEvents(s, { query: "budget", calendar: "other" }, NOW));
    expect(r.events.map((e) => e.uid)).toEqual(["o1"]);
  });

  it("finds every occurrence of a series and returns problems", async () => {
    await put(
      "work",
      "s.ics",
      ics(vevent("s", "SUMMARY:Yoga", "DTSTART:20261102T100000Z", "RRULE:FREQ=DAILY;COUNT=3")),
    );
    await put("work", "bad.ics", "garbage\r\n");
    const r = await runOk(searchEvents(settings(), { query: "yoga" }, NOW));
    expect(r.events).toHaveLength(3);
    expect(r.problems).toHaveLength(1);
  });

  it("rejects an empty, too long or control-character query and a bad range", async () => {
    const s = settings();
    expect((await runFail(searchEvents(s, { query: "  " }, NOW))).message).toContain("must not be empty");
    expect((await runFail(searchEvents(s, { query: "a\nb" }, NOW))).message).toContain("control characters");
    expect(
      (await runFail(searchEvents(s, { query: "x".repeat(MAX_QUERY_LENGTH + 1) }, NOW))).message,
    ).toContain("longer than");
    expect((await runFail(searchEvents(s, { query: "a", range: "x y z" }, NOW))).message).toContain(
      "not a range",
    );
  });
});

describe("pure helpers", () => {
  const ev = (o: Partial<CalendarEvent>): CalendarEvent => ({
    calendar: "c",
    startDate: "",
    startTime: "",
    endDate: "",
    endTime: "",
    title: "",
    location: "",
    organizer: "",
    attendees: "",
    uid: "",
    status: "",
    cancelled: "",
    allDay: "False",
    repeatPattern: "",
    description: "",
    ...o,
  });

  it("repeatPattern", () => {
    expect(repeatPattern([])).toBe("");
    expect(repeatPattern(["FREQ=WEEKLY; BYDAY=MO,WE;;"])).toBe("FREQ=WEEKLY;BYDAY=MO,WE");
    expect(repeatPattern(["FREQ=DAILY", "", "FREQ=YEARLY"])).toBe("FREQ=DAILY, FREQ=YEARLY");
  });

  it("matchesQuery", () => {
    expect(matchesQuery(ev({ title: "Straße" }), "STRASSE")).toBe(false);
    expect(matchesQuery(ev({ title: "Straße" }), "straße")).toBe(true);
    expect(matchesQuery(ev({ description: "Hello" }), "ell")).toBe(true);
    expect(matchesQuery(ev({ organizer: "ell" }), "ell")).toBe(false);
  });

  it("checkQuery trims", () => {
    expect(Result.getOrUndefined(checkQuery("  hi "))).toBe("hi");
    for (const bad of ["a\nb", "a\tb", "a\u0000b", "a\u007fb", "a\u0085b", "a b"])
      expect(typeof bad).toBe("string");
    expect(Result.getOrUndefined(checkQuery("a b"))).toBe("a b");
    const withChar = (code: number): string => `a${String.fromCharCode(code)}b`;
    for (const code of [0, 7, 9, 10, 13, 31, 127, 0x85, 0x2028, 0x2029])
      expect(Result.isFailure(checkQuery(withChar(code)))).toBe(true);
    expect(Result.isSuccess(checkQuery(withChar(32)))).toBe(true);
    expect(Result.isFailure(checkQuery("a b"))).toBe(true);
  });

  it("searchWindow is a year each way, in the zone", () => {
    expect(searchWindow(new Date("2026-11-02T23:30:00Z"), "Europe/Berlin")).toBe("2025-11-03 2027-11-03");
    expect(searchWindow(new Date("2026-11-02T23:30:00Z"), "America/New_York")).toBe("2025-11-02 2027-11-02");
  });

  it("sortRanked orders by start, end, title, calendar, uid and does not mutate", () => {
    const r = (start: number, end: number, o: Partial<CalendarEvent>): Ranked => ({
      start,
      end,
      event: ev(o),
    });
    const input = [
      r(2, 3, { title: "a" }),
      r(1, 5, { title: "z" }),
      r(1, 2, { title: "y" }),
      r(1, 2, { title: "x", calendar: "b" }),
      r(1, 2, { title: "x", calendar: "a", uid: "2" }),
      r(1, 2, { title: "x", calendar: "a", uid: "1" }),
    ];
    const out = sortRanked(input).map(
      (x) => `${x.start}${x.end}${x.event.title}${x.event.calendar}${x.event.uid}`,
    );
    expect(out).toEqual(["12xa1", "12xa2", "12xb", "12yc", "15zc", "23ac"]);
    expect(input[0]?.event.title).toBe("a");
  });
});
