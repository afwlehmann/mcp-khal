import { Result } from "effect";
import { describe, expect, it } from "vitest";
import { type EventTimes, MAX_SPAN_DAYS, parseDuration, parseEventTimes, parseRange } from "./range.js";

const ok = <A>(r: Result.Result<A, unknown>): A | undefined =>
  Result.match(r, { onFailure: () => undefined, onSuccess: (a) => a });
const msg = (r: Result.Result<unknown, { message: string }>): string =>
  Result.match(r, { onFailure: (e) => e.message, onSuccess: () => "" });

const BERLIN = "Europe/Berlin";
// 00:30 on 2026-11-15 in Berlin, still 2026-11-14 in UTC
const NOW = new Date("2026-11-14T23:30:00Z");

const dates = (input: string, now = NOW, zone = BERLIN) => {
  const r = ok(parseRange(input, now, zone));
  return r === undefined ? undefined : [r.fromDate, r.toDate];
};

describe("parseRange", () => {
  it("defaults to today and the next 7 days, today taken in the host zone", () => {
    expect(dates("")).toEqual(["2026-11-15", "2026-11-22"]);
    expect(dates("  ")).toEqual(["2026-11-15", "2026-11-22"]);
    expect(dates("", NOW, "UTC")).toEqual(["2026-11-14", "2026-11-21"]);
  });

  it("single days", () => {
    expect(dates("today")).toEqual(["2026-11-15", "2026-11-16"]);
    expect(dates("Tomorrow")).toEqual(["2026-11-16", "2026-11-17"]);
    expect(dates("2026-12-31")).toEqual(["2026-12-31", "2027-01-01"]);
    expect(dates("2028-02-29")).toEqual(["2028-02-29", "2028-03-01"]);
  });

  it("two days, the end is exclusive", () => {
    expect(dates("2026-11-02 2026-11-09")).toEqual(["2026-11-02", "2026-11-09"]);
    expect(dates("today tomorrow")).toEqual(["2026-11-15", "2026-11-16"]);
    expect(dates("2026-11-01  today")).toEqual(["2026-11-01", "2026-11-15"]);
  });

  it("a number of days", () => {
    expect(dates("today 7d")).toEqual(["2026-11-15", "2026-11-22"]);
    expect(dates("2026-12-30 3d")).toEqual(["2026-12-30", "2027-01-02"]);
    expect(dates("tomorrow 1d")).toEqual(["2026-11-16", "2026-11-17"]);
  });

  it("gives instants at the start of the days in the zone", () => {
    const r = ok(parseRange("2026-11-15", NOW, BERLIN));
    expect(r?.from.toISOString()).toBe("2026-11-14T23:00:00.000Z");
    expect(r?.to.toISOString()).toBe("2026-11-15T23:00:00.000Z");
    expect(r?.zone).toBe(BERLIN);
  });

  it("is DST-safe: calendar days, not 24 hours", () => {
    const spring = ok(parseRange("2026-03-29", NOW, BERLIN));
    expect((spring?.to.getTime() ?? 0) - (spring?.from.getTime() ?? 0)).toBe(23 * 3600_000);
    const autumn = ok(parseRange("2026-10-25", NOW, BERLIN));
    expect((autumn?.to.getTime() ?? 0) - (autumn?.from.getTime() ?? 0)).toBe(25 * 3600_000);
    expect(dates("2026-10-24 7d")).toEqual(["2026-10-24", "2026-10-31"]);
    const week = ok(parseRange("2026-03-25 7d", NOW, BERLIN));
    expect(week?.to.toISOString()).toBe("2026-03-31T22:00:00.000Z");
  });

  it("rejects an empty or backwards range", () => {
    expect(msg(parseRange("2026-11-09 2026-11-09", NOW, BERLIN))).toContain("must end after it starts");
    expect(msg(parseRange("2026-11-09 2026-11-02", NOW, BERLIN))).toContain("must end after it starts");
    expect(msg(parseRange("tomorrow today", NOW, BERLIN))).toContain("must end after");
  });

  it("rejects absurd spans", () => {
    expect(msg(parseRange("2000-01-01 2026-01-01", NOW, BERLIN))).toContain("at most 3660 days");
    expect(msg(parseRange(`today ${MAX_SPAN_DAYS + 1}d`, NOW, BERLIN))).toContain("too long");
    expect(dates(`today ${MAX_SPAN_DAYS}d`)).toBeDefined();
    expect(msg(parseRange("2000-01-01 2010-06-01", NOW, BERLIN))).toContain("days long");
  });

  it("rejects junk", () => {
    for (const junk of [
      "next week",
      "yesterday",
      "2026-13-01",
      "2026-02-30",
      "11/02/2026",
      "2026-11-02T10:00",
      "today 0d",
      "today -1d",
      "today 7days",
      "today tomorrow today",
      "2026-11-02 junk",
      "today; rm -rf",
      "--help",
    ]) {
      expect(Result.isFailure(parseRange(junk, NOW, BERLIN)), junk).toBe(true);
    }
    expect(msg(parseRange("junk", NOW, BERLIN))).toContain("is not a range");
    expect(msg(parseRange("today 0d", NOW, BERLIN))).toContain("at least 1d");
  });

  it("rejects an unknown zone", () => {
    expect(msg(parseRange("today", NOW, "Mars/Base"))).toContain("not an IANA time zone");
  });

  it("rejects dates outside the supported years", () => {
    expect(Result.isFailure(parseRange("9999-12-31", NOW, "UTC"))).toBe(true);
  });
});

