import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listEvents, renderFile } from "../events.js";
import { unfoldLines } from "../ics.js";
import { itReq, runOk, type Sandbox, sandbox } from "../testlib.js";

/*
 * What calendar files of real clients look like, and what the read side does with them.
 *
 * STANDARD FIRST: files we write follow RFC 5545 with standard properties only. Reading follows
 * the standard too. The ONLY deviations we tolerate on input are these (each has a test named
 * "tolerates ..." below, without a requirement id, because no requirement asks for it):
 *
 *   1. Windows time zone names without a VTIMEZONE (Outlook: "W. Europe Standard Time"), mapped
 *      with a CLDR snapshot (`WINDOWS_ZONES` in src/timezone.ts). Customized names ("Customized Time
 *      Zone") and the like are only usable with a VTIMEZONE in the file.
 *   2. A UTF-8 byte order mark at the start of the file.
 *   3. LF or a lone CR as line ending instead of CRLF.
 *   4. A tab as fold character (the RFC allows it, some readers do not).
 *   5. Lowercase property names (the RFC says names are case-insensitive).
 *   6. `mailto:` in any case in ORGANIZER and ATTENDEE.
 *   7. An all-day event whose DTEND equals its DTSTART (Outlook): it is read as one day.
 *
 * Everything else that is not standard is reported as a problem (never silently guessed). Among
 * others: a TZID without VTIMEZONE that is neither an IANA nor a known Windows name (Zimbra's
 * "(GMT+01.00) Amsterdam ...", Thunderbird's "/mozilla.org/20050126_1/Europe/Berlin"), a file with
 * two UIDs, a file without UID. A TZID refers to the VTIMEZONE of the same file first (RFC 5545
 * 3.2.19), the IANA zone of that name only when the file has none.
 *
 * Vendor properties (X-MICROSOFT-CDO-*, X-ALT-DESC, X-APPLE-*, X-WR-*, X-LIC-LOCATION, ...) are
 * ignored on read and kept by the edit tools untouched; we never add one.
 */

const NOW = new Date("2026-11-02T08:00:00Z");

const crlf = (...lines: string[]): string => `${lines.join("\r\n")}\r\n`;

/** A calendar object; `head` goes between PRODID and the components. */
const cal = (head: readonly string[], ...body: string[]): string =>
  crlf("BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//vendor//EN", ...head, ...body, "END:VCALENDAR");

const utc = (day: string): number => Date.parse(`${day}T00:00:00Z`);

/** The occurrences of a file text in a window of UTC days, rendered in the host zone (UTC unless given). */
const renderAt = (text: string, from = "2026-11-01", to = "2026-12-01", zone = "UTC") =>
  renderFile("cal", { file: "/x/a.ics", uid: "u", lines: unfoldLines(text) }, utc(from), utc(to), zone);

/** Start and end as `YYYY-MM-DD HH:MM` of the one occurrence. */
const span = (text: string, from?: string, to?: string, zone?: string): string => {
  const r = renderAt(text, from, to, zone);
  expect(r.problems).toEqual([]);
  expect(r.events).toHaveLength(1);
  const e = r.events[0]?.event;
  return `${e?.startDate} ${e?.startTime}..${e?.endDate} ${e?.endTime}`;
};

/** An Outlook-style VTIMEZONE: DTSTART in 1601 and yearly rules for the last Sunday of March and October. */
const europeVtimezone = (tzid: string, since = "16010101", extra: readonly string[] = []): string =>
  crlf(
    "BEGIN:VTIMEZONE",
    `TZID:${tzid}`,
    ...extra,
    "BEGIN:STANDARD",
    `DTSTART:${since}T030000`,
    "TZOFFSETFROM:+0200",
    "TZOFFSETTO:+0100",
    "RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=10",
    "END:STANDARD",
    "BEGIN:DAYLIGHT",
    `DTSTART:${since}T020000`,
    "TZOFFSETFROM:+0100",
    "TZOFFSETTO:+0200",
    "RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=3",
    "END:DAYLIGHT",
    "END:VTIMEZONE",
  ).trimEnd();

