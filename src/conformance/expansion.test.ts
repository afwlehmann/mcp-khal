import { Result } from "effect";
import { describe, expect, it } from "vitest";
import { occurrencesIn } from "../expand.js";
import { itReq } from "../testlib.js";

// Conformance of the reading side of RFC 5545: value types (3.3.4 to 3.3.14), recurrence rules
// (3.3.10), event dates (3.8.2), recurrence sets (3.8.5) and exceptions (3.8.4.4).

const BERLIN = "Europe/Berlin";
const FROM = "1990-01-01T00:00:00Z";
const TO = "2040-01-01T00:00:00Z";

const cal = (...body: string[]): string[] => [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//test//EN",
  ...body,
  "END:VCALENDAR",
];

/** A VEVENT as given: a timed event without DTEND and DURATION has no length (RFC 5545 3.6.1). */
const ev = (...props: string[]): string[] => [
  "BEGIN:VEVENT",
  "UID:u1",
  "DTSTAMP:20240101T000000Z",
  ...props,
  "END:VEVENT",
];

const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 19);

/** `start/end` (UTC, seconds; `A` for all-day) of every instance, or `ERR: message`. */
const occ = (lines: string[], host = BERLIN, from = FROM, to = TO): string[] => {
  const r = occurrencesIn(lines, Date.parse(from), Date.parse(to), host);
  return Result.isSuccess(r)
    ? r.success.map((i) => `${iso(i.start)}/${iso(i.end)}${i.allDay ? " A" : ""}`)
    : [`ERR: ${r.failure.message}`];
};

/** Just the start instants (UTC, minutes). */
const starts = (lines: string[], host = BERLIN): string[] => occ(lines, host).map((s) => s.slice(0, 16));

const problem = (lines: string[], host = BERLIN): string => {
  const r = occ(lines, host)[0] ?? "";
  return r.startsWith("ERR: ") ? r.slice(5) : "";
};

const event = (...props: string[]): string[] => cal(...ev(...props));

describe("RFC 5545 3.3.4 DATE", () => {
  itReq("RFC5545:3.3.4:date-format-yyyymmdd", "20240229 is a DATE; other forms are rejected", () => {
    expect(occ(event("DTSTART;VALUE=DATE:20240229"), "UTC")).toEqual([
      "2024-02-29T00:00:00/2024-03-01T00:00:00 A",
    ]);
    for (const bad of ["2024-02-29", "240229", "20230229"]) {
      expect(problem(event(`DTSTART;VALUE=DATE:${bad}`))).toMatch(/not a valid DATE/);
    }
  });
});

describe("RFC 5545 3.3.5 DATE-TIME", () => {
  itReq(
    "RFC5545:3.3.5:no-utc-offset-form",
    "an offset after the time is rejected, not read as local time",
    () => {
      expect(problem(event("DTSTART:19980119T230000-0800"))).toMatch(/not a valid DATE-TIME/);
    },
  );

  itReq("RFC5545:3.3.5:form1-floating", "a floating time is the same wall clock in every zone", () => {
    const l = event("DTSTART:20240101T100000");
    expect(starts(l, "Europe/Berlin")).toEqual(["2024-01-01T09:00"]);
    expect(starts(l, "America/New_York")).toEqual(["2024-01-01T15:00"]);
  });

  itReq(
    "RFC5545:3.3.5:floating-fixed-to-current-zone",
    "a floating time follows the zone it is read in",
    () => {
      expect(starts(event("DTSTART:20240101T100000"), "Asia/Tokyo")).toEqual(["2024-01-01T01:00"]);
      expect(starts(event("DTSTART:20240701T100000"), "Asia/Tokyo")).toEqual(["2024-07-01T01:00"]);
    },
  );

  itReq("RFC5545:3.3.5:form2-utc-z-suffix", "Z is UTC; a lowercase z is rejected", () => {
    expect(starts(event("DTSTART:20240101T100000Z"))).toEqual(["2024-01-01T10:00"]);
    expect(problem(event("DTSTART:20240101T100000z"))).toMatch(/not a valid DATE-TIME/);
  });

  itReq(
    ["RFC5545:3.3.5:utc-datetime-no-tzid", "RFC5545:3.2.19:tzid-not-on-date-or-utc"],
    "TZID on a UTC time or on a DATE is rejected",
    () => {
      expect(problem(event("DTSTART;TZID=Europe/Berlin:20240101T100000Z"))).toMatch(/must not have a TZID/);
      expect(problem(event("DTSTART;VALUE=DATE;TZID=Europe/Berlin:20240101"))).toMatch(
        /must not have a TZID/,
      );
    },
  );

  itReq("RFC5545:3.3.5:fold-first-occurrence", "a repeated local time takes the first occurrence", () => {
    expect(starts(event("DTSTART;TZID=Europe/Berlin:20241027T023000"))).toEqual(["2024-10-27T00:30"]);
  });

  itReq(
    "RFC5545:3.3.5:gap-offset-before-gap",
    "a local time that does not exist uses the offset before the gap",
    () => {
      expect(starts(event("DTSTART;TZID=Europe/Berlin:20240331T023000"))).toEqual(["2024-03-31T01:30"]);
      expect(starts(event("DTSTART;TZID=America/New_York:20070311T023000"))).toEqual(["2007-03-11T07:30"]);
    },
  );

  itReq("RFC5545:3.3.5:leap-second-60", "second 60 is accepted only as the last second of a UTC day", () => {
    expect(occ(event("DTSTART:19970630T235960Z"))).toHaveLength(1);
    expect(problem(event("DTSTART:20240101T100060Z"))).toMatch(/not a valid DATE-TIME/);
    expect(problem(event("DTSTART:20240101T240000"))).toMatch(/not a valid DATE-TIME/);
  });

  itReq("RFC5545:3.3.5:leap-second-as-59", "a leap second is read as second 59", () => {
    expect(occ(event("DTSTART:19970630T235960Z"))[0]?.slice(0, 19)).toBe("1997-06-30T23:59:59");
  });
});

