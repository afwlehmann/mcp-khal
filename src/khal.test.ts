import { describe, expect, it } from "vitest";
import {
  calendarsArgs,
  EVENT_FORMAT,
  listArgs,
  newArgs,
  parseEvents,
  rangeArgs,
  searchArgs,
} from "./khal.js";
import { failure, unwrap } from "./testlib.js";

describe("argv builders", () => {
  it("calendarsArgs uses printcalendars", () => {
    expect(unwrap(calendarsArgs())).toEqual(["printcalendars"]);
  });

  it("listArgs defaults to today 7d", () => {
    expect(unwrap(listArgs({}))).toEqual([
      "list",
      "--day-format",
      "",
      "--format",
      EVENT_FORMAT,
      "today",
      "7d",
    ]);
  });

  it("listArgs filters by calendar", () => {
    expect(unwrap(listArgs({ calendar: "work" })).slice(0, 3)).toEqual(["list", "-a", "work"]);
  });

  it("rangeArgs passes both ends as positionals", () => {
    const args = unwrap(rangeArgs({ start: "2026-10-28 10:00", end: "2026-10-28 11:00" }));
    expect(args.slice(-4)).toEqual(["2026-10-28", "10:00", "2026-10-28", "11:00"]);
  });

  it("searchArgs puts the query after --", () => {
    const args = unwrap(searchArgs({ query: "standup" }));
    expect(args.slice(-2)).toEqual(["--", "standup"]);
  });

  it("newArgs places positionals after --", () => {
    const args = unwrap(
      newArgs({
        calendar: "work",
        start: "2026-11-01 10:00",
        end: "11:00",
        summary: "Lunch",
        location: "Cafe",
        description: "hi",
      }),
    );
    expect(args).toEqual([
      "new",
      "-a",
      "work",
      "-l",
      "Cafe",
      "--",
      "2026-11-01",
      "10:00",
      "11:00",
      "Lunch",
      "::",
      "hi",
    ]);
  });
});

describe("input validation", () => {
  it("rejects values that look like options", () => {
    expect(failure(listArgs({ calendar: "-x" }))._tag).toBe("InvalidInput");
    expect(failure(searchArgs({ query: "--foo" }))._tag).toBe("InvalidInput");
    expect(failure(newArgs({ start: "tomorrow", summary: "-x" }))._tag).toBe("InvalidInput");
    expect(failure(rangeArgs({ start: "today", end: "-1d" }))._tag).toBe("InvalidInput");
  });

  it("rejects control characters", () => {
    expect(failure(newArgs({ start: "tomorrow", summary: "a\u0007b" }))._tag).toBe("InvalidInput");
    expect(failure(newArgs({ start: "tomorrow", summary: "ok", description: "x\u0000y" }))._tag).toBe(
      "InvalidInput",
    );
  });

  it("rejects empty required values", () => {
    expect(failure(searchArgs({ query: "  " }))._tag).toBe("InvalidInput");
  });
});

describe("parseEvents", () => {
  it("parses pipe-delimited lines and keeps pipes in the description", () => {
    const out = "work|2026-11-01|10:00|2026-11-01|11:00|Lunch|Cafe|a|b\nnoise\n";
    expect(parseEvents(out)).toEqual([
      {
        calendar: "work",
        startDate: "2026-11-01",
        startTime: "10:00",
        endDate: "2026-11-01",
        endTime: "11:00",
        title: "Lunch",
        location: "Cafe",
        description: "a|b",
      },
    ]);
  });
});