const vevent = (...props: string[]): string =>
  ["BEGIN:VEVENT", "UID:u", "DTSTAMP:20261101T120000Z", ...props, "END:VEVENT"].join("\r\n");

describe("Outlook", () => {
  const winZone = "W. Europe Standard Time";
  const meeting = (tzid: string) =>
    vevent(
      `DTSTART;TZID=${tzid}:20261102T090000`,
      `DTEND;TZID=${tzid}:20261102T100000`,
      "SUMMARY:Planning",
      "DESCRIPTION:Plain text",
      "X-ALT-DESC;FMTTYPE=text/html:<html><body><p>HTML text</p></body></html>",
      "X-MICROSOFT-CDO-BUSYSTATUS:BUSY",
      "X-MICROSOFT-CDO-IMPORTANCE:1",
      "X-MICROSOFT-DISALLOW-COUNTER:FALSE",
    );

  it("tolerates a Windows time zone name without VTIMEZONE: W. Europe Standard Time is Europe/Berlin", () => {
    // 09:00 in Berlin in November is 08:00 UTC
    expect(span(cal([], meeting(winZone)))).toBe("2026-11-02 08:00..2026-11-02 09:00");
    // and in July 07:00 UTC: the zone is the real one, not a fixed offset
    const july = cal(
      [],
      vevent(`DTSTART;TZID=${winZone}:20260701T090000`, `DTEND;TZID=${winZone}:20260701T100000`),
    );
    expect(span(july, "2026-07-01", "2026-07-02")).toBe("2026-07-01 07:00..2026-07-01 08:00");
  });

  itReq(
    "RFC5545:3.2.19:missing-vtimezone-inconsistent",
    "a Windows zone name without VTIMEZONE is resolved by the CLDR snapshot, an unknown one is a problem (never floating)",
    () => {
      const unknown = renderAt(cal([], meeting("Nowhere Standard Time")));
      expect(unknown.events).toEqual([]);
      expect(unknown.problems).toHaveLength(1);
      expect(unknown.problems[0]).toContain('unknown time zone "Nowhere Standard Time"');
    },
  );

  it("reads W. Europe Standard Time from the VTIMEZONE of the file (Outlook shape, 1601 start)", () => {
    const text = cal([], europeVtimezone(winZone), meeting(winZone));
    expect(span(text)).toBe("2026-11-02 08:00..2026-11-02 09:00");
    const july = cal(
      [],
      europeVtimezone(winZone),
      vevent(`DTSTART;TZID=${winZone}:20260701T090000`, `DTEND;TZID=${winZone}:20260701T100000`),
    );
    expect(span(july, "2026-07-01", "2026-07-02")).toBe("2026-07-01 07:00..2026-07-01 08:00");
  });

  it("reads 'Customized Time Zone' from its VTIMEZONE", () => {
    const text = cal([], europeVtimezone("Customized Time Zone"), meeting("Customized Time Zone"));
    expect(span(text)).toBe("2026-11-02 08:00..2026-11-02 09:00");
  });

  it("reports 'Customized Time Zone' without VTIMEZONE as a problem", () => {
    const r = renderAt(cal([], meeting("Customized Time Zone")));
    expect(r.events).toEqual([]);
    expect(r.problems[0]).toContain('unknown time zone "Customized Time Zone"');
  });

  it("the VTIMEZONE of the file comes first, even for a name that is a Windows zone", () => {
    const fixed = crlf(
      "BEGIN:VTIMEZONE",
      `TZID:${winZone}`,
      "BEGIN:STANDARD",
      "DTSTART:19700101T000000",
      "TZOFFSETFROM:+0300",
      "TZOFFSETTO:+0300",
      "END:STANDARD",
      "END:VTIMEZONE",
    ).trimEnd();
    expect(span(cal([], fixed, meeting(winZone)))).toBe("2026-11-02 06:00..2026-11-02 07:00");
  });

  it("tolerates an all-day event whose DTEND equals its DTSTART: it is read as one day", () => {
    const text = cal(
      [],
      vevent("DTSTART;VALUE=DATE:20261105", "DTEND;VALUE=DATE:20261105", "SUMMARY:Holiday"),
    );
    const r = renderAt(text);
    expect(r.problems).toEqual([]);
    expect(r.events).toHaveLength(1);
    expect(r.events[0]?.event).toMatchObject({
      allDay: "True",
      startDate: "2026-11-05",
      endDate: "2026-11-05",
      title: "Holiday",
    });
  });

  it("X-MICROSOFT-CDO-* and X-ALT-DESC are ignored: the description is the plain DESCRIPTION", () => {
    const r = renderAt(cal([], meeting(winZone)));
    expect(r.events[0]?.event).toMatchObject({ title: "Planning", description: "Plain text" });
  });

  it("X-ALT-DESC is never shown, even when DESCRIPTION is missing", () => {
    const text = cal(
      [],
      vevent(
        "DTSTART:20261102T090000Z",
        "SUMMARY:S",
        "X-ALT-DESC;FMTTYPE=text/html:<html><body>only html</body></html>",
      ),
    );
    expect(renderAt(text).events[0]?.event.description).toBe("");
  });

  itReq(
    "POLICY:tolerate-method-on-read",
    "a file with METHOD:REQUEST (saved invitation) is read like any other",
    () => {
      const text = cal(["METHOD:REQUEST", "X-MS-OLK-FORCEINSPECTOROPEN:TRUE"], meeting(winZone));
      const r = renderAt(text);
      expect(r.problems).toEqual([]);
      expect(r.events).toHaveLength(1);
    },
  );
});