describe("RFC 5545 3.3.12 TIME and 3.3.14 UTC-OFFSET as they appear in values", () => {
  itReq("RFC5545:3.3.12:time-hour-range", "hours run from 00 to 23", () => {
    expect(starts(event("DTSTART:20240101T083000Z"))).toEqual(["2024-01-01T08:30"]);
    expect(starts(event("DTSTART:20240101T133000Z"))).toEqual(["2024-01-01T13:30"]);
    expect(problem(event("DTSTART:20240101T240000Z"))).toMatch(/not a valid DATE-TIME/);
    expect(problem(event("DTSTART:20240101T2530"))).toMatch(/not a valid DATE-TIME/);
  });

  itReq("RFC5545:3.3.12:no-fractional-seconds", "fractional seconds are rejected", () => {
    expect(problem(event("DTSTART:20240101T100000.5Z"))).toMatch(/not a valid DATE-TIME/);
  });

  itReq("RFC5545:3.3.12:no-utc-offset-time", "a time with a UTC offset is rejected", () => {
    expect(problem(event("DTSTART:20240101T230000-0800"))).toMatch(/not a valid DATE-TIME/);
  });
});

describe("RFC 5545 3.3.6 DURATION", () => {
  const withDuration = (value: string): string[] => event("DTSTART:20240101T000000Z", `DURATION:${value}`);

  itReq(
    "RFC5545:3.3.6:duration-no-year-month",
    "days, hours, minutes, seconds are fine; years and months are not",
    () => {
      expect(occ(withDuration("P15DT5H0M20S"))).toEqual(["2024-01-01T00:00:00/2024-01-16T05:00:20"]);
      expect(problem(withDuration("-PT15M"))).toMatch(/negative/);
      expect(problem(withDuration("P1M"))).toMatch(/not a valid duration/);
      expect(problem(withDuration("P1Y"))).toMatch(/not a valid duration/);
    },
  );

  itReq("RFC5545:3.3.6:duration-week-form-alone", "weeks stand alone", () => {
    expect(occ(withDuration("P7W"))).toEqual(["2024-01-01T00:00:00/2024-02-19T00:00:00"]);
    expect(problem(withDuration("P1W2D"))).toMatch(/not a valid duration/);
    expect(problem(withDuration("P1WT1H"))).toMatch(/not a valid duration/);
  });

  itReq("RFC5545:3.3.6:no-leap-seconds-in-duration", "PT24H is 86400 seconds, whatever a leap second", () => {
    expect(occ(event("DTSTART:20161231T000000Z", "DURATION:PT24H"))).toEqual([
      "2016-12-31T00:00:00/2017-01-01T00:00:00",
    ]);
  });

  itReq(
    "RFC5545:3.3.6:duration-component-add-order",
    "days are added on the wall clock, then exact hours",
    () => {
      expect(occ(event("DTSTART;TZID=Europe/Berlin:20240330T120000", "DURATION:P1DT2H"))).toEqual([
        "2024-03-30T11:00:00/2024-03-31T12:00:00",
      ]);
    },
  );

  itReq(
    "RFC5545:3.3.6:nominal-day-dst",
    "P1D is a calendar day (23 hours over the change), PT24H is exact",
    () => {
      expect(occ(event("DTSTART;TZID=Europe/Berlin:20240330T100000", "DURATION:P1D"))).toEqual([
        "2024-03-30T09:00:00/2024-03-31T08:00:00",
      ]);
      expect(occ(event("DTSTART;TZID=Europe/Berlin:20240330T100000", "DURATION:PT24H"))).toEqual([
        "2024-03-30T09:00:00/2024-03-31T09:00:00",
      ]);
    },
  );

  itReq(
    "RFC5545:3.8.5.3:nominal-duration-from-duration",
    "a daily P1D event is 23 and 25 hours long on the change days",
    () => {
      const hours = (l: string[]): number[] =>
        Result.getOrThrow(occurrencesIn(l, Date.parse(FROM), Date.parse(TO), BERLIN)).map(
          (i) => (i.end - i.start) / 3_600_000,
        );
      expect(
        hours(
          event("DTSTART;TZID=Europe/Berlin:20240330T100000", "RRULE:FREQ=DAILY;COUNT=2", "DURATION:P1D"),
        ),
      ).toEqual([23, 24]);
      expect(
        hours(
          event("DTSTART;TZID=Europe/Berlin:20241026T100000", "RRULE:FREQ=DAILY;COUNT=2", "DURATION:P1D"),
        ),
      ).toEqual([25, 24]);
    },
  );

  itReq(
    "RFC5545:3.8.5.3:exact-duration-from-dtend",
    "a DTEND gives every instance the same exact length",
    () => {
      const l = event(
        "DTSTART;TZID=Europe/Berlin:20240330T100000",
        "DTEND;TZID=Europe/Berlin:20240330T110000",
        "RRULE:FREQ=DAILY;COUNT=3",
      );
      const hours = Result.getOrThrow(occurrencesIn(l, Date.parse(FROM), Date.parse(TO), BERLIN)).map(
        (i) => (i.end - i.start) / 3_600_000,
      );
      expect(hours).toEqual([1, 1, 1]);
    },
  );
});

describe("RFC 5545 3.3.9 PERIOD", () => {
  const withPeriod = (value: string): string[] =>
    event("DTSTART:19970101T000000Z", `RDATE;VALUE=PERIOD:${value}`);

  itReq("RFC5545:3.3.9:period-start-before-end", "a period must start before it ends", () => {
    expect(occ(withPeriod("19970101T180000Z/19970102T070000Z"))[1]).toBe(
      "1997-01-01T18:00:00/1997-01-02T07:00:00",
    );
    expect(problem(withPeriod("19970102T070000Z/19970101T180000Z"))).toMatch(/start before it ends/);
  });

  itReq("RFC5545:3.3.9:period-start-positive-duration", "a period duration is positive", () => {
    expect(occ(withPeriod("19970101T180000Z/PT5H30M"))[1]).toBe("1997-01-01T18:00:00/1997-01-01T23:30:00");
    expect(problem(withPeriod("19970101T180000Z/-PT1H"))).toMatch(/must be positive/);
  });

  itReq("RFC5545:3.8.5.2:rdate-value-types", "an RDATE PERIOD adds an instance with its own length", () => {
    const l = event(
      "DTSTART:19960401T000000Z",
      "DURATION:PT1H",
      "RDATE;VALUE=PERIOD:19960403T020000Z/19960403T040000Z",
    );
    expect(occ(l)).toEqual([
      "1996-04-01T00:00:00/1996-04-01T01:00:00",
      "1996-04-03T02:00:00/1996-04-03T04:00:00",
    ]);
  });
});

