import { describe, expect, it } from "vitest";
import { type EditEnv, splitSeries, type UpdateParams, updateInstance, updateLines } from "../editEvent.js";
import { endSeriesLines } from "../endSeries.js";
import { events, isMaster, prop, props } from "../ics.js";
import { failure, itReq, unwrap } from "../testlib.js";

// Editing rules: times in the host zone, exceptions (RECURRENCE-ID), ending and splitting a series
// (UNTIL, COUNT, RDATE, EXDATE), and what a rewrite must keep of the zone handling.

const NOW = new Date("2026-11-14T10:15:00Z");
const ENV: EditEnv = { hostZone: "Europe/Berlin", me: "me@example.com" };
const base = { calendar: "work", uid: "u" };

const calendar = (...inner: string[][]): string[] => [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//test//EN",
  ...inner.flat(),
  "END:VCALENDAR",
];
const vevent = (...inner: string[]): string[] => ["BEGIN:VEVENT", ...inner, "END:VEVENT"];

/** A weekly series on Fridays starting 2026-11-20 10:00, in the form given by `start` and `end`. */
const weekly = (start: string, end: string, inner: string[] = [], rule = "FREQ=WEEKLY"): string[] =>
  calendar(vevent("UID:u", "DTSTAMP:20261101T000000Z", start, end, `RRULE:${rule}`, ...inner));

const BERLIN = ";TZID=Europe/Berlin";
const zoned = (inner: string[] = [], rule?: string) =>
  weekly(`DTSTART${BERLIN}:20261120T100000`, `DTEND${BERLIN}:20261120T110000`, inner, rule);
const utc = (inner: string[] = []) => weekly("DTSTART:20261120T100000Z", "DTEND:20261120T110000Z", inner);
const floating = (inner: string[] = []) => weekly("DTSTART:20261120T100000", "DTEND:20261120T110000", inner);
const allDay = (inner: string[] = []) =>
  weekly("DTSTART;VALUE=DATE:20261120", "DTEND;VALUE=DATE:20261121", inner);

const master = (lines: readonly string[]) => events(lines).find(isMaster) ?? [];
const rrule = (lines: readonly string[]) => prop(master(lines), "RRULE")?.value;
const end = (lines: readonly string[], lastDate: string, env = ENV) =>
  endSeriesLines(lines, { ...base, lastDate }, NOW, env);
const update = (lines: readonly string[], p: Partial<UpdateParams>, env = ENV) =>
  updateLines(lines, { ...base, ...p }, NOW, env);
const instance = (lines: readonly string[], date: string, p: Partial<UpdateParams> = { summary: "One" }) =>
  updateInstance(lines, { ...base, scope: "instance", date, ...p }, NOW, ENV);
const exceptionOf = (lines: readonly string[]) => events(lines).filter((e) => !isMaster(e))[0] ?? [];

