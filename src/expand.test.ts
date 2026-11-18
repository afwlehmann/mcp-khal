import { Result } from "effect";
import { describe, expect, it } from "vitest";
import {
  hostOccurrenceDatesIn,
  MAX_OCCURRENCES,
  MAX_WALKED,
  occurrenceDatesIn,
  occurrencesIn,
} from "./expand.js";

const BERLIN = "Europe/Berlin";

const ics = (...event: string[]): string[] => [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//test//EN",
  ...event,
  "END:VCALENDAR",
];

/** An event exactly as given (a timed one without DTEND and DURATION has no length, RFC 5545 3.6.1). */
const bare = (...props: string[]): string[] => [
  "BEGIN:VEVENT",
  "UID:u1",
  "DTSTAMP:20260101T000000Z",
  ...props,
  "END:VEVENT",
];

/** Like `bare`, but a timed event without a length gets one hour (most tests do not care about it). */
const vevent = (...props: string[]): string[] => {
  const timed = props.some((p) => p.startsWith("DTSTART") && !p.includes("VALUE=DATE"));
  const sized = props.some((p) => /^(DTEND|DURATION)/.test(p));
  return bare(...props, ...(timed && !sized ? ["DURATION:PT1H"] : []));
};

const dates = (lines: string[], from: string, to: string, host = BERLIN): string[] | string => {
  const r = occurrenceDatesIn(lines, from, to, host);
  return Result.isSuccess(r) ? [...r.success] : r.failure.message;
};

const FAR_FROM = "2000-01-01T00:00:00Z";
const FAR_TO = "2040-01-01T00:00:00Z";

/** `start/end` ISO instants (plus `A` for all-day) of every instance in the window. */
const occ = (lines: string[], from = FAR_FROM, to = FAR_TO, host = BERLIN): string[] | string => {
  const r = occurrencesIn(lines, Date.parse(from), Date.parse(to), host);
  return Result.isSuccess(r)
    ? r.success.map(
        (i) =>
          `${new Date(i.start).toISOString().slice(0, 16)}/${new Date(i.end).toISOString().slice(0, 16)}${i.allDay ? " A" : ""}`,
      )
    : r.failure.message;
};

describe("occurrenceDatesIn", () => {
  it("lists a single event inside and outside the range", () => {
    const l = ics(...vevent("DTSTART:20260310T090000Z", "SUMMARY:x"));
    expect(dates(l, "2026-03-10", "2026-03-11")).toEqual(["2026-03-10"]);
    expect(dates(l, "2026-03-11", "2026-03-12")).toEqual([]);
  });

  it("expands a daily rule with COUNT within the window", () => {
    const l = ics(...vevent("DTSTART;VALUE=DATE:20260301", "RRULE:FREQ=DAILY;COUNT=5"));
    expect(dates(l, "2026-03-02", "2026-03-05")).toEqual(["2026-03-02", "2026-03-03", "2026-03-04"]);
  });

  it("honours EXDATE and RDATE", () => {
    const ex = ics(
      ...vevent("DTSTART:20260301T100000Z", "RRULE:FREQ=DAILY;COUNT=3", "EXDATE:20260302T100000Z"),
    );
    expect(dates(ex, "2026-03-01", "2026-04-01")).toEqual(["2026-03-01", "2026-03-03"]);
    const rd = ics(
      ...vevent("DTSTART:20260301T100000Z", "RRULE:FREQ=WEEKLY;COUNT=1", "RDATE:20260305T100000Z"),
    );
    expect(dates(rd, "2026-03-01", "2026-04-01")).toEqual(["2026-03-01", "2026-03-05"]);
  });

  it("moves an instance with a RECURRENCE-ID exception", () => {
    const l = ics(
      ...vevent("DTSTART:20260301T100000Z", "RRULE:FREQ=DAILY;COUNT=3"),
      ...vevent("RECURRENCE-ID:20260302T100000Z", "DTSTART:20260310T100000Z"),
    );
    expect(dates(l, "2026-03-01", "2026-04-01")).toEqual(["2026-03-01", "2026-03-03", "2026-03-10"]);
  });

  it("keeps the wall-clock date across DST in a time zone", () => {
    const l = ics(...vevent("DTSTART;TZID=Europe/Berlin:20260327T233000", "RRULE:FREQ=DAILY;COUNT=3"));
    expect(dates(l, "2026-03-27", "2026-04-01")).toEqual(["2026-03-27", "2026-03-28", "2026-03-29"]);
  });

  it("dates a floating event in its own wall clock, whatever the host zone", () => {
    const l = ics(...vevent("DTSTART:20260310T233000"));
    expect(dates(l, "2026-03-10", "2026-03-11", "Asia/Kolkata")).toEqual(["2026-03-10"]);
    expect(dates(l, "2026-03-10", "2026-03-11", "America/New_York")).toEqual(["2026-03-10"]);
  });

  it("dates an instant in UTC by its UTC date", () => {
    const l = ics(...vevent("DTSTART:20260310T233000Z"));
    expect(dates(l, "2026-03-10", "2026-03-11", "Asia/Kolkata")).toEqual(["2026-03-10"]);
  });

  it("bounds a rule without end by the window", () => {
    const l = ics(...vevent("DTSTART:20200101T100000Z", "RRULE:FREQ=YEARLY"));
    expect(dates(l, "2030-01-01", "2031-01-01")).toEqual(["2030-01-01"]);
  });

  it("rejects a bad range", () => {
    const l = ics(...vevent("DTSTART:20260310T090000Z"));
    expect(dates(l, "2026-03-10", "2026-03-10")).toMatch(/before the end/);
    expect(dates(l, "x", "2026-03-10")).toMatch(/real dates/);
    expect(dates(l, "2026-02-30", "2026-03-10")).toMatch(/real dates/);
  });

  it("rejects data that is not iCalendar", () => {
    expect(dates(["hello"], "2026-03-10", "2026-03-11")).toMatch(/not valid/);
  });

  it("rejects a file without a main event", () => {
    expect(dates(ics(), "2026-03-10", "2026-03-11")).toMatch(/no main event/);
  });

  it("rejects an unknown host zone", () => {
    const l = ics(...vevent("DTSTART:20260310T090000Z"));
    expect(dates(l, "2026-03-10", "2026-03-11", "Nowhere/Land")).toMatch(/Nowhere\/Land/);
  });

  it("fails instead of running forever", () => {
    const l = ics(...vevent("DTSTART:20260101T000000Z", "RRULE:FREQ=SECONDLY"));
    expect(MAX_OCCURRENCES).toBeGreaterThan(0);
    expect(dates(l, "2027-01-01", "2027-01-02")).toMatch(/too many/);
  });
});

