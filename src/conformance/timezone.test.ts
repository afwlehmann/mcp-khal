import { Result } from "effect";
import ICAL from "ical.js";
import { describe, expect, it } from "vitest";
import { occurrencesIn } from "../expand.js";
import { itReq } from "../testlib.js";
import { resolveZone, WINDOWS_ZONES, wallToInstant, type Zone, zoneFromVtimezone } from "../timezone.js";

// Conformance of time zone handling: VTIMEZONE reading (RFC 5545 3.6.5), UTC offsets (3.3.14),
// TZID resolution (3.2.19) and the zones of the fixtures (IANA through luxon).

const vtimezone = (...lines: string[]): ICAL.Component => {
  const text = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VTIMEZONE",
    ...lines,
    "END:VTIMEZONE",
    "END:VCALENDAR",
  ].join("\r\n");
  const v = new ICAL.Component(ICAL.parse(text)).getFirstSubcomponent("vtimezone");
  if (v === null) throw new Error("no vtimezone");
  return v;
};

const zoneOf = (...lines: string[]): Result.Result<Zone, { message: string }> =>
  zoneFromVtimezone(vtimezone(...lines));

const message = (r: Result.Result<unknown, { message: string }>): string =>
  Result.isFailure(r) ? r.failure.message : "";

const offsetAt = (r: Result.Result<Zone, { message: string }>, utc: string): number => {
  if (Result.isFailure(r)) throw new Error(r.failure.message);
  return r.success.offsetMinutes(Date.parse(utc));
};

const observance = (
  kind: "STANDARD" | "DAYLIGHT",
  from: string,
  to: string,
  start: string,
  ...more: string[]
): string[] => [
  `BEGIN:${kind}`,
  `DTSTART:${start}`,
  `TZOFFSETFROM:${from}`,
  `TZOFFSETTO:${to}`,
  ...more,
  `END:${kind}`,
];

// the America/New_York definition of RFC 5545 3.6.5
const newYork = [
  "TZID:America/New_York",
  ...observance("STANDARD", "-0400", "-0500", "20071104T020000", "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU"),
  ...observance("DAYLIGHT", "-0500", "-0400", "20070311T020000", "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU"),
];