describe("Zimbra", () => {
  const zone = "(GMT+01.00) Amsterdam / Berlin / Bern / Rome / Stockholm / Vienna";
  // the people tests only need a readable file: put the VTIMEZONE in front of the event
  const europeAndText = (text: string): string =>
    text.replace("BEGIN:VEVENT", `${europeVtimezone(zone, "19710101")}\r\nBEGIN:VEVENT`);
  const meeting = (...extra: string[]) =>
    vevent(
      `DTSTART;TZID="${zone}":20261102T090000`,
      `DTEND;TZID="${zone}":20261102T100000`,
      "SUMMARY:Sync",
      ...extra,
    );

  it("reads its descriptive TZID from the VTIMEZONE of the file", () => {
    const text = cal([], europeVtimezone(zone, "19710101"), meeting());
    expect(span(text)).toBe("2026-11-02 08:00..2026-11-02 09:00");
  });

  it("reports that TZID without VTIMEZONE as a problem: it is neither IANA nor a Windows name", () => {
    const r = renderAt(cal([], meeting()));
    expect(r.events).toEqual([]);
    expect(r.problems[0]).toContain(`unknown time zone "${zone}"`);
  });

  it("shows a room (CUTYPE=ROOM) with an address that is not a mailto: URI as it is", () => {
    const text = cal(
      [],
      meeting(
        "ORGANIZER;CN=Boss:mailto:boss@example.com",
        "ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;CN=Alice:mailto:alice@example.com",
        "ATTENDEE;CUTYPE=ROOM;ROLE=NON-PARTICIPANT;PARTSTAT=ACCEPTED;CN=Room Alpha:urn:uuid:5a1f2c",
      ),
    );
    const r = renderAt(europeAndText(text));
    expect(r.problems).toEqual([]);
    expect(r.events[0]?.event.attendees).toBe("Alice <alice@example.com>, Room Alpha <urn:uuid:5a1f2c>");
  });

  it("shows the organizer, not the assistant who sent the invitation (SENT-BY)", () => {
    const text = cal(
      [],
      meeting('ORGANIZER;CN=Boss;SENT-BY="mailto:assistant@example.com":mailto:boss@example.com'),
    );
    const r = renderAt(europeAndText(text));
    expect(r.events[0]?.event.organizer).toBe("Boss <boss@example.com>");
  });
});

