import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type CalendarEvent,
  classification,
  listEvents,
  PRIVATE_TITLE,
  renderFile,
  searchEvents,
  transparency,
} from "../events.js";
import { events as eventsOf, unfoldLines } from "../ics.js";
import { itReq, runOk, type Sandbox, sandbox } from "../testlib.js";

// Conformance of what the read tools (list_events, events_in_range, search_events) show: the
// properties of RFC 5545 3.8.x as rendered, the recurrence set as seen through the listing, and
// the rule that events with CLASS other than PUBLIC show no details. Pure cases go through
// `renderFile`; the private-event search and listing go through the real read path.

const NOW = new Date("2026-11-02T08:00:00Z");

const ics = (...body: string[]): string =>
  ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//EN", ...body, "END:VCALENDAR", ""].join("\r\n");

const vevent = (...props: string[]): string =>
  ["BEGIN:VEVENT", "UID:u", "DTSTAMP:20260101T000000Z", ...props, "END:VEVENT"].join("\r\n");

const utc = (day: string): number => Date.parse(`${day}T00:00:00Z`);

/** The occurrences of one file text in a window (UTC days), rendered for the host zone. */
const render = (text: string, from = "2026-11-01", to = "2026-12-01", zone = "Europe/Berlin") =>
  renderFile("cal", { file: "/x/a.ics", uid: "u", lines: unfoldLines(text) }, utc(from), utc(to), zone);

const only = (text: string, from?: string, to?: string, zone?: string): CalendarEvent => {
  const r = render(text, from, to, zone);
  expect(r.problems).toEqual([]);
  expect(r.events).toHaveLength(1);
  return r.events[0]?.event as CalendarEvent;
};

const titlesAndDays = (text: string, from?: string, to?: string): string[] =>
  render(text, from, to).events.map((r) => `${r.event.title}@${r.event.startDate} ${r.event.startTime}`);

const firstEvent = (text: string): readonly string[] => eventsOf(unfoldLines(text))[0] ?? [];

const NY_VTIMEZONE = [
  "BEGIN:VTIMEZONE",
  "TZID:America/New_York",
  "BEGIN:STANDARD",
  "DTSTART:19701101T020000",
  "TZOFFSETFROM:-0400",
  "TZOFFSETTO:-0500",
  "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU",
  "END:STANDARD",
  "BEGIN:DAYLIGHT",
  "DTSTART:19700308T020000",
  "TZOFFSETFROM:-0500",
  "TZOFFSETTO:-0400",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU",
  "END:DAYLIGHT",
  "END:VTIMEZONE",
].join("\r\n");