describe("occurrencesIn windows", () => {
  const l = ics(...vevent("DTSTART:20260310T090000Z", "DTEND:20260310T100000Z"));

  it("overlaps half-open: start < to and end > from", () => {
    expect(occ(l, "2026-03-10T09:30:00Z", "2026-03-10T12:00:00Z")).toHaveLength(1);
    expect(occ(l, "2026-03-10T08:00:00Z", "2026-03-10T09:00:01Z")).toHaveLength(1);
    expect(occ(l, "2026-03-10T10:00:00Z", "2026-03-10T11:00:00Z")).toEqual([]);
    expect(occ(l, "2026-03-10T08:00:00Z", "2026-03-10T09:00:00Z")).toEqual([]);
  });

  it("counts an event without length when its start is in the window", () => {
    const z = ics(...bare("DTSTART:20260310T090000Z"));
    expect(occ(z, "2026-03-10T09:00:00Z", "2026-03-10T10:00:00Z")).toEqual([
      "2026-03-10T09:00/2026-03-10T09:00",
    ]);
    expect(occ(z, "2026-03-10T08:00:00Z", "2026-03-10T09:00:00Z")).toEqual([]);
    expect(occ(z, "2026-03-10T09:00:01Z", "2026-03-10T10:00:00Z")).toEqual([]);
  });

  it("rejects an empty or non-finite window", () => {
    expect(occ(l, "2026-03-10T09:00:00Z", "2026-03-10T09:00:00Z")).toMatch(/start before its end/);
    const r = occurrencesIn(l, Number.NaN, 1, BERLIN);
    expect(Result.isFailure(r)).toBe(true);
  });
});

describe("durations", () => {
  it("defaults to no length (timed) and one day (all-day, in the host zone)", () => {
    expect(occ(ics(...bare("DTSTART:20260310T090000Z")))).toEqual(["2026-03-10T09:00/2026-03-10T09:00"]);
    expect(occ(ics(...vevent("DTSTART;VALUE=DATE:20260310")))).toEqual([
      "2026-03-09T23:00/2026-03-10T23:00 A",
    ]);
  });

  it("reads DURATION and DTEND, also for all-day events", () => {
    expect(occ(ics(...vevent("DTSTART:20260310T090000Z", "DURATION:PT90M")))).toEqual([
      "2026-03-10T09:00/2026-03-10T10:30",
    ]);
    expect(
      occ(ics(...vevent("DTSTART;VALUE=DATE:20260310", "DURATION:P2D")), FAR_FROM, FAR_TO, "UTC"),
    ).toEqual(["2026-03-10T00:00/2026-03-12T00:00 A"]);
    expect(
      occ(
        ics(...vevent("DTSTART;VALUE=DATE:20260310", "DTEND;VALUE=DATE:20260313")),
        FAR_FROM,
        FAR_TO,
        "UTC",
      ),
    ).toEqual(["2026-03-10T00:00/2026-03-13T00:00 A"]);
  });

  it("measures an end in another zone as an instant difference", () => {
    const l = ics(
      ...vevent("DTSTART;TZID=Europe/Berlin:20260701T120000", "DTEND;TZID=America/New_York:20260701T080000"),
    );
    expect(occ(l)).toEqual(["2026-07-01T10:00/2026-07-01T12:00"]);
  });

  it("rejects an end before the start and a negative duration", () => {
    expect(occ(ics(...vevent("DTSTART:20260310T090000Z", "DTEND:20260310T080000Z")))).toMatch(/ends before/);
    expect(occ(ics(...vevent("DTSTART;VALUE=DATE:20260310", "DTEND;VALUE=DATE:20260309")))).toMatch(
      /ends before/,
    );
    expect(occ(ics(...vevent("DTSTART:20260310T090000Z", "DURATION:-PT1H")))).toMatch(/negative/);
  });

  it("rejects an event without DTSTART and one with an unreadable value", () => {
    expect(occ(ics(...vevent("SUMMARY:x")))).toMatch(/no DTSTART/);
    expect(
      occ(ics(...vevent("DTSTART:20260310T090000Z", "EXDATE;VALUE=PERIOD:20260310T090000Z/PT1H"))),
    ).toMatch(/PERIOD/);
  });
});

