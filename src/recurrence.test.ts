import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildIcs, type IcsEventParams, toIcsParams } from "./recurrence.js";
import { failure, unwrap } from "./testlib.js";

// 2026-11-04 is a Wednesday (the first of the month); 2026-11-11 the second.
const base: IcsEventParams = { summary: "Sync", date: "2026-11-04", startTime: "10:00", endTime: "11:00" };
const build = (p: Partial<IcsEventParams> = {}) =>
  buildIcs({ ...base, ...p }, "uid-1@test", "20261102T100000Z");
const lines = (ics: string): string[] =>
  ics
    .replace(/\r\n /g, "")
    .split("\r\n")
    .filter((l) => l !== "");

describe("buildIcs", () => {
  it("builds a deterministic single event without RRULE", () => {
    const ics = unwrap(build());
    assert.ok(ics.endsWith("\r\n"));
    assert.deepEqual(lines(ics), [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//mcp-khal//EN",
      "BEGIN:VEVENT",
      "UID:uid-1@test",
      "DTSTAMP:20261102T100000Z",
      "DTSTART:20261104T100000",
      "DTEND:20261104T110000",
      "SUMMARY:Sync",
      "END:VEVENT",
      "END:VCALENDAR",
    ]);
  });

  it("builds weekly rules with interval and count", () => {
    const ics = unwrap(
      build({
        recurrence: { kind: "weekly", interval: 2, weekdays: ["wednesday"] },
        ending: { kind: "count", count: 3 },
      }),
    );
    assert.ok(lines(ics).includes("RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=WE;COUNT=3"));
  });

  it("builds monthly nth-weekday rules and checks the first occurrence", () => {
    const recurrence = { kind: "monthly_weekday", nth: 2, weekday: "wednesday" } as const;
    assert.ok(
      lines(unwrap(build({ date: "2026-11-11", recurrence }))).includes("RRULE:FREQ=MONTHLY;BYDAY=2WE"),
    );
    assert.equal(failure(build({ recurrence }))._tag, "InvalidInput");
  });

  it("rejects an end before the start and an unknown alarm", () => {
    assert.equal(failure(build({ endTime: "09:00" }))._tag, "InvalidInput");
    assert.equal(failure(build({ alarm: "soon" }))._tag, "InvalidInput");
  });

  it("emits a VALARM trigger", () => {
    assert.ok(lines(unwrap(build({ alarm: "15m" }))).includes("TRIGGER:-PT15M"));
  });

  it("escapes text and rejects control characters", () => {
    assert.ok(lines(unwrap(build({ summary: "a,b;c" }))).includes("SUMMARY:a\\,b\\;c"));
    assert.equal(failure(build({ summary: "a\u0007b" }))._tag, "InvalidInput");
  });
});

describe("invites", () => {
  it("adds ORGANIZER and deduped ATTENDEE lines, dropping the organizer", () => {
    const ics = lines(
      unwrap(build({ organizer: "me@x.com", attendees: ["A@x.com", "a@x.com", "ME@x.com", "b@x.com"] })),
    );
    assert.ok(ics.includes("ORGANIZER:mailto:me@x.com"));
    const attendees = ics.filter((l) => l.startsWith("ATTENDEE"));
    assert.equal(attendees.length, 2);
    assert.ok(attendees[0]?.endsWith(":mailto:A@x.com"));
    assert.ok(attendees[1]?.endsWith(":mailto:b@x.com"));
  });

  it("requires an organizer and at least one other attendee", () => {
    assert.equal(failure(build({ attendees: ["a@x.com"] }))._tag, "InvalidInput");
    assert.equal(failure(build({ organizer: "me@x.com", attendees: ["me@x.com"] }))._tag, "InvalidInput");
    assert.equal(failure(build({ organizer: "me@x.com", attendees: ["nope"] }))._tag, "InvalidInput");
  });
});

describe("line folding", () => {
  it("keeps every line within 75 octets and unfolds to the original", () => {
    const location = "ä".repeat(120);
    const ics = unwrap(build({ location }));
    for (const line of ics.split("\r\n")) assert.ok(Buffer.byteLength(line) <= 75, line);
    assert.ok(ics.replace(/\r\n /g, "").includes(`LOCATION:${location}`));
  });
});

describe("toIcsParams", () => {
  it("maps start/end into date and times", () => {
    const p = unwrap(toIcsParams({ summary: "S", start: "2026-11-04 10:00", end: "11:00" }));
    assert.deepEqual([p.date, p.startTime, p.endTime], ["2026-11-04", "10:00", "11:00"]);
  });

  it("requires strict start and end formats", () => {
    assert.equal(
      failure(toIcsParams({ summary: "S", start: "tomorrow", end: "11:00" }))._tag,
      "InvalidInput",
    );
    assert.equal(failure(toIcsParams({ summary: "S", start: "2026-11-04 10:00" }))._tag, "InvalidInput");
    assert.equal(
      failure(toIcsParams({ summary: "S", start: "2026-11-04 10:00", end: "1h" }))._tag,
      "InvalidInput",
    );
  });
});