describe("RFC 5545 3.3.10 rule syntax", () => {
  const daily = (rule: string, ...more: string[]): string[] =>
    event("DTSTART:20240101T100000Z", `RRULE:${rule}`, ...more);

  itReq("RFC5545:3.3.10:freq-required", "a rule without FREQ is rejected", () => {
    expect(problem(daily("COUNT=3"))).toMatch(/needs FREQ/);
  });

  itReq("RFC5545:3.3.10:rule-parts-at-most-once", "a part twice is rejected", () => {
    expect(problem(daily("FREQ=DAILY;FREQ=WEEKLY"))).toMatch(/more than once/);
    expect(problem(daily("FREQ=DAILY;COUNT=2;COUNT=3"))).toMatch(/more than once/);
  });

  itReq("RFC5545:3.3.10:freq-first-accept-any-order", "FREQ may come after other parts", () => {
    expect(occ(daily("COUNT=3;FREQ=DAILY"))).toHaveLength(3);
  });

  itReq("RFC5545:3.3.10:count-and-until-exclusive", "COUNT and UNTIL together are rejected", () => {
    expect(problem(daily("FREQ=DAILY;COUNT=3;UNTIL=20240110T000000Z"))).toMatch(/never both/);
  });

  itReq("RFC5545:3.3.10:interval-positive-integer", "INTERVAL is a positive integer, default 1", () => {
    expect(problem(daily("FREQ=DAILY;INTERVAL=0"))).toMatch(/positive integer/);
    expect(starts(daily("FREQ=DAILY;COUNT=10;INTERVAL=2")).map((s) => s.slice(8, 10))).toEqual([
      "01",
      "03",
      "05",
      "07",
      "09",
      "11",
      "13",
      "15",
      "17",
      "19",
    ]);
    expect(starts(daily("FREQ=DAILY;COUNT=2")).map((s) => s.slice(8, 10))).toEqual(["01", "02"]);
  });

  itReq("RFC5545:3.3.10:until-same-type-as-dtstart", "UNTIL has the type of DTSTART (DATE)", () => {
    const date = (until: string): string[] =>
      event("DTSTART;VALUE=DATE:20240101", `RRULE:FREQ=DAILY;UNTIL=${until}`);
    expect(problem(date("20240110T000000Z"))).toMatch(/UNTIL must be a DATE/);
    expect(occ(date("20240110"), "UTC")).toHaveLength(10);
  });

  itReq("RFC5545:3.3.10:until-floating-for-local-dtstart", "a floating DTSTART has a floating UNTIL", () => {
    const local = (until: string): string[] =>
      event("DTSTART:20240101T100000", `RRULE:FREQ=DAILY;UNTIL=${until}`);
    expect(occ(local("20240110T100000"))).toHaveLength(10);
    expect(problem(local("20240110T100000Z"))).toMatch(/floating date-time/);
  });

  itReq("RFC5545:3.3.10:until-utc-for-utc-or-tzid-dtstart", "a UTC or TZID DTSTART has a UTC UNTIL", () => {
    const zoned = (until: string): string[] =>
      event("DTSTART;TZID=Europe/Berlin:20240101T100000", `RRULE:FREQ=DAILY;UNTIL=${until}`);
    expect(occ(zoned("20240110T090000Z"))).toHaveLength(10);
    expect(problem(zoned("20240110T100000"))).toMatch(/UTC date-time/);
    const utc = event("DTSTART:20240101T100000Z", "RRULE:FREQ=DAILY;UNTIL=20240110T100000");
    expect(problem(utc)).toMatch(/UTC date-time/);
  });

  itReq("RFC5545:3.3.10:until-inclusive", "the UNTIL instant itself is an instance", () => {
    expect(starts(daily("FREQ=DAILY;UNTIL=20240103T100000Z"))).toEqual([
      "2024-01-01T10:00",
      "2024-01-02T10:00",
      "2024-01-03T10:00",
    ]);
  });

  itReq("RFC5545:3.3.10:until-utc-in-vtimezone-observance", "the UNTIL of an observance rule is UTC", () => {
    const zone = (until: string): string[] =>
      cal(
        "BEGIN:VTIMEZONE",
        "TZID:Test/Zone",
        "BEGIN:DAYLIGHT",
        "DTSTART:19670430T020000",
        "TZOFFSETFROM:-0500",
        "TZOFFSETTO:-0400",
        `RRULE:FREQ=YEARLY;BYMONTH=4;BYDAY=-1SU;UNTIL=${until}`,
        "END:DAYLIGHT",
        "END:VTIMEZONE",
        ...ev("DTSTART;TZID=Test/Zone:20240101T100000"),
      );
    expect(occ(zone("19730429T070000Z"))).toHaveLength(1);
    expect(problem(zone("19730429T020000"))).toMatch(/UNTIL of a VTIMEZONE observance|UTC date-time/);
  });

  itReq("RFC5545:3.3.10:count-bounds-occurrences", "COUNT=3 yields exactly three instances", () => {
    expect(occ(daily("FREQ=DAILY;COUNT=3"))).toHaveLength(3);
  });

  itReq(
    ["RFC5545:3.3.10:dtstart-counts-first", "RFC5545:3.8.5.3:dtstart-first-instance"],
    "DTSTART is the first instance and nothing comes before it",
    () => {
      expect(starts(daily("FREQ=DAILY;COUNT=3"))).toEqual([
        "2024-01-01T10:00",
        "2024-01-02T10:00",
        "2024-01-03T10:00",
      ]);
    },
  );
});

