import assert from "node:assert/strict";
import { describe, it } from "node:test";
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
    assert.deepEqual(unwrap(calendarsArgs()), ["printcalendars"]);
  });

  it("listArgs defaults to today 7d", () => {
    assert.deepEqual(unwrap(listArgs({})), [
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
    assert.deepEqual(unwrap(listArgs({ calendar: "work" })).slice(0, 3), ["list", "-a", "work"]);
  });

  it("rangeArgs passes both ends as positionals", () => {
    const args = unwrap(rangeArgs({ start: "2026-10-28 10:00", end: "2026-10-28 11:00" }));
    assert.deepEqual(args.slice(-4), ["2026-10-28", "10:00", "2026-10-28", "11:00"]);
  });

  it("searchArgs puts the query after --", () => {
    const args = unwrap(searchArgs({ query: "standup" }));
    assert.deepEqual(args.slice(-2), ["--", "standup"]);
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
    assert.deepEqual(args, [
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
    assert.equal(failure(listArgs({ calendar: "-x" }))._tag, "InvalidInput");
    assert.equal(failure(searchArgs({ query: "--foo" }))._tag, "InvalidInput");
    assert.equal(failure(newArgs({ start: "tomorrow", summary: "-x" }))._tag, "InvalidInput");
    assert.equal(failure(rangeArgs({ start: "today", end: "-1d" }))._tag, "InvalidInput");
  });

  it("rejects control characters", () => {
    assert.equal(failure(newArgs({ start: "tomorrow", summary: "a\u0007b" }))._tag, "InvalidInput");
    assert.equal(
      failure(newArgs({ start: "tomorrow", summary: "ok", description: "x\u0000y" }))._tag,
      "InvalidInput",
    );
  });

  it("rejects empty required values", () => {
    assert.equal(failure(searchArgs({ query: "  " }))._tag, "InvalidInput");
  });
});

describe("parseEvents", () => {
  it("parses pipe-delimited lines and keeps pipes in the description", () => {
    const out = "work|2026-11-01|10:00|2026-11-01|11:00|Lunch|Cafe|a|b\nnoise\n";
    assert.deepEqual(parseEvents(out), [
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
