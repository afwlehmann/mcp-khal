import { describe, expect, it } from "vitest";
import {
  attendeeOf,
  calendarWarnings,
  classifyFile,
  escapeText,
  events,
  fileUids,
  formatProp,
  isMaster,
  mapEvents,
  mapEventsChecked,
  param,
  paramsOf,
  parseProp,
  prop,
  props,
  restamp,
  sequenceOf,
  serialize,
  setDescription,
  setProp,
  stamp,
  structureProblems,
  touch,
  uidOf,
  unescapeText,
  unfoldLines,
} from "./ics.js";
import { failure, unwrap } from "./testlib.js";

const SAMPLE = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "UID:u1",
  "SUMMARY:Standup",
  "DTSTART;TZID=Europe/Berlin:20301016T090000",
  "BEGIN:VALARM",
  "DESCRIPTION:Reminder",
  "TRIGGER:-PT15M",
  "END:VALARM",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:u1",
  "RECURRENCE-ID:20301023T090000",
  "SUMMARY:Moved",
  "END:VEVENT",
  "END:VCALENDAR",
];

describe("lines", () => {
  it("unfolds continuation lines and drops blanks, whatever the line ending", () => {
    expect(unfoldLines("A:1\r\nB:long\r\n  value\n\nC:3\r\n")).toEqual(["A:1", "B:long value", "C:3"]);
  });

  it("serializes folded, CRLF-terminated lines that unfold back", () => {
    const long = `DESCRIPTION:${"x".repeat(200)}`;
    const out = serialize(["A:1", long]);
    expect(out.endsWith("\r\n")).toBe(true);
    expect(out.split("\r\n").every((l) => Buffer.byteLength(l) <= 75)).toBe(true);
    expect(unfoldLines(out)).toEqual(["A:1", long]);
  });
});

describe("properties", () => {
  it("splits name, parameters and value, ignoring a colon inside a quoted parameter", () => {
    expect(parseProp('ATTENDEE;CN="A: B";PARTSTAT=ACCEPTED:mailto:a@b.co')).toEqual({
      name: "ATTENDEE",
      params: ';CN="A: B";PARTSTAT=ACCEPTED',
      value: "mailto:a@b.co",
    });
    expect(parseProp("summary:Hi")).toEqual({ name: "SUMMARY", params: "", value: "Hi" });
    expect(parseProp("BROKEN")).toEqual({ name: "BROKEN", params: "", value: "" });
  });

  it("reads parameters, quoted or not, case-insensitively", () => {
    const p = parseProp('DTSTART;tzid="Europe/Berlin";VALUE=DATE-TIME:20301016T090000');
    expect(param(p, "TZID")).toBe("Europe/Berlin");
    expect(param(p, "VALUE")).toBe("DATE-TIME");
    expect(param(p, "CN")).toBeUndefined();
    expect(formatProp("X", ";A=1", "v")).toBe("X;A=1:v");
  });
});

describe("events", () => {
  it("finds the events, tells the main one from exceptions and reads the uid", () => {
    const [main, exception, ...rest] = events(SAMPLE);
    expect(rest).toEqual([]);
    expect(isMaster(main ?? [])).toBe(true);
    expect(isMaster(exception ?? [])).toBe(false);
    expect(uidOf(SAMPLE)).toBe("u1");
    expect(uidOf(["BEGIN:VCALENDAR", "END:VCALENDAR"])).toBeUndefined();
  });

  it("does not see properties of a nested alarm as the event's own", () => {
    const [main] = events(SAMPLE);
    expect(prop(main ?? [], "DESCRIPTION")).toBeUndefined();
    expect(props(main ?? [], "SUMMARY")).toHaveLength(1);
  });

  it("sets, adds and removes properties without touching the alarm", () => {
    const [main] = events(SAMPLE);
    const set = setProp(setProp(main ?? [], "SUMMARY", "SUMMARY:New"), "LOCATION", "LOCATION:Room");
    expect(prop(set, "SUMMARY")?.value).toBe("New");
    expect(prop(set, "LOCATION")?.value).toBe("Room");
    expect(set.at(-1)).toBe("END:VEVENT");
    expect(set).toContain("DESCRIPTION:Reminder");
    expect(prop(setProp(set, "LOCATION", undefined), "LOCATION")).toBeUndefined();
    expect(setProp(main ?? [], "NOPE", undefined)).toEqual(main);
  });

  it("collapses duplicates of a property into one line", () => {
    const e = ["BEGIN:VEVENT", "X:1", "X:2", "END:VEVENT"];
    expect(setProp(e, "X", "X:3")).toEqual(["BEGIN:VEVENT", "X:3", "END:VEVENT"]);
  });

  it("maps events in place, can drop one and keeps everything around them", () => {
    const dropped = mapEvents(SAMPLE, (e, main) => (main ? e : undefined));
    expect(dropped).toEqual([...SAMPLE.slice(0, 11), ...SAMPLE.slice(16)]);
    expect(mapEvents(SAMPLE, (e) => e)).toEqual(SAMPLE);
  });
});