describe("RFC 5545 3.3.10 rule parts and the table", () => {
  const rule = (r: string, start = "DTSTART:20240101T100000Z"): string[] => event(start, `RRULE:${r}`);

  itReq(
    "RFC5545:3.3.10:byday-numeric-only-monthly-yearly",
    "a number in BYDAY needs MONTHLY or YEARLY",
    () => {
      expect(problem(rule("FREQ=WEEKLY;BYDAY=1MO"))).toMatch(/only valid for FREQ=MONTHLY or YEARLY/);
      expect(starts(rule("FREQ=MONTHLY;BYDAY=-1FR;COUNT=2", "DTSTART:20240126T100000Z"))).toEqual([
        "2024-01-26T10:00",
        "2024-02-23T10:00",
      ]);
    },
  );

  itReq(
    "RFC5545:3.3.10:byday-numeric-not-yearly-byweekno",
    "a number in BYDAY is not valid with BYWEEKNO",
    () => {
      expect(problem(rule("FREQ=YEARLY;BYWEEKNO=20;BYDAY=1MO"))).toMatch(/BYWEEKNO/);
      expect(occ(rule("FREQ=YEARLY;BYWEEKNO=20;BYDAY=MO;COUNT=1"))).toHaveLength(1);
    },
  );

  itReq("RFC5545:3.3.10:bymonthday-not-weekly", "BYMONTHDAY is not valid for WEEKLY", () => {
    expect(problem(rule("FREQ=WEEKLY;BYMONTHDAY=1"))).toMatch(/BYMONTHDAY is not valid for FREQ=WEEKLY/);
    expect(starts(rule("FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=2", "DTSTART:20240131T100000Z"))).toEqual([
      "2024-01-31T10:00",
      "2024-02-29T10:00",
    ]);
  });

  itReq(
    "RFC5545:3.3.10:byyearday-not-daily-weekly-monthly",
    "BYYEARDAY is not valid for DAILY, WEEKLY, MONTHLY",
    () => {
      expect(problem(rule("FREQ=DAILY;BYYEARDAY=1"))).toMatch(/BYYEARDAY is not valid/);
      expect(starts(rule("FREQ=YEARLY;BYYEARDAY=-1;COUNT=2", "DTSTART:20241231T100000Z"))).toEqual([
        "2024-12-31T10:00",
        "2025-12-31T10:00",
      ]);
    },
  );

  itReq("RFC5545:3.3.10:byweekno-only-yearly", "BYWEEKNO is only valid for YEARLY", () => {
    expect(problem(rule("FREQ=MONTHLY;BYWEEKNO=1"))).toMatch(/BYWEEKNO is only valid for FREQ=YEARLY/);
  });

  itReq("RFC5545:3.3.10:bysetpos-needs-other-byxxx", "BYSETPOS needs another BYxxx part", () => {
    expect(problem(rule("FREQ=MONTHLY;BYSETPOS=1"))).toMatch(/BYSETPOS needs/);
    expect(
      starts(rule("FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=3", "DTSTART:20240131T100000Z")),
    ).toEqual(["2024-01-31T10:00", "2024-02-29T10:00", "2024-03-29T10:00"]);
  });

  itReq("RFC5545:3.3.10:bymonthday-range", "BYMONTHDAY is -31..-1 or 1..31", () => {
    for (const bad of ["0", "32"])
      expect(problem(rule(`FREQ=MONTHLY;BYMONTHDAY=${bad}`))).toMatch(/out of range/);
    for (const good of ["-31", "31"]) expect(problem(rule(`FREQ=MONTHLY;BYMONTHDAY=${good}`))).toBe("");
  });

  itReq("RFC5545:3.3.10:byyearday-range", "BYYEARDAY is -366..-1 or 1..366", () => {
    for (const bad of ["0", "367"])
      expect(problem(rule(`FREQ=YEARLY;BYYEARDAY=${bad}`))).toMatch(/out of range/);
    for (const good of ["-366", "366"]) expect(problem(rule(`FREQ=YEARLY;BYYEARDAY=${good}`))).toBe("");
  });

  itReq("RFC5545:3.3.10:byweekno-range", "BYWEEKNO is -53..-1 or 1..53", () => {
    for (const bad of ["54", "0"])
      expect(problem(rule(`FREQ=YEARLY;BYWEEKNO=${bad}`))).toMatch(/out of range/);
    for (const good of ["53", "-53"]) expect(problem(rule(`FREQ=YEARLY;BYWEEKNO=${good}`))).toBe("");
  });

  itReq("RFC5545:3.3.10:bymonth-range", "BYMONTH is 1..12", () => {
    for (const bad of ["0", "13"])
      expect(problem(rule(`FREQ=YEARLY;BYMONTH=${bad}`))).toMatch(/out of range/);
    for (const good of ["1", "12"]) expect(problem(rule(`FREQ=YEARLY;BYMONTH=${good}`))).toBe("");
  });

  itReq("RFC5545:3.3.10:bysecond-range-0-60", "BYSECOND 0..60, BYMINUTE 0..59, BYHOUR 0..23", () => {
    expect(problem(rule("FREQ=DAILY;BYSECOND=61"))).toMatch(/out of range/);
    for (const good of ["0", "60"]) expect(problem(rule(`FREQ=DAILY;BYSECOND=${good}`))).toBe("");
    expect(problem(rule("FREQ=DAILY;BYMINUTE=60"))).toMatch(/out of range/);
    expect(problem(rule("FREQ=DAILY;BYHOUR=24"))).toMatch(/out of range/);
  });

  itReq("RFC5545:3.3.10:na-means-must-not-use", "every N/A cell of the table is rejected", () => {
    const na: readonly [string, string][] = [
      ["WEEKLY", "BYWEEKNO=1"],
      ["DAILY", "BYWEEKNO=1"],
      ["MONTHLY", "BYWEEKNO=1"],
      ["DAILY", "BYYEARDAY=1"],
      ["WEEKLY", "BYYEARDAY=1"],
      ["MONTHLY", "BYYEARDAY=1"],
      ["WEEKLY", "BYMONTHDAY=1"],
      ["DAILY", "BYDAY=1MO"],
      ["WEEKLY", "BYDAY=1MO"],
    ];
    for (const [freq, part] of na) expect(problem(rule(`FREQ=${freq};${part}`))).not.toBe("");
  });

  itReq(
    [
      "RFC5545:3.3.10:table-bymonth",
      "RFC5545:3.3.10:limit-vs-expand-limit",
      "RFC5545:3.3.10:limit-vs-expand-expand",
    ],
    "BYMONTH limits a DAILY rule and expands a YEARLY one",
    () => {
      expect(starts(rule("FREQ=DAILY;BYMONTH=1;COUNT=4", "DTSTART:20240130T100000Z"))).toEqual([
        "2024-01-30T10:00",
        "2024-01-31T10:00",
        "2025-01-01T10:00",
        "2025-01-02T10:00",
      ]);
      expect(starts(rule("FREQ=YEARLY;BYMONTH=1,2;COUNT=4", "DTSTART:20240115T100000Z"))).toEqual([
        "2024-01-15T10:00",
        "2024-02-15T10:00",
        "2025-01-15T10:00",
        "2025-02-15T10:00",
      ]);
    },
  );

  itReq("RFC5545:3.3.10:table-byweekno", "BYWEEKNO selects the ISO weeks of a year", () => {
    expect(starts(rule("FREQ=YEARLY;BYWEEKNO=20;BYDAY=MO;COUNT=2", "DTSTART:20240513T100000Z"))).toEqual([
      "2024-05-13T10:00",
      "2025-05-12T10:00",
    ]);
  });

  itReq("RFC5545:3.3.10:table-byyearday", "BYYEARDAY limits HOURLY and expands YEARLY", () => {
    expect(starts(rule("FREQ=HOURLY;BYYEARDAY=1;COUNT=3", "DTSTART:20240101T000000Z"))).toEqual([
      "2024-01-01T00:00",
      "2024-01-01T01:00",
      "2024-01-01T02:00",
    ]);
    expect(starts(rule("FREQ=YEARLY;BYYEARDAY=1,100,200;COUNT=3", "DTSTART:20240101T100000Z"))).toEqual([
      "2024-01-01T10:00",
      "2024-04-09T10:00",
      "2024-07-18T10:00",
    ]);
  });

  itReq("RFC5545:3.3.10:table-bymonthday", "BYMONTHDAY limits DAILY and expands MONTHLY", () => {
    expect(starts(rule("FREQ=DAILY;BYMONTHDAY=1;COUNT=3"))).toEqual([
      "2024-01-01T10:00",
      "2024-02-01T10:00",
      "2024-03-01T10:00",
    ]);
    expect(starts(rule("FREQ=MONTHLY;BYMONTHDAY=1,15;COUNT=4"))).toEqual([
      "2024-01-01T10:00",
      "2024-01-15T10:00",
      "2024-02-01T10:00",
      "2024-02-15T10:00",
    ]);
  });

  itReq("RFC5545:3.3.10:table-byday-notes", "BYDAY limits with BYMONTHDAY and expands otherwise", () => {
    expect(starts(rule("FREQ=MONTHLY;BYDAY=MO;BYMONTHDAY=13;COUNT=2", "DTSTART:20240513T100000Z"))).toEqual([
      "2024-05-13T10:00",
      "2025-01-13T10:00",
    ]);
    expect(starts(rule("FREQ=MONTHLY;BYDAY=MO;COUNT=5"))).toEqual([
      "2024-01-01T10:00",
      "2024-01-08T10:00",
      "2024-01-15T10:00",
      "2024-01-22T10:00",
      "2024-01-29T10:00",
    ]);
    expect(starts(rule("FREQ=YEARLY;BYDAY=MO;COUNT=3"))).toEqual([
      "2024-01-01T10:00",
      "2024-01-08T10:00",
      "2024-01-15T10:00",
    ]);
  });

  itReq(
    "RFC5545:3.3.10:byxxx-evaluation-order",
    "BYSETPOS applies after BYDAY and COUNT after BYSETPOS",
    () => {
      expect(starts(rule("FREQ=MONTHLY;BYDAY=TU,WE;BYSETPOS=2;COUNT=3", "DTSTART:20240103T100000Z"))).toEqual(
        ["2024-01-03T10:00", "2024-02-07T10:00", "2024-03-06T10:00"],
      );
    },
  );

  itReq("RFC5545:3.3.10:missing-parts-from-dtstart", "missing parts come from DTSTART", () => {
    expect(
      occ(rule("FREQ=YEARLY;BYMONTH=1;COUNT=3", "DTSTART:19970105T083000"), "UTC").map((s) => s.slice(0, 19)),
    ).toEqual(["1997-01-05T08:30:00", "1998-01-05T08:30:00", "1999-01-05T08:30:00"]);
  });

  itReq(
    "RFC5545:3.3.10:invalid-dates-ignored-not-counted",
    "a date that does not exist is skipped and not counted",
    () => {
      expect(starts(rule("FREQ=MONTHLY;BYMONTHDAY=15,30;COUNT=5", "DTSTART:20070115T100000Z"))).toEqual([
        "2007-01-15T10:00",
        "2007-01-30T10:00",
        "2007-02-15T10:00",
        "2007-03-15T10:00",
        "2007-03-30T10:00",
      ]);
      expect(starts(rule("FREQ=MONTHLY;COUNT=3", "DTSTART:20070131T100000Z"))).toEqual([
        "2007-01-31T10:00",
        "2007-03-31T10:00",
        "2007-05-31T10:00",
      ]);
    },
  );

  itReq(
    "RFC5545:3.3.10:rule-gap-time-like-explicit-datetime",
    "a rule instance in a gap is read like an explicit date-time and still counts",
    () => {
      const berlin = (day: string): string[] =>
        event(`DTSTART;TZID=Europe/Berlin:${day}T023000`, "RRULE:FREQ=DAILY;COUNT=3");
      expect(starts(berlin("20240330"))).toEqual([
        "2024-03-30T01:30",
        "2024-03-31T01:30",
        "2024-04-01T00:30",
      ]);
      expect(starts(berlin("20241026"))).toEqual([
        "2024-10-26T00:30",
        "2024-10-27T00:30",
        "2024-10-28T01:30",
      ]);
    },
  );

  itReq(
    "RFC5545:3.3.10:wkst-significance",
    "WKST changes which instances a weekly interval rule yields",
    () => {
      const weekly = (wkst: string): string[] =>
        event(
          "DTSTART;TZID=America/New_York:19970805T090000",
          `RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU;WKST=${wkst}`,
        );
      const days = (l: string[]): string[] => starts(l).map((s) => s.slice(8, 10));
      expect(days(weekly("MO"))).toEqual(["05", "10", "19", "24"]);
      expect(days(weekly("SU"))).toEqual(["05", "17", "19", "31"]);
    },
  );

  itReq("RFC5545:3.3.10:wkst-default-monday", "without WKST the week starts on Monday", () => {
    const plain = event(
      "DTSTART;TZID=America/New_York:19970805T090000",
      "RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU",
    );
    const monday = event(
      "DTSTART;TZID=America/New_York:19970805T090000",
      "RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU;WKST=MO",
    );
    expect(occ(plain)).toEqual(occ(monday));
  });

  itReq("RFC5545:3.3.10:bytime-on-date-ignored", "BYHOUR is ignored on an all-day rule", () => {
    expect(occ(event("DTSTART;VALUE=DATE:20240101", "RRULE:FREQ=DAILY;BYHOUR=9;COUNT=3"), "UTC")).toEqual([
      "2024-01-01T00:00:00/2024-01-02T00:00:00 A",
      "2024-01-02T00:00:00/2024-01-03T00:00:00 A",
      "2024-01-03T00:00:00/2024-01-04T00:00:00 A",
    ]);
  });
});