describe("the UNTIL that ends a series has the type of DTSTART", () => {
  itReq(
    [
      "RFC5545:3.3.10:until-same-value-type",
      "RFC5545:3.3.10:until-same-type-as-dtstart",
      "RFC5545:3.8.4.4:truncate-with-until",
      "RFC5545:3.8.4.4:end-series-by-truncating-rule",
    ],
    "an all-day series ends with a DATE: DTSTART 20261120 and last day 2026-12-04 give UNTIL=20261204",
    () => {
      expect(rrule(unwrap(end(allDay(), "2026-12-04")))).toBe("FREQ=WEEKLY;UNTIL=20261204");
    },
  );

  itReq(
    ["RFC5545:3.3.10:until-floating-dtstart", "RFC5545:3.3.10:until-floating-for-local-dtstart"],
    "a floating series ends with a floating UNTIL (no Z)",
    () => {
      expect(rrule(unwrap(end(floating(), "2026-12-04")))).toBe("FREQ=WEEKLY;UNTIL=20261204T100000");
    },
  );

  itReq(
    [
      "RFC5545:3.3.10:until-utc-for-utc-or-tzid",
      "RFC5545:3.3.10:until-utc-for-utc-or-tzid-dtstart",
      "RFC5545:3.3.10:until-datetime-is-utc",
      "RFC5545:3.3.10:until-datetime-in-utc",
    ],
    "a series with a TZID ends with a UTC UNTIL converted with the offset of that day (Berlin, winter: +01:00)",
    () => {
      expect(rrule(unwrap(end(zoned(), "2026-12-04")))).toBe("FREQ=WEEKLY;UNTIL=20261204T090000Z");
    },
  );

  itReq(
    ["RFC5545:3.3.10:until-utc-for-utc-or-tzid", "RFC5545:3.3.10:until-utc-for-utc-or-tzid-dtstart"],
    "a UTC series ends with a UTC UNTIL",
    () => {
      expect(rrule(unwrap(end(utc(), "2026-12-04")))).toBe("FREQ=WEEKLY;UNTIL=20261204T100000Z");
    },
  );

  itReq(
    ["RFC5545:3.3.10:until-count-exclusive", "RFC5545:3.3.10:count-and-until-exclusive"],
    "ending a COUNT series replaces COUNT by UNTIL, never both",
    () => {
      const out = unwrap(end(zoned([], "FREQ=DAILY;COUNT=40"), "2026-12-04"));
      expect(rrule(out)).toBe("FREQ=DAILY;UNTIL=20261204T090000Z");
      expect(rrule(out)).not.toMatch(/COUNT/);
      const bounded = unwrap(end(zoned([], "FREQ=DAILY;UNTIL=20270101T000000Z"), "2026-12-04"));
      expect(rrule(bounded)).toBe("FREQ=DAILY;UNTIL=20261204T090000Z");
    },
  );

  itReq(
    "RFC5545:3.3.10:freq-first-accept-any-order",
    "an edited RRULE starts with FREQ even when it was written in another order",
    () => {
      const out = unwrap(end(zoned([], "COUNT=10;BYDAY=FR;FREQ=WEEKLY"), "2026-11-27"));
      expect(rrule(out)).toBe("FREQ=WEEKLY;BYDAY=FR;UNTIL=20261127T090000Z");
    },
  );

  itReq(
    "RFC5545:3.3.10:rdate-after-until",
    "RDATE entries after the end are removed with it; earlier ones stay",
    () => {
      const out = unwrap(
        end(zoned(["RDATE:20261125T120000Z,20270105T100000Z", "EXDATE:20270112T100000Z"]), "2026-12-05"),
      );
      expect(props(master(out), "RDATE").map((p) => p.value)).toEqual(["20261125T120000Z"]);
      expect(props(master(out), "EXDATE")).toEqual([]);
    },
  );

  itReq(
    "POLICY:end-series-truncate-rrule",
    "ending a weekly series drops EXDATEs and exceptions after the end and keeps the earlier ones",
    () => {
      const exception = (rid: string) =>
        vevent("UID:u", `RECURRENCE-ID${BERLIN}:${rid}`, `DTSTART${BERLIN}:${rid}`, "SUMMARY:Special");
      const lines = calendar(
        vevent(
          "UID:u",
          `DTSTART${BERLIN}:20261120T100000`,
          "RRULE:FREQ=WEEKLY;COUNT=20",
          `EXDATE${BERLIN}:20261127T100000,20261218T100000`,
        ),
        exception("20261204T100000"),
        exception("20261225T100000"),
      );
      const out = unwrap(end(lines, "2026-12-05"));
      expect(rrule(out)).toBe("FREQ=WEEKLY;UNTIL=20261204T090000Z");
      expect(prop(master(out), "EXDATE")?.value).toBe("20261127T100000");
      expect(
        events(out)
          .filter((e) => !isMaster(e))
          .map((e) => prop(e, "RECURRENCE-ID")?.value),
      ).toEqual(["20261204T100000"]);
    },
  );

  it("tolerates Windows time zone names without a VTIMEZONE when ending a series", () => {
    const lines = weekly(
      "DTSTART;TZID=W. Europe Standard Time:20261120T100000",
      "DTEND;TZID=W. Europe Standard Time:20261120T110000",
    );
    expect(rrule(unwrap(end(lines, "2026-12-04")))).toBe("FREQ=WEEKLY;UNTIL=20261204T090000Z");
  });

  it("uses the VTIMEZONE of the file before the IANA zone of the same name", () => {
    const vtimezone = [
      "BEGIN:VTIMEZONE",
      "TZID:Europe/Berlin",
      "BEGIN:STANDARD",
      "DTSTART:19700101T000000",
      "TZOFFSETFROM:+0500",
      "TZOFFSETTO:+0500",
      "END:STANDARD",
      "END:VTIMEZONE",
    ];
    const lines = calendar(
      vtimezone,
      vevent("UID:u", `DTSTART${BERLIN}:20261120T100000`, "RRULE:FREQ=WEEKLY"),
    );
    // 10:00 at +05:00 is 05:00Z, not 09:00Z
    expect(rrule(unwrap(end(lines, "2026-12-04", { hostZone: "UTC", me: undefined })))).toBe(
      "FREQ=WEEKLY;UNTIL=20261204T050000Z",
    );
  });

  itReq(
    "RFC5545:3.8.4.4:end-series-by-truncating-rule",
    "the day is the host-zone day shown by list_events, whatever the zone of the series",
    () => {
      // 23:30 in New York (EST) is 05:30 the next morning in Berlin: the instance of NY Fri 20 Nov shows on Sat 21 Nov
      const ny = weekly(
        "DTSTART;TZID=America/New_York:20261120T233000",
        "DTEND;TZID=America/New_York:20261121T003000",
      );
      expect(rrule(unwrap(end(ny, "2026-11-28")))).toBe("FREQ=WEEKLY;UNTIL=20261128T043000Z");
      expect(failure(end(ny, "2026-11-20")).message).toMatch(/before the series starts/);
    },
  );
});