describe("structure", () => {
  it("pairs BEGIN and END and reports what is left over, with a line number", () => {
    expect(structureProblems(SAMPLE)).toEqual([]);
    expect(structureProblems(["END:VEVENT"])).toEqual([
      "END:VEVENT (content line 1) has no matching BEGIN:VEVENT",
    ]);
    expect(structureProblems(["BEGIN:VCALENDAR", "BEGIN:VEVENT", "END:VCALENDAR"])).toEqual([
      "BEGIN:VEVENT (content line 2) has no matching END:VEVENT",
    ]);
    expect(structureProblems(["BEGIN:VEVENT", "BEGIN:VALARM"])).toHaveLength(2);
  });

  it("never duplicates or touches the lines of a VEVENT without END", () => {
    const broken = ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:a", "SUMMARY:x", "END:VCALENDAR"];
    expect(events(broken)).toEqual([]);
    expect(mapEvents(broken, () => ["X"])).toEqual(broken);
    expect(failure(mapEventsChecked(broken, (e) => e)).message).toMatch(
      /malformed: BEGIN:VEVENT \(content line 2\) has no matching END:VEVENT/,
    );
    expect(unwrap(mapEventsChecked(SAMPLE, (e) => e))).toEqual(SAMPLE);
  });

  it("finds the events of a nested or repeated VEVENT only once", () => {
    const nested = ["BEGIN:VEVENT", "UID:a", "BEGIN:VEVENT", "UID:b", "END:VEVENT", "END:VEVENT"];
    expect(events(nested)).toHaveLength(1);
    expect(fileUids(SAMPLE)).toEqual(["u1"]);
    expect(fileUids(["BEGIN:VEVENT", "UID: x ", "END:VEVENT", "BEGIN:VEVENT", "END:VEVENT"])).toEqual([
      "x",
      undefined,
    ]);
  });

  it("classifies a file by what it holds", () => {
    expect(classifyFile(SAMPLE)).toEqual({ kind: "event", uid: "u1" });
    expect(
      classifyFile(["BEGIN:VCALENDAR", "BEGIN:VTODO", "UID:t", "END:VTODO", "END:VCALENDAR"]),
    ).toMatchObject({
      reason: "holds no VEVENT (only VTODO), skipped",
    });
  });
});

