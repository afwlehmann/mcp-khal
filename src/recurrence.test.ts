import { describe, expect, it } from "vitest";
import { parseEventTimes } from "./range.js";
import { buildIcs, type IcsEventParams } from "./recurrence.js";
import { failure, unwrap } from "./testlib.js";

/** A timed event on `date` from `start` to `end` (HH:MM) in `zone`. */
const at = (date: string, start = "10:00", end = "11:00", zone = "UTC") =>
  unwrap(parseEventTimes({ start: `${date}T${start}`, end: `${date}T${end}`, zone }, "Europe/Berlin"));

// 2026-11-04 is a Wednesday (the first of the month); 2026-11-11 the second.
const base: IcsEventParams = { summary: "Sync", times: at("2026-11-04") };
const build = (p: Partial<IcsEventParams> = {}) =>
  buildIcs({ ...base, ...p }, "uid-1@test", "20261102T100000Z");
const lines = (ics: string): string[] =>
  ics
    .replace(/\r\n /g, "")
    .split("\r\n")
    .filter((l) => l !== "");
const rrule = (p: Partial<IcsEventParams>): string | undefined =>
  lines(unwrap(build(p)))
    .slice(lines(unwrap(build(p))).indexOf("BEGIN:VEVENT"))
    .find((l) => l.startsWith("RRULE:"));
const on = (date: string) => ({ times: at(date) });

describe("buildIcs", () => {
  it("builds a deterministic single UTC event without RRULE and VTIMEZONE", () => {
    const ics = unwrap(build());
    expect(ics.endsWith("\r\n")).toBe(true);
    expect(lines(ics)).toEqual([
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//mcp-khal//EN",
      "BEGIN:VEVENT",
      "UID:uid-1@test",
      "DTSTAMP:20261102T100000Z",
      "DTSTART:20261104T100000Z",
      "DTEND:20261104T110000Z",
      "SUMMARY:Sync",
      "END:VEVENT",
      "END:VCALENDAR",
    ]);
  });

  it("writes a timed event in an IANA zone with TZID and its VTIMEZONE", () => {
    const ics = lines(unwrap(build({ times: at("2026-11-04", "10:00", "11:30", "Europe/Berlin") })));
    expect(ics).toContain("DTSTART;TZID=Europe/Berlin:20261104T100000");
    expect(ics).toContain("DTEND;TZID=Europe/Berlin:20261104T113000");
    expect(ics).toContain("BEGIN:VTIMEZONE");
    expect(ics).toContain("TZID:Europe/Berlin");
    expect(ics.indexOf("BEGIN:VTIMEZONE")).toBeLessThan(ics.indexOf("BEGIN:VEVENT"));
    expect(ics.filter((l) => l === "END:VTIMEZONE")).toHaveLength(1);
  });

  it("writes an all-day event with DATE values and an exclusive end", () => {
    const times = unwrap(parseEventTimes({ start: "2026-11-04", end: "2026-11-05" }, "Europe/Berlin"));
    const ics = lines(unwrap(build({ times })));
    expect(ics).toContain("DTSTART;VALUE=DATE:20261104");
    expect(ics).toContain("DTEND;VALUE=DATE:20261106");
    expect(ics).not.toContain("BEGIN:VTIMEZONE");
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
    expect(lines(unwrap(build({ ...on("2026-11-11"), recurrence })))).toContain(
      "RRULE:FREQ=MONTHLY;BYDAY=2WE",
    );
    expect(failure(build({ recurrence }))._tag).toBe("InvalidInput");
  });

  it("rejects an end that is not after the start and an unknown alarm", () => {
    expect(failure(build({ times: at("2026-11-04", "10:00", "10:00") })).message).toMatch(/later than start/);
    expect(failure(build({ alarm: "soon" }))._tag).toBe("InvalidInput");
  });

  it("rejects a zone that has no VTIMEZONE to write", () => {
    const times = { ...at("2026-11-04"), zone: "+01:00" };
    expect(failure(build({ times }))._tag).toBe("InvalidInput");
  });

  it("emits a VALARM with action, description and trigger", () => {
    const ics = lines(unwrap(build({ alarm: "15m" })));
    expect(ics).toEqual(
      expect.arrayContaining(["BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:Reminder", "TRIGGER:-PT15M"]),
    );
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
    expect(rrule({ ...on("2026-11-25"), recurrence })).toBe("RRULE:FREQ=MONTHLY;BYDAY=-1WE");
    expect(failure(build({ ...on("2026-11-18"), recurrence }))._tag).toBe("InvalidInput");
  });

  it("checks the nth weekday counted from the start of the month", () => {
    const first = { kind: "monthly_weekday", nth: 1, weekday: "wednesday" } as const;
    expect(rrule({ ...on("2026-11-04"), recurrence: first })).toBe("RRULE:FREQ=MONTHLY;BYDAY=1WE");
    expect(failure(build({ ...on("2026-11-11"), recurrence: first }))._tag).toBe("InvalidInput");
    const fourth = { kind: "monthly_weekday", nth: 4, weekday: "wednesday" } as const;
    expect(rrule({ ...on("2026-11-25"), recurrence: fourth })).toBe("RRULE:FREQ=MONTHLY;BYDAY=4WE");
  });

  it("checks the first occurrence on the local date of the zone", () => {
    // 2026-11-04 00:30 in Berlin is still the 3rd in UTC: the local date decides
    const times = at("2026-11-04", "00:30", "01:30", "Europe/Berlin");
    expect(rrule({ times, recurrence: { kind: "weekly", weekdays: ["wednesday"] } })).toBe(
      "RRULE:FREQ=WEEKLY;BYDAY=WE",
    );
  });
});