describe("CLASS (RFC 5545 3.8.1.3)", () => {
  itReq(
    "RFC5545:3.8.1.3:class-default-public",
    "an event without CLASS is PUBLIC and shows its details",
    () => {
      const text = ics(vevent("SUMMARY:Lunch", "LOCATION:Canteen", "DTSTART:20261102T100000Z"));
      expect(classification(firstEvent(text))).toBe("PUBLIC");
      expect(only(text)).toMatchObject({ title: "Lunch", location: "Canteen" });
    },
  );

  itReq(
    "RFC5545:3.8.1.3:class-default-public",
    "CLASS:PUBLIC is read in any case and keeps the details",
    () => {
      const text = ics(vevent("CLASS:public", "SUMMARY:Open", "DTSTART:20261102T100000Z"));
      expect(classification(firstEvent(text))).toBe("PUBLIC");
      expect(only(text).title).toBe("Open");
    },
  );

  itReq("RFC5545:3.8.1.3:class-unknown-private", "CLASS:X-FOO counts as PRIVATE: no details", () => {
    const text = ics(
      vevent("CLASS:X-FOO", "SUMMARY:Secret", "DESCRIPTION:hidden words", "DTSTART:20261102T100000Z"),
    );
    expect(classification(firstEvent(text))).toBe("PRIVATE");
    expect(only(text)).toMatchObject({ title: PRIVATE_TITLE, description: "" });
  });

  itReq(
    "RFC5545:3.8.1.3:class-unknown-private",
    "an empty or unknown IANA token counts as PRIVATE too",
    () => {
      expect(classification(firstEvent(ics(vevent("CLASS:", "DTSTART:20261102T100000Z"))))).toBe("PRIVATE");
      expect(classification(firstEvent(ics(vevent("CLASS:SECRET", "DTSTART:20261102T100000Z"))))).toBe(
        "PRIVATE",
      );
    },
  );

  it("PRIVATE and CONFIDENTIAL keep their own names, in any case", () => {
    expect(classification(firstEvent(ics(vevent("CLASS:private", "DTSTART:20261102T100000Z"))))).toBe(
      "PRIVATE",
    );
    expect(classification(firstEvent(ics(vevent("CLASS:Confidential", "DTSTART:20261102T100000Z"))))).toBe(
      "CONFIDENTIAL",
    );
  });

  it("an event shows the first of several CLASS lines", () => {
    const text = ics(vevent("CLASS:PUBLIC", "CLASS:PRIVATE", "SUMMARY:Open", "DTSTART:20261102T100000Z"));
    expect(classification(firstEvent(text))).toBe("PUBLIC");
    expect(only(text).title).toBe("Open");
  });

  it("a CLASS inside a VALARM is not the class of the event", () => {
    const text = ics(
      vevent(
        "SUMMARY:Open",
        "DTSTART:20261102T100000Z",
        "BEGIN:VALARM",
        "CLASS:PRIVATE",
        "ACTION:DISPLAY",
        "TRIGGER:-PT5M",
        "DESCRIPTION:x",
        "END:VALARM",
      ),
    );
    expect(classification(firstEvent(text))).toBe("PUBLIC");
  });
});