describe("RFC 5545 3.6.5 VTIMEZONE", () => {
  itReq(
    "RFC5545:3.6.5:vtimezone-tzid-and-observance-required",
    "a VTIMEZONE needs a TZID and an observance",
    () => {
      expect(message(zoneOf("TZID:Empty"))).toMatch(/no rules/);
      expect(message(zoneOf(...observance("STANDARD", "+0100", "+0100", "19700101T000000")))).toMatch(
        /no TZID/,
      );
    },
  );

  itReq(
    "RFC5545:3.6.5:observance-required-props",
    "an observance needs DTSTART, TZOFFSETFROM and TZOFFSETTO",
    () => {
      const without = (drop: string): string[] =>
        observance("STANDARD", "+0100", "+0200", "19700101T000000").filter((l) => !l.startsWith(drop));
      expect(message(zoneOf("TZID:X", ...without("TZOFFSETTO")))).toMatch(/TZOFFSETTO/);
      expect(message(zoneOf("TZID:X", ...without("TZOFFSETFROM")))).toMatch(/TZOFFSETFROM/);
      expect(message(zoneOf("TZID:X", ...without("DTSTART")))).toMatch(/DTSTART/);
    },
  );

  itReq("RFC5545:3.6.5:observance-dtstart-local", "the DTSTART of an observance is local time", () => {
    const withStart = (line: string): string[] => [
      "TZID:X",
      "BEGIN:STANDARD",
      line,
      "TZOFFSETFROM:+0100",
      "TZOFFSETTO:+0100",
      "END:STANDARD",
    ];
    expect(Result.isSuccess(zoneOf(...withStart("DTSTART:19671029T020000")))).toBe(true);
    expect(message(zoneOf(...withStart("DTSTART:19671029T020000Z")))).toMatch(/local date-time/);
    expect(message(zoneOf(...withStart("DTSTART;TZID=Europe/Berlin:19671029T020000")))).toMatch(
      /local date-time/,
    );
  });

  itReq(
    "RFC5545:3.3.10:until-utc-in-vtimezone-observance",
    "a non-UTC UNTIL in an observance is rejected",
    () => {
      const rule = (until: string): string[] => [
        "TZID:X",
        ...observance(
          "DAYLIGHT",
          "-0500",
          "-0400",
          "19670430T020000",
          `RRULE:FREQ=YEARLY;BYMONTH=4;BYDAY=-1SU;UNTIL=${until}`,
        ),
      ];
      expect(Result.isSuccess(zoneOf(...rule("19730429T070000Z")))).toBe(true);
      expect(message(zoneOf(...rule("19730429T020000")))).toMatch(
        /UNTIL of a VTIMEZONE observance rule must be a UTC/,
      );
      expect(message(zoneOf(...rule("19730429")))).toMatch(
        /UNTIL of a VTIMEZONE observance rule must be a UTC/,
      );
    },
  );

  itReq("RFC5545:3.6.5:offset-from-last-onset", "the offset is the TZOFFSETTO of the last onset", () => {
    const zone = zoneOf(...newYork);
    expect(offsetAt(zone, "2007-07-01T12:00:00Z")).toBe(-240);
    expect(offsetAt(zone, "2007-12-01T12:00:00Z")).toBe(-300);
    expect(
      Result.isSuccess(zone) &&
        new Date(
          wallToInstant(zone.success, { year: 2007, month: 7, day: 1, hour: 9, minute: 0, second: 0 }),
        ).toISOString(),
    ).toBe("2007-07-01T13:00:00.000Z");
  });

  itReq(
    "RFC5545:3.6.5:observance-rrule-uses-tzoffsetfrom",
    "an onset is local time in the offset before it",
    () => {
      const zone = zoneOf(...newYork);
      // DAYLIGHT 2007-03-11 02:00 with TZOFFSETFROM -0500 is 07:00Z
      expect(offsetAt(zone, "2007-03-11T06:59:59Z")).toBe(-300);
      expect(offsetAt(zone, "2007-03-11T07:00:00Z")).toBe(-240);
      // STANDARD 2007-11-04 02:00 with TZOFFSETFROM -0400 is 06:00Z
      expect(offsetAt(zone, "2007-11-04T05:59:59Z")).toBe(-240);
      expect(offsetAt(zone, "2007-11-04T06:00:00Z")).toBe(-300);
    },
  );

  itReq(
    "RFC5545:3.6.5:observance-until-last-onset-utc",
    "no onset follows the UNTIL of an observance",
    () => {
      const zone = zoneOf(
        "TZID:Test/Until",
        ...observance(
          "STANDARD",
          "-0400",
          "-0500",
          "19671029T020000",
          "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
        ),
        ...observance(
          "DAYLIGHT",
          "-0500",
          "-0400",
          "19670430T020000",
          "RRULE:FREQ=YEARLY;BYMONTH=4;BYDAY=-1SU;UNTIL=19730429T070000Z",
        ),
      );
      expect(offsetAt(zone, "1973-07-01T12:00:00Z")).toBe(-240);
      // no DAYLIGHT onset in April 1974: it stays standard time all year
      expect(offsetAt(zone, "1974-07-01T12:00:00Z")).toBe(-300);
    },
  );

  itReq(
    "RFC5545:3.6.5:observance-rdate-local-relative-tzoffsetfrom",
    "an RDATE onset is local time in TZOFFSETFROM",
    () => {
      const zone = zoneOf(
        "TZID:Test/Rdate",
        ...observance("DAYLIGHT", "-0500", "-0400", "19740106T020000", "RDATE:19750223T020000"),
        ...observance("STANDARD", "-0400", "-0500", "19741027T020000"),
      );
      expect(offsetAt(zone, "1975-02-23T06:59:59Z")).toBe(-300);
      expect(offsetAt(zone, "1975-02-23T07:00:00Z")).toBe(-240);
    },
  );

  it("reads a Customized Time Zone of Outlook (DTSTART 1601, yearly last Sunday rules)", () => {
    const zone = zoneOf(
      "TZID:Customized Time Zone",
      ...observance(
        "STANDARD",
        "+0200",
        "+0100",
        "16011028T030000",
        "RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=10",
      ),
      ...observance(
        "DAYLIGHT",
        "+0100",
        "+0200",
        "16010325T020000",
        "RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=3",
      ),
    );
    expect(offsetAt(zone, "2024-01-15T12:00:00Z")).toBe(60);
    expect(offsetAt(zone, "2024-07-15T12:00:00Z")).toBe(120);
    expect(offsetAt(zone, "2024-03-31T00:59:59Z")).toBe(60);
    expect(offsetAt(zone, "2024-03-31T01:00:00Z")).toBe(120);
    expect(offsetAt(zone, "2024-10-27T00:59:59Z")).toBe(120);
    expect(offsetAt(zone, "2024-10-27T01:00:00Z")).toBe(60);
  });

  it("reads a Customized Time Zone inside an event file", () => {
    const lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//test//EN",
      "BEGIN:VTIMEZONE",
      "TZID:Customized Time Zone",
      ...observance(
        "STANDARD",
        "+0200",
        "+0100",
        "16011028T030000",
        "RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=10",
      ),
      ...observance(
        "DAYLIGHT",
        "+0100",
        "+0200",
        "16010325T020000",
        "RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=3",
      ),
      "END:VTIMEZONE",
      "BEGIN:VEVENT",
      "UID:u",
      "DTSTAMP:20240101T000000Z",
      'DTSTART;TZID="Customized Time Zone":20240701T100000',
      "END:VEVENT",
      "END:VCALENDAR",
    ];
    const r = occurrencesIn(
      lines,
      Date.parse("2024-01-01T00:00:00Z"),
      Date.parse("2025-01-01T00:00:00Z"),
      "UTC",
    );
    expect(Result.isSuccess(r) && r.success.map((i) => new Date(i.start).toISOString())).toEqual([
      "2024-07-01T08:00:00.000Z",
    ]);
  });
});

