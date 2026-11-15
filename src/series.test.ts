import { describe, expect, it } from "vitest";
import { events, parseProp, prop, props } from "./ics.js";
import {
  checkFile,
  compactDate,
  filterEntries,
  formatWall,
  instantOf,
  listedInstants,
  markEvent,
  nextSequence,
  normAddress,
  overrideTimes,
  parseWall,
  ruleAllows,
  ruleCount,
  sameAddress,
  stampAt,
  untilValue,
  valueAt,
  withCount,
  withoutMethod,
  withUntil,
  zonesOf,
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
});

describe("zones come from timezone.ts: the VTIMEZONE of the file first, then IANA and Windows names", () => {
  const vtz = (offset: string) => [
    "BEGIN:VTIMEZONE",
    "TZID:Custom/Zone",
    "BEGIN:STANDARD",
    "DTSTART:19700101T000000",
    `TZOFFSETFROM:${offset}`,
    `TZOFFSETTO:${offset}`,
    "END:STANDARD",
    "END:VTIMEZONE",
  ];
  const file = (inside: string[], start = "DTSTART;TZID=Custom/Zone:20301016T090000") => [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    ...inside,
    "BEGIN:VEVENT",
    "UID:z",
    start,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  const dtstartOf = (lines: string[]) => prop(events(lines)[0] ?? [], "DTSTART");

  it("reads a value with the zone of the file's own VTIMEZONE", () => {
    const lines = file(vtz("+0300"));
    const zones = unwrap(zonesOf(lines, "Europe/Berlin"));
    const p = dtstartOf(lines);
    expect(unwrap(instantOf(zones, p ?? parseProp("X:1"), p?.value ?? ""))).toBe(Date.UTC(2030, 9, 16, 6));
  });

  it("knows Windows zone names and says so for unknown ones", () => {
    const win = file([], "DTSTART;TZID=W. Europe Standard Time:20301016T090000");
    const zones = unwrap(zonesOf(win, "Europe/Berlin"));
    const p = dtstartOf(win);
    expect(unwrap(instantOf(zones, p ?? parseProp("X:1"), p?.value ?? ""))).toBe(Date.UTC(2030, 9, 16, 7));
    const unknown = file([], "DTSTART;TZID=Mars/Base:20301016T090000");
    const bad = unwrap(zonesOf(unknown, "Europe/Berlin"));
    const q = dtstartOf(unknown);
    expect(failure(instantOf(bad, q ?? parseProp("X:1"), q?.value ?? "")).message).toMatch(
      /unknown time zone/,
    );
  });

  it("takes the host zone for floating times and dates, UTC for Z", () => {
    const zones = unwrap(zonesOf(file([]), "America/New_York"));
    const p = parseProp("DTSTART:20301016T090000");
    expect(unwrap(instantOf(zones, p, "20301016T090000"))).toBe(Date.UTC(2030, 9, 16, 13));
    expect(unwrap(instantOf(zones, p, "20301016T090000", zones.host))).toBe(Date.UTC(2030, 9, 16, 13));
    expect(unwrap(instantOf(zones, p, "20301016T090000Z"))).toBe(Date.UTC(2030, 9, 16, 9));
    expect(unwrap(instantOf(zones, parseProp("DTSTART;VALUE=DATE:20301016"), "20301016"))).toBe(
      Date.UTC(2030, 9, 16, 4),
    );
    expect(failure(instantOf(zones, p, "soon")).message).toMatch(/cannot read DTSTART/);
  });

  it("uses a floating value's own zone when told to", () => {
    const zones = unwrap(zonesOf(file([]), "America/New_York"));
    const berlin = unwrap(zonesOf(file([]), "Europe/Berlin")).host;
    expect(
      unwrap(instantOf(zones, parseProp("RECURRENCE-ID:20301016T090000"), "20301016T090000", berlin)),
    ).toBe(Date.UTC(2030, 9, 16, 7));
  });

  it("rejects an unknown host zone and a file that is no iCalendar", () => {
    expect(failure(zonesOf(file([]), "Mars/Base")).message).toMatch(/unknown time zone/);
    expect(failure(zonesOf(["BEGIN:VCALENDAR", "BEGIN:VEVENT"], "Europe/Berlin")).message).toMatch(
      /not valid iCalendar data/,
    );
  });

  it("writes an instant back in the form of the value", () => {
    const zones = unwrap(zonesOf(file([]), "Europe/Berlin"));
    const at = Date.UTC(2030, 9, 16, 7);
    expect(valueAt(zones.host, { hasTime: true, utc: false }, at)).toBe("20301016T090000");
    expect(valueAt(zones.host, { hasTime: false, utc: false }, at)).toBe("20301016");
  });

  it("builds the UNTIL of a rule in the type DTSTART asks for", () => {
    const zones = unwrap(zonesOf(file([]), "Europe/Berlin"));
    const at = Date.UTC(2030, 9, 19, 7);
    const until = (p: string) =>
      untilValue(
        zones.host,
        parseProp(p),
        parseWall(parseProp(p).value) ?? { ms: 0, hasTime: false, utc: false },
        at,
      );
    expect(until("DTSTART;TZID=Europe/Berlin:20301016T090000")).toBe("20301019T070000Z");
    expect(until("DTSTART:20301016T070000Z")).toBe("20301019T070000Z");
    expect(until("DTSTART:20301016T090000")).toBe("20301019T090000");
    expect(until("DTSTART;VALUE=DATE:20301016")).toBe("20301019");
  });

  it("gives the instants of an exception and of listed dates", () => {
    const lines = file([]);
    const zones = unwrap(zonesOf(lines, "Europe/Berlin"));
    const e = ["BEGIN:VEVENT", "RECURRENCE-ID:20301017T090000", "DTSTART:20301018T090000Z", "END:VEVENT"];
    expect(unwrap(overrideTimes(zones, e, zones.host))).toEqual({
      rid: Date.UTC(2030, 9, 17, 7),
      start: Date.UTC(2030, 9, 18, 9),
    });
    expect(
      unwrap(
        overrideTimes(
          zones,
          e.filter((l) => !l.startsWith("DTSTART")),
          zones.host,
        ),
      ),
    ).toEqual({
      rid: Date.UTC(2030, 9, 17, 7),
      start: Date.UTC(2030, 9, 17, 7),
    });
    expect(failure(overrideTimes(zones, ["BEGIN:VEVENT", "END:VEVENT"], zones.host)).message).toMatch(
      /no RECURRENCE-ID/,
    );
    const listed = [
      "BEGIN:VEVENT",
      "EXDATE:20301017T090000,20301018T090000Z",
      "RDATE;VALUE=PERIOD:20301101T090000/PT1H",
      "END:VEVENT",
    ];
    expect(unwrap(listedInstants(zones, listed, "EXDATE", zones.host))).toEqual([
      Date.UTC(2030, 9, 17, 7),
      Date.UTC(2030, 9, 18, 9),
    ]);
    expect(unwrap(listedInstants(zones, listed, "RDATE", zones.host))).toEqual([Date.UTC(2030, 10, 1, 8)]);
    expect(
      failure(listedInstants(zones, ["BEGIN:VEVENT", "EXDATE:soon", "END:VEVENT"], "EXDATE", zones.host))
        .message,
    ).toMatch(/cannot read EXDATE/);
  });
});

describe("rules", () => {
  it("reads COUNT and replaces the end of a rule, FREQ first", () => {
    expect(ruleCount("FREQ=DAILY;COUNT=5")).toBe(5);
    expect(ruleCount("FREQ=DAILY")).toBeUndefined();
    expect(withUntil("FREQ=WEEKLY;BYDAY=MO;COUNT=5", "20301023T085959Z")).toBe(
      "FREQ=WEEKLY;BYDAY=MO;UNTIL=20301023T085959Z",
    );
    expect(withUntil("FREQ=DAILY;UNTIL=20400101", "20301023")).toBe("FREQ=DAILY;UNTIL=20301023");
    expect(withCount("FREQ=DAILY;UNTIL=20400101", 3)).toBe("FREQ=DAILY;COUNT=3");
    expect(withCount("BYDAY=MO;FREQ=WEEKLY;COUNT=9", 3)).toBe("FREQ=WEEKLY;BYDAY=MO;COUNT=3");
  });

  it("tells whether a day satisfies the rule", () => {
    const day = (iso: string) => {
      const [year = 0, month = 0, d = 0] = iso.split("-").map(Number);
      return { year, month, day: d };
    };
    expect(ruleAllows("FREQ=DAILY", day("2030-10-17"))).toBe(true);
    expect(ruleAllows("FREQ=WEEKLY;BYDAY=WE", day("2030-10-16"))).toBe(true);
    expect(ruleAllows("FREQ=WEEKLY;BYDAY=WE", day("2030-10-17"))).toBe(false);
    expect(ruleAllows("FREQ=WEEKLY;BYDAY=2WE", day("2030-10-17"))).toBe(false);
    expect(ruleAllows("FREQ=MONTHLY;BYDAY=2WE", day("2030-10-09"))).toBe(true);
    expect(ruleAllows("FREQ=MONTHLY;BYDAY=2WE", day("2030-10-16"))).toBe(false);
    expect(ruleAllows("FREQ=MONTHLY;BYDAY=-1WE", day("2030-10-30"))).toBe(true);
    expect(ruleAllows("FREQ=MONTHLY;BYDAY=-1WE", day("2030-10-23"))).toBe(false);
    expect(ruleAllows("FREQ=MONTHLY;BYMONTHDAY=-1", day("2030-10-31"))).toBe(true);
    expect(ruleAllows("FREQ=MONTHLY;BYMONTHDAY=15", day("2030-10-16"))).toBe(false);
    expect(ruleAllows("FREQ=YEARLY;BYMONTH=10", day("2030-10-16"))).toBe(true);
    expect(ruleAllows("FREQ=YEARLY;BYMONTH=3", day("2030-10-16"))).toBe(false);
    expect(ruleAllows("FREQ=WEEKLY;BYDAY=garbage", day("2030-10-16"))).toBe(false);
  });
});

describe("editing helpers", () => {
  it("removes the calendar's METHOD only", () => {
    const lines = [
      "BEGIN:VCALENDAR",
      "METHOD:REQUEST",
      "BEGIN:VEVENT",
      "METHOD:SOMETHING",
      "END:VEVENT",
      "method;x=1:PUBLISH",
      "END:VCALENDAR",
    ];
    expect(withoutMethod(lines)).toEqual([
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "METHOD:SOMETHING",
      "END:VEVENT",
      "END:VCALENDAR",
    ]);
  });

  it("filters the entries of EXDATE and RDATE lines and keeps the others byte for byte", () => {
    const event = [
      "BEGIN:VEVENT",
      "EXDATE;TZID=Europe/Berlin:20301017T090000,20301020T090000",
      "EXDATE:20301019T090000Z",
      "RDATE:20301030T090000Z",
      "BEGIN:VALARM",
      "EXDATE:ignored-inside-alarm",
      "END:VALARM",
      "END:VEVENT",
    ];
    const kept = filterEntries(event, "EXDATE", (_p, v) => v < "20301019");
    expect(kept).toEqual([
      "BEGIN:VEVENT",
      "EXDATE;TZID=Europe/Berlin:20301017T090000",
      "RDATE:20301030T090000Z",
      "BEGIN:VALARM",
      "EXDATE:ignored-inside-alarm",
      "END:VALARM",
      "END:VEVENT",
    ]);
    expect(filterEntries(event, "EXDATE", () => true)).toEqual(event);
    expect(
      props(
        filterEntries(event, "RDATE", () => false),
        "RDATE",
      ),
    ).toEqual([]);
  });

  it("refuses files with several UIDs or another kind of component", () => {
    const e = (uid: string) => ["BEGIN:VEVENT", `UID:${uid}`, "END:VEVENT"];
    expect(unwrap(checkFile(["BEGIN:VCALENDAR", ...e("a"), ...e("a"), "END:VCALENDAR"]))).toBeUndefined();
    expect(failure(checkFile(["BEGIN:VCALENDAR", ...e("a"), ...e("b"), "END:VCALENDAR"])).message).toMatch(
      /different UIDs \(a, b\)/,
    );
    for (const kind of ["VTODO", "VJOURNAL", "VFREEBUSY"])
      expect(
        failure(checkFile(["BEGIN:VCALENDAR", ...e("a"), `BEGIN:${kind}`, `END:${kind}`, "END:VCALENDAR"]))
          .message,
      ).toMatch(new RegExp(`${kind}`));
    // unknown components and alarms are kept, not refused
    expect(
      unwrap(
        checkFile([
          "BEGIN:VCALENDAR",
          "BEGIN:X-FOO",
          "END:X-FOO",
          "BEGIN:VEVENT",
          "BEGIN:VALARM",
          "END:VALARM",
          "END:VEVENT",
          "END:VCALENDAR",
        ]),
      ),
    ).toBeUndefined();
  });

  it("compares addresses without mailto: (any case) and without regard to case", () => {
    expect(normAddress(" MAILTO:Me@Example.COM ")).toBe("me@example.com");
    expect(sameAddress("mailto:me@example.com", "ME@example.com")).toBe(true);
    expect(sameAddress("mailto:me@example.com", undefined)).toBe(false);
    // not a character set: letters of "mailto" at the start of the local part survive
    expect(normAddress("mailto:otto@example.com")).toBe("otto@example.com");
    expect(normAddress("tom@example.com")).toBe("tom@example.com");
  });

  it("only ever produces a valid SEQUENCE", () => {
    expect(nextSequence(undefined)).toBe("1");
    expect(nextSequence("4")).toBe("5");
    expect(nextSequence(" +7 ")).toBe("8");
    expect(nextSequence("abc")).toBe("1");
    expect(nextSequence("1.5")).toBe("1");
    expect(nextSequence("")).toBe("1");
    expect(nextSequence("-5")).toBe("1");
    expect(nextSequence("2147483647")).toBe("2147483647");
    expect(nextSequence("2147483646")).toBe("2147483647");
    expect(nextSequence("9999999999")).toBe("1");
  });

  it("stamps with the clock, or with a later stored stamp (never backwards)", () => {
    const now = new Date("2030-01-01T10:00:00Z");
    expect(stampAt(["BEGIN:VEVENT", "END:VEVENT"], now)).toBe("20300101T100000Z");
    expect(stampAt(["BEGIN:VEVENT", "DTSTAMP:20300101T101500Z", "END:VEVENT"], now)).toBe("20300101T101500Z");
    expect(stampAt(["BEGIN:VEVENT", "LAST-MODIFIED:20300102T000000Z", "END:VEVENT"], now)).toBe(
      "20300102T000000Z",
    );
    expect(
      stampAt(["BEGIN:VEVENT", "DTSTAMP:garbage", "LAST-MODIFIED:20290101T000000Z", "END:VEVENT"], now),
    ).toBe("20300101T100000Z");
    const marked = markEvent(
      ["BEGIN:VEVENT", "SEQUENCE:2", "DTSTAMP:20200101T000000Z", "END:VEVENT"],
      now,
      true,
    );
    expect(prop(marked, "SEQUENCE")?.value).toBe("3");
    expect(prop(marked, "DTSTAMP")?.value).toBe("20300101T100000Z");
    expect(prop(marked, "LAST-MODIFIED")?.value).toBe("20300101T100000Z");
    expect(prop(markEvent(marked, now, false), "SEQUENCE")?.value).toBe("3");
  });
});