describe("time zones", () => {
  it("reads TZID without VTIMEZONE as the IANA zone, not floating", () => {
    expect(occ(ics(...vevent("DTSTART;TZID=Europe/Berlin:20260701T120000")))).toEqual([
      "2026-07-01T10:00/2026-07-01T11:00",
    ]);
    expect(occ(ics(...vevent("DTSTART;TZID=America/New_York:20260701T120000")))).toEqual([
      "2026-07-01T16:00/2026-07-01T17:00",
    ]);
    expect(occ(ics(...vevent("DTSTART;TZID=Asia/Kolkata:20260701T090000")))).toEqual([
      "2026-07-01T03:30/2026-07-01T04:30",
    ]);
  });

  it("uses the VTIMEZONE of the file", () => {
    const l = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//test//EN",
      "BEGIN:VTIMEZONE",
      "TZID:Custom Zone",
      "BEGIN:STANDARD",
      "DTSTART:19700101T000000",
      "TZOFFSETFROM:+0530",
      "TZOFFSETTO:+0530",
      "END:STANDARD",
      "END:VTIMEZONE",
      ...vevent('DTSTART;TZID="Custom Zone":20260701T090000'),
      "END:VCALENDAR",
    ];
    expect(occ(l)).toEqual(["2026-07-01T03:30/2026-07-01T04:30"]);
  });

  it("maps Windows zone names", () => {
    expect(occ(ics(...vevent("DTSTART;TZID=W. Europe Standard Time:20260701T120000")))).toEqual([
      "2026-07-01T10:00/2026-07-01T11:00",
    ]);
  });

  it("rejects an unknown TZID naming it", () => {
    expect(occ(ics(...vevent("DTSTART;TZID=Mars/Olympus:20260701T120000")))).toMatch(/"Mars\/Olympus"/);
    expect(
      occ(ics(...vevent("DTSTART:20260701T120000Z", "EXDATE;TZID=Mars/Olympus:20260701T120000"))),
    ).toMatch(/Mars\/Olympus/);
  });

  it("places floating events in the host zone", () => {
    const l = ics(...vevent("DTSTART:20260701T120000"));
    expect(occ(l, FAR_FROM, FAR_TO, "America/New_York")).toEqual(["2026-07-01T16:00/2026-07-01T17:00"]);
    expect(occ(l, FAR_FROM, FAR_TO, "Asia/Kolkata")).toEqual(["2026-07-01T06:30/2026-07-01T07:30"]);
  });

  it("keeps the local time of a daily rule across the spring-forward change", () => {
    const l = ics(...vevent("DTSTART;TZID=Europe/Berlin:20260327T093000", "RRULE:FREQ=DAILY;COUNT=4"));
    expect(occ(l)).toEqual([
      "2026-03-27T08:30/2026-03-27T09:30",
      "2026-03-28T08:30/2026-03-28T09:30",
      "2026-03-29T07:30/2026-03-29T08:30",
      "2026-03-30T07:30/2026-03-30T08:30",
    ]);
  });

  it("moves an instance falling into the gap forward", () => {
    const l = ics(...vevent("DTSTART;TZID=Europe/Berlin:20260328T023000", "RRULE:FREQ=DAILY;COUNT=3"));
    expect(occ(l)).toEqual([
      "2026-03-28T01:30/2026-03-28T02:30",
      "2026-03-29T01:30/2026-03-29T02:30",
      "2026-03-30T00:30/2026-03-30T01:30",
    ]);
    expect(dates(l, "2026-03-29", "2026-03-30")).toEqual(["2026-03-29"]);
  });

  it("takes the first occurrence in the fold", () => {
    const l = ics(...vevent("DTSTART;TZID=Europe/Berlin:20261024T023000", "RRULE:FREQ=DAILY;COUNT=3"));
    expect(occ(l)).toEqual([
      "2026-10-24T00:30/2026-10-24T01:30",
      "2026-10-25T00:30/2026-10-25T01:30",
      "2026-10-26T01:30/2026-10-26T02:30",
    ]);
  });

  it("expands in America/New_York across DST", () => {
    const l = ics(...vevent("DTSTART;TZID=America/New_York:20260307T200000", "RRULE:FREQ=DAILY;COUNT=2"));
    expect(occ(l)).toEqual(["2026-03-08T01:00/2026-03-08T02:00", "2026-03-09T00:00/2026-03-09T01:00"]);
  });

  it("expands in a half-hour zone", () => {
    const l = ics(...vevent("DTSTART;TZID=Asia/Kolkata:20260701T090000", "RRULE:FREQ=WEEKLY;COUNT=2"));
    expect(occ(l)).toEqual(["2026-07-01T03:30/2026-07-01T04:30", "2026-07-08T03:30/2026-07-08T04:30"]);
  });

  it("keeps an all-day event as a date in the host zone, across DST", () => {
    const l = ics(...vevent("DTSTART;VALUE=DATE:20260328", "RRULE:FREQ=DAILY;COUNT=3"));
    expect(occ(l)).toEqual([
      "2026-03-27T23:00/2026-03-28T23:00 A",
      "2026-03-28T23:00/2026-03-29T22:00 A",
      "2026-03-29T22:00/2026-03-30T22:00 A",
    ]);
    expect(dates(l, "2026-03-28", "2026-03-31")).toEqual(["2026-03-28", "2026-03-29", "2026-03-30"]);
  });
});