describe("events with hidden details (CLASS PRIVATE, CONFIDENTIAL, unknown)", () => {
  const secret = (cls: string): string =>
    ics(
      vevent(
        `CLASS:${cls}`,
        "SUMMARY:Salary talk",
        "LOCATION:Vault",
        "DESCRIPTION:classified numbers",
        "ORGANIZER;CN=Olga:mailto:olga@example.com",
        "ATTENDEE;CN=Bob:mailto:bob@example.com",
        "STATUS:TENTATIVE",
        "DTSTART:20261102T100000Z",
        "DTEND:20261102T110000Z",
        "RRULE:FREQ=DAILY;COUNT=2",
      ),
    );

  for (const cls of ["PRIVATE", "CONFIDENTIAL", "X-WHATEVER"]) {
    it(`CLASS:${cls} shows time, uid and status and a placeholder title, nothing else`, () => {
      const r = render(secret(cls), "2026-11-01", "2026-11-05");
      expect(r.events).toHaveLength(2);
      for (const { event: e, hidden } of r.events) {
        expect(hidden).toBe(true);
        expect(e).toMatchObject({
          title: "Private event",
          location: "",
          description: "",
          organizer: "",
          attendees: "",
          repeatPattern: "",
          uid: "u",
          status: "TENTATIVE",
          startTime: "11:00",
          endTime: "12:00",
          allDay: "False",
        });
      }
    });
  }

  it("a hidden event keeps its CANCELLED flag", () => {
    const e = only(ics(vevent("CLASS:PRIVATE", "STATUS:CANCELLED", "SUMMARY:S", "DTSTART:20261102T100000Z")));
    expect(e).toMatchObject({ title: PRIVATE_TITLE, status: "CANCELLED", cancelled: "CANCELLED" });
  });

  it("a hidden all-day event keeps its all-day flag", () => {
    const e = only(ics(vevent("CLASS:PRIVATE", "SUMMARY:S", "DTSTART;VALUE=DATE:20261105")));
    expect(e).toMatchObject({ title: PRIVATE_TITLE, allDay: "True", startDate: "2026-11-05", startTime: "" });
  });

  it("an exception without CLASS inherits the hiding of its series", () => {
    const text = ics(
      vevent("CLASS:PRIVATE", "SUMMARY:Series", "DTSTART:20261102T100000Z", "RRULE:FREQ=DAILY;COUNT=2"),
      vevent(
        "SUMMARY:Moved secret",
        "LOCATION:Vault",
        "RECURRENCE-ID:20261103T100000Z",
        "DTSTART:20261103T120000Z",
      ),
    );
    const r = render(text, "2026-11-01", "2026-11-05");
    expect(r.events.map((x) => x.event.title)).toEqual([PRIVATE_TITLE, PRIVATE_TITLE]);
    expect(r.events.map((x) => x.event.location)).toEqual(["", ""]);
  });

  it("an exception with its own CLASS:PUBLIC of a hidden series shows its details", () => {
    const text = ics(
      vevent("CLASS:PRIVATE", "SUMMARY:Series", "DTSTART:20261102T100000Z", "RRULE:FREQ=DAILY;COUNT=2"),
      vevent(
        "CLASS:PUBLIC",
        "SUMMARY:Open day",
        "RECURRENCE-ID:20261103T100000Z",
        "DTSTART:20261103T120000Z",
      ),
    );
    const r = render(text, "2026-11-01", "2026-11-05");
    expect(r.events.map((x) => x.event.title)).toEqual([PRIVATE_TITLE, "Open day"]);
  });

  it("an exception with CLASS:PRIVATE of a public series is hidden alone", () => {
    const text = ics(
      vevent("SUMMARY:Series", "DTSTART:20261102T100000Z", "RRULE:FREQ=DAILY;COUNT=2"),
      vevent("CLASS:PRIVATE", "SUMMARY:Doctor", "RECURRENCE-ID:20261103T100000Z", "DTSTART:20261103T120000Z"),
    );
    const r = render(text, "2026-11-01", "2026-11-05");
    expect(r.events.map((x) => x.event.title)).toEqual(["Series", PRIVATE_TITLE]);
  });

  describe("through list_events and search_events", () => {
    let sb: Sandbox;
    beforeEach(async () => {
      sb = await sandbox();
    });
    afterEach(async () => {
      await sb.cleanup();
    });

    const put = async (name: string, content: string): Promise<void> => {
      await writeFile(join(await sb.vdir("work"), name), content);
    };
    const seed = async (): Promise<void> => {
      await put("1.ics", secret("PRIVATE").replace("UID:u", "UID:p1"));
      await put("2.ics", secret("CONFIDENTIAL").replace("UID:u", "UID:p2"));
      await put("3.ics", secret("X-UNKNOWN").replace("UID:u", "UID:p3"));
      await put(
        "4.ics",
        ics(
          vevent(
            "SUMMARY:Public classified review",
            "LOCATION:Vault two",
            "DTSTART:20261103T100000Z",
          ).replace("UID:u", "UID:pub"),
        ),
      );
    };
    const search = async (query: string): Promise<string[]> =>
      (
        await runOk(searchEvents(await sb.settings(), { query, range: "2026-11-01 2026-12-01" }, NOW))
      ).events.map((e) => e.uid);

    it("list_events shows the placeholder, and the public event as it is", async () => {
      await seed();
      const r = await runOk(listEvents(await sb.settings(), { range: "2026-11-02 2026-11-04" }, NOW));
      expect(r.problems).toEqual([]);
      const hidden = r.events.filter((e) => /^p\d/.test(e.uid));
      expect(hidden).toHaveLength(6);
      for (const e of hidden)
        expect(e).toMatchObject({
          title: PRIVATE_TITLE,
          location: "",
          description: "",
          organizer: "",
          attendees: "",
          repeatPattern: "",
        });
      expect(r.events.find((e) => e.uid === "pub")).toMatchObject({
        title: "Public classified review",
        location: "Vault two",
      });
    });

    it("a word only present in a private description finds nothing", async () => {
      await seed();
      // "numbers" occurs only in the descriptions of the three hidden events
      expect(await search("numbers")).toEqual([]);
    });

    it("a word of the hidden summary, location, organizer or attendee finds nothing", async () => {
      await seed();
      for (const word of ["Salary", "Vault", "Olga", "bob@example.com"]) {
        const found = await search(word);
        expect(found.filter((u) => /^p\d/.test(u))).toEqual([]);
      }
    });

    it("the placeholder title is not searchable", async () => {
      await seed();
      expect(await search("Private event")).toEqual([]);
      expect(await search("private")).toEqual([]);
    });

    it("a public event with the same words is still found", async () => {
      await seed();
      expect(await search("classified")).toEqual(["pub"]);
      expect(await search("vault")).toEqual(["pub"]);
    });
  });
});

