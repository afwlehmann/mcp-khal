import { describe, expect, it } from "vitest";
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
const rrule = (p: Partial<IcsEventParams>): string | undefined =>
  lines(unwrap(build(p))).find((l) => l.startsWith("RRULE:"));

describe("buildIcs", () => {
  it("builds a deterministic single event without RRULE", () => {
    const ics = unwrap(build());
    expect(ics.endsWith("\r\n")).toBe(true);
    expect(lines(ics)).toEqual([
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
    expect(lines(ics)).toContain("RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=WE;COUNT=3");
  });

  it("builds monthly nth-weekday rules and checks the first occurrence", () => {
    const recurrence = { kind: "monthly_weekday", nth: 2, weekday: "wednesday" } as const;
    expect(lines(unwrap(build({ date: "2026-11-11", recurrence })))).toContain(
      "RRULE:FREQ=MONTHLY;BYDAY=2WE",
    );
    expect(failure(build({ recurrence }))._tag).toBe("InvalidInput");
  });

  it("rejects an end before the start and an unknown alarm", () => {
    expect(failure(build({ endTime: "09:00" }))._tag).toBe("InvalidInput");
    expect(failure(build({ alarm: "soon" }))._tag).toBe("InvalidInput");
  });

  it("emits a VALARM trigger", () => {
    expect(lines(unwrap(build({ alarm: "15m" })))).toContain("TRIGGER:-PT15M");
  });

  it("escapes text and rejects control characters", () => {
    expect(lines(unwrap(build({ summary: "a,b;c" })))).toContain("SUMMARY:a\\,b\\;c");
    expect(failure(build({ summary: "a\u0007b" }))._tag).toBe("InvalidInput");
  });
});

describe("rule shapes", () => {
  it("daily and yearly rules accept any first occurrence", () => {
    expect(rrule({ recurrence: { kind: "daily", interval: 3 } })).toBe("RRULE:FREQ=DAILY;INTERVAL=3");
    expect(rrule({ recurrence: { kind: "yearly" } })).toBe("RRULE:FREQ=YEARLY");
  });

  it("an interval of 1 is omitted", () => {
    expect(rrule({ recurrence: { kind: "daily", interval: 1 } })).toBe("RRULE:FREQ=DAILY");
  });

  it("weekly rules dedupe weekdays and require the first occurrence to match", () => {
    expect(rrule({ recurrence: { kind: "weekly", weekdays: ["wednesday", "wednesday", "friday"] } })).toBe(
      "RRULE:FREQ=WEEKLY;BYDAY=WE,FR",
    );
    expect(failure(build({ recurrence: { kind: "weekly", weekdays: ["friday"] } }))._tag).toBe(
      "InvalidInput",
    );
  });

  it("monthly_day requires the first occurrence to be on that day", () => {
    expect(rrule({ recurrence: { kind: "monthly_day", day: 4 } })).toBe("RRULE:FREQ=MONTHLY;BYMONTHDAY=4");
    expect(failure(build({ recurrence: { kind: "monthly_day", day: 5 } }))._tag).toBe("InvalidInput");
  });

  it("supports the last weekday of the month", () => {
    const recurrence = { kind: "monthly_weekday", nth: -1, weekday: "wednesday" } as const;
    expect(rrule({ date: "2026-11-25", recurrence })).toBe("RRULE:FREQ=MONTHLY;BYDAY=-1WE");
    expect(failure(build({ date: "2026-11-18", recurrence }))._tag).toBe("InvalidInput");
  });

  it("checks the nth weekday counted from the start of the month", () => {
    const first = { kind: "monthly_weekday", nth: 1, weekday: "wednesday" } as const;
    expect(rrule({ date: "2026-11-04", recurrence: first })).toBe("RRULE:FREQ=MONTHLY;BYDAY=1WE");
    expect(failure(build({ date: "2026-11-11", recurrence: first }))._tag).toBe("InvalidInput");
    const fourth = { kind: "monthly_weekday", nth: 4, weekday: "wednesday" } as const;
    expect(rrule({ date: "2026-11-25", recurrence: fourth })).toBe("RRULE:FREQ=MONTHLY;BYDAY=4WE");
  });
});

describe("endings", () => {
  const daily = { kind: "daily" } as const;

  it("never adds nothing", () => {
    expect(rrule({ recurrence: daily, ending: { kind: "never" } })).toBe("RRULE:FREQ=DAILY");
  });

  it("until adds an inclusive floating UNTIL", () => {
    expect(rrule({ recurrence: daily, ending: { kind: "until", date: "2026-12-31" } })).toBe(
      "RRULE:FREQ=DAILY;UNTIL=20261231T235959",
    );
  });

  it("rejects an until date before the first occurrence or an invalid one", () => {
    expect(failure(build({ recurrence: daily, ending: { kind: "until", date: "2026-11-03" } }))._tag).toBe(
      "InvalidInput",
    );
    expect(failure(build({ recurrence: daily, ending: { kind: "until", date: "soon" } }))._tag).toBe(
      "InvalidInput",
    );
  });
});

describe("date and time validation", () => {
  it("rejects malformed and impossible dates", () => {
    expect(failure(build({ date: "11/04/2026" })).message).toMatch(/YYYY-MM-DD/);
    expect(failure(build({ date: "2026-02-30" })).message).toMatch(/real calendar date/);
  });

  it("rejects out-of-range times", () => {
    expect(failure(build({ startTime: "25:00" })).message).toMatch(/startTime/);
    expect(failure(build({ endTime: "10:61" })).message).toMatch(/endTime/);
    expect(failure(build({ startTime: "9:00" })).message).toMatch(/HH:MM/);
  });

  it("rejects an empty summary", () => {
    expect(failure(build({ summary: "   " }))._tag).toBe("InvalidInput");
  });
});

describe("ICS injection", () => {
  const payload = (sep: string): string => `Sync${sep}ATTENDEE:mailto:victim@corp.com`;
  const separators = [0x0d, 0x85, 0x2028, 0x2029, 0x0b, 0x0c, 0x1c, 0x7f].map((c) => String.fromCodePoint(c));

  it.each(separators)("rejects %j as a line break in summary, location and description", (sep) => {
    for (const field of ["summary", "location", "description"] as const)
      expect(failure(build({ [field]: payload(sep) }))._tag).toBe("InvalidInput");
  });

  it("escapes CRLF and LF instead of emitting a new line", () => {
    const ics = unwrap(build({ description: "a\r\nATTENDEE:mailto:victim@corp.com\nb" }));
    expect(ics).not.toMatch(/\r\nATTENDEE/);
    expect(lines(ics)).toContain("DESCRIPTION:a\\nATTENDEE:mailto:victim@corp.com\\nb");
  });

  it("emits no property the caller did not ask for", () => {
    const ics = unwrap(build({ summary: "plain", location: "tab\there" }));
    expect(lines(ics).filter((l) => l.startsWith("ATTENDEE") || l.startsWith("ORGANIZER"))).toEqual([]);
  });
});

describe("optional text fields", () => {
  it("emits escaped LOCATION and DESCRIPTION", () => {
    const ics = lines(unwrap(build({ location: "Room 1, Floor 2", description: "line1\nline2; ok" })));
    expect(ics).toContain("LOCATION:Room 1\\, Floor 2");
    expect(ics).toContain("DESCRIPTION:line1\\nline2\\; ok");
  });

  it("rejects control characters in location and description", () => {
    expect(failure(build({ location: "a\u0001b" }))._tag).toBe("InvalidInput");
    expect(failure(build({ description: "a\u0001b" }))._tag).toBe("InvalidInput");
  });

  it("emits hour and day alarms", () => {
    expect(lines(unwrap(build({ alarm: "2h" })))).toContain("TRIGGER:-PT2H");
    expect(lines(unwrap(build({ alarm: "1d" })))).toContain("TRIGGER:-P1D");
  });
});

describe("invites", () => {
  it("adds ORGANIZER and deduped ATTENDEE lines, dropping the organizer", () => {
    const ics = lines(
      unwrap(build({ organizer: "me@x.com", attendees: ["A@x.com", "a@x.com", "ME@x.com", "b@x.com"] })),
    );
    expect(ics).toContain("ORGANIZER:mailto:me@x.com");
    const attendees = ics.filter((l) => l.startsWith("ATTENDEE"));
    expect(attendees).toHaveLength(2);
    expect(attendees[0]).toMatch(/:mailto:A@x\.com$/);
    expect(attendees[1]).toMatch(/:mailto:b@x\.com$/);
  });

  it("requires an organizer and at least one other attendee", () => {
    expect(failure(build({ attendees: ["a@x.com"] }))._tag).toBe("InvalidInput");
    expect(failure(build({ organizer: "me@x.com", attendees: ["me@x.com"] }))._tag).toBe("InvalidInput");
    expect(failure(build({ organizer: "me@x.com", attendees: ["nope"] }))._tag).toBe("InvalidInput");
  });
});

describe("line folding", () => {
  it("keeps every line within 75 octets and unfolds to the original", () => {
    const location = "ä".repeat(120);
    const ics = unwrap(build({ location }));
    for (const line of ics.split("\r\n")) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
    expect(ics.replace(/\r\n /g, "")).toContain(`LOCATION:${location}`);
  });
});

describe("toIcsParams", () => {
  it("maps start/end into date and times", () => {
    const p = unwrap(toIcsParams({ summary: "S", start: "2026-11-04 10:00", end: "11:00" }));
    expect([p.date, p.startTime, p.endTime]).toEqual(["2026-11-04", "10:00", "11:00"]);
  });

  it("requires strict start and end formats", () => {
    expect(failure(toIcsParams({ summary: "S", start: "tomorrow", end: "11:00" }))._tag).toBe("InvalidInput");
    expect(failure(toIcsParams({ summary: "S", start: "2026-11-04 10:00" }))._tag).toBe("InvalidInput");
    expect(failure(toIcsParams({ summary: "S", start: "2026-11-04 10:00", end: "1h" }))._tag).toBe(
      "InvalidInput",
    );
  });
});