describe("parseDuration", () => {
  it("days, hours, minutes", () => {
    expect(ok(parseDuration("1h"))).toEqual({ days: 0, hours: 1, minutes: 0 });
    expect(ok(parseDuration(" 30M "))).toEqual({ days: 0, hours: 0, minutes: 30 });
    expect(ok(parseDuration("1h30m"))).toEqual({ days: 0, hours: 1, minutes: 30 });
    expect(ok(parseDuration("2d"))).toEqual({ days: 2, hours: 0, minutes: 0 });
    expect(ok(parseDuration("1d2h5m"))).toEqual({ days: 1, hours: 2, minutes: 5 });
  });

  it("rejects junk, zero and absurd values", () => {
    for (const bad of ["", "h", "1x", "-1h", "1h1d", "1.5h", "PT1H", "0m", "0d0h"])
      expect(Result.isFailure(parseDuration(bad)), bad).toBe(true);
    expect(msg(parseDuration("0m"))).toContain("zero");
    expect(msg(parseDuration("99999d"))).toContain("too long");
    expect(msg(parseDuration("x"))).toContain("is not a duration");
  });
});

const times = (
  start: string,
  extra: { end?: string; duration?: string; zone?: string } = {},
): EventTimes | undefined => ok(parseEventTimes({ start, ...extra }, BERLIN));

describe("parseEventTimes, all-day", () => {
  it("defaults to one day", () => {
    expect(times("2026-11-20")).toEqual({ allDay: true, startDate: "2026-11-20", endDate: "2026-11-21" });
  });

  it("end is inclusive in the input and exclusive in the result", () => {
    expect(times("2026-11-20", { end: "2026-11-22" })).toEqual({
      allDay: true,
      startDate: "2026-11-20",
      endDate: "2026-11-23",
    });
    expect(times("2026-12-31", { end: "2026-12-31" })).toEqual({
      allDay: true,
      startDate: "2026-12-31",
      endDate: "2027-01-01",
    });
  });

  it("duration in whole days", () => {
    expect(times("2026-11-20", { duration: "3d" })).toMatchObject({ endDate: "2026-11-23" });
  });

  it("rejects wrong combinations", () => {
    const r = (start: string, extra: { end?: string; duration?: string; zone?: string }) =>
      msg(parseEventTimes({ start, ...extra }, BERLIN));
    expect(r("2026-11-20", { end: "2026-11-19" })).toContain("before start");
    expect(r("2026-11-20", { end: "2026-11-21T10:00" })).toContain("end must be a date");
    expect(r("2026-11-20", { duration: "2h" })).toContain("whole days");
    expect(r("2026-11-20", { duration: "1d30m" })).toContain("whole days");
    expect(r("2026-11-20", { duration: "x" })).toContain("not a duration");
    expect(r("2026-11-20", { zone: BERLIN })).toContain("zone only applies");
    expect(r("2026-11-20", { end: "2026-11-21", duration: "1d" })).toContain("either end or duration");
    expect(r("2026-02-30", {})).toContain("not a date");
    expect(r("2026-11-20", { end: "2026-02-30" })).toContain("not a date");
    expect(r("2026-11-20", { duration: "3660d" })).toBe("");
    expect(r("2026-11-20", { duration: "3661d" })).toContain("too long");
    expect(r("2000-01-01", { end: "2030-01-01" })).toContain("longer than");
    expect(r("9999-12-31", {})).toContain("outside");
  });

  it("ignores blank optional fields", () => {
    expect(times("2026-11-20", { end: " ", duration: "", zone: " " })).toMatchObject({ allDay: true });
  });
});