describe("UNTIL", () => {
  const berlin = (until: string): string[] =>
    ics(...vevent("DTSTART;TZID=Europe/Berlin:20260327T090000", `RRULE:FREQ=DAILY;UNTIL=${until}`));

  it("converts a UTC UNTIL to the zone of the event", () => {
    expect(dates(berlin("20260329T070000Z"), "2026-03-01", "2026-05-01")).toEqual([
      "2026-03-27",
      "2026-03-28",
      "2026-03-29",
    ]);
    expect(dates(berlin("20260329T065959Z"), "2026-03-01", "2026-05-01")).toEqual([
      "2026-03-27",
      "2026-03-28",
    ]);
  });

  it("rejects a DATE or floating UNTIL for a series with a TZID (RFC 5545 3.3.10)", () => {
    expect(dates(berlin("20260328"), "2026-03-01", "2026-05-01")).toMatch(/UTC date-time/);
    expect(dates(berlin("20260328T090000"), "2026-03-01", "2026-05-01")).toMatch(/UTC date-time/);
  });

  it("reads a floating UNTIL of a floating series as wall clock", () => {
    const l = ics(...vevent("DTSTART:20260327T090000", "RRULE:FREQ=DAILY;UNTIL=20260328T090000"));
    expect(dates(l, "2026-03-01", "2026-05-01")).toEqual(["2026-03-27", "2026-03-28"]);
  });

  it("handles all-day events with a DATE UNTIL and rejects a date-time one", () => {
    const d = ics(...vevent("DTSTART;VALUE=DATE:20260301", "RRULE:FREQ=DAILY;UNTIL=20260303"));
    expect(dates(d, "2026-03-01", "2026-04-01")).toEqual(["2026-03-01", "2026-03-02", "2026-03-03"]);
    const t = ics(...vevent("DTSTART;VALUE=DATE:20260301", "RRULE:FREQ=DAILY;UNTIL=20260303T120000Z"));
    expect(dates(t, "2026-03-01", "2026-04-01")).toMatch(/UNTIL must be a DATE/);
  });

  it("yields nothing when UNTIL lies before DTSTART", () => {
    expect(dates(berlin("20260101T000000Z"), "2026-01-01", "2026-12-01")).toEqual([]);
  });
});

describe("EXDATE and RDATE", () => {
  const base = (...extra: string[]): string[] =>
    ics(...vevent("DTSTART;TZID=Europe/Berlin:20260327T090000", "RRULE:FREQ=DAILY;COUNT=4", ...extra));

  it("removes an EXDATE given in the zone, in UTC or as several values", () => {
    expect(dates(base("EXDATE;TZID=Europe/Berlin:20260328T090000"), "2026-03-01", "2026-05-01")).toEqual([
      "2026-03-27",
      "2026-03-29",
      "2026-03-30",
    ]);
    expect(dates(base("EXDATE:20260329T070000Z"), "2026-03-01", "2026-05-01")).toEqual([
      "2026-03-27",
      "2026-03-28",
      "2026-03-30",
    ]);
    expect(
      dates(base("EXDATE;TZID=Europe/Berlin:20260328T090000,20260329T090000"), "2026-03-01", "2026-05-01"),
    ).toEqual(["2026-03-27", "2026-03-30"]);
  });

  it("does not remove an instance when only the wall clock matches in another zone", () => {
    expect(
      dates(base("EXDATE;TZID=America/New_York:20260328T090000"), "2026-03-01", "2026-05-01"),
    ).toHaveLength(4);
  });

  it("removes an all-day EXDATE", () => {
    const l = ics(
      ...vevent("DTSTART;VALUE=DATE:20260301", "RRULE:FREQ=DAILY;COUNT=3", "EXDATE;VALUE=DATE:20260302"),
    );
    expect(dates(l, "2026-03-01", "2026-04-01")).toEqual(["2026-03-01", "2026-03-03"]);
  });

  it("adds an RDATE given in the zone, also to a non-recurring event, and dedupes", () => {
    expect(
      occ(
        ics(
          ...vevent(
            "DTSTART;TZID=Europe/Berlin:20260401T090000",
            "RDATE;TZID=Europe/Berlin:20260415T090000",
            "RDATE;TZID=Europe/Berlin:20260401T090000",
          ),
        ),
      ),
    ).toEqual(["2026-04-01T07:00/2026-04-01T08:00", "2026-04-15T07:00/2026-04-15T08:00"]);
  });

  it("reads RDATE with PERIOD values, each with its own length", () => {
    expect(
      occ(
        ics(
          ...vevent(
            "DTSTART:20260401T090000Z",
            "RDATE;VALUE=PERIOD:20260405T090000Z/PT2H,20260406T090000Z/20260406T093000Z",
          ),
        ),
      ),
    ).toEqual([
      "2026-04-01T09:00/2026-04-01T10:00",
      "2026-04-05T09:00/2026-04-05T11:00",
      "2026-04-06T09:00/2026-04-06T09:30",
    ]);
  });

  it("rejects an RDATE PERIOD in an all-day event", () => {
    expect(
      occ(ics(...vevent("DTSTART;VALUE=DATE:20260401", "RDATE;VALUE=PERIOD:20260405T090000Z/PT2H"))),
    ).toMatch(/all-day/);
  });
});

describe("uncovered rule and event checks", () => {
  it("rejects an event with both DTEND and DURATION", () => {
    const l = ics(...bare("DTSTART:20260310T090000Z", "DTEND:20260310T100000Z", "DURATION:PT1H"));
    expect(occ(l)).toMatch(/both DTEND and DURATION/);
  });

  it("rejects BYWEEKNO together with BYMONTHDAY", () => {
    const l = ics(...vevent("DTSTART:20260101T090000Z", "RRULE:FREQ=YEARLY;BYWEEKNO=20;BYMONTHDAY=1"));
    expect(occ(l)).toMatch(/BYWEEKNO together with/);
  });

  it("sorts several days of a BYWEEKNO week", () => {
    const l = ics(...vevent("DTSTART:20260101T090000Z", "RRULE:FREQ=YEARLY;BYWEEKNO=20;BYDAY=MO,TU;COUNT=2"));
    // DTSTART itself is the first instance and counts towards COUNT (RFC 5545 3.8.5.3)
    expect(occ(l)).toEqual(["2026-01-01T09:00/2026-01-01T10:00", "2026-05-11T09:00/2026-05-11T10:00"]);
  });

  it("applies two THISANDFUTURE exceptions in order of their instants", () => {
    const l = ics(
      ...vevent("DTSTART:20260301T090000Z", "RRULE:FREQ=DAILY;COUNT=4"),
      ...vevent(
        "RECURRENCE-ID;RANGE=THISANDFUTURE:20260303T090000Z",
        "DTSTART:20260303T100000Z",
        "DURATION:PT1H",
      ),
      ...vevent(
        "RECURRENCE-ID;RANGE=THISANDFUTURE:20260302T090000Z",
        "DTSTART:20260302T090000Z",
        "DURATION:PT1H",
      ),
    );
    expect(typeof occ(l)).not.toBe("undefined");
  });
});