describe("STATUS and TRANSP", () => {
  itReq(
    "RFC5545:3.8.1.11:status-vevent-values",
    "TENTATIVE, CONFIRMED and CANCELLED are shown; only CANCELLED flags",
    () => {
      for (const [status, cancelled] of [
        ["TENTATIVE", ""],
        ["CONFIRMED", ""],
        ["CANCELLED", "CANCELLED"],
        ["cancelled", "CANCELLED"],
      ] as const) {
        const e = only(ics(vevent(`STATUS:${status}`, "SUMMARY:S", "DTSTART:20261102T100000Z")));
        expect(e.status).toBe(status.toUpperCase());
        expect(e.cancelled).toBe(cancelled);
      }
    },
  );

  it("an event without STATUS has an empty status and is not cancelled", () => {
    expect(only(ics(vevent("SUMMARY:S", "DTSTART:20261102T100000Z")))).toMatchObject({
      status: "",
      cancelled: "",
    });
  });

  it("a cancelled exception of a series is listed and flagged, the other days are not", () => {
    const text = ics(
      vevent("SUMMARY:Standup", "DTSTART:20261102T090000Z", "RRULE:FREQ=DAILY;COUNT=3"),
      vevent(
        "SUMMARY:Standup",
        "STATUS:CANCELLED",
        "RECURRENCE-ID:20261103T090000Z",
        "DTSTART:20261103T090000Z",
      ),
    );
    const r = render(text, "2026-11-01", "2026-11-06");
    expect(r.events.map((x) => x.event.cancelled)).toEqual(["", "CANCELLED", ""]);
    expect(r.events.map((x) => x.event.startDate)).toEqual(["2026-11-02", "2026-11-03", "2026-11-04"]);
  });

  itReq(
    "RFC5545:3.8.2.7:transp-default-opaque",
    "an event without TRANSP is OPAQUE; only TRANSPARENT changes it",
    () => {
      const of = (...p: string[]) => firstEvent(ics(vevent("DTSTART:20261102T100000Z", ...p)));
      expect(transparency(of())).toBe("OPAQUE");
      expect(transparency(of("TRANSP:OPAQUE"))).toBe("OPAQUE");
      expect(transparency(of("TRANSP:transparent"))).toBe("TRANSPARENT");
      expect(transparency(of("TRANSP:X-FOO"))).toBe("OPAQUE");
    },
  );
});

