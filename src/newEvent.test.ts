import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InvalidInput } from "./errors.js";
import { newEvent, timestamp } from "./newEvent.js";
import type { Settings } from "./settings.js";
import { type FakeKhal, fakeKhal, runFail, runOk, unfold } from "./testlib.js";

const NOW = new Date("2026-11-02T10:00:00.123Z");
const UID = "fixed-uid";

describe("timestamp", () => {
  it("formats an ICS DTSTAMP", () => {
    expect(timestamp(NOW)).toBe("20261102T100000Z");
  });
});

describe("newEvent reminders", () => {
  let fake: FakeKhal;

  beforeEach(async () => {
    fake = await fakeKhal({ stdout: "done\n" });
  });
  afterEach(async () => {
    await fake.cleanup();
  });

  /** `alarms` is calendar name -> that calendar's own reminder */
  const settingsWith = (alarms: Record<string, string> = {}, defaultCalendar?: string) =>
    fake.settings({
      calendars: Object.fromEntries(Object.entries(alarms).map(([name, alarm]) => [name, { alarm }])),
      ...(defaultCalendar === undefined ? {} : { defaultCalendar }),
    });

  /** the `-m` value of the single khal call, or undefined when there is none */
  const alarmArg = async (): Promise<string | undefined> => {
    const [call] = await fake.calls();
    const i = call?.indexOf("-m") ?? -1;
    return i < 0 ? undefined : call?.[i + 1];
  };

  const plain = { start: "2030-01-15 12:00", end: "13:00", summary: "Lunch" };
  const series = {
    start: "2030-01-16 09:00",
    end: "09:30",
    summary: "Standup",
    recurrence: { pattern: { kind: "daily" } },
  } as const;
  const triggers = async (): Promise<string[]> =>
    ((await fake.imported()) ?? "").split("\r\n").filter((l) => l.startsWith("TRIGGER"));

  describe("khal new", () => {
    it("adds no reminder when the calendar has none configured", async () => {
      await runOk(newEvent(settingsWith(), { ...plain, calendar: "work" }, UID, NOW));
      expect(await alarmArg()).toBeUndefined();
    });

    it("applies the reminder of the calendar the event goes to", async () => {
      await runOk(
        newEvent(settingsWith({ work: "1d", home: "none" }), { ...plain, calendar: "work" }, UID, NOW),
      );
      expect(await alarmArg()).toBe("1d");
    });

    it("adds no reminder on a calendar configured with 'none', or on one that is not configured", async () => {
      await runOk(newEvent(settingsWith({ home: "none" }), { ...plain, calendar: "home" }, UID, NOW));
      expect(await alarmArg()).toBeUndefined();
      await runOk(newEvent(settingsWith({ work: "1d" }), { ...plain, calendar: "other" }, UID, NOW));
      const calls = await fake.calls();
      expect(calls[1]?.includes("-m")).toBe(false);
    });

    it("prefers an explicit alarm over the configuration", async () => {
      await runOk(
        newEvent(settingsWith({ work: "1d" }), { ...plain, calendar: "work", alarm: "5m" }, UID, NOW),
      );
      expect(await alarmArg()).toBe("5m");
    });

    it("lets an explicit 'none' suppress a configured reminder", async () => {
      await runOk(
        newEvent(settingsWith({ work: "1d" }), { ...plain, calendar: "work", alarm: "none" }, UID, NOW),
      );
      expect(await alarmArg()).toBeUndefined();
    });

    it("applies the reminder of the default calendar when the call names no calendar", async () => {
      await runOk(newEvent(settingsWith({ work: "90m", home: "1d" }, "work"), plain, UID, NOW));
      expect(await alarmArg()).toBe("90m");
    });
  });

  describe("imported ICS (series and invites)", () => {
    it("writes the calendar's reminder as a VALARM trigger, in days and in minutes", async () => {
      await runOk(newEvent(settingsWith({ work: "2d" }), { ...series, calendar: "work" }, UID, NOW));
      expect(await triggers()).toEqual(["TRIGGER:-P2D"]);
      await runOk(newEvent(settingsWith({ work: "45m" }), { ...series, calendar: "work" }, UID, NOW));
      expect(await triggers()).toEqual(["TRIGGER:-PT45M"]);
    });

    it("writes the calendar's reminder for invites too", async () => {
      await runOk(
        newEvent(
          fake.settings({ calendars: { work: { email: "me@work.com", alarm: "30m" } } }),
          {
            calendar: "work",
            start: "2030-01-17 10:00",
            end: "11:00",
            summary: "Review",
            attendees: ["you@x.com"],
          },
          UID,
          NOW,
        ),
      );
      expect(await triggers()).toEqual(["TRIGGER:-PT30M"]);
    });

    it("writes no VALARM for 'none', configured or explicit, nor for a calendar without a reminder", async () => {
      await runOk(newEvent(settingsWith({ work: "none" }), { ...series, calendar: "work" }, UID, NOW));
      expect(await triggers()).toEqual([]);
      await runOk(
        newEvent(settingsWith({ work: "15m" }), { ...series, calendar: "work", alarm: "none" }, UID, NOW),
      );
      expect(await triggers()).toEqual([]);
      await runOk(newEvent(settingsWith(), { ...series, calendar: "work" }, UID, NOW));
      expect(await triggers()).toEqual([]);
    });

    it("lets an explicit alarm override the configuration", async () => {
      await runOk(
        newEvent(settingsWith({ work: "1d" }), { ...series, calendar: "work", alarm: "2h" }, UID, NOW),
      );
      expect(await triggers()).toEqual(["TRIGGER:-PT2H"]);
    });

    it("applies the reminder of the default calendar when the call names no calendar", async () => {
      await runOk(newEvent(settingsWith({ work: "3d" }, "work"), series, UID, NOW));
      expect(await triggers()).toEqual(["TRIGGER:-P3D"]);
    });
  });
});