describe("RFC 5545 3.8.2 DTSTART, DTEND, DURATION", () => {
  itReq("RFC5545:3.8.2.4:dtstart-required-without-method", "an event without DTSTART is reported", () => {
    expect(problem(event("SUMMARY:x"))).toMatch(/no DTSTART/);
  });

  itReq(
    "RFC5545:3.8.2.4:dtstart-required-for-rrule",
    "an event with RRULE but no DTSTART yields nothing",
    () => {
      expect(occ(event("RRULE:FREQ=DAILY;COUNT=3"))).toEqual(["ERR: an event has no DTSTART"]);
    },
  );

  itReq("RFC5545:3.8.2.4:dtstart-default-datetime", "a DATE without VALUE=DATE is flagged", () => {
    expect(problem(event("DTSTART:20240105"))).toMatch(/needs VALUE=DATE/);
    expect(starts(event("DTSTART:20240105T100000Z"))).toEqual(["2024-01-05T10:00"]);
  });

  itReq("RFC5545:3.8.5.3:multiple-rrule-undefined", "two RRULEs are reported, not guessed", () => {
    expect(
      problem(event("DTSTART:20240101T100000Z", "RRULE:FREQ=DAILY;COUNT=2", "RRULE:FREQ=WEEKLY;COUNT=2")),
    ).toMatch(/more than one RRULE/);
  });

  itReq("RFC5545:3.8.2.2:dtend-same-type-and-later", "DTEND is of the type of DTSTART and later", () => {
    expect(problem(event("DTSTART:20240105T100000Z", "DTEND:20240105T100000Z"))).toMatch(
      /later than DTSTART/,
    );
    expect(problem(event("DTSTART:20240105T100000Z", "DTEND:20240105T090000Z"))).toMatch(/ends before/);
    expect(problem(event("DTSTART;VALUE=DATE:20240105", "DTEND:20240106T000000Z"))).toMatch(/same type/);
    expect(problem(event("DTSTART:20240105T100000Z", "DTEND;VALUE=DATE:20240106"))).toMatch(/same type/);
  });

  it("tolerates an all-day DTEND equal to DTSTART and reads it as one day", () => {
    expect(occ(event("DTSTART;VALUE=DATE:20240105", "DTEND;VALUE=DATE:20240105"), "UTC")).toEqual([
      "2024-01-05T00:00:00/2024-01-06T00:00:00 A",
    ]);
  });

  itReq("RFC5545:3.8.2.2:dtend-local-iff-dtstart-local", "DTEND is floating exactly when DTSTART is", () => {
    expect(problem(event("DTSTART:20240105T100000", "DTEND:20240105T110000Z"))).toMatch(/floating/);
    expect(problem(event("DTSTART:20240105T100000Z", "DTEND:20240105T110000"))).toMatch(/floating/);
    expect(occ(event("DTSTART;TZID=Europe/Berlin:20240105T100000", "DTEND:20240105T100000Z"))).toEqual([
      "2024-01-05T09:00:00/2024-01-05T10:00:00",
    ]);
  });

  it("an event without DTEND and DURATION has no length (timed) or lasts one day (all-day)", () => {
    expect(occ(event("DTSTART:20240105T100000Z"))).toEqual(["2024-01-05T10:00:00/2024-01-05T10:00:00"]);
    expect(occ(event("DTSTART;VALUE=DATE:20240105"), "UTC")).toEqual([
      "2024-01-05T00:00:00/2024-01-06T00:00:00 A",
    ]);
  });

  itReq("RFC5545:3.8.2.5:duration-positive-only", "a negative DURATION of an event is rejected", () => {
    expect(problem(event("DTSTART:20240105T100000Z", "DURATION:-PT1H"))).toMatch(/negative/);
    // the TRIGGER of an alarm is another property and may be negative
    const withAlarm = cal(
      ...ev(
        "DTSTART:20240105T100000Z",
        "DURATION:PT1H",
        "BEGIN:VALARM",
        "ACTION:DISPLAY",
        "TRIGGER:-PT15M",
        "END:VALARM",
      ),
    );
    expect(occ(withAlarm)).toHaveLength(1);
  });

  itReq("RFC5545:3.8.2.5:duration-date-dtstart-day-week", "an all-day DURATION is in days or weeks", () => {
    expect(problem(event("DTSTART;VALUE=DATE:20240105", "DURATION:PT1H"))).toMatch(/days or weeks/);
    expect(occ(event("DTSTART;VALUE=DATE:20240105", "DURATION:P2D"), "UTC")).toEqual([
      "2024-01-05T00:00:00/2024-01-07T00:00:00 A",
    ]);
    expect(occ(event("DTSTART;VALUE=DATE:20240105", "DURATION:P1W"), "UTC")).toEqual([
      "2024-01-05T00:00:00/2024-01-12T00:00:00 A",
    ]);
  });
});