describe("TEXT values (RFC 5545 3.3.11)", () => {
  const field = (line: string): string => only(ics(vevent(line, "DTSTART:20261102T100000Z"))).description;

  itReq(
    ["RFC5545:3.3.11:text-newline-escape", "RFC5545:3.3.11:text-newline"],
    "both \\n and \\N decode to a line break",
    () => {
      expect(field("DESCRIPTION:one\\ntwo\\Nthree")).toBe("one\ntwo\nthree");
    },
  );

  itReq(
    ["RFC5545:3.3.11:text-backslash-escape", "RFC5545:3.3.11:text-backslash"],
    "an escaped backslash decodes to one backslash, and is not read as the start of \\n",
    () => {
      expect(field("DESCRIPTION:a\\\\b")).toBe("a\\b");
      expect(field("DESCRIPTION:a\\\\nb")).toBe("a\\nb");
    },
  );

  itReq(
    ["RFC5545:3.3.11:text-comma-escape", "RFC5545:3.3.11:text-comma"],
    "an escaped comma decodes to a comma (location)",
    () => {
      const e = only(ics(vevent("LOCATION:Room 1\\, Bldg 2", "DTSTART:20261102T100000Z")));
      expect(e.location).toBe("Room 1, Bldg 2");
    },
  );

  itReq(
    ["RFC5545:3.3.11:text-semicolon-escape", "RFC5545:3.3.11:text-semicolon"],
    "an escaped semicolon decodes to a semicolon (summary)",
    () => {
      const e = only(ics(vevent("SUMMARY:a\\;b", "DTSTART:20261102T100000Z")));
      expect(e.title).toBe("a;b");
    },
  );

  itReq(
    "RFC5545:3.3.11:text-colon-not-escaped",
    "a plain colon stays, and an incoming backslash-colon is read as a colon",
    () => {
      expect(field("DESCRIPTION:Meeting: planning")).toBe("Meeting: planning");
      expect(field("DESCRIPTION:Meeting\\: planning")).toBe("Meeting: planning");
    },
  );

  it("an unknown escape is left as it is", () => {
    expect(field("DESCRIPTION:a\\xb")).toBe("a\\xb");
  });
});

describe("ORGANIZER and ATTENDEE rendering", () => {
  const people = (...lines: string[]): CalendarEvent =>
    only(ics(vevent(...lines, "DTSTART:20261102T100000Z")));

  itReq(
    "RFC5545:3.1.1:param-special-chars-quoted",
    "a quoted CN with colon, semicolon and comma is one value; the first unquoted colon starts the address",
    () => {
      const e = people('ATTENDEE;CN="a:b;c,d":mailto:x@example.com');
      expect(e.attendees).toBe("a:b;c,d <x@example.com>");
    },
  );

  itReq(
    "POLICY:organizer-without-attendee-valid",
    "an event with ORGANIZER and no ATTENDEE shows the organizer and no attendees",
    () => {
      const e = people("ORGANIZER;CN=Olga:mailto:olga@example.com");
      expect(e).toMatchObject({ organizer: "Olga <olga@example.com>", attendees: "" });
    },
  );

  it("mailto: is removed in any case; a name without address or an address without name stands alone", () => {
    const e = people(
      "ORGANIZER;CN=Olga:MAILTO:olga@example.com",
      "ATTENDEE;CN=Bob:Mailto:bob@example.com",
      "ATTENDEE:mailto:eve@example.com",
      "ATTENDEE;CN=Only Name:",
    );
    expect(e.organizer).toBe("Olga <olga@example.com>");
    expect(e.attendees).toBe("Bob <bob@example.com>, eve@example.com, Only Name");
  });

  it("unknown parameters of ORGANIZER and ATTENDEE are ignored", () => {
    const e = people(
      'ORGANIZER;CN=Olga;SENT-BY="mailto:pa@example.com";X-FOO=1:mailto:olga@example.com',
      "ATTENDEE;X-NUM-GUESTS=2;PARTSTAT=ACCEPTED;CN=Bob:mailto:bob@example.com",
    );
    expect(e.organizer).toBe("Olga <olga@example.com>");
    expect(e.attendees).toBe("Bob <bob@example.com>");
  });

  it("an ATTENDEE inside a VALARM is not an attendee of the event", () => {
    const e = only(
      ics(
        vevent(
          "DTSTART:20261102T100000Z",
          "BEGIN:VALARM",
          "ACTION:EMAIL",
          "ATTENDEE:mailto:alarm@example.com",
          "SUMMARY:s",
          "DESCRIPTION:d",
          "TRIGGER:-PT5M",
          "END:VALARM",
        ),
      ),
    );
    expect(e).toMatchObject({ attendees: "", title: "", description: "" });
  });
});