describe("newEvent default calendar", () => {
  let fake: FakeKhal;

  beforeEach(async () => {
    fake = await fakeKhal({ stdout: "done\n" });
  });
  afterEach(async () => {
    await fake.cleanup();
  });

  const calendars = { work: { email: "me@work.com" }, home: { email: "me@home.org" } };
  const settings = (defaultCalendar?: string) =>
    fake.settings({ calendars, ...(defaultCalendar === undefined ? {} : { defaultCalendar }) });
  const plain = { start: "2030-01-15 12:00", end: "13:00", summary: "Lunch" };
  const invite = {
    start: "2030-01-17 10:00",
    end: "11:00",
    summary: "Review",
    attendees: ["you@x.com"],
  };

  it("files a plain event in the default calendar when the call names none, telling khal explicitly", async () => {
    await runOk(newEvent(settings("work"), plain, UID, NOW));
    expect(await fake.calls()).toEqual([
      ["new", "-a", "work", "--", "2030-01-15", "12:00", "13:00", "Lunch"],
    ]);
  });

  it("imports a series or an invite into the default calendar, with that calendar's organizer", async () => {
    await runOk(newEvent(settings("home"), invite, UID, NOW));
    const [call] = await fake.calls();
    expect(call?.slice(0, 3)).toEqual(["import", "-a", "home"]);
    expect(unfold((await fake.imported()) ?? "")).toMatch(/ORGANIZER:mailto:me@home\.org/);
  });

  it("lets the calendar of the call win over the default calendar", async () => {
    await runOk(newEvent(settings("work"), { ...plain, calendar: " home " }, UID, NOW));
    expect((await fake.calls())[0]?.slice(0, 3)).toEqual(["new", "-a", "home"]);
  });

  it("refuses to create an event when there is no calendar at all: khal's own default is never relied on", async () => {
    for (const input of [plain, invite, { ...plain, recurrence: { pattern: { kind: "daily" } } } as const]) {
      const e = await runFail(newEvent(settings(), input, UID, NOW));
      expect(e).toBeInstanceOf(InvalidInput);
      expect(e.message).toMatch(/no calendar given and no default calendar is configured/);
    }
    expect(await fake.calls()).toEqual([]);
  });

  it("does not replace a blank calendar of the call by the default calendar", async () => {
    const e = await runFail(newEvent(settings("work"), { ...plain, calendar: "   " }, UID, NOW));
    expect(e).toBeInstanceOf(InvalidInput);
    expect(await fake.calls()).toEqual([]);
  });
});

