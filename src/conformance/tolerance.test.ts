import { Result } from "effect";
import { describe, expect, it } from "vitest";
import { occurrencesIn } from "../expand.js";

// The deviations from RFC 5545 the reader tolerates (each documented in src/expand.ts or
// src/timezone.ts). Everything else non-standard is reported, see expansion.test.ts.

const starts = (lines: string[]): string[] => {
  const r = occurrencesIn(
    lines,
    Date.parse("2000-01-01T00:00:00Z"),
    Date.parse("2040-01-01T00:00:00Z"),
    "UTC",
  );
  return Result.isSuccess(r)
    ? r.success.map((i) => new Date(i.start).toISOString().slice(0, 16))
    : [r.failure.message];
};

const wrap = (...body: string[]): string[] => [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//t//EN",
  ...body,
  "END:VCALENDAR",
];

describe("tolerated deviations of the reader", () => {
  it("tolerates lowercase property names", () => {
    const l = wrap(
      "begin:vevent",
      "uid:u1",
      "dtstart:20240101T100000Z",
      "rrule:FREQ=DAILY;COUNT=2",
      "end:vevent",
    );
    expect(starts(l)).toEqual(["2024-01-01T10:00", "2024-01-02T10:00"]);
  });

  it("tolerates a tab fold of a long line", () => {
    const l = wrap("BEGIN:VEVENT", "UID:u1", "DTSTART:2024010", "\t1T100000Z", "END:VEVENT");
    expect(starts(l)).toEqual(["2024-01-01T10:00"]);
  });
});