describe("duplicate singleton properties", () => {
  itReq(
    "RFC5545:3.6.1:optional-props-at-most-once",
    "of two SUMMARY, LOCATION or DESCRIPTION lines the first is shown (policy: first wins)",
    () => {
      const e = only(
        ics(
          vevent(
            "SUMMARY:first",
            "SUMMARY:second",
            "LOCATION:here",
            "LOCATION:there",
            "DESCRIPTION:one",
            "DESCRIPTION:two",
            "STATUS:CONFIRMED",
            "STATUS:CANCELLED",
            "DTSTART:20261102T100000Z",
          ),
        ),
      );
      expect(e).toMatchObject({
        title: "first",
        location: "here",
        description: "one",
        status: "CONFIRMED",
        cancelled: "",
      });
    },
  );
});

describe("the recurrence set as the listing shows it", () => {
  itReq("RFC5545:3.8.5.1:exdate-precedence-over-rdate", "EXDATE hides a rule instance and an RDATE", () => {
    const text = ics(
      vevent(
        "SUMMARY:S",
        "DTSTART:20261102T100000Z",
        "RRULE:FREQ=DAILY;COUNT=4",
        "RDATE:20261110T100000Z",
        "EXDATE:20261103T100000Z,20261110T100000Z",
      ),
    );
    expect(render(text).events.map((r) => r.event.startDate)).toEqual([
      "2026-11-02",
      "2026-11-04",
      "2026-11-05",
    ]);
  });

  itReq("RFC5545:3.6.1:repeatable-props", "two EXDATE lines and two RDATE lines are used together", () => {
    const text = ics(
      vevent(
        "SUMMARY:S",
        "DTSTART:20261102T100000Z",
        "RRULE:FREQ=DAILY;COUNT=5",
        "EXDATE:20261103T100000Z",
        "EXDATE:20261104T100000Z",
        "RDATE:20261110T100000Z",
        "RDATE:20261112T100000Z",
      ),
    );
    expect(render(text).events.map((r) => r.event.startDate)).toEqual([
      "2026-11-02",
      "2026-11-05",
      "2026-11-06",
      "2026-11-10",
      "2026-11-12",
    ]);
  });

  itReq("RFC5545:3.8.5.1:exdate-value-types", "EXDATE;VALUE=DATE hides the day of an all-day series", () => {
    const text = ics(
      vevent(
        "SUMMARY:S",
        "DTSTART;VALUE=DATE:20261102",
        "RRULE:FREQ=DAILY;COUNT=3",
        "EXDATE;VALUE=DATE:20261103",
      ),
    );
    expect(render(text).events.map((r) => r.event.startDate)).toEqual(["2026-11-02", "2026-11-04"]);
  });

  itReq(
    "RFC5545:3.8.4.4:recurrence-id-replaces-instance-by-uid",
    "an exception replaces exactly its instance, the others stay",
    () => {
      const text = ics(
        vevent(
          "SUMMARY:Standup",
          "DTSTART:20261102T100000Z",
          "DTEND:20261102T110000Z",
          "RRULE:FREQ=DAILY;COUNT=3",
        ),
        vevent(
          "SUMMARY:Standup (moved)",
          "RECURRENCE-ID:20261103T100000Z",
          "DTSTART:20261103T120000Z",
          "DTEND:20261103T130000Z",
        ),
      );
      expect(titlesAndDays(text)).toEqual([
        "Standup@2026-11-02 11:00",
        "Standup (moved)@2026-11-03 13:00",
        "Standup@2026-11-04 11:00",
      ]);
    },
  );

  itReq(
    "RFC4791:4.1:overrides-without-master",
    "a file with only an exception is listed as one event at its own time",
    () => {
      const text = ics(
        vevent(
          "SUMMARY:Moved",
          "RECURRENCE-ID:20261103T100000Z",
          "DTSTART:20261103T120000Z",
          "DTEND:20261103T130000Z",
        ),
      );
      const r = render(text);
      expect(r.problems).toEqual([]);
      expect(r.events).toHaveLength(1);
      expect(r.events[0]?.event).toMatchObject({
        title: "Moved",
        startDate: "2026-11-03",
        startTime: "13:00",
        endTime: "14:00",
        repeatPattern: "",
      });
    },
  );

  it("exceptions without a main event: each is listed, a broken one is a problem, the other stays", () => {
    const text = ics(
      vevent("SUMMARY:Good", "RECURRENCE-ID:20261103T100000Z", "DTSTART:20261103T120000Z"),
      vevent(
        "SUMMARY:Bad",
        "RECURRENCE-ID:20261104T100000Z",
        "DTSTART:20261104T120000Z",
        "DTEND:20261104T110000Z",
      ),
    );
    const r = render(text);
    expect(r.events.map((x) => x.event.title)).toEqual(["Good"]);
    expect(r.problems).toHaveLength(1);
  });

  it("a hidden exception without a main event hides its details", () => {
    const text = ics(
      vevent("CLASS:PRIVATE", "SUMMARY:Secret", "RECURRENCE-ID:20261103T100000Z", "DTSTART:20261103T120000Z"),
    );
    const r = render(text);
    expect(r.events[0]).toMatchObject({ hidden: true });
    expect(r.events[0]?.event.title).toBe(PRIVATE_TITLE);
  });
});