describe("parseEventTimes, timed", () => {
  it("defaults to one hour in the host zone", () => {
    const t = times("2026-11-20T09:00");
    expect(t).toMatchObject({
      allDay: false,
      start: "2026-11-20T09:00:00",
      end: "2026-11-20T10:00:00",
      zone: BERLIN,
    });
    expect(t?.allDay === false && t.startInstant.toISOString()).toBe("2026-11-20T08:00:00.000Z");
    expect(t?.allDay === false && t.endInstant.toISOString()).toBe("2026-11-20T09:00:00.000Z");
  });

  it("explicit end, with seconds", () => {
    expect(times("2026-11-20T09:00:15", { end: "2026-11-20T09:30" })).toMatchObject({
      start: "2026-11-20T09:00:15",
      end: "2026-11-20T09:30:00",
    });
  });

  it("duration", () => {
    expect(times("2026-11-20T09:00", { duration: "1h30m" })).toMatchObject({ end: "2026-11-20T10:30:00" });
    expect(times("2026-11-20T23:30", { duration: "45m" })).toMatchObject({ end: "2026-11-21T00:15:00" });
  });

  it("a day is a calendar day across a clock change", () => {
    expect(times("2026-03-28T12:00", { duration: "1d" })).toMatchObject({ end: "2026-03-29T12:00:00" });
  });

  it("uses the given zone", () => {
    const t = times("2026-11-20T09:00", { zone: "America/New_York" });
    expect(t).toMatchObject({ zone: "America/New_York" });
    expect(t?.allDay === false && t.startInstant.toISOString()).toBe("2026-11-20T14:00:00.000Z");
  });

  it("allows an end equal to the start but not before it", () => {
    expect(times("2026-11-20T09:00", { end: "2026-11-20T09:00" })).toMatchObject({
      end: "2026-11-20T09:00:00",
    });
    expect(msg(parseEventTimes({ start: "2026-11-20T09:00", end: "2026-11-20T08:59" }, BERLIN))).toContain(
      "before start",
    );
  });

  it("rejects what is wrong", () => {
    const r = (start: string, extra: { end?: string; duration?: string; zone?: string } = {}) =>
      msg(parseEventTimes({ start, ...extra }, BERLIN));
    expect(r("2026-11-20T09:00", { end: "2026-11-21" })).toContain("end must have one too");
    expect(r("2026-11-20T09:00", { end: "2026-11-20T09:00", duration: "1h" })).toContain("either");
    expect(r("2026-11-20T09:00", { duration: "0h" })).toContain("zero");
    expect(r("2026-11-20T25:00")).toContain("not a date-time");
    expect(r("2026-11-20T09:00Z")).toContain("not a date-time");
    expect(r("2026-11-20 09:00")).toContain("not a date-time");
    expect(r("tomorrow")).toContain("not a date-time");
    expect(r("2026-11-20T09:00", { end: "2026-11-20T25:00" })).toContain("not a date-time");
    expect(r("2026-11-20T09:00", { zone: "Mars/Base" })).toContain("not an IANA");
    expect(r("2026-03-29T02:30")).toContain("does not exist in Europe/Berlin");
  });

  it("rejects a host zone that is not a zone", () => {
    expect(msg(parseEventTimes({ start: "2026-11-20" }, "nowhere"))).toContain("not an IANA");
  });
});