describe("RFC 5545 3.8.5 recurrence sets", () => {
  const daily = (...more: string[]): string[] =>
    event("DTSTART:20240101T100000Z", "RRULE:FREQ=DAILY;COUNT=4", ...more);

  itReq("RFC5545:3.8.5.3:set-gathering-and-exclusion", "(DTSTART + RRULE + RDATE) minus EXDATE", () => {
    expect(starts(daily("RDATE:20240110T100000Z", "EXDATE:20240102T100000Z"))).toEqual([
      "2024-01-01T10:00",
      "2024-01-03T10:00",
      "2024-01-04T10:00",
      "2024-01-10T10:00",
    ]);
  });

  itReq(
    "RFC5545:3.8.5.1:exdate-excludes-dtstart-keep-original",
    "an EXDATE equal to DTSTART removes the first instance",
    () => {
      expect(starts(daily("EXDATE:20240101T100000Z"))).toEqual([
        "2024-01-02T10:00",
        "2024-01-03T10:00",
        "2024-01-04T10:00",
      ]);
    },
  );

  itReq(
    "RFC5545:3.8.5.1:exdate-precedence-over-rdate",
    "an EXDATE removes an RDATE and a rule instance",
    () => {
      expect(starts(daily("RDATE:20240110T100000Z", "EXDATE:20240110T100000Z,20240103T100000Z"))).toEqual([
        "2024-01-01T10:00",
        "2024-01-02T10:00",
        "2024-01-04T10:00",
      ]);
    },
  );

  itReq("RFC5545:3.8.5.3:duplicates-ignored", "an RDATE equal to an instance counts once", () => {
    expect(starts(daily("RDATE:20240102T100000Z,20240101T100000Z"))).toHaveLength(4);
  });

  itReq("RFC5545:3.8.5.2:rdate-union-with-rrule", "RDATE adds to the rule", () => {
    const l = event("DTSTART:20240101T100000Z", "RRULE:FREQ=WEEKLY;COUNT=2", "RDATE:20240103T100000Z");
    expect(starts(l)).toEqual(["2024-01-01T10:00", "2024-01-03T10:00", "2024-01-08T10:00"]);
  });

  itReq(
    "RFC5545:3.8.5.1:exdate-value-types",
    "EXDATE;VALUE=DATE excludes an all-day instance; PERIOD is rejected",
    () => {
      const allDay = event(
        "DTSTART;VALUE=DATE:20240101",
        "RRULE:FREQ=DAILY;COUNT=3",
        "EXDATE;VALUE=DATE:20240102",
      );
      expect(occ(allDay, "UTC").map((s) => s.slice(0, 10))).toEqual(["2024-01-01", "2024-01-03"]);
      expect(problem(daily("EXDATE;VALUE=PERIOD:20240102T100000Z/PT1H"))).toMatch(/PERIOD/);
    },
  );

  itReq(
    "RFC5545:3.8.5.1:exdate-type-vs-dtstart-unspecified",
    "an EXDATE of the other type than DTSTART is reported (policy)",
    () => {
      expect(problem(daily("EXDATE;VALUE=DATE:20240102"))).toMatch(/same type/);
      const allDay = event(
        "DTSTART;VALUE=DATE:20240101",
        "RRULE:FREQ=DAILY;COUNT=3",
        "EXDATE:20240102T000000Z",
      );
      expect(problem(allDay)).toMatch(/same type/);
    },
  );

  itReq(
    "RFC5545:3.2.19:exdate-tzid-matches-instance",
    "an EXDATE by TZID or by UTC matches the instance",
    () => {
      const l = (exdate: string): string[] =>
        event("DTSTART;TZID=Europe/Berlin:20240101T100000", "RRULE:FREQ=DAILY;COUNT=3", exdate);
      const rest = ["2024-01-01T09:00", "2024-01-03T09:00"];
      expect(starts(l("EXDATE;TZID=Europe/Berlin:20240102T100000"))).toEqual(rest);
      expect(starts(l("EXDATE:20240102T090000Z"))).toEqual(rest);
    },
  );

  itReq(
    "RFC5545:3.8.5.3:dtstart-unsynchronized-undefined",
    "an unsynchronized DTSTART stays the first instance (policy)",
    () => {
      expect(starts(event("DTSTART:20240101T100000Z", "RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=3"))).toEqual([
        "2024-01-01T10:00",
        "2024-01-02T10:00",
        "2024-01-09T10:00",
      ]);
    },
  );

  itReq(
    "RFC5545:3.8.5.3:dtstart-tzid-for-recurring-datetime",
    "a TZID series keeps its local time across DST",
    () => {
      const l = event("DTSTART;TZID=Europe/Berlin:20240323T100000", "RRULE:FREQ=WEEKLY;COUNT=2");
      expect(starts(l)).toEqual(["2024-03-23T09:00", "2024-03-30T09:00"]);
      expect(
        starts(event("DTSTART;TZID=Europe/Berlin:20240330T100000", "RRULE:FREQ=WEEKLY;COUNT=2")),
      ).toEqual(["2024-03-30T09:00", "2024-04-06T08:00"]);
    },
  );
});

