import ICAL from "ical.js";
import { describe, expect, it } from "vitest";
import { failure, unwrap } from "./testlib.js";
import { ianaZone, type Zone, zoneFromVtimezone } from "./timezone.js";
import { isUtcName, vtimezone } from "./vtimezone.js";

const DAY = 86_400_000;

const text = (name: string): string => unwrap(vtimezone(name)).lines.join("\r\n");

/** The zone a consumer reads from the generated VTIMEZONE. */
const generated = (name: string): Zone => {
  const ics = ["BEGIN:VCALENDAR", ...unwrap(vtimezone(name)).lines, "END:VCALENDAR"].join("\r\n");
  const component = new ICAL.Component(ICAL.parse(ics)).getFirstSubcomponent("vtimezone");
  return unwrap(zoneFromVtimezone(component!));
};

/** Noon UTC of every `step` days from `from`. */
const days = (from: number, count: number, step = 3): number[] =>
  Array.from({ length: count }, (_, i) => from + i * step * DAY);

/** The generated zone gives the offsets of the IANA zone at these instants. */
const sameOffsets = (name: string, instants: readonly number[]): void => {
  const real = unwrap(ianaZone(name));
  const made = generated(name);
  for (const ms of instants) expect([ms, made.offsetMinutes(ms)]).toEqual([ms, real.offsetMinutes(ms)]);
};

const year2026 = days(Date.UTC(2026, 0, 1, 12), 122);

describe("Europe/Berlin", () => {
  it("has the current rules: last Sunday of March and October, open ended", () => {
    const t = text("Europe/Berlin");
    expect(t).toContain("TZID:Europe/Berlin");
    expect(t).toContain(
      "BEGIN:DAYLIGHT\r\nDTSTART:19960331T020000\r\nTZOFFSETFROM:+0100\r\nTZOFFSETTO:+0200\r\nRRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU\r\nEND:DAYLIGHT",
    );
    expect(t).toContain(
      "BEGIN:STANDARD\r\nDTSTART:19961027T030000\r\nTZOFFSETFROM:+0200\r\nTZOFFSETTO:+0100\r\nRRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU\r\nEND:STANDARD",
    );
  });

  it("bounds the older rules (October used to be September) with a UTC UNTIL", () => {
    expect(text("Europe/Berlin")).toMatch(/BYMONTH=9;BYDAY=-1SU;UNTIL=1995\d{4}T000000Z/);
  });

  it("yields the right offsets across a year, in the past and in the future", () => {
    sameOffsets("Europe/Berlin", year2026);
    sameOffsets("Europe/Berlin", days(Date.UTC(1985, 0, 1, 12), 122));
    sameOffsets("Europe/Berlin", days(Date.UTC(1975, 0, 1, 12), 20, 30));
    sameOffsets("Europe/Berlin", days(Date.UTC(2040, 0, 1, 12), 122));
  });

  it("is well formed and the first line is BEGIN:VTIMEZONE", () => {
    const { lines } = unwrap(vtimezone("Europe/Berlin"));
    expect(lines[0]).toBe("BEGIN:VTIMEZONE");
    expect(lines[lines.length - 1]).toBe("END:VTIMEZONE");
  });
});

describe("America/New_York", () => {
  it("has the rules since 2007: second Sunday of March, first Sunday of November", () => {
    const t = text("America/New_York");
    expect(t).toContain(
      "BEGIN:DAYLIGHT\r\nDTSTART:20070311T020000\r\nTZOFFSETFROM:-0500\r\nTZOFFSETTO:-0400\r\nRRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU\r\nEND:DAYLIGHT",
    );
    expect(t).toContain(
      "BEGIN:STANDARD\r\nDTSTART:20071104T020000\r\nTZOFFSETFROM:-0400\r\nTZOFFSETTO:-0500\r\nRRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU\r\nEND:STANDARD",
    );
  });

  it("yields the right offsets across a year, before 2007 and in the future", () => {
    sameOffsets("America/New_York", year2026);
    sameOffsets("America/New_York", days(Date.UTC(2000, 0, 1, 12), 122));
    sameOffsets("America/New_York", days(Date.UTC(2050, 0, 1, 12), 122));
  });
});

describe("Asia/Kolkata", () => {
  it("is a fixed-offset stub without rules", () => {
    const { lines } = unwrap(vtimezone("Asia/Kolkata"));
    expect(lines).toEqual([
      "BEGIN:VTIMEZONE",
      "TZID:Asia/Kolkata",
      "BEGIN:STANDARD",
      "DTSTART:19700101T000000",
      "TZOFFSETFROM:+0530",
      "TZOFFSETTO:+0530",
      "END:STANDARD",
      "END:VTIMEZONE",
    ]);
  });

  it("yields +05:30 all year", () => {
    sameOffsets("Asia/Kolkata", year2026);
    expect(generated("Asia/Kolkata").offsetMinutes(year2026[0]!)).toBe(330);
  });
});

