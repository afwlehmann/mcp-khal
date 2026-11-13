import { describe, expect, it } from "vitest";
import {
  events,
  formatProp,
  isMaster,
  mapEvents,
  param,
  parseProp,
  prop,
  props,
  serialize,
  setProp,
  stamp,
  touch,
  uidOf,
  unfoldLines,
} from "./ics.js";

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

describe("touch", () => {
  const now = new Date("2030-01-01T10:00:00.500Z");

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