describe("RFC 5545 3.3.14 UTC-OFFSET", () => {
  const offsetTo = (value: string): Result.Result<Zone, { message: string }> =>
    zoneOf("TZID:X", ...observance("STANDARD", "+0000", value, "19700101T000000"));

  itReq("RFC5545:3.3.14:utc-offset-plus-for-positive", "a positive offset is written with +", () => {
    expect(offsetAt(offsetTo("+0100"), "2024-01-01T00:00:00Z")).toBe(60);
    expect(message(offsetTo("0100"))).toMatch(/TZOFFSETTO/);
  });

  itReq("RFC5545:3.3.14:utc-offset-minus-for-negative", "a negative offset is written with -", () => {
    const zone = zoneOf("TZID:X", ...observance("STANDARD", "-0500", "-0500", "19700101T000000"));
    expect(offsetAt(zone, "2024-01-01T00:00:00Z")).toBe(-300);
  });

  itReq("RFC5545:3.3.14:utc-offset-minus-zero-invalid", "-0000 is rejected, +0000 is UTC", () => {
    expect(message(offsetTo("-0000"))).toMatch(/zero offset is written \+0000/);
    expect(message(offsetTo("-000000"))).toMatch(/zero offset is written \+0000/);
    expect(offsetAt(offsetTo("+0000"), "2024-01-01T00:00:00Z")).toBe(0);
  });

  itReq("RFC5545:3.3.14:utc-offset-seconds-not-60", "seconds are below 60; +0530 equals +053000", () => {
    expect(message(offsetTo("+010060"))).toMatch(/below 60/);
    expect(offsetAt(offsetTo("+0530"), "2024-01-01T00:00:00Z")).toBe(
      offsetAt(offsetTo("+053000"), "2024-01-01T00:00:00Z"),
    );
    expect(offsetAt(offsetTo("+0530"), "2024-01-01T00:00:00Z")).toBe(330);
  });
});