describe("overrides", () => {
  const master = vevent(
    "DTSTART;TZID=Europe/Berlin:20260327T090000",
    "DTEND;TZID=Europe/Berlin:20260327T100000",
    "RRULE:FREQ=DAILY;COUNT=3",
  );

  it("matches RECURRENCE-ID by instant, given in UTC or in the zone", () => {
    for (const rid of [
      "RECURRENCE-ID:20260328T080000Z",
      "RECURRENCE-ID;TZID=Europe/Berlin:20260328T090000",
    ]) {
      const l = ics(...master, ...vevent(rid, "DTSTART:20260328T120000Z", "DTEND:20260328T130000Z"));
      expect(occ(l)).toEqual([
        "2026-03-27T08:00/2026-03-27T09:00",
        "2026-03-28T12:00/2026-03-28T13:00",
        "2026-03-29T07:00/2026-03-29T08:00",
      ]);
    }
  });

  it("does not replace anything when the RECURRENCE-ID names another instant", () => {
    const l = ics(...master, ...vevent("RECURRENCE-ID:20260328T090000Z", "DTSTART:20260328T120000Z"));
    expect(occ(l)).toHaveLength(4);
  });

  it("shifts later instances with THISANDFUTURE", () => {
    const l = ics(
      ...vevent(
        "DTSTART;TZID=Europe/Berlin:20260327T090000",
        "DTEND;TZID=Europe/Berlin:20260327T100000",
        "RRULE:FREQ=DAILY;COUNT=4",
      ),
      ...vevent(
        "RECURRENCE-ID;RANGE=THISANDFUTURE;TZID=Europe/Berlin:20260328T090000",
        "DTSTART;TZID=Europe/Berlin:20260328T100000",
        "DTEND;TZID=Europe/Berlin:20260328T113000",
      ),
    );
    expect(occ(l)).toEqual([
      "2026-03-27T08:00/2026-03-27T09:00",
      "2026-03-28T09:00/2026-03-28T10:30",
      "2026-03-29T08:00/2026-03-29T09:30",
      "2026-03-30T08:00/2026-03-30T09:30",
    ]);
  });

  it("keeps all-day instances on their date with THISANDFUTURE and changes the length", () => {
    const l = ics(
      ...vevent("DTSTART;VALUE=DATE:20260301", "RRULE:FREQ=DAILY;COUNT=3"),
      ...vevent(
        "RECURRENCE-ID;RANGE=THISANDFUTURE;VALUE=DATE:20260302",
        "DTSTART;VALUE=DATE:20260302",
        "DTEND;VALUE=DATE:20260304",
      ),
    );
    expect(occ(l, FAR_FROM, FAR_TO, "UTC")).toEqual([
      "2026-03-01T00:00/2026-03-02T00:00 A",
      "2026-03-02T00:00/2026-03-04T00:00 A",
      "2026-03-03T00:00/2026-03-05T00:00 A",
    ]);
  });

  it("rejects THISANDPRIOR and an exception without DTSTART", () => {
    expect(
      occ(
        ics(
          ...master,
          ...vevent("RECURRENCE-ID;RANGE=THISANDPRIOR:20260328T080000Z", "DTSTART:20260328T080000Z"),
        ),
      ),
    ).toMatch(/THISANDPRIOR/);
    expect(occ(ics(...master, ...vevent("RECURRENCE-ID:20260328T080000Z")))).toMatch(/no DTSTART/);
  });
});