describe("exceptions carry a RECURRENCE-ID of the same type as DTSTART", () => {
  itReq(
    [
      "RFC5545:3.8.4.4:recurrence-id-same-value-type",
      "RFC5545:3.8.4.4:recurrence-id-same-type-as-dtstart",
      "RFC5545:3.8.4.4:recurrence-id-date-is-calendar-date",
      "RFC5545:3.6.1:date-dtstart-date-dtend",
      "RFC5545:3.6.1:date-dtend-must-be-date",
    ],
    "an all-day series gets RECURRENCE-ID;VALUE=DATE:20261127 and a DATE DTEND",
    () => {
      const e = exceptionOf(unwrap(instance(allDay(), "2026-11-27")));
      expect(prop(e, "RECURRENCE-ID")).toMatchObject({ params: ";VALUE=DATE", value: "20261127" });
      expect(prop(e, "DTSTART")).toMatchObject({ params: ";VALUE=DATE", value: "20261127" });
      expect(prop(e, "DTEND")).toMatchObject({ params: ";VALUE=DATE", value: "20261128" });
    },
  );

  itReq(
    ["RFC5545:3.8.4.4:recurrence-id-floating-iff", "RFC5545:3.8.4.4:recurrence-id-local-iff-dtstart-local"],
    "floating gives a floating RECURRENCE-ID, UTC a Z value, a TZID series a TZID value",
    () => {
      expect(prop(exceptionOf(unwrap(instance(floating(), "2026-11-27"))), "RECURRENCE-ID")).toMatchObject({
        params: "",
        value: "20261127T100000",
      });
      expect(prop(exceptionOf(unwrap(instance(utc(), "2026-11-27"))), "RECURRENCE-ID")).toMatchObject({
        params: "",
        value: "20261127T100000Z",
      });
      expect(prop(exceptionOf(unwrap(instance(zoned(), "2026-11-27"))), "RECURRENCE-ID")).toMatchObject({
        params: BERLIN,
        value: "20261127T100000",
      });
    },
  );

  itReq(
    [
      "RFC5545:3.8.4.4:recurrence-id-original-dtstart",
      "RFC5545:3.8.4.4:recurrence-id-friday-to-thursday",
      "RFC5546:3.7.1:recurrence-id-on-renegotiation",
    ],
    "moving the Friday instance to Thursday keeps the Friday start in RECURRENCE-ID and puts Thursday in DTSTART",
    () => {
      const e = exceptionOf(
        unwrap(instance(zoned(), "2026-11-27", { start: "2026-11-26 12:00", end: "13:00" })),
      );
      expect(prop(e, "RECURRENCE-ID")?.value).toBe("20261127T100000");
      expect(prop(e, "DTSTART")?.value).toBe("20261126T120000");
      expect(prop(e, "DTEND")?.value).toBe("20261126T130000");
    },
  );

  itReq(
    "POLICY:match-override-by-recurrence-id-value",
    "an exception whose RECURRENCE-ID is written in another zone is the same instance and is changed, not duplicated",
    () => {
      const lines = calendar(
        vevent("UID:u", "DTSTART:20261120T100000Z", "DTEND:20261120T110000Z", "RRULE:FREQ=WEEKLY"),
        vevent(
          "UID:u",
          `RECURRENCE-ID${BERLIN}:20261127T110000`,
          "DTSTART:20261127T100000Z",
          "DTEND:20261127T110000Z",
          "SUMMARY:Special",
        ),
      );
      const out = unwrap(instance(lines, "2026-11-27", { location: "Hall" }));
      expect(events(out)).toHaveLength(2);
      expect(prop(exceptionOf(out), "LOCATION")?.value).toBe("Hall");
      expect(prop(exceptionOf(out), "RECURRENCE-ID")).toMatchObject({
        params: BERLIN,
        value: "20261127T110000",
      });
    },
  );
});

