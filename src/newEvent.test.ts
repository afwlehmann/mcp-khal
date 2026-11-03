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

describe("newEvent", () => {
  let fake: FakeKhal;
  let settings: Settings;

  beforeEach(async () => {
    fake = await fakeKhal({ stdout: "done\n" });
    settings = fake.settings({ calendarEmails: { work: "me@work.com" } });
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
    const bare = fake.settings({ calendarEmails: {} });
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