describe("long series", () => {
  it("skips ahead to the window: instances before it do not count against MAX_OCCURRENCES", () => {
    const l = ics(...vevent("DTSTART:20000101T100000Z", "RRULE:FREQ=DAILY"));
    // 14,620 instances lie before the window, more than MAX_OCCURRENCES
    expect(MAX_OCCURRENCES).toBeLessThan(14_620);
    expect(occ(l, "2040-01-10T00:00:00Z", "2040-01-12T00:00:00Z")).toEqual([
      "2040-01-10T10:00/2040-01-10T11:00",
      "2040-01-11T10:00/2040-01-11T11:00",
    ]);
    expect(dates(l, "2040-01-10", "2040-01-12")).toEqual(["2040-01-10", "2040-01-11"]);
  });

  it("skips ahead for a rule with COUNT, an interval and all-day events", () => {
    const counted = ics(...vevent("DTSTART:19900101T100000Z", "RRULE:FREQ=DAILY;COUNT=20000"));
    expect(occ(counted, "2030-01-01T00:00:00Z", "2030-01-02T00:00:00Z")).toEqual([
      "2030-01-01T10:00/2030-01-01T11:00",
    ]);
    const allDay = ics(...vevent("DTSTART;VALUE=DATE:19900101", "RRULE:FREQ=DAILY"));
    expect(dates(allDay, "2035-05-05", "2035-05-07")).toEqual(["2035-05-05", "2035-05-06"]);
  });

  it("still sees an instance that starts before the window but reaches into it", () => {
    const l = ics(...vevent("DTSTART:20000101T100000Z", "DTEND:20000104T100000Z", "RRULE:FREQ=WEEKLY"));
    // 2000-01-01 and 2039-12-31 are Saturdays (14,609 days = 2,087 weeks apart); the instance lasts three days
    const r = occ(l, "2040-01-01T00:00:00Z", "2040-01-02T00:00:00Z");
    expect(r).toEqual(["2039-12-31T10:00/2040-01-03T10:00"]);
  });

  it("brings an exception far in the future into the window", () => {
    const l = ics(
      ...vevent("DTSTART;TZID=Europe/Berlin:20200101T090000", "RRULE:FREQ=DAILY"),
      ...vevent(
        "RECURRENCE-ID;RANGE=THISANDFUTURE;TZID=Europe/Berlin:20300601T090000",
        "DTSTART;TZID=Europe/Berlin:20300601T100000",
      ),
    );
    expect(occ(l, "2030-06-10T00:00:00Z", "2030-06-11T00:00:00Z")).toEqual([
      "2030-06-10T08:00/2030-06-10T09:00",
    ]);
  });

  it("still guards a rule that produces too many instances in the window", () => {
    const l = ics(...vevent("DTSTART:20270101T000000Z", "RRULE:FREQ=SECONDLY"));
    expect(MAX_OCCURRENCES).toBe(10_000);
    expect(dates(l, "2027-01-01", "2027-01-02")).toMatch(/too many/);
  });

  it("skips years without Feb 29 also when the rule has BYxxx parts", () => {
    const l = ics(...vevent("DTSTART:20240229T100000Z", "RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29"));
    expect(dates(l, "2024-01-01", "2033-01-01")).toEqual(["2024-02-29", "2028-02-29", "2032-02-29"]);
  });

  it("handles a huge INTERVAL on sub-daily rules without walking or overflowing", () => {
    for (const freq of ["MINUTELY", "SECONDLY", "HOURLY"]) {
      const l = ics(...vevent("DTSTART:20260101T000000Z", `RRULE:FREQ=${freq};INTERVAL=2000000000`));
      expect(occ(l, "2026-01-01T00:00:00Z", "2030-01-01T00:00:00Z")).toEqual([
        expect.stringContaining("2026-01-01T"),
      ]);
    }
  });

  it("refuses to walk endlessly towards a distant window", () => {
    expect(MAX_WALKED).toBeGreaterThan(MAX_OCCURRENCES);
    const l = ics(...vevent("DTSTART:20200101T000000Z", "RRULE:FREQ=SECONDLY"));
    expect(occ(l, "2031-01-01T00:00:00Z", "2031-01-02T00:00:00Z")).toMatch(/too many/);
  });
});

describe("UNTIL in UTC is an instant", () => {
  const ny = (until: string): string[] =>
    ics(...vevent("DTSTART;TZID=America/New_York:20301101T220000", `RRULE:FREQ=DAILY;UNTIL=${until}`));

  it("is inclusive and converted with the DST offset of the day (22:00 EDT is 02:00Z)", () => {
    expect(dates(ny("20301103T020000Z"), "2030-11-01", "2030-12-01")).toEqual(["2030-11-01", "2030-11-02"]);
    expect(dates(ny("20301103T015959Z"), "2030-11-01", "2030-12-01")).toEqual(["2030-11-01"]);
    expect(dates(ny("20301102T235959Z"), "2030-11-01", "2030-12-01")).toEqual(["2030-11-01"]);
  });
});

describe("THISANDFUTURE shift", () => {
  const weekly = (...override: string[]): string[] =>
    ics(
      ...vevent("DTSTART;TZID=Europe/Berlin:20260302T090000", "RRULE:FREQ=WEEKLY;COUNT=3"),
      ...vevent(...override),
    );

  it("moves later instances by the days and the time of the exception", () => {
    const l = weekly(
      "RECURRENCE-ID;RANGE=THISANDFUTURE;TZID=Europe/Berlin:20260309T090000",
      "DTSTART;TZID=Europe/Berlin:20260311T100000",
    );
    expect(occ(l)).toEqual([
      "2026-03-02T08:00/2026-03-02T09:00",
      "2026-03-11T09:00/2026-03-11T10:00",
      "2026-03-18T09:00/2026-03-18T10:00",
    ]);
  });

  it("keeps the local time when the exception lies after a DST change", () => {
    const l = ics(
      ...vevent("DTSTART;TZID=Europe/Berlin:20260323T090000", "RRULE:FREQ=WEEKLY;COUNT=3"),
      ...vevent(
        "RECURRENCE-ID;RANGE=THISANDFUTURE;TZID=Europe/Berlin:20260323T090000",
        "DTSTART;TZID=Europe/Berlin:20260330T100000",
      ),
    );
    // Berlin changes to summer time on 29 March: 10:00 stays 10:00 local, 08:00Z
    expect(occ(l)).toEqual([
      "2026-03-30T08:00/2026-03-30T09:00",
      "2026-04-06T08:00/2026-04-06T09:00",
      "2026-04-13T08:00/2026-04-13T09:00",
    ]);
  });

  it("measures the shift in the zone of the exception", () => {
    // the exception is written in UTC (09:00 Berlin is 08:00Z, moved to 10:00Z = one hour later)
    const l = weekly("RECURRENCE-ID;RANGE=THISANDFUTURE:20260309T080000Z", "DTSTART:20260309T090000Z");
    expect(occ(l)).toEqual([
      "2026-03-02T08:00/2026-03-02T09:00",
      "2026-03-09T09:00/2026-03-09T10:00",
      "2026-03-16T09:00/2026-03-16T10:00",
    ]);
  });
});