describe("times are taken in the host zone and written in the form of the event", () => {
  const move = { start: "2026-11-27 12:00", end: "13:00" };

  itReq(
    ["RFC5545:3.2.19:tzid-required-for-local-datetime", "RFC5545:3.3.5:utc-datetime-no-tzid"],
    "a TZID event keeps TZID on DTSTART and DTEND; a UTC event is written in UTC and never gets a TZID",
    () => {
      const plain = events(
        calendar(vevent("UID:u", `DTSTART${BERLIN}:20261120T100000`, `DTEND${BERLIN}:20261120T110000`)),
      )[0];
      const zonedOut = unwrap(
        update(calendar([...(plain ?? [])]), move, { hostZone: "Europe/Berlin", me: undefined }),
      );
      expect(prop(master(zonedOut), "DTSTART")).toMatchObject({ params: BERLIN, value: "20261127T120000" });
      expect(prop(master(zonedOut), "DTEND")).toMatchObject({ params: BERLIN, value: "20261127T130000" });
      const utcOut = unwrap(
        update(calendar(vevent("UID:u", "DTSTART:20261120T100000Z", "DTEND:20261120T110000Z")), move, {
          hostZone: "Europe/Berlin",
          me: undefined,
        }),
      );
      // 12:00 in Berlin (CET) is 11:00Z
      expect(prop(master(utcOut), "DTSTART")).toMatchObject({ params: "", value: "20261127T110000Z" });
      expect(prop(master(utcOut), "DTEND")).toMatchObject({ params: "", value: "20261127T120000Z" });
    },
  );

  itReq(
    ["RFC5545:3.6.1:dtend-duration-exclusive", "RFC5545:3.6.1:dtend-xor-duration"],
    "a new end replaces DURATION: DTEND and DURATION never occur together",
    () => {
      const lines = calendar(vevent("UID:u", `DTSTART${BERLIN}:20261120T100000`, "DURATION:PT1H"));
      const out = master(unwrap(update(lines, move)));
      expect(prop(out, "DTEND")?.value).toBe("20261127T130000");
      expect(prop(out, "DURATION")).toBeUndefined();
    },
  );

  itReq("RFC5545:3.8.2.2:dtend-same-type-and-later", "an end that is not after the start is refused", () => {
    expect(failure(update(zoned(), { start: "2026-11-27 12:00", end: "12:00" })).message).toMatch(
      /end must be after start/,
    );
    expect(failure(update(zoned(), { start: "2026-11-27 12:00", end: "11:00" })).message).toMatch(
      /end must be after start/,
    );
  });

  itReq(
    "RFC5545:3.8.5.3:dtstart-synchronized-with-rule",
    "moving a weekly BYDAY series to a day its rule does not name is refused with a clear message",
    () => {
      const lines = zoned([], "FREQ=WEEKLY;BYDAY=FR");
      // 20 Nov 2026 is a Friday; Thursday 26 Nov breaks BYDAY=FR, Friday 27 Nov keeps it
      expect(failure(update(lines, { start: "2026-11-26 12:00", end: "13:00" })).message).toMatch(
        /does not fit the repeat rule \(FREQ=WEEKLY;BYDAY=FR\)/,
      );
      expect(prop(master(unwrap(update(lines, move))), "DTSTART")?.value).toBe("20261127T120000");
    },
  );

  it("moves a Berlin event given in the host zone New York into the zone of the event", () => {
    const lines = zoned();
    const out = master(
      unwrap(
        update(
          lines,
          { start: "2026-11-27 04:00", end: "05:00" },
          { hostZone: "America/New_York", me: undefined },
        ),
      ),
    );
    // 04:00 in New York (EST) is 10:00 in Berlin (CET)
    expect(prop(out, "DTSTART")?.value).toBe("20261127T100000");
    expect(prop(out, "DTEND")?.value).toBe("20261127T110000");
  });

  it("tolerates lowercase property names and edits them in place", () => {
    const lines = calendar(vevent("UID:u", "summary:Old", "dtstart:20261120T100000Z"));
    const out = unwrap(update(lines, { summary: "New" }));
    expect(out).toContain("SUMMARY:New");
    expect(out.some((l) => l === "summary:Old")).toBe(false);
  });
});