describe("Google", () => {
  const file = (...components: string[]) =>
    cal(["X-WR-CALNAME:Work", "X-WR-TIMEZONE:Europe/Berlin", "X-WR-CALDESC:my calendar"], ...components);
  const google = (...props: string[]) =>
    ["BEGIN:VEVENT", "UID:x@google.com", "DTSTAMP:20261101T120000Z", ...props, "END:VEVENT"].join("\r\n");

  it("reads a UTC event and ignores the X-WR-* properties of the calendar", () => {
    const text = file(google("DTSTART:20261102T090000Z", "DTEND:20261102T100000Z", "SUMMARY:Standup"));
    expect(span(text)).toBe("2026-11-02 09:00..2026-11-02 10:00");
  });

  it("a cancelled instance is an exception with STATUS:CANCELLED: listed and flagged, the others stay", () => {
    const text = file(
      google(
        "DTSTART:20261102T090000Z",
        "DTEND:20261102T093000Z",
        "RRULE:FREQ=DAILY;COUNT=3",
        "SUMMARY:Standup",
      ),
      google(
        "RECURRENCE-ID:20261103T090000Z",
        "DTSTART:20261103T090000Z",
        "DTEND:20261103T093000Z",
        "STATUS:CANCELLED",
        "SUMMARY:Standup",
      ),
    );
    const r = renderAt(text);
    expect(r.problems).toEqual([]);
    expect(r.events.map((x) => `${x.event.startDate}:${x.event.cancelled}`)).toEqual([
      "2026-11-02:",
      "2026-11-03:CANCELLED",
      "2026-11-04:",
    ]);
  });
});

describe("Apple", () => {
  const appleTimezone = crlf(
    "BEGIN:VTIMEZONE",
    "TZID:Europe/Berlin",
    "X-LIC-LOCATION:Europe/Berlin",
    "BEGIN:DAYLIGHT",
    "TZOFFSETFROM:+0100",
    "TZOFFSETTO:+0200",
    "TZNAME:CEST",
    "DTSTART:19700329T020000",
    "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
    "END:DAYLIGHT",
    "BEGIN:STANDARD",
    "TZOFFSETFROM:+0200",
    "TZOFFSETTO:+0100",
    "TZNAME:CET",
    "DTSTART:19701025T030000",
    "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
    "END:STANDARD",
    "END:VTIMEZONE",
  ).trimEnd();

  it("shows LOCATION and ignores X-APPLE-STRUCTURED-LOCATION", () => {
    const text = cal(
      [],
      appleTimezone,
      vevent(
        "DTSTART;TZID=Europe/Berlin:20261102T090000",
        "DTEND;TZID=Europe/Berlin:20261102T100000",
        "SUMMARY:Visit",
        "LOCATION:Office\\nStreet 1\\, Berlin",
        'X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-ADDRESS="Street 1, Berlin";X-APPLE-RADIUS=70;X-TITLE=Office:geo:52.52,13.40',
      ),
    );
    const r = renderAt(text);
    expect(r.problems).toEqual([]);
    expect(r.events[0]?.event.location).toBe("Office\nStreet 1, Berlin");
    expect(r.events[0]?.event.startTime).toBe("08:00");
  });

  it("a VALARM with X-WR-ALARMUID does not leak its DESCRIPTION into the event", () => {
    const text = cal(
      [],
      vevent(
        "DTSTART:20261102T090000Z",
        "SUMMARY:Visit",
        "BEGIN:VALARM",
        "X-WR-ALARMUID:5F0D5C5B-0000-0000-0000-000000000001",
        "UID:5F0D5C5B-0000-0000-0000-000000000001",
        "TRIGGER:-PT15M",
        "ACTION:DISPLAY",
        "DESCRIPTION:Reminder",
        "X-APPLE-DEFAULT-ALARM:TRUE",
        "END:VALARM",
      ),
    );
    const r = renderAt(text);
    expect(r.problems).toEqual([]);
    expect(r.events[0]?.event).toMatchObject({ title: "Visit", description: "" });
  });

  it("the VTIMEZONE with X-LIC-LOCATION is read like any other (Europe/Berlin)", () => {
    const text = cal(
      [],
      appleTimezone,
      vevent("DTSTART;TZID=Europe/Berlin:20260701T090000", "DTEND;TZID=Europe/Berlin:20260701T100000"),
    );
    expect(span(text, "2026-07-01", "2026-07-02")).toBe("2026-07-01 07:00..2026-07-01 08:00");
  });
});