describe("durations without DTEND (RFC 5545 3.6.1)", () => {
  itReq(
    "RFC5545:3.6.1:date-no-end-one-day",
    "an all-day event without DTEND or DURATION is one day long",
    () => {
      expect(only(ics(vevent("SUMMARY:S", "DTSTART;VALUE=DATE:20261105")))).toMatchObject({
        startDate: "2026-11-05",
        endDate: "2026-11-05",
        allDay: "True",
      });
    },
  );

  itReq(
    "RFC5545:3.6.1:dtend-non-inclusive",
    "an all-day DTEND is exclusive: 28 June to 9 July ends on 8 July",
    () => {
      const e = only(
        ics(vevent("SUMMARY:S", "DTSTART;VALUE=DATE:20070628", "DTEND;VALUE=DATE:20070709")),
        "2007-06-01",
        "2007-08-01",
      );
      expect(e).toMatchObject({ startDate: "2007-06-28", endDate: "2007-07-08", allDay: "True" });
    },
  );

  itReq(
    "RFC5545:3.6.1:datetime-no-end-zero-length",
    "a timed event without DTEND ends where it starts",
    () => {
      expect(only(ics(vevent("SUMMARY:S", "DTSTART:20261105T100000Z")))).toMatchObject({
        startTime: "11:00",
        endTime: "11:00",
        endDate: "2026-11-05",
      });
    },
  );
});

describe("floating times", () => {
  const text = ics(NY_VTIMEZONE, vevent("SUMMARY:S", "DTSTART:20261102T100000", "DTEND:20261102T110000"));

  itReq(
    ["RFC5545:3.2.19:tzid-absent-means-floating", "RFC5545:3.3.5:form1-floating"],
    "a local time without TZID stays floating, though the file defines a VTIMEZONE: 10:00 in every host zone",
    () => {
      for (const zone of ["Europe/Berlin", "Asia/Tokyo", "America/New_York"])
        expect(only(text, "2026-11-01", "2026-12-01", zone)).toMatchObject({
          startDate: "2026-11-02",
          startTime: "10:00",
          endTime: "11:00",
        });
    },
  );
});