describe("endings", () => {
  const daily = { kind: "daily" } as const;

  it("never adds nothing", () => {
    expect(rrule({ recurrence: daily, ending: { kind: "never" } })).toBe("RRULE:FREQ=DAILY");
  });

  it("until in UTC is the end of that day", () => {
    expect(rrule({ recurrence: daily, ending: { kind: "until", date: "2026-12-31" } })).toBe(
      "RRULE:FREQ=DAILY;UNTIL=20261231T235959Z",
    );
  });

  it("until in a zone is the end of that local day as a UTC time", () => {
    const times = at("2026-11-04", "10:00", "11:00", "Europe/Berlin");
    expect(rrule({ times, recurrence: daily, ending: { kind: "until", date: "2026-12-31" } })).toBe(
      "RRULE:FREQ=DAILY;UNTIL=20261231T225959Z",
    );
    // summer time: the end of the day is 21:59:59 UTC
    expect(
      rrule({
        times: at("2026-06-01", "10:00", "11:00", "Europe/Berlin"),
        recurrence: daily,
        ending: { kind: "until", date: "2026-07-31" },
      }),
    ).toBe("RRULE:FREQ=DAILY;UNTIL=20260731T215959Z");
  });

  it("until of an all-day event is a date", () => {
    const times = unwrap(parseEventTimes({ start: "2026-11-04" }, "Europe/Berlin"));
    expect(rrule({ times, recurrence: daily, ending: { kind: "until", date: "2026-12-31" } })).toBe(
      "RRULE:FREQ=DAILY;UNTIL=20261231",
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

describe("date validation", () => {
  it("rejects a first day that is not a real calendar date", () => {
    const starting = (start: string): IcsEventParams["times"] =>
      ({ ...at("2026-11-04"), start }) as IcsEventParams["times"];
    expect(failure(build({ times: starting("2026-02-30T10:00:00") })).message).toMatch(/real calendar date/);
    expect(failure(build({ times: starting("11/04/2026") })).message).toMatch(/YYYY-MM-DD/);
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

  const injections = [0x00, 0x07, 0x0b, 0x0c, 0x0d, 0x0a, 0x1c, 0x7f, 0x85, 0x9f, 0x2028, 0x2029].map((c) =>
    String.fromCodePoint(c),
  );

  it.each(injections)("rejects %j in an attendee address", (sep) => {
    const e = failure(
      build({ organizer: "me@x.com", attendees: [`a@x.com${sep}ATTENDEE:mailto:v@corp.com`] }),
    );
    expect(e._tag).toBe("InvalidInput");
    expect(e.message).toMatch(/not a valid email address/);
  });

  it.each(injections)("rejects %j in the organizer address", (sep) => {
    expect(failure(build({ organizer: `me@x.com${sep}X:y`, attendees: ["a@x.com"] }))._tag).toBe(
      "InvalidInput",
    );
  });

  it("rejects an address longer than 254 characters", () => {
    const long = `${"a".repeat(250)}@x.com`;
    expect(failure(build({ organizer: "me@x.com", attendees: [long] }))._tag).toBe("InvalidInput");
    const ok = `${"a".repeat(240)}@x.com`;
    expect(
      lines(unwrap(build({ organizer: "me@x.com", attendees: [ok] }))).some((l) =>
        l.endsWith(`mailto:${ok}`),
      ),
    ).toBe(true);
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