describe("RFC 5545 3.2.19 TZID resolution", () => {
  const fixed = (tzid: string, offset: string): ICAL.Component =>
    vtimezone(`TZID:${tzid}`, ...observance("STANDARD", offset, offset, "19700101T000000"));

  itReq(
    "RFC5545:3.2.19:missing-vtimezone-inconsistent",
    "without a VTIMEZONE a TZID is an IANA name or a known Windows name; everything else is reported",
    () => {
      expect(Result.isSuccess(resolveZone("Europe/Berlin", []))).toBe(true);
      expect(Result.isSuccess(resolveZone("W. Europe Standard Time", []))).toBe(true);
      expect(message(resolveZone("Mars/Olympus", []))).toMatch(/unknown time zone "Mars\/Olympus"/);
      expect(message(resolveZone("GMT+0100", []))).toMatch(/unknown time zone "GMT\+0100"/);
      expect(message(resolveZone("+01:00", []))).toMatch(/unknown time zone "\+01:00"/);
    },
  );

  it("tolerates a Windows time zone name without VTIMEZONE (CLDR names)", () => {
    expect(WINDOWS_ZONES["W. Europe Standard Time"]).toBe("Europe/Berlin");
    expect(offsetAt(resolveZone("W. Europe Standard Time", []), "2024-07-01T00:00:00Z")).toBe(120);
    expect(offsetAt(resolveZone("W. Europe Standard Time", []), "2024-01-01T00:00:00Z")).toBe(60);
  });

  it("reports a TZID=GMT+0100 style name unless the file defines it", () => {
    expect(message(resolveZone("GMT+0100", []))).not.toBe("");
    expect(offsetAt(resolveZone("GMT+0100", [fixed("GMT+0100", "+0100")]), "2024-07-01T00:00:00Z")).toBe(60);
  });

  it("accepts legacy IANA aliases through the tz database", () => {
    expect(offsetAt(resolveZone("US/Eastern", []), "2024-07-01T00:00:00Z")).toBe(-240);
    expect(offsetAt(resolveZone("Europe/Kiev", []), "2024-07-01T00:00:00Z")).toBe(180);
  });

  it("lets the VTIMEZONE of the file win over a newer tz database (stale definitions)", () => {
    // a file written when Europe/Berlin had no summer time
    const stale = fixed("Europe/Berlin", "+0100");
    expect(offsetAt(resolveZone("Europe/Berlin", [stale]), "2024-07-01T00:00:00Z")).toBe(60);
    expect(offsetAt(resolveZone("Europe/Berlin", []), "2024-07-01T00:00:00Z")).toBe(120);
  });

  it("matches the TZID against the TZID of a VTIMEZONE exactly", () => {
    expect(
      message(resolveZone("/example.org/America/New_York", [fixed("America/New_York", "-0500")])),
    ).toMatch(/unknown time zone/);
    expect(
      offsetAt(
        resolveZone("/example.org/America/New_York", [fixed("/example.org/America/New_York", "-0500")]),
        "2024-07-01T00:00:00Z",
      ),
    ).toBe(-300);
  });
});

describe("zone fixtures", () => {
  const at = (tzid: string, utc: string): number => offsetAt(resolveZone(tzid, []), utc);

  it("Europe/Berlin", () => {
    expect([
      at("Europe/Berlin", "2024-01-15T12:00:00Z"),
      at("Europe/Berlin", "2024-07-15T12:00:00Z"),
    ]).toEqual([60, 120]);
  });

  it("America/New_York", () => {
    expect([
      at("America/New_York", "2024-01-15T12:00:00Z"),
      at("America/New_York", "2024-07-15T12:00:00Z"),
    ]).toEqual([-300, -240]);
  });

  it("Asia/Kolkata has a half-hour offset and no DST", () => {
    expect([at("Asia/Kolkata", "2024-01-15T12:00:00Z"), at("Asia/Kolkata", "2024-07-15T12:00:00Z")]).toEqual([
      330, 330,
    ]);
  });

  it("Asia/Kathmandu has a 45-minute offset", () => {
    expect(at("Asia/Kathmandu", "2024-07-15T12:00:00Z")).toBe(345);
  });

  it("Australia/Lord_Howe has a half-hour DST change", () => {
    expect(at("Australia/Lord_Howe", "2024-01-15T12:00:00Z")).toBe(660);
    expect(at("Australia/Lord_Howe", "2024-07-15T12:00:00Z")).toBe(630);
    // 2024-10-06 02:00 does not exist (the clock jumps to 02:30): read with the offset before the gap
    const r = occurrencesIn(
      [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//test//EN",
        "BEGIN:VEVENT",
        "UID:u",
        "DTSTAMP:20240101T000000Z",
        "DTSTART;TZID=Australia/Lord_Howe:20241006T021500",
        "END:VEVENT",
        "END:VCALENDAR",
      ],
      Date.parse("2024-01-01T00:00:00Z"),
      Date.parse("2025-01-01T00:00:00Z"),
      "UTC",
    );
    expect(Result.isSuccess(r) && r.success.map((i) => new Date(i.start).toISOString())).toEqual([
      "2024-10-05T15:45:00.000Z",
    ]);
  });

  it("Pacific/Auckland is ahead of UTC in both seasons", () => {
    expect([
      at("Pacific/Auckland", "2024-01-15T12:00:00Z"),
      at("Pacific/Auckland", "2024-07-15T12:00:00Z"),
    ]).toEqual([780, 720]);
  });
});
