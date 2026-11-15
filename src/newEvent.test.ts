import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CalendarConfig } from "./config.js";
import { InvalidInput } from "./errors.js";
import { type NewEventInput, newEvent, timestamp, titleWarning } from "./newEvent.js";
import type { Settings } from "./settings.js";
import { removeDir, runFail, runOk, tempDir, testSettings, unfold } from "./testlib.js";

const NOW = new Date("2026-11-02T10:00:00.123Z");
const UID = "fixed-uid";
const FILE = `${UID}@mcp-khal.ics`;

describe("timestamp", () => {
  it("formats an ICS DTSTAMP", () => {
    expect(timestamp(NOW)).toBe("20261102T100000Z");
  });
});

describe("titleWarning", () => {
  it("warns about a slash in the title only", () => {
    expect(titleWarning("Plan A/B")).toMatch(/CalDAV.*synchronization/);
    expect(titleWarning("Lunch")).toBeUndefined();
  });
});

describe("newEvent", () => {
  let dir: string;
  let other: string;

  beforeEach(async () => {
    dir = await tempDir();
    other = await tempDir();
  });
  afterEach(async () => {
    await removeDir(dir);
    await removeDir(other);
  });

  /** calendars `work` (in `dir`) and `home` (in `other`), each with the given extra settings */
  const settings = (
    work: Partial<CalendarConfig> = {},
    over: Partial<Settings> = {},
    home: Partial<CalendarConfig> = {},
  ): Settings =>
    testSettings({
      calendars: { work: { path: dir, ...work }, home: { path: other, ...home } },
      ...over,
    });

  const files = (d: string = dir): Promise<string[]> => readdir(d);
  const written = async (d: string = dir): Promise<string> => unfold(await readFile(join(d, FILE), "utf8"));
  const triggers = async (d: string = dir): Promise<string[]> =>
    (await written(d)).split("\r\n").filter((l) => l.startsWith("TRIGGER"));

  const plain: NewEventInput = {
    calendar: "work",
    start: "2030-01-15T12:00",
    end: "2030-01-15T13:00",
    summary: "Lunch",
  };
  const series: NewEventInput = {
    calendar: "work",
    start: "2030-01-16T09:00",
    end: "2030-01-16T09:30",
    summary: "Standup",
    recurrence: { pattern: { kind: "daily" } },
  };

  describe("the file", () => {
    it("writes <uid>@mcp-khal.ics into the vdir of the calendar and names the uid", async () => {
      const out = await runOk(newEvent(settings(), plain, UID, NOW));
      expect(out).toBe("Created event 'Lunch' (uid fixed-uid@mcp-khal) in calendar 'work'.");
      expect(await files()).toEqual([FILE]);
      expect(await files(other)).toEqual([]);
    });

    it("writes a timed event in the host zone with its VTIMEZONE, as a complete calendar", async () => {
      await runOk(newEvent(settings(), plain, UID, NOW));
      const ics = await written();
      expect(ics).toMatch(
        /^BEGIN:VCALENDAR\r\nVERSION:2\.0\r\nPRODID:-\/\/mcp-khal\/\/EN\r\nBEGIN:VTIMEZONE\r\nTZID:Europe\/Berlin\r\n/,
      );
      expect(ics).toMatch(/\r\nUID:fixed-uid@mcp-khal\r\n/);
      expect(ics).toMatch(/\r\nDTSTAMP:20261102T100000Z\r\n/);
      expect(ics).toMatch(/\r\nDTSTART;TZID=Europe\/Berlin:20300115T120000\r\n/);
      expect(ics).toMatch(/\r\nDTEND;TZID=Europe\/Berlin:20300115T130000\r\n/);
      expect(ics).toMatch(/\r\nSUMMARY:Lunch\r\n/);
      expect(ics.endsWith("END:VEVENT\r\nEND:VCALENDAR\r\n")).toBe(true);
      expect(ics.slice(ics.indexOf("BEGIN:VEVENT"))).not.toMatch(/RRULE:|ORGANIZER|ATTENDEE|VALARM/);
    });

    it("uses the zone of the call, else the host zone of the settings", async () => {
      await runOk(newEvent(settings(), { ...plain, zone: "America/New_York" }, UID, NOW));
      expect(await written()).toMatch(/DTSTART;TZID=America\/New_York:20300115T120000/);
    });

    it("writes UTC events with Z and without a VTIMEZONE", async () => {
      await runOk(newEvent(settings({}, { timezone: "UTC" }), plain, UID, NOW));
      const ics = await written();
      expect(ics).toMatch(/DTSTART:20300115T120000Z/);
      expect(ics).toMatch(/DTEND:20300115T130000Z/);
      expect(ics).not.toMatch(/VTIMEZONE/);
    });

    it("takes a duration, and defaults to one hour", async () => {
      await runOk(newEvent(settings(), { ...plain, end: undefined, duration: "90m" }, UID, NOW));
      expect(await written()).toMatch(/DTEND;TZID=Europe\/Berlin:20300115T133000/);
      const file2 = await tempDir();
      try {
        await runOk(
          newEvent(
            settings({}, {}, { path: file2 }),
            { ...plain, calendar: "home", end: undefined },
            UID,
            NOW,
          ),
        );
        expect(await written(file2)).toMatch(/DTEND;TZID=Europe\/Berlin:20300115T130000/);
      } finally {
        await removeDir(file2);
      }
    });

    it("writes all-day events as dates, the end day inclusive in the input", async () => {
      await runOk(newEvent(settings(), { ...plain, start: "2030-01-15", end: "2030-01-16" }, UID, NOW));
      const ics = await written();
      expect(ics).toMatch(/DTSTART;VALUE=DATE:20300115/);
      expect(ics).toMatch(/DTEND;VALUE=DATE:20300117/);
      expect(ics).not.toMatch(/VTIMEZONE/);
    });

    it("writes location and description escaped", async () => {
      await runOk(newEvent(settings(), { ...plain, location: "Room 1, A", description: "a;b" }, UID, NOW));
      const ics = await written();
      expect(ics).toMatch(/LOCATION:Room 1\\, A/);
      expect(ics).toMatch(/DESCRIPTION:a\\;b/);
    });

    it("writes a recurring series with RRULE", async () => {
      await runOk(
        newEvent(
          settings(),
          {
            ...series,
            start: "2026-11-04T10:00",
            end: "2026-11-04T11:00",
            recurrence: { pattern: { kind: "weekly", weekdays: ["wednesday"] } },
          },
          UID,
          NOW,
        ),
      );
      const ics = await written();
      expect(ics).toMatch(/\r\nRRULE:FREQ=WEEKLY;BYDAY=WE\r\n/);
      expect(ics).not.toMatch(/ORGANIZER|ATTENDEE/);
    });

    it("does not overwrite an existing file", async () => {
      await runOk(newEvent(settings(), plain, UID, NOW));
      const e = await runFail(newEvent(settings(), { ...plain, summary: "Other" }, UID, NOW));
      expect(e._tag).toBe("IoError");
      expect(await written()).toMatch(/SUMMARY:Lunch/);
      expect(await files()).toEqual([FILE]);
    });

    it("fails when the vdir does not exist", async () => {
      const e = await runFail(
        newEvent(testSettings({ calendars: { work: { path: join(dir, "nope") } } }), plain, UID, NOW),
      );
      expect(e._tag).toBe("IoError");
    });

    it("refuses a uid that is not a safe file name", async () => {
      const e = await runFail(newEvent(settings(), plain, "../evil", NOW));
      expect(e).toBeInstanceOf(InvalidInput);
      expect(e.message).toMatch(/not a safe file name/);
      expect(await files()).toEqual([]);
    });
  });

  describe("invalid input writes nothing", () => {
    const fails = async (input: NewEventInput, s: Settings = settings()): Promise<string> => {
      const e = await runFail(newEvent(s, input, UID, NOW));
      expect(e).toBeInstanceOf(InvalidInput);
      expect(await files()).toEqual([]);
      return e.message;
    };

    it("rejects an organizer without attendees", async () => {
      expect(await fails({ ...plain, organizer: "me@x.com" })).toMatch(/only valid together with attendees/);
    });

    it("rejects bad times, zones and durations", async () => {
      await fails({ ...plain, start: "tomorrow 10:00" });
      await fails({ ...plain, end: "2030-01-15T11:00" });
      await fails({ ...plain, zone: "Mars/Olympus" });
      await fails({ ...plain, end: undefined, duration: "soon" });
      await fails({ ...plain, duration: "1h" });
    });

    it("rejects an empty title and an unknown alarm", async () => {
      await fails({ ...plain, summary: "  " });
      await fails({ ...plain, alarm: "soon" });
    });

    it("gives no warning when the event could not be created", async () => {
      expect(await fails({ ...plain, summary: "a/b", start: "x" })).not.toMatch(/WARNING/);
    });

    it("rejects a calendar without a path or with a bad name", async () => {
      expect(await fails({ ...plain, calendar: "unknown" })).toMatch(/is not configured/);
      await fails({ ...plain, calendar: "a\u0001b" });
    });
  });

  describe("title warning", () => {
    it("appends the warning to the success text of a plain event and an invite", async () => {
      const s = settings({ email: "me@work.com" });
      const out = await runOk(newEvent(s, { ...plain, summary: "A/B" }, UID, NOW));
      expect(out).toMatch(/^Created event 'A\/B'.*\n\s*WARNING: .*CalDAV/);
      await removeDir(dir);
      dir = await tempDir();
      const invite = await runOk(
        newEvent(
          settings({ email: "me@work.com" }),
          { ...plain, summary: "A/B", attendees: ["you@x.org"] },
          UID,
          NOW,
        ),
      );
      expect(invite).toMatch(/WARNING: .*CalDAV/);
    });

    it("adds nothing for a title without a slash, and the slash in other fields is fine", async () => {
      const out = await runOk(
        newEvent(settings(), { ...plain, location: "a/b", description: "c/d" }, UID, NOW),
      );
      expect(out).not.toMatch(/WARNING/);
    });
  });

  describe("reminders", () => {
    /** `alarms` is calendar name -> that calendar's own reminder */
    const withAlarm = (alarm?: string, over: Partial<Settings> = {}) =>
      settings(alarm === undefined ? {} : { alarm }, over);

    it("adds no reminder when the calendar has none configured", async () => {
      await runOk(newEvent(withAlarm(), plain, UID, NOW));
      expect(await triggers()).toEqual([]);
    });

    it("writes the calendar's reminder as a VALARM with action, description and trigger", async () => {
      await runOk(newEvent(withAlarm("45m"), plain, UID, NOW));
      const ics = await written();
      expect(ics).toMatch(
        /BEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:Reminder\r\nTRIGGER:-PT45M\r\nEND:VALARM/,
      );
    });

    it("writes days as -P<n>D and hours as -PT<n>H, for series and invites too", async () => {
      await runOk(newEvent(withAlarm("2d"), series, UID, NOW));
      expect(await triggers()).toEqual(["TRIGGER:-P2D"]);
      await removeDir(dir);
      dir = await tempDir();
      await runOk(
        newEvent(
          withAlarm("3h", { calendars: { work: { path: dir, alarm: "3h", email: "me@work.com" } } }),
          { ...plain, attendees: ["you@x.com"] },
          UID,
          NOW,
        ),
      );
      expect(await triggers()).toEqual(["TRIGGER:-PT3H"]);
    });

    it("writes no VALARM for 'none', configured or explicit", async () => {
      await runOk(newEvent(withAlarm("none"), plain, UID, NOW));
      expect(await triggers()).toEqual([]);
      await removeDir(dir);
      dir = await tempDir();
      await runOk(newEvent(withAlarm("15m"), { ...plain, alarm: "none" }, UID, NOW));
      expect(await triggers()).toEqual([]);
    });

    it("lets an explicit alarm override the configuration", async () => {
      await runOk(newEvent(withAlarm("1d"), { ...plain, alarm: "5m" }, UID, NOW));
      expect(await triggers()).toEqual(["TRIGGER:-PT5M"]);
    });

    it("applies the reminder of the calendar the event goes to, and of the default calendar", async () => {
      const s = settings({ alarm: "1d" }, { defaultCalendar: "home" }, { alarm: "90m" });
      await runOk(newEvent(s, { ...plain, calendar: undefined }, UID, NOW));
      expect(await triggers(other)).toEqual(["TRIGGER:-PT90M"]);
      await runOk(newEvent(s, plain, UID, NOW));
      expect(await triggers()).toEqual(["TRIGGER:-P1D"]);
    });
  });

  describe("calendar choice", () => {
    it("files the event in the default calendar when the call names none", async () => {
      await runOk(
        newEvent(settings({}, { defaultCalendar: "home" }), { ...plain, calendar: undefined }, UID, NOW),
      );
      expect(await files(other)).toEqual([FILE]);
      expect(await files()).toEqual([]);
    });

    it("lets the calendar of the call win over the default calendar", async () => {
      await runOk(
        newEvent(settings({}, { defaultCalendar: "work" }), { ...plain, calendar: " home " }, UID, NOW),
      );
      expect(await files(other)).toEqual([FILE]);
    });

    it("refuses to create an event when there is no calendar at all", async () => {
      for (const input of [
        { ...plain, calendar: undefined },
        { ...series, calendar: undefined },
      ]) {
        const e = await runFail(newEvent(settings(), input, UID, NOW));
        expect(e).toBeInstanceOf(InvalidInput);
        expect(e.message).toMatch(/no calendar given and no default calendar is configured/);
      }
      expect(await files()).toEqual([]);
    });

    it("does not replace a blank calendar of the call by the default calendar", async () => {
      const e = await runFail(
        newEvent(settings({}, { defaultCalendar: "work" }), { ...plain, calendar: "   " }, UID, NOW),
      );
      expect(e).toBeInstanceOf(InvalidInput);
      expect(await files()).toEqual([]);
    });
  });

  describe("invites", () => {
    const invite: NewEventInput = {
      ...plain,
      start: "2026-11-04T10:00",
      end: "2026-11-04T11:00",
      summary: "Review",
      attendees: ["you@x.com"],
    };

    it("takes the organizer from the calendar's address", async () => {
      await runOk(newEvent(settings({ email: "me@work.com" }), invite, UID, NOW));
      const ics = await written();
      expect(ics).toMatch(/ORGANIZER:mailto:me@work\.com\r\n/);
      expect(ics).toMatch(/ATTENDEE;[^\r]*:mailto:you@x\.com\r\n/);
      expect(ics.slice(ics.indexOf("BEGIN:VEVENT"))).not.toMatch(/RRULE/);
    });

    it("an explicit organizer wins over the mapping", async () => {
      await runOk(
        newEvent(settings({ email: "me@work.com" }), { ...invite, organizer: "alias@work.com" }, UID, NOW),
      );
      expect(await written()).toMatch(/ORGANIZER:mailto:alias@work\.com/);
    });

    it("uses the address of the default calendar", async () => {
      await runOk(
        newEvent(
          settings({}, { defaultCalendar: "home" }, { email: "me@home.org" }),
          { ...invite, calendar: undefined },
          UID,
          NOW,
        ),
      );
      expect(await written(other)).toMatch(/ORGANIZER:mailto:me@home\.org/);
    });

    it("fails when no organizer can be determined", async () => {
      const e = await runFail(newEvent(settings(), invite, UID, NOW));
      expect(e).toBeInstanceOf(InvalidInput);
      expect(e.message).toMatch(/no address known for calendar 'work'/);
      expect(await files()).toEqual([]);
    });
  });
});