describe("Australia/Lord_Howe", () => {
  it("has the 30 minute daylight saving rule of the southern hemisphere", () => {
    const t = text("Australia/Lord_Howe");
    expect(t).toContain(
      "TZOFFSETFROM:+1030\r\nTZOFFSETTO:+1100\r\nRRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=1SU\r\nEND:DAYLIGHT",
    );
    expect(t).toContain(
      "TZOFFSETFROM:+1100\r\nTZOFFSETTO:+1030\r\nRRULE:FREQ=YEARLY;BYMONTH=4;BYDAY=1SU\r\nEND:STANDARD",
    );
  });

  it("yields +10:30 and +11:00 at the right times of the year", () => {
    sameOffsets("Australia/Lord_Howe", year2026);
    sameOffsets("Australia/Lord_Howe", days(Date.UTC(2045, 0, 1, 12), 122));
    const made = generated("Australia/Lord_Howe");
    expect(made.offsetMinutes(Date.UTC(2026, 0, 15))).toBe(660);
    expect(made.offsetMinutes(Date.UTC(2026, 6, 15))).toBe(630);
  });
});

describe("zones with date-dependent rules (no yearly RRULE)", () => {
  /** Every 4 days from 2038 to 2100 (the old generator stopped following DST after 2037). */
  const late = days(Date.UTC(2038, 0, 1, 12), 5_700, 4).filter((ms) => ms < Date.UTC(2100, 11, 31));
  const offsetsOf = (name: string, year: number, month: number): number =>
    unwrap(ianaZone(name)).offsetMinutes(Date.UTC(year, month, 15, 12));

  it("Asia/Jerusalem: Friday before the last Sunday of March is listed as RDATE through 2100", () => {
    const t = text("Asia/Jerusalem");
    expect(t).toContain("RDATE:");
    // DST really goes on in 2090 (reference: the IANA zone), and so does the generated zone
    expect(offsetsOf("Asia/Jerusalem", 2090, 0)).toBe(120);
    expect(offsetsOf("Asia/Jerusalem", 2090, 6)).toBe(180);
    const made = generated("Asia/Jerusalem");
    expect(made.offsetMinutes(Date.UTC(2090, 0, 15, 12))).toBe(120);
    expect(made.offsetMinutes(Date.UTC(2090, 6, 15, 12))).toBe(180);
    sameOffsets("Asia/Jerusalem", late);
    sameOffsets("Asia/Jerusalem", days(Date.UTC(2020, 0, 1, 12), 122));
  });

  it("America/Santiago, America/Asuncion, Africa/Cairo and Africa/Casablanca follow the IANA zone after 2037", () => {
    for (const name of ["America/Santiago", "America/Asuncion", "Africa/Cairo", "Africa/Casablanca"]) {
      sameOffsets(name, late);
      sameOffsets(name, days(Date.UTC(2050, 0, 1, 12), 122, 3));
    }
    expect(offsetsOf("America/Santiago", 2090, 0)).not.toBe(offsetsOf("America/Santiago", 2090, 6));
    expect(generated("America/Santiago").offsetMinutes(Date.UTC(2090, 0, 15, 12))).toBe(
      offsetsOf("America/Santiago", 2090, 0),
    );
  });

  it("writes long RDATE lists in lines of a few dates", () => {
    const rdates = unwrap(vtimezone("Asia/Jerusalem")).lines.filter((l) => l.startsWith("RDATE:"));
    expect(rdates.length).toBeGreaterThan(1);
    expect(rdates.every((l) => l.split(",").length <= 4)).toBe(true);
  });

  it("keeps the yearly RRULE for zones whose rule repeats, open ended, through 2100", () => {
    const t = text("Europe/Berlin");
    expect(t).not.toContain("RDATE");
    expect(t).not.toMatch(/UNTIL=20[3-9]\d/);
    sameOffsets("Europe/Berlin", late);
    sameOffsets("America/New_York", late);
  });
});

describe("UTC", () => {
  it("has no VTIMEZONE: its times are written with Z", () => {
    expect(unwrap(vtimezone("UTC"))).toEqual({ tzid: "UTC", lines: [] });
    expect(unwrap(vtimezone("Etc/UTC")).lines).toEqual([]);
    expect(unwrap(vtimezone(" Zulu ")).lines).toEqual([]);
  });

  it("knows its aliases and nothing else", () => {
    expect(isUtcName("utc")).toBe(true);
    expect(isUtcName("Etc/GMT")).toBe(true);
    expect(isUtcName("Europe/London")).toBe(false);
  });
});

describe("other zones", () => {
  it("handles a zone whose rules changed over the years (Europe/London, Pacific/Auckland)", () => {
    sameOffsets("Europe/London", days(Date.UTC(1972, 0, 1, 12), 400, 30));
    sameOffsets("Pacific/Auckland", days(Date.UTC(2026, 0, 1, 12), 122));
  });

  it("handles a zone whose offset changed once (Europe/Istanbul)", () => {
    sameOffsets("Europe/Istanbul", days(Date.UTC(2014, 0, 1, 12), 300, 10));
  });

  it("uses the canonical spelling of the name when only the case differs", () => {
    expect(unwrap(vtimezone("europe/berlin")).tzid).toBe("Europe/Berlin");
    expect(unwrap(vtimezone(" America/New_York ")).tzid).toBe("America/New_York");
  });

  it("rejects names that are not IANA zones", () => {
    expect(failure(vtimezone("Mars/Olympus"))._tag).toBe("InvalidInput");
    expect(failure(vtimezone(""))._tag).toBe("InvalidInput");
    expect(failure(vtimezone("+01:00"))._tag).toBe("InvalidInput");
  });
});