describe("date-valued EXDATE and RECURRENCE-ID on a timed series", () => {
  const ny = (...extra: string[]): string[] =>
    ics(...vevent("DTSTART;TZID=America/New_York:20260301T220000", "RRULE:FREQ=DAILY;COUNT=3", ...extra));

  it("rejects an EXDATE;VALUE=DATE on a timed series: the types must match", () => {
    expect(dates(ny("EXDATE;VALUE=DATE:20260302"), "2026-03-01", "2026-03-10")).toMatch(/same type/);
  });

  it("rejects an RDATE;VALUE=DATE on a timed series and a RECURRENCE-ID;VALUE=DATE", () => {
    expect(dates(ny("RDATE;VALUE=DATE:20260302"), "2026-03-01", "2026-03-10")).toMatch(/same type/);
    const withOverride = ics(
      ...vevent("DTSTART;TZID=America/New_York:20260301T220000", "RRULE:FREQ=DAILY;COUNT=3"),
      ...vevent("RECURRENCE-ID;VALUE=DATE:20260302", "DTSTART;TZID=America/New_York:20260302T230000"),
    );
    expect(occ(withOverride)).toMatch(/same type/);
  });

  it("a date-valued EXDATE on an all-day series still matches by the host date", () => {
    const l = ics(
      ...vevent("DTSTART;VALUE=DATE:20260301", "RRULE:FREQ=DAILY;COUNT=3", "EXDATE;VALUE=DATE:20260302"),
    );
    expect(dates(l, "2026-03-01", "2026-03-10", "America/New_York")).toEqual(["2026-03-01", "2026-03-03"]);
  });
});

describe("nominal and exact durations of timed events", () => {
  const berlin = (start: string, ...rest: string[]): string[] =>
    ics(...vevent(`DTSTART;TZID=Europe/Berlin:${start}`, ...rest));

  it("P1D is a day of the wall clock: 23 hours across the change to summer time", () => {
    expect(occ(berlin("20260328T120000", "DURATION:P1D"))).toEqual(["2026-03-28T11:00/2026-03-29T10:00"]);
  });

  it("P1W is seven days of the wall clock", () => {
    expect(occ(berlin("20260325T120000", "DURATION:P1W"))).toEqual(["2026-03-25T11:00/2026-04-01T10:00"]);
  });

  it("hours and minutes are exact: PT24H is 24 hours across the same change", () => {
    expect(occ(berlin("20260328T120000", "DURATION:PT24H"))).toEqual(["2026-03-28T11:00/2026-03-29T11:00"]);
    expect(occ(berlin("20260328T120000", "DURATION:PT1H30M"))).toEqual(["2026-03-28T11:00/2026-03-28T12:30"]);
  });

  it("mixes days (wall clock) with hours (exact)", () => {
    expect(occ(berlin("20260328T120000", "DURATION:P1DT2H"))).toEqual(["2026-03-28T11:00/2026-03-29T12:00"]);
  });

  it("applies to every instance of a series", () => {
    const l = berlin("20260327T120000", "DURATION:P1D", "RRULE:FREQ=DAILY;COUNT=3");
    expect(occ(l)).toEqual([
      "2026-03-27T11:00/2026-03-28T11:00",
      "2026-03-28T11:00/2026-03-29T10:00",
      "2026-03-29T10:00/2026-03-30T10:00",
    ]);
  });

  it("an all-day DURATION in weeks counts whole days", () => {
    const l = ics(...vevent("DTSTART;VALUE=DATE:20260310", "DURATION:P1W"));
    expect(occ(l, FAR_FROM, FAR_TO, "UTC")).toEqual(["2026-03-10T00:00/2026-03-17T00:00 A"]);
  });

  it("a DTEND is an absolute instant: its difference is exact", () => {
    expect(occ(berlin("20260328T120000", "DTEND;TZID=Europe/Berlin:20260329T120000"))).toEqual([
      "2026-03-28T11:00/2026-03-29T10:00",
    ]);
  });
});

describe("dates in the host zone", () => {
  const ny = ics(...vevent("DTSTART;TZID=America/New_York:20260301T220000", "RRULE:FREQ=DAILY;COUNT=2"));

  it("Instance has the date in the zone of the event and in the host zone", () => {
    const r = occurrencesIn(ny, Date.parse(FAR_FROM), Date.parse(FAR_TO), BERLIN);
    expect(Result.isSuccess(r)).toBe(true);
    const found = Result.isSuccess(r) ? r.success.map((i) => [i.isoStartDate, i.hostIsoDate]) : [];
    // 22:00 in New York is 04:00 the next day in Berlin
    expect(found).toEqual([
      ["2026-03-01", "2026-03-02"],
      ["2026-03-02", "2026-03-03"],
    ]);
  });

  it("hostOccurrenceDatesIn lists the dates the user sees, occurrenceDatesIn those of the event", () => {
    const host = hostOccurrenceDatesIn(ny, "2026-03-01", "2026-03-05", BERLIN);
    const own = occurrenceDatesIn(ny, "2026-03-01", "2026-03-05", BERLIN);
    expect(Result.isSuccess(host) && host.success).toEqual(["2026-03-02", "2026-03-03"]);
    expect(Result.isSuccess(own) && own.success).toEqual(["2026-03-01", "2026-03-02"]);
    const onlyFirst = hostOccurrenceDatesIn(ny, "2026-03-01", "2026-03-02", BERLIN);
    expect(Result.isSuccess(onlyFirst) && onlyFirst.success).toEqual([]);
  });

  it("is the same date for all-day and floating events, and rejects a bad range", () => {
    const allDay = ics(...vevent("DTSTART;VALUE=DATE:20260301"));
    const r = hostOccurrenceDatesIn(allDay, "2026-03-01", "2026-03-02", "America/New_York");
    expect(Result.isSuccess(r) && r.success).toEqual(["2026-03-01"]);
    const bad = hostOccurrenceDatesIn(allDay, "2026-03-02", "2026-03-01", BERLIN);
    expect(Result.isFailure(bad) && bad.failure.message).toMatch(/real dates/);
  });
});