describe("Thunderbird", () => {
  const tzid = "/mozilla.org/20050126_1/Europe/Berlin";
  const meeting = vevent(
    `DTSTART;TZID=${tzid}:20261102T090000`,
    `DTEND;TZID=${tzid}:20261102T100000`,
    "SUMMARY:Review",
  );

  itReq(
    ["RFC5545:3.2.19:tzid-solidus-global-id", "RFC5545:3.2.19:missing-vtimezone-inconsistent"],
    "a TZID with the /mozilla.org/ prefix is an opaque label: without VTIMEZONE it is reported as unknown",
    () => {
      const r = renderAt(cal([], meeting));
      expect(r.events).toEqual([]);
      expect(r.problems).toHaveLength(1);
      expect(r.problems[0]).toContain(`unknown time zone "${tzid}"`);
    },
  );

  itReq(
    "RFC5545:3.2.19:tzid-solidus-global-id",
    "with a VTIMEZONE of the identical TZID text the event is read (the label is matched, not parsed)",
    () => {
      const text = cal([], europeVtimezone(tzid, "19700101", ["X-TZINFO:Europe/Berlin"]), meeting);
      expect(span(text)).toBe("2026-11-02 08:00..2026-11-02 09:00");
    },
  );

  it("the same label with a different TZID in the VTIMEZONE does not match", () => {
    const text = cal([], europeVtimezone("/mozilla.org/20070129_1/Europe/Berlin"), meeting);
    expect(renderAt(text).problems[0]).toContain("unknown time zone");
  });
});