describe("RFC 5545 3.8.4.4 RECURRENCE-ID", () => {
  const master = (...more: string[]): string[] =>
    ev("DTSTART:20240101T100000Z", "RRULE:FREQ=DAILY;COUNT=5", ...more);

  itReq(
    "RFC5545:3.8.4.4:recurrence-id-same-type-as-dtstart",
    "the type of RECURRENCE-ID is that of DTSTART",
    () => {
      const allDay = cal(
        ...ev("DTSTART;VALUE=DATE:20240101", "RRULE:FREQ=DAILY;COUNT=3"),
        ...ev("RECURRENCE-ID:20240102T000000Z", "DTSTART;VALUE=DATE:20240102"),
      );
      expect(problem(allDay)).toMatch(/same type/);
    },
  );

  itReq(
    "RFC5545:3.8.4.4:recurrence-id-local-iff-dtstart-local",
    "RECURRENCE-ID is floating exactly when DTSTART is",
    () => {
      const floating = cal(
        ...ev("DTSTART:20240101T100000", "RRULE:FREQ=DAILY;COUNT=3"),
        ...ev("RECURRENCE-ID:20240102T100000Z", "DTSTART:20240102T120000"),
      );
      expect(problem(floating)).toMatch(/floating/);
      const utc = cal(...master(), ...ev("RECURRENCE-ID:20240102T100000", "DTSTART:20240102T120000Z"));
      expect(problem(utc)).toMatch(/floating/);
    },
  );

  itReq(
    [
      "RFC5545:3.8.4.4:recurrence-id-replaces-instance-by-uid",
      "RFC5545:3.8.4.4:recurrence-id-original-dtstart",
    ],
    "an override replaces exactly the instance named by its RECURRENCE-ID",
    () => {
      const l = cal(...master(), ...ev("RECURRENCE-ID:20240103T100000Z", "DTSTART:20240103T120000Z"));
      expect(starts(l)).toEqual([
        "2024-01-01T10:00",
        "2024-01-02T10:00",
        "2024-01-03T12:00",
        "2024-01-04T10:00",
        "2024-01-05T10:00",
      ]);
    },
  );

  itReq(
    "RFC5545:3.8.4.4:recurrence-id-friday-to-thursday",
    "the original date stays in RECURRENCE-ID, the new one is DTSTART",
    () => {
      // 2024-01-05 is a Friday, 2024-01-04 a Thursday
      const l = cal(...master(), ...ev("RECURRENCE-ID:20240105T100000Z", "DTSTART:20240104T150000Z"));
      expect(starts(l)).toEqual([
        "2024-01-01T10:00",
        "2024-01-02T10:00",
        "2024-01-03T10:00",
        "2024-01-04T10:00",
        "2024-01-04T15:00",
      ]);
    },
  );

  itReq(
    "RFC5545:3.8.4.4:recurrence-id-date-is-calendar-date",
    "an all-day series is overridden by a DATE",
    () => {
      const l = cal(
        ...ev("DTSTART;VALUE=DATE:19960401", "RRULE:FREQ=DAILY;COUNT=3"),
        ...ev("RECURRENCE-ID;VALUE=DATE:19960402", "DTSTART;VALUE=DATE:19960410"),
      );
      expect(occ(l, "UTC").map((s) => s.slice(0, 10))).toEqual(["1996-04-01", "1996-04-03", "1996-04-10"]);
    },
  );

  itReq(
    "RFC5545:3.8.4.4:thisandfuture-shifts-subsequent",
    "THISANDFUTURE moves later instances and changes their length",
    () => {
      const l = cal(
        ...master("DTEND:20240101T110000Z"),
        ...ev(
          "RECURRENCE-ID;RANGE=THISANDFUTURE:20240103T100000Z",
          "DTSTART:20240103T120000Z",
          "DTEND:20240103T133000Z",
        ),
      );
      expect(occ(l).map((s) => s.replace(/:00(?=\/|$)/g, ""))).toEqual([
        "2024-01-01T10:00/2024-01-01T11:00",
        "2024-01-02T10:00/2024-01-02T11:00",
        "2024-01-03T12:00/2024-01-03T13:30",
        "2024-01-04T12:00/2024-01-04T13:30",
        "2024-01-05T12:00/2024-01-05T13:30",
      ]);
    },
  );

  itReq(
    "RFC5545:3.8.4.4:thisandfuture-by-recurrence-id",
    "a later override is matched by the original start",
    () => {
      const l = cal(
        ...master("DTEND:20240101T110000Z"),
        ...ev(
          "RECURRENCE-ID;RANGE=THISANDFUTURE:20240103T100000Z",
          "DTSTART:20240103T120000Z",
          "DTEND:20240103T130000Z",
        ),
        // the original start of the 4th instance (10:00), although it now runs at 12:00
        ...ev("RECURRENCE-ID:20240104T100000Z", "DTSTART:20240104T180000Z", "DTEND:20240104T190000Z"),
      );
      expect(starts(l)).toEqual([
        "2024-01-01T10:00",
        "2024-01-02T10:00",
        "2024-01-03T12:00",
        "2024-01-04T18:00",
        "2024-01-05T12:00",
      ]);
    },
  );

  it("reports RANGE=THISANDPRIOR as unsupported and an unknown RANGE as invalid", () => {
    const range = (r: string): string[] =>
      cal(...master(), ...ev(`RECURRENCE-ID;RANGE=${r}:20240103T100000Z`, "DTSTART:20240103T120000Z"));
    expect(problem(range("THISANDPRIOR"))).toMatch(/THISANDPRIOR is not supported/);
    expect(problem(range("SOMETHING"))).toMatch(/not valid/);
  });
});