describe("invalid dates of MONTHLY and YEARLY rules are skipped", () => {
  it("YEARLY from 29 February only yields leap days, and COUNT counts valid instances", () => {
    const l = ics(...vevent("DTSTART:20240229T100000Z", "RRULE:FREQ=YEARLY;COUNT=3"));
    expect(occ(l)).toEqual([
      "2024-02-29T10:00/2024-02-29T11:00",
      "2028-02-29T10:00/2028-02-29T11:00",
      "2032-02-29T10:00/2032-02-29T11:00",
    ]);
  });

  it("MONTHLY on the 31st skips short months", () => {
    const l = ics(...vevent("DTSTART:20260131T100000Z", "RRULE:FREQ=MONTHLY;COUNT=4"));
    expect(occ(l)).toEqual([
      "2026-01-31T10:00/2026-01-31T11:00",
      "2026-03-31T10:00/2026-03-31T11:00",
      "2026-05-31T10:00/2026-05-31T11:00",
      "2026-07-31T10:00/2026-07-31T11:00",
    ]);
  });

  it("applies to all-day events and to an interval", () => {
    const l = ics(...vevent("DTSTART;VALUE=DATE:20240229", "RRULE:FREQ=YEARLY;INTERVAL=2;COUNT=2"));
    expect(dates(l, "2024-01-01", "2040-01-01", "UTC")).toEqual(["2024-02-29", "2028-02-29"]);
  });

  it("steps by INTERVAL months and honours UNTIL", () => {
    const l = ics(
      ...vevent("DTSTART:20260131T100000Z", "RRULE:FREQ=MONTHLY;INTERVAL=12;UNTIL=20300101T000000Z"),
    );
    expect(occ(l)).toEqual([
      "2026-01-31T10:00/2026-01-31T11:00",
      "2027-01-31T10:00/2027-01-31T11:00",
      "2028-01-31T10:00/2028-01-31T11:00",
      "2029-01-31T10:00/2029-01-31T11:00",
    ]);
  });
});

describe("THISANDFUTURE moving instances earlier", () => {
  it("finds a shifted instance in a window that ends before the original one", () => {
    const l = ics(
      ...vevent("DTSTART:20260303T090000Z", "RRULE:FREQ=WEEKLY;COUNT=4"),
      ...vevent("RECURRENCE-ID;RANGE=THISANDFUTURE:20260310T090000Z", "DTSTART:20260309T090000Z"),
    );
    expect(occ(l, "2026-03-16T00:00:00Z", "2026-03-16T12:00:00Z")).toEqual([
      "2026-03-16T09:00/2026-03-16T10:00",
    ]);
    expect(occ(l)).toHaveLength(4);
  });

  it("shifts all-day instances after a THISANDFUTURE exception", () => {
    const l = ics(
      ...vevent("DTSTART;VALUE=DATE:20260301", "RRULE:FREQ=DAILY;COUNT=3"),
      ...vevent(
        "RECURRENCE-ID;RANGE=THISANDFUTURE;VALUE=DATE:20260302",
        "DTSTART;VALUE=DATE:20260303",
        "DTEND;VALUE=DATE:20260304",
      ),
    );
    expect(occ(l, FAR_FROM, FAR_TO, "UTC")).toEqual([
      "2026-03-01T00:00/2026-03-02T00:00 A",
      "2026-03-03T00:00/2026-03-04T00:00 A",
      "2026-03-04T00:00/2026-03-05T00:00 A",
    ]);
  });
});

describe("sub-daily rules step in exact time", () => {
  it("HOURLY skips the gap hour of the spring change", () => {
    const l = ics(...vevent("DTSTART;TZID=Europe/Berlin:20260329T000000", "RRULE:FREQ=HOURLY;COUNT=5"));
    expect(occ(l)).toEqual([
      "2026-03-28T23:00/2026-03-29T00:00",
      "2026-03-29T00:00/2026-03-29T01:00",
      "2026-03-29T01:00/2026-03-29T02:00",
      "2026-03-29T02:00/2026-03-29T03:00",
      "2026-03-29T03:00/2026-03-29T04:00",
    ]);
  });

  it("HOURLY produces the repeated hour of the autumn change twice", () => {
    const l = ics(...vevent("DTSTART;TZID=Europe/Berlin:20261025T010000", "RRULE:FREQ=HOURLY;COUNT=4"));
    expect(occ(l)).toEqual([
      "2026-10-24T23:00/2026-10-25T00:00",
      "2026-10-25T00:00/2026-10-25T01:00",
      "2026-10-25T01:00/2026-10-25T02:00",
      "2026-10-25T02:00/2026-10-25T03:00",
    ]);
  });

  it("honours INTERVAL and UNTIL", () => {
    const l = ics(
      ...vevent("DTSTART:20260310T090000Z", "RRULE:FREQ=MINUTELY;INTERVAL=30;UNTIL=20260310T100000Z"),
    );
    expect(occ(l)).toHaveLength(3);
  });
});

describe("infinite rules", () => {
  it("are bounded by the window", () => {
    const l = ics(...vevent("DTSTART:20260101T100000Z", "RRULE:FREQ=DAILY"));
    expect(occ(l, "2026-01-10T00:00:00Z", "2026-01-12T00:00:00Z")).toEqual([
      "2026-01-10T10:00/2026-01-10T11:00",
      "2026-01-11T10:00/2026-01-11T11:00",
    ]);
  });
});