describe("newEvent", () => {
  let fake: FakeKhal;
  let settings: Settings;

  beforeEach(async () => {
    fake = await fakeKhal({ stdout: "done\n" });
    settings = fake.settings({ calendars: { work: { email: "me@work.com" } } });
  });

  afterEach(async () => {
    await fake.cleanup();
  });

  it("creates a plain event with `khal new`", async () => {
    const out = await runOk(
      newEvent(
        settings,
        { calendar: "work", start: "tomorrow 10:00", end: "1h", summary: "Lunch" },
        UID,
        NOW,
      ),
    );
    expect(out).toBe("done\n");
    expect(await fake.calls()).toEqual([["new", "-a", "work", "--", "tomorrow", "10:00", "1h", "Lunch"]]);
  });

  it("rejects an organizer without attendees", async () => {
    const e = await runFail(
      newEvent(settings, { start: "tomorrow", summary: "x", organizer: "me@x.com" }, UID, NOW),
    );
    expect(e).toBeInstanceOf(InvalidInput);
    expect(await fake.calls()).toEqual([]);
  });

  it("imports a recurring series without invite lines", async () => {
    await runOk(
      newEvent(
        settings,
        {
          calendar: "work",
          start: "2026-11-04 10:00",
          end: "11:00",
          summary: "Standup",
          recurrence: { pattern: { kind: "weekly", weekdays: ["wednesday"] } },
        },
        UID,
        NOW,
      ),
    );
    const ics = (await fake.imported()) ?? "";
    expect(ics).toMatch(/UID:fixed-uid@mcp-khal\r\n/);
    expect(ics).toMatch(/DTSTAMP:20261102T100000Z\r\n/);
    expect(ics).toMatch(/RRULE:FREQ=WEEKLY;BYDAY=WE\r\n/);
    expect(ics).not.toMatch(/ORGANIZER|ATTENDEE/);
  });

  it("invites attendees with the organizer taken from the settings' mapping", async () => {
    await runOk(
      newEvent(
        settings,
        {
          calendar: "work",
          start: "2026-11-04 10:00",
          end: "11:00",
          summary: "Review",
          attendees: ["you@x.com"],
        },
        UID,
        NOW,
      ),
    );
    const [call] = await fake.calls();
    expect(call?.slice(0, 3)).toEqual(["import", "-a", "work"]);
    const ics = unfold((await fake.imported()) ?? "");
    expect(ics).toMatch(/ORGANIZER:mailto:me@work\.com\r\n/);
    expect(ics).toMatch(/ATTENDEE;[^\r]*:mailto:you@x\.com\r\n/);
    expect(ics).not.toMatch(/RRULE/);
  });

  it("an explicit organizer wins over the mapping", async () => {
    await runOk(
      newEvent(
        settings,
        {
          calendar: "work",
          start: "2026-11-04 10:00",
          end: "11:00",
          summary: "Review",
          attendees: ["you@x.com"],
          organizer: "alias@work.com",
        },
        UID,
        NOW,
      ),
    );
    expect((await fake.imported()) ?? "").toMatch(/ORGANIZER:mailto:alias@work\.com/);
  });

  it("does not consult anything but the settings for the organizer", async () => {
    const bare = fake.settings({ calendars: {} });
    const e = await runFail(
      newEvent(
        bare,
        {
          calendar: "work",
          start: "2026-11-04 10:00",
          end: "11:00",
          summary: "Review",
          attendees: ["you@x.com"],
        },
        UID,
        NOW,
      ),
    );
    expect(e).toBeInstanceOf(InvalidInput);
    expect(e.message).toMatch(/no address known for calendar 'work'/);
  });

  it("fails without khal calls when no organizer can be determined", async () => {
    const e = await runFail(
      newEvent(
        settings,
        { start: "2026-11-04 10:00", end: "11:00", summary: "Review", attendees: ["you@x.com"] },
        UID,
        NOW,
      ),
    );
    expect(e).toBeInstanceOf(InvalidInput);
    expect(await fake.calls()).toEqual([]);
  });

  it("rejects khal-style relative times for invites", async () => {
    const e = await runFail(
      newEvent(
        settings,
        {
          calendar: "work",
          start: "tomorrow 10:00",
          end: "1h",
          summary: "Review",
          attendees: ["you@x.com"],
        },
        UID,
        NOW,
      ),
    );
    expect(e).toBeInstanceOf(InvalidInput);
    expect(await fake.calls()).toEqual([]);
  });
});