describe("what the reader does with the files (read path with a sandbox)", () => {
  let sb: Sandbox;
  beforeEach(async () => {
    sb = await sandbox();
  });
  afterEach(async () => {
    await sb.cleanup();
  });

  const read = async (files: Readonly<Record<string, string | Uint8Array>>, zone = "UTC") => {
    const dir = await sb.vdir("work");
    for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content);
    return runOk(
      listEvents(await sb.settings(["work"], { timezone: zone }), { range: "2026-11-01 2026-12-01" }, NOW),
    );
  };

  const simple = (uid = "u1", ...props: string[]): string =>
    cal(
      [],
      [
        "BEGIN:VEVENT",
        `UID:${uid}`,
        "DTSTAMP:20261101T120000Z",
        "SUMMARY:Plain",
        ...props,
        "END:VEVENT",
      ].join("\r\n"),
    );

  it("reads an Outlook UID of 82 hex characters and a Google UID with a domain unchanged", async () => {
    const hex = `040000008200E00074C5B7101A82E008000000008062306C6261CB01${"0123456789ABCDEF".repeat(2)}`;
    const r = await read({
      "outlook.ics": simple(hex, "DTSTART:20261102T090000Z"),
      "google.ics": simple("x@google.com", "DTSTART:20261103T090000Z"),
    });
    expect(r.problems).toEqual([]);
    expect(r.events.map((e) => e.uid)).toEqual([hex, "x@google.com"]);
  });

  itReq(
    "POLICY:tolerate-method-on-read",
    "a file with METHOD:PUBLISH is listed normally and is not an error",
    async () => {
      const text = cal(["METHOD:PUBLISH"], vevent("DTSTART:20261102T090000Z", "SUMMARY:Published"));
      const r = await read({ "p.ics": text });
      expect(r.problems).toEqual([]);
      expect(r.events.map((e) => e.title)).toEqual(["Published"]);
    },
  );

  it("tolerates a UTF-8 byte order mark at the start of the file", async () => {
    const text = simple("bom", "DTSTART:20261102T090000Z");
    const r = await read({ "bom.ics": Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]) });
    expect(r.problems).toEqual([]);
    expect(r.events.map((e) => e.uid)).toEqual(["bom"]);
  });

  it("tolerates LF line endings", async () => {
    const text = simple("lf", "DTSTART:20261102T090000Z").replaceAll("\r\n", "\n");
    const r = await read({ "lf.ics": text });
    expect(r.problems).toEqual([]);
    expect(r.events.map((e) => e.uid)).toEqual(["lf"]);
  });

  it("tolerates a lone CR as line ending", async () => {
    const text = simple("cr", "DTSTART:20261102T090000Z").replaceAll("\r\n", "\r");
    const r = await read({ "cr.ics": text });
    expect(r.problems).toEqual([]);
    expect(r.events.map((e) => e.uid)).toEqual(["cr"]);
  });

  it("tolerates a tab as fold character", async () => {
    const text = simple("tab", "DTSTART:20261102T090000Z", "DESCRIPTION:Hello \r\n\tworld");
    const r = await read({ "tab.ics": text });
    expect(r.problems).toEqual([]);
    expect(r.events[0]?.description).toBe("Hello world");
  });

  it("tolerates lowercase property names", async () => {
    const text = crlf(
      "begin:vcalendar",
      "version:2.0",
      "prodid:-//lower//EN",
      "begin:vevent",
      "uid:lower",
      "dtstamp:20261101T120000Z",
      "dtstart;tzid=Europe/Berlin:20261102T090000",
      "summary:Lowercase",
      "attendee;cn=Bob:MAILTO:bob@example.com",
      "end:vevent",
      "end:vcalendar",
    );
    const r = await read({ "lower.ics": text });
    expect(r.problems).toEqual([]);
    expect(r.events[0]).toMatchObject({
      uid: "lower",
      title: "Lowercase",
      startTime: "08:00",
      attendees: "Bob <bob@example.com>",
    });
  });

  itReq(
    "RFC5545:3.1:utf8-unfold-restores-sequence",
    "a character split across a fold by a naive producer is restored (unfolding is done on bytes)",
    async () => {
      const bytes = Buffer.concat([
        Buffer.from("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//n//EN\r\nBEGIN:VEVENT\r\nUID:fold\r\n"),
        Buffer.from("DTSTART:20261102T090000Z\r\nSUMMARY:Pri"),
        Buffer.from([0xe2, 0x82]),
        Buffer.from("\r\n "),
        Buffer.from([0xac]),
        Buffer.from("ce\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"),
      ]);
      const r = await read({ "fold.ics": bytes });
      expect(r.problems).toEqual([]);
      expect(r.events[0]?.title).toBe("Pri€ce");
    },
  );

  it("VTODO and VJOURNAL next to the event: the file is skipped and reported (one component type per resource)", async () => {
    const text = cal(
      [],
      vevent("DTSTART:20261102T090000Z", "SUMMARY:Event"),
      crlf("BEGIN:VTODO", "UID:u", "DTSTAMP:20261101T120000Z", "SUMMARY:Todo", "END:VTODO").trimEnd(),
      crlf(
        "BEGIN:VJOURNAL",
        "UID:u",
        "DTSTAMP:20261101T120000Z",
        "SUMMARY:Journal",
        "END:VJOURNAL",
      ).trimEnd(),
    );
    const r = await read({ "mixed.ics": text });
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toMatch(/several component types in one file/);
    expect(r.events).toEqual([]);
  });

  it("a file that holds only a VTODO is a problem, not an event", async () => {
    const text = cal(
      [],
      crlf("BEGIN:VTODO", "UID:t1", "DTSTAMP:20261101T120000Z", "SUMMARY:Todo", "END:VTODO").trimEnd(),
    );
    const r = await read({ "todo.ics": text });
    expect(r.events).toEqual([]);
    expect(r.problems).toHaveLength(1);
  });

  itReq(
    "RFC5545:3.6:ignore-unknown-components",
    "an unknown X- component next to the event is ignored",
    async () => {
      const text = cal(
        [],
        crlf("BEGIN:X-FOO", "X-BAR:1", "END:X-FOO").trimEnd(),
        vevent("DTSTART:20261102T090000Z", "SUMMARY:Event"),
      );
      const r = await read({ "x.ics": text });
      expect(r.problems).toEqual([]);
      expect(r.events.map((e) => e.title)).toEqual(["Event"]);
    },
  );

  itReq(
    ["RFC5545:3.2:ignore-unknown-x-iana-param", "RFC5545:3.2:ignore-unknown-params"],
    "unknown parameters on DTSTART and ATTENDEE are ignored",
    async () => {
      const text = cal(
        [],
        vevent(
          "DTSTART;X-FOO=1:20261102T090000Z",
          "SUMMARY:Params",
          "ATTENDEE;X-NUM-GUESTS=2;PARTSTAT=ACCEPTED;CN=Me:mailto:me@example.com",
        ),
      );
      const r = await read({ "p.ics": text });
      expect(r.problems).toEqual([]);
      expect(r.events[0]).toMatchObject({ startTime: "09:00", attendees: "Me <me@example.com>" });
    },
  );

  itReq(
    "RFC4791:4.1:different-uid-separate-resource",
    "a file with two UIDs is reported as a problem and none of its events is listed",
    async () => {
      const text = cal(
        [],
        ["BEGIN:VEVENT", "UID:a", "DTSTAMP:20261101T120000Z", "DTSTART:20261102T090000Z", "END:VEVENT"].join(
          "\r\n",
        ),
        ["BEGIN:VEVENT", "UID:b", "DTSTAMP:20261101T120000Z", "DTSTART:20261103T090000Z", "END:VEVENT"].join(
          "\r\n",
        ),
      );
      const r = await read({ "two.ics": text, "ok.ics": simple("c", "DTSTART:20261104T090000Z") });
      expect(r.events.map((e) => e.uid)).toEqual(["c"]);
      expect(r.problems).toHaveLength(1);
      expect(r.problems[0]).toContain("two.ics");
      expect(r.problems[0]).toContain("several UIDs");
    },
  );

  itReq(
    "RFC5545:3.8.4.7:vevent-uid-required",
    "an event without UID is reported as a problem, not listed",
    async () => {
      const text = cal(
        [],
        ["BEGIN:VEVENT", "DTSTAMP:20261101T120000Z", "DTSTART:20261102T090000Z", "END:VEVENT"].join("\r\n"),
      );
      const r = await read({ "nouid.ics": text });
      expect(r.events).toEqual([]);
      expect(r.problems).toHaveLength(1);
      expect(r.problems[0]).toContain("no event with a UID");
    },
  );

  itReq(
    [
      "VDIR:ignore-tmp-and-no-extension",
      "VDIR:metadata-files-no-extension",
      "VDIR:ics-extension",
      "VDIR:collection-contains-only-items",
    ],
    "only *.ics files of the collection directory are events: .tmp, files without extension and sub-directories are not",
    async () => {
      const dir = await sb.vdir("work");
      await writeFile(join(dir, "x.ics"), simple("x", "DTSTART:20261102T090000Z"));
      await writeFile(join(dir, "y.ics.tmp"), simple("y", "DTSTART:20261102T090000Z"));
      await writeFile(join(dir, "color"), "#FF8800");
      await writeFile(join(dir, "displayname"), "Work");
      await writeFile(join(dir, "x.txt"), simple("t", "DTSTART:20261102T090000Z"));
      const sub = await sb.vdir("work/sub");
      await writeFile(join(sub, "z.ics"), simple("z", "DTSTART:20261102T090000Z"));
      const r = await runOk(listEvents(await sb.settings(["work"]), { range: "2026-11-01 2026-12-01" }, NOW));
      expect(r.problems).toEqual([]);
      expect(r.events.map((e) => e.uid)).toEqual(["x"]);
    },
  );

  itReq(
    ["VDIR:filename-no-requirement", "VDIR:filename-metadata-not-preserved"],
    "an event is identified by its UID and content, not by the name of its file",
    async () => {
      const r = await read({
        "2030-01-01-something-else.ics": simple("xyz", "DTSTART:20261102T090000Z"),
      });
      expect(r.problems).toEqual([]);
      expect(r.events[0]).toMatchObject({ uid: "xyz", title: "Plain", startDate: "2026-11-02" });
    },
  );
});