describe("text, parameters and defaults", () => {
  it("escapes and unescapes TEXT", () => {
    expect(unescapeText(escapeText("a\\b;c,d\ne:f"))).toBe("a\\b;c,d\ne:f");
    expect(unescapeText("keep \\x")).toBe("keep \\x");
  });

  it("reads and writes parameters", () => {
    expect(paramsOf(';A=1;NOEQUALS;B="x,y",z;C=')).toEqual([
      { name: "A", values: ["1"] },
      { name: "B", values: ["x,y", "z"] },
      { name: "C", values: [""] },
    ]);
    expect(param(parseProp("X;A=1;A=2:v"), "a")).toBe("1");
    expect(param(parseProp("X;B=u,v:v"), "B")).toBe("u,v");
  });

  it("reads an attendee with the defaults of RFC 5545", () => {
    expect(attendeeOf(parseProp("ATTENDEE;ROLE=OPT-PARTICIPANT;PARTSTAT=TENTATIVE:mailto:a@b.co"))).toEqual({
      address: "mailto:a@b.co",
      cutype: "INDIVIDUAL",
      role: "OPT-PARTICIPANT",
      rsvp: false,
      partstat: "TENTATIVE",
    });
  });

  it("warns about a CALSCALE and an unusual VERSION, and about a calendar without a VCALENDAR", () => {
    expect(
      calendarWarnings(["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:x", "CALSCALE:JULIAN", "END:VCALENDAR"]),
    ).toHaveLength(1);
  });

  it("sets the description and drops the stale X-ALT-DESC only when the description changes", () => {
    const e = ["BEGIN:VEVENT", "DESCRIPTION:old", "X-ALT-DESC;FMTTYPE=text/html:<b>old</b>", "END:VEVENT"];
    expect(setDescription(e, "DESCRIPTION:old")).toEqual(e);
    expect(setDescription(e, "DESCRIPTION:new")).toEqual(["BEGIN:VEVENT", "DESCRIPTION:new", "END:VEVENT"]);
    expect(setDescription(e, undefined)).toEqual(["BEGIN:VEVENT", "END:VEVENT"]);
    const noAlt = ["BEGIN:VEVENT", "END:VEVENT"];
    expect(setDescription(noAlt, undefined)).toEqual(noAlt);
    expect(setDescription(noAlt, "DESCRIPTION:x")).toEqual(["BEGIN:VEVENT", "DESCRIPTION:x", "END:VEVENT"]);
  });
});

describe("touch", () => {
  const now = new Date("2030-01-01T10:00:00.500Z");

  it("never lets a stamp go back, and keeps SEQUENCE a valid integer", () => {
    const e = [
      "BEGIN:VEVENT",
      "DTSTAMP:20400101T000000Z",
      "LAST-MODIFIED:bad",
      "SEQUENCE:2147483647",
      "END:VEVENT",
    ];
    const t = touch(e, now);
    expect(prop(t, "DTSTAMP")?.value).toBe("20400101T000000Z");
    expect(prop(t, "LAST-MODIFIED")?.value).toBe("20300101T100000Z");
    expect(prop(t, "SEQUENCE")?.value).toBe("2147483647");
    expect(prop(restamp(e, now), "SEQUENCE")?.value).toBe("2147483647");
    for (const bad of ["1.5", "1e3", "-4", "0x10", "", "99999999999"])
      expect(prop(touch(["BEGIN:VEVENT", `SEQUENCE:${bad}`, "END:VEVENT"], now), "SEQUENCE")?.value).toMatch(
        /^\d+$/,
      );
    expect(sequenceOf(["BEGIN:VEVENT", "SEQUENCE:+7", "END:VEVENT"])).toBe(7);
    expect(prop(touch(["BEGIN:VEVENT", "SEQUENCE:1e3", "END:VEVENT"], now), "SEQUENCE")?.value).toBe("1");
  });

  it("formats a UTC stamp", () => {
    expect(stamp(now)).toBe("20300101T100000Z");
  });

  it("raises SEQUENCE and sets LAST-MODIFIED and DTSTAMP", () => {
    const e = touch(["BEGIN:VEVENT", "SEQUENCE:2", "DTSTAMP:20200101T000000Z", "END:VEVENT"], now);
    expect(prop(e, "SEQUENCE")?.value).toBe("3");
    expect(prop(e, "LAST-MODIFIED")?.value).toBe("20300101T100000Z");
    expect(prop(e, "DTSTAMP")?.value).toBe("20300101T100000Z");
  });

  it("starts at 1 without a valid SEQUENCE", () => {
    expect(prop(touch(["BEGIN:VEVENT", "END:VEVENT"], now), "SEQUENCE")?.value).toBe("1");
    expect(prop(touch(["BEGIN:VEVENT", "SEQUENCE:x", "END:VEVENT"], now), "SEQUENCE")?.value).toBe("1");
  });
});