describe("RFC 5545 3.2.19 TZID in events", () => {
  itReq(
    "RFC5545:3.2.19:tzid-absent-means-floating",
    "a time without TZID is floating even when the file has a VTIMEZONE",
    () => {
      const l = cal(
        "BEGIN:VTIMEZONE",
        "TZID:Test/Zone",
        "BEGIN:STANDARD",
        "DTSTART:19700101T000000",
        "TZOFFSETFROM:+0900",
        "TZOFFSETTO:+0900",
        "END:STANDARD",
        "END:VTIMEZONE",
        ...ev("DTSTART:20240101T100000"),
      );
      expect(starts(l, "America/New_York")).toEqual(["2024-01-01T15:00"]);
    },
  );

  itReq("RFC5545:3.2.19:tzid-solidus-global-id", "a globally unique TZID is an opaque label", () => {
    const withoutZone = event("DTSTART;TZID=/example.org/America/New_York:20240101T100000");
    expect(problem(withoutZone)).toMatch(/unknown time zone "\/example.org\/America\/New_York"/);
    const l = cal(
      "BEGIN:VTIMEZONE",
      "TZID:/example.org/America/New_York",
      "BEGIN:STANDARD",
      "DTSTART:19700101T000000",
      "TZOFFSETFROM:-0500",
      "TZOFFSETTO:-0500",
      "END:STANDARD",
      "END:VTIMEZONE",
      ...ev("DTSTART;TZID=/example.org/America/New_York:20240101T100000"),
    );
    expect(starts(l)).toEqual(["2024-01-01T15:00"]);
  });

  itReq(
    "RFC5545:3.2.19:missing-vtimezone-inconsistent",
    "a TZID without VTIMEZONE: IANA, then Windows names, else reported",
    () => {
      expect(starts(event("DTSTART;TZID=America/New_York:20240701T100000"))).toEqual(["2024-07-01T14:00"]);
      expect(problem(event("DTSTART;TZID=Mars/Olympus:20240701T100000"))).toMatch(
        /unknown time zone "Mars\/Olympus"/,
      );
      expect(problem(event("DTSTART;TZID=GMT+0100:20240701T100000"))).toMatch(
        /unknown time zone "GMT\+0100"/,
      );
    },
  );
});
