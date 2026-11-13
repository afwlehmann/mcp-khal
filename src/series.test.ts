import { describe, expect, it } from "vitest";
import { parseProp } from "./ics.js";
import {
  compactDate,
  dateMs,
  dayOf,
  formatWall,
  listedDates,
  parseWall,
  recurrenceId,
  ruleCount,
  untilBefore,
  withCount,
  withUntil,
} from "./series.js";
import { failure, unwrap } from "./testlib.js";

describe("wall clock values", () => {
  it("parses and formats dates, local and UTC times", () => {
    for (const v of ["20301016", "20301016T090000", "20301016T090000Z"]) {
      const w = parseWall(v);
      expect(w).toBeDefined();
      expect(formatWall(w ?? { ms: 0, hasTime: false, utc: false })).toBe(v);
    }
    expect(parseWall("20301016T090000Z")).toMatchObject({ hasTime: true, utc: true });
    expect(parseWall("20301016")).toMatchObject({ hasTime: false, utc: false });
    expect(parseWall("tomorrow")).toBeUndefined();
  });

  it("accepts only real dates", () => {
    expect(compactDate("2030-03-04")).toBe("20300304");
    expect(compactDate(" 2030-03-04 ")).toBe("20300304");
    expect(compactDate("2030-02-31")).toBeUndefined();
    expect(compactDate("4 March")).toBeUndefined();
  });

  it("splits a value into its day and time of day", () => {
    const w = parseWall("20301016T093000");
    expect(w && w.ms - dayOf(w)).toBe(9.5 * 3_600_000);
    expect(dateMs("20301016")).toBe(Date.UTC(2030, 9, 16));
  });
});

describe("untilBefore: one second before the occurrence of that day", () => {
  const until = (prop: string, date: string) => unwrap(untilBefore(parseProp(prop), date));

  it("is a floating time for a floating start and UTC for a UTC start", () => {
    expect(until("DTSTART:20301016T090000", "20301023")).toBe("20301023T085959");
    expect(until("DTSTART:20301016T090000Z", "20301023")).toBe("20301023T085959Z");
  });

  it("is a date for an all-day start", () => {
    expect(until("DTSTART;VALUE=DATE:20301016", "20301023")).toBe("20301022");
  });

  it("converts a zoned start to UTC, with the offset of that day (summer and winter time)", () => {
    expect(until("DTSTART;TZID=Europe/Berlin:20300916T090000", "20300923")).toBe("20300923T065959Z");
    expect(until("DTSTART;TZID=Europe/Berlin:20300916T090000", "20301223")).toBe("20301223T075959Z");
    expect(until('DTSTART;TZID="America/New_York":20300916T090000', "20301223")).toBe("20301223T135959Z");
  });

  it("rejects an unknown zone and an unreadable start", () => {
    expect(
      failure(untilBefore(parseProp("DTSTART;TZID=Mars/Base:20301016T090000"), "20301023")).message,
    ).toMatch(/unknown time zone 'Mars\/Base'/);
    expect(failure(untilBefore(parseProp("DTSTART:soon"), "20301023")).message).toMatch(
      /cannot read DTSTART/,
    );
  });
});

describe("rules", () => {
  it("reads COUNT and replaces the end of a rule", () => {
    expect(ruleCount("FREQ=DAILY;COUNT=5")).toBe(5);
    expect(ruleCount("FREQ=DAILY")).toBeUndefined();
    expect(withUntil("FREQ=WEEKLY;BYDAY=MO;COUNT=5", "20301023T085959Z")).toBe(
      "FREQ=WEEKLY;BYDAY=MO;UNTIL=20301023T085959Z",
    );
    expect(withUntil("FREQ=DAILY;UNTIL=20400101", "20301023")).toBe("FREQ=DAILY;UNTIL=20301023");
    expect(withCount("FREQ=DAILY;UNTIL=20400101", 3)).toBe("FREQ=DAILY;COUNT=3");
  });
});

describe("exceptions", () => {
  it("lists the dates of EXDATE and RDATE values", () => {
    const event = [
      "BEGIN:VEVENT",
      "EXDATE:20301017T090000,20301018T090000",
      "RDATE;VALUE=DATE:20301101",
      "END:VEVENT",
    ];
    expect(listedDates(event)).toEqual(["20301017", "20301018", "20301101"]);
  });

  it("builds the RECURRENCE-ID shaped like DTSTART", () => {
    const id = (p: string) => recurrenceId(parseProp(p), "20301023");
    expect(id("DTSTART;TZID=Europe/Berlin:20301016T090000")).toBe(
      "RECURRENCE-ID;TZID=Europe/Berlin:20301023T090000",
    );
    expect(id("DTSTART:20301016T090000Z")).toBe("RECURRENCE-ID:20301023T090000Z");
    expect(id("DTSTART;VALUE=DATE:20301016")).toBe("RECURRENCE-ID;VALUE=DATE:20301023");
    expect(id("DTSTART:soon")).toBeUndefined();
  });
});