describe("splitting a series", () => {
  const split = (lines: readonly string[], date: string, p: Partial<UpdateParams> = { summary: "Later" }) =>
    unwrap(splitSeries(lines, { ...base, scope: "from_date", date, ...p }, "n@mcp-khal", NOW, ENV));

  itReq(
    ["RFC5545:3.8.7.4:sequence-initial-zero", "RFC5545:3.8.7.4:sequence-created-zero"],
    "the new series starts at SEQUENCE:0, not 1",
    () => {
      const lines = zoned(["SEQUENCE:7"]);
      const { created } = split(lines, "2026-12-04");
      expect(prop(master(created), "SEQUENCE")?.value).toBe("0");
      expect(prop(master(created), "UID")?.value).toBe("n@mcp-khal");
    },
  );

  itReq(
    ["RFC5545:3.3.10:until-datetime-in-utc", "RFC5545:3.8.4.4:end-series-by-truncating-rule"],
    "the old part ends with its last instance before the day, as a UTC UNTIL, and COUNT is split by every instance before the day",
    () => {
      const { original, created } = split(zoned([], "FREQ=WEEKLY;COUNT=10"), "2026-12-04");
      expect(rrule(original)).toBe("FREQ=WEEKLY;UNTIL=20261127T090000Z");
      // 20 Nov and 27 Nov come before 4 Dec: 8 of 10 are left
      expect(rrule(created)).toBe("FREQ=WEEKLY;COUNT=8");
      expect(prop(master(created), "DTSTART")?.value).toBe("20261204T100000");
    },
  );

  it("counts the excluded instances before the day too (COUNT counts what EXDATE removes)", () => {
    const { created } = split(
      zoned([`EXDATE${BERLIN}:20261127T100000`], "FREQ=WEEKLY;COUNT=10"),
      "2026-12-04",
    );
    expect(rrule(created)).toBe("FREQ=WEEKLY;COUNT=8");
  });

  it("never writes a THISANDPRIOR or THISANDFUTURE range", () => {
    const { original, created } = split(zoned(), "2026-12-04");
    for (const out of [original, created]) expect(out.some((l) => /RANGE=/i.test(l))).toBe(false);
  });
});
