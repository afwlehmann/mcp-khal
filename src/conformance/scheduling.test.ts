import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type EditEnv,
  organizerNote,
  splitSeries,
  type UpdateParams,
  updateEvent,
  updateInstance,
  updateLines,
} from "../editEvent.js";
import { endSeries, endSeriesLines } from "../endSeries.js";
import { events, isMaster, prop, props, unfoldLines } from "../ics.js";
import { respondLines, respondToEvent } from "../respondEvent.js";
import { failure, itReq, removeDir, runFail, runOk, tempDir, testSettings, unwrap } from "../testlib.js";

// Scheduling-related rules for stored objects (RFC 5546 as far as it concerns a file we edit, the
// ATTENDEE/ORGANIZER and SEQUENCE/DTSTAMP rows of RFC 5545, the policies decided for this server).
// Everything is evaluated in UTC (the host zone), so the digits of a value are its instant.

const NOW = new Date("2026-11-14T10:15:00Z");
const ME = "me@example.com";
const ENV: EditEnv = { hostZone: "UTC", me: ME };
const base = { calendar: "work", uid: "u" };

const vevent = (...inner: string[]): string[] => ["BEGIN:VEVENT", ...inner, "END:VEVENT"];
const calendar = (...inner: string[][]): string[] => [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//test//EN",
  ...inner.flat(),
  "END:VCALENDAR",
];

const ORGANIZER = "ORGANIZER;CN=Boss:mailto:boss@example.com";
const MINE = `ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${ME}`;
const OTHER = "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:other@example.com";

/** An invitation to a single meeting: we are an attendee, SEQUENCE 3. */
const invitation = (sequence = "3", extra: string[] = []): string[] =>
  calendar(
    vevent(
      "UID:u",
      "DTSTAMP:20261114T100000Z",
      `SEQUENCE:${sequence}`,
      "SUMMARY:Review",
      "DTSTART:20261120T100000Z",
      "DTEND:20261120T110000Z",
      ORGANIZER,
      MINE,
      OTHER,
      ...extra,
    ),
  );

/** A weekly series on Saturdays, 10:00Z; the instance of 2026-11-21 exists. */
const weekly = (inner: string[] = [], outer: string[][] = []): string[] =>
  calendar(
    vevent(
      "UID:u",
      "DTSTAMP:20261114T100000Z",
      "SEQUENCE:2",
      "SUMMARY:Weekly",
      "DTSTART:20261114T100000Z",
      "DTEND:20261114T110000Z",
      "RRULE:FREQ=WEEKLY",
      ORGANIZER,
      MINE,
      OTHER,
      ...inner,
    ),
    ...outer,
  );

const override = (rid: string, ...inner: string[]): string[] =>
  vevent("UID:u", `RECURRENCE-ID:${rid}`, `DTSTART:${rid}`, ...inner);

const respond = (lines: readonly string[], p: object = {}, address = ME, now = NOW) =>
  respondLines(lines, { ...base, response: "accepted", ...p }, address, now, "UTC");
const update = (lines: readonly string[], p: Partial<UpdateParams>, env = ENV, now = NOW) =>
  updateLines(lines, { ...base, ...p }, now, env);
const end = (lines: readonly string[], lastDate: string, env = ENV) =>
  endSeriesLines(lines, { ...base, lastDate }, NOW, env);

const master = (lines: readonly string[]) => events(lines).find(isMaster) ?? [];
const sequence = (e: readonly string[]) => prop(e, "SEQUENCE")?.value;
const partstats = (e: readonly string[]) =>
  Object.fromEntries(props(e, "ATTENDEE").map((a) => [a.value, /PARTSTAT=([A-Z-]+)/.exec(a.params)?.[1]]));
const asOrganizer = (lines: readonly string[]) =>
  lines.map((l) => (l === ORGANIZER ? `ORGANIZER:mailto:${ME}` : l));
const MOVE = { start: "2026-11-21 12:00", end: "13:00" };

describe("SEQUENCE belongs to the organizer", () => {
  itReq("RFC5546:2.1.4:organizer-revises-sequence", "a PARTSTAT edit as attendee keeps SEQUENCE:3", () => {
    expect(sequence(master(unwrap(respond(invitation("3")))))).toBe("3");
  });

  itReq(
    ["RFC5546:2.1.4:no-increment-for-reply", "POLICY:respond-local-partstat-only"],
    "respond_to_event on SEQUENCE:2 leaves the line byte-identical",
    () => {
      const out = unwrap(respond(invitation("2")));
      expect(out).toContain("SEQUENCE:2");
      expect(props(master(out), "SEQUENCE")).toHaveLength(1);
    },
  );

  itReq(
    [
      "RFC5546:2.1.4:increment-on-trigger-properties",
      "RFC5545:3.8.7.4:sequence-increment-on-revision",
      "RFC5545:3.8.7.4:sequence-incremented-by-organizer",
      "POLICY:sequence-organizer-bump",
    ],
    "as organizer a change of DTSTART/DTEND raises SEQUENCE from n to n+1",
    () => {
      const mine = asOrganizer(invitation("4"));
      expect(sequence(master(unwrap(update(mine, MOVE))))).toBe("5");
    },
  );

  itReq(
    ["RFC5546:2.1.4:increment-on-trigger-properties", "POLICY:sequence-organizer-bump"],
    "an absent SEQUENCE counts as 0 and becomes 1",
    () => {
      const mine = asOrganizer(invitation()).filter((l) => !l.startsWith("SEQUENCE"));
      expect(sequence(master(unwrap(update(mine, MOVE))))).toBe("1");
    },
  );

  itReq(
    ["POLICY:sequence-organizer-bump", "RFC5545:3.8.7.4:sequence-incremented-by-organizer"],
    "one edit call raises SEQUENCE once, however many properties change",
    () => {
      const mine = asOrganizer(invitation("4"));
      const out = unwrap(update(mine, { ...MOVE, summary: "New", location: "Hall", description: "d" }));
      expect(sequence(master(out))).toBe("5");
    },
  );

  itReq(
    ["RFC5546:2.1.4:increment-on-trigger-properties", "POLICY:sequence-organizer-bump"],
    "ending a series (RRULE changes) as organizer raises SEQUENCE by one; so does the old part of a split",
    () => {
      const mine = asOrganizer(weekly());
      expect(sequence(master(unwrap(end(mine, "2026-11-28"))))).toBe("3");
      const { original, created } = unwrap(
        splitSeries(
          mine,
          { ...base, scope: "from_date", date: "2026-11-28", summary: "Later" },
          "n",
          NOW,
          ENV,
        ),
      );
      expect(sequence(master(original))).toBe("3");
      expect(sequence(master(created))).toBe("0");
    },
  );

  itReq(
    ["RFC5546:2.1.4:increment-other-changes", "POLICY:sequence-organizer-bump"],
    "an organizer edit that only changes SUMMARY keeps SEQUENCE",
    () => {
      const mine = asOrganizer(invitation("4"));
      expect(sequence(master(unwrap(update(mine, { summary: "Renamed" }))))).toBe("4");
    },
  );

  itReq(
    ["POLICY:non-organizer-edit-is-local", "RFC5545:3.8.7.4:sequence-incremented-by-organizer"],
    "an attendee's text edit keeps SEQUENCE and the result warns that the organizer is not told",
    () => {
      const out = unwrap(update(invitation("3"), { summary: "My name for it" }));
      expect(sequence(master(out))).toBe("3");
      expect(organizerNote(invitation("3"), ENV)).toMatch(
        /boss@example.com organizes this event and is not told about the change/,
      );
    },
  );

  itReq(
    ["POLICY:non-organizer-edit-is-local", "RFC6047:2.2.1:only-organizer-modifies"],
    "an attendee who asks to change the time or the recurrence is refused, in every tool",
    () => {
      expect(failure(update(invitation(), MOVE)).message).toMatch(/only the organizer/);
      expect(failure(end(weekly(), "2026-11-28")).message).toMatch(/only the organizer/);
      const split = splitSeries(
        weekly(),
        { ...base, scope: "from_date", date: "2026-11-28", summary: "x" },
        "n",
        NOW,
        ENV,
      );
      expect(failure(split).message).toMatch(/only the organizer/);
      const one = updateInstance(
        weekly(),
        { ...base, scope: "instance", date: "2026-11-21", ...MOVE },
        NOW,
        ENV,
      );
      expect(failure(one).message).toMatch(/only the organizer/);
    },
  );

  itReq(
    "RFC5545:3.8.7.4:per-instance-sequence",
    "master SEQUENCE:2 with an exception SEQUENCE:0 stays valid; editing the master does not rewrite the exception",
    () => {
      const lines = weekly([], [override("20261121T100000Z", "SEQUENCE:0", "SUMMARY:One")]);
      const out = unwrap(update(lines, { summary: "Renamed" }));
      expect(sequence(master(out))).toBe("2");
      expect(events(out)[1]).toEqual(events(lines)[1]);
    },
  );

  itReq(
    ["RFC5545:3.8.7.4:sequence-per-instance", "RFC5546:2.1.5:highest-sequence-obsoletes"],
    "master SEQUENCE:2 and exception SEQUENCE:1 are not renumbered by an unrelated edit",
    () => {
      const lines = weekly([], [override("20261121T100000Z", "SEQUENCE:1", "SUMMARY:One")]);
      const out = unwrap(update(lines, { location: "Hall" }));
      expect(sequence(events(out)[0] ?? [])).toBe("2");
      expect(sequence(events(out)[1] ?? [])).toBe("1");
    },
  );
});

describe("DTSTAMP and LAST-MODIFIED", () => {
  itReq(
    [
      "RFC5546:2.1.5:dtstamp-tiebreaker",
      "POLICY:update-refreshes-dtstamp-last-modified",
      "RFC5545:3.8.7.2:dtstamp-equals-last-modified-without-method",
    ],
    "a PARTSTAT edit writes the clock to DTSTAMP and LAST-MODIFIED, later than before",
    () => {
      const e = master(unwrap(respond(invitation())));
      expect(prop(e, "DTSTAMP")?.value).toBe("20261114T101500Z");
      expect(prop(e, "LAST-MODIFIED")?.value).toBe("20261114T101500Z");
    },
  );

  itReq(
    "POLICY:update-refreshes-dtstamp-last-modified",
    "with a clock earlier than the stored DTSTAMP the later value stays: stamps never decrease",
    () => {
      const skewed = new Date("2026-11-14T09:00:00Z");
      const e = master(unwrap(respond(invitation(), {}, ME, skewed)));
      expect(prop(e, "DTSTAMP")?.value).toBe("20261114T100000Z");
      expect(prop(e, "LAST-MODIFIED")?.value).toBe("20261114T100000Z");
    },
  );

  itReq(
    ["RFC5545:3.8.7.2:dtstamp-utc", "RFC5545:3.8.7.3:last-modified-utc"],
    "every edit writes both stamps in UTC (a trailing Z)",
    () => {
      const e = master(unwrap(update(invitation(), { summary: "x" })));
      expect(prop(e, "DTSTAMP")?.value).toMatch(/^\d{8}T\d{6}Z$/);
      expect(prop(e, "LAST-MODIFIED")?.value).toMatch(/^\d{8}T\d{6}Z$/);
    },
  );

  itReq(
    ["RFC5545:3.8.7.2:dtstamp-required", "RFC5545:3.8.7.2:vevent-dtstamp-required"],
    "editing an event without DTSTAMP adds exactly one",
    () => {
      const lines = invitation().filter((l) => !l.startsWith("DTSTAMP"));
      const e = master(unwrap(update(lines, { summary: "x" })));
      expect(props(e, "DTSTAMP").map((p) => p.value)).toEqual(["20261114T101500Z"]);
    },
  );
});

describe("keys of a component survive every rewrite", () => {
  itReq(
    [
      "RFC5546:2.1.5:persist-key-properties",
      "RFC5545:3.8.4.7:uid-globally-unique",
      "RFC4791:5.3.2.1:no-uid-change-on-overwrite",
    ],
    "UID, RECURRENCE-ID with its parameters, SEQUENCE and DTSTAMP stay on every component",
    () => {
      const exception = vevent(
        "UID:u",
        "DTSTAMP:20261101T000000Z",
        "SEQUENCE:5",
        "RECURRENCE-ID;TZID=Europe/Berlin:20261121T110000",
        "DTSTART;TZID=Europe/Berlin:20261121T110000",
        "SUMMARY:One",
      );
      const lines = calendar(
        vevent(
          "UID:u",
          "DTSTAMP:20261101T000000Z",
          "SEQUENCE:5",
          "DTSTART;TZID=Europe/Berlin:20261114T110000",
          "DTEND;TZID=Europe/Berlin:20261114T120000",
          "RRULE:FREQ=WEEKLY",
          "SUMMARY:Weekly",
        ),
        exception,
      );
      const out = unwrap(update(lines, { summary: "Renamed" }, { hostZone: "Europe/Berlin", me: ME }));
      expect(events(out)[1]).toEqual(events(lines)[1]);
      for (const e of events(out)) {
        expect(prop(e, "UID")?.value).toBe("u");
        expect(sequence(e)).toBe("5");
        expect(prop(e, "DTSTAMP")).toBeDefined();
      }
      expect(prop(events(out)[1] ?? [], "RECURRENCE-ID")).toMatchObject({
        params: ";TZID=Europe/Berlin",
        value: "20261121T110000",
      });
    },
  );

  itReq(
    "RFC5545:3.8.4.7:uid-255-octets-no-utf8-truncation",
    "a 300-octet UID with multi-byte characters is written back unchanged",
    () => {
      const uid = "é".repeat(150);
      const lines = invitation().map((l) => (l === "UID:u" ? `UID:${uid}` : l));
      const out = unwrap(update(lines, { summary: "x" }));
      expect(prop(master(out), "UID")?.value).toBe(uid);
      expect(Buffer.byteLength(uid)).toBe(300);
    },
  );
});

describe("responding to an invitation", () => {
  itReq(
    [
      "RFC5546:3.7.1:per-instance-partstat",
      "POLICY:respond-instance-override",
      "RFC5546:3.7.1:recurrence-id-on-renegotiation",
    ],
    "declining one instance appends an exception with the attendee list copied and only my PARTSTAT changed",
    () => {
      const lines = weekly();
      const out = unwrap(respond(lines, { response: "declined", scope: "instance", date: "2026-11-21" }));
      expect(events(out)).toHaveLength(2);
      const [first, exception] = events(out);
      // the main event is not touched
      expect(first).toEqual(master(lines));
      expect(prop(exception ?? [], "UID")?.value).toBe("u");
      expect(prop(exception ?? [], "RECURRENCE-ID")?.value).toBe("20261121T100000Z");
      expect(prop(exception ?? [], "DTSTART")?.value).toBe("20261121T100000Z");
      expect(prop(exception ?? [], "DTSTAMP")?.value).toBe("20261114T101500Z");
      expect(partstats(exception ?? [])).toEqual({
        [`mailto:${ME}`]: "DECLINED",
        "mailto:other@example.com": "NEEDS-ACTION",
      });
      expect(partstats(master(out))[`mailto:${ME}`]).toBe("NEEDS-ACTION");
      expect(prop(exception ?? [], "RRULE")).toBeUndefined();
    },
  );

  itReq(
    "RFC5546:3.7.1:no-per-instance-needed",
    "answering the whole series changes the master's PARTSTAT only and leaves exceptions untouched",
    () => {
      const exception = override("20261121T100000Z", "ATTENDEE;PARTSTAT=DECLINED:mailto:me@example.com");
      const lines = weekly([], [exception]);
      const out = unwrap(respond(lines, { response: "tentative" }));
      expect(partstats(master(out))[`mailto:${ME}`]).toBe("TENTATIVE");
      expect(events(out)[1]).toEqual(events(lines)[1]);
    },
  );

  itReq(
    ["RFC5546:3.7.2:own-attendee-not-found", "POLICY:reject-respond-when-not-attendee"],
    "an address that is no attendee is refused, and the error names the event",
    () => {
      const message = failure(respond(invitation(), {}, "nobody@example.com")).message;
      expect(message).toMatch(/nobody@example.com is not invited to event u/);
    },
  );

  itReq(
    ["POLICY:reject-respond-when-not-attendee", "RFC6047:2.3:mailto-addresses"],
    "the address matches after stripping a mailto: prefix in any case, ignoring the case of the address, never by character set",
    () => {
      const lines = invitation().map((l) => (l === MINE ? "ATTENDEE:MAILTO:Me@Example.COM" : l));
      expect(partstats(master(unwrap(respond(lines))))["MAILTO:Me@Example.COM"]).toBe("ACCEPTED");
      const tom = invitation().map((l) => (l === MINE ? "ATTENDEE:mailto:tom@example.com" : l));
      expect(failure(respond(tom, {}, "om@example.com")).message).toMatch(/not invited/);
      expect(partstats(master(unwrap(respond(tom, {}, "TOM@example.com"))))["mailto:tom@example.com"]).toBe(
        "ACCEPTED",
      );
    },
  );

  itReq(
    [
      "RFC5545:3.8.4.1:attendee-in-group-scheduled",
      "RFC5545:3.8.4.3:organizer-in-group-scheduled",
      "POLICY:respond-requires-organizer",
    ],
    "an event with ATTENDEE lines but no ORGANIZER cannot be answered",
    () => {
      const lines = invitation().filter((l) => !l.startsWith("ORGANIZER"));
      expect(failure(respond(lines)).message).toMatch(/no ORGANIZER/);
    },
  );

  itReq(
    ["RFC5545:3.2.12:partstat-allowed-values", "RFC5545:3.2.12:partstat-values-match-component"],
    "accepted, declined and tentative are written; COMPLETED and MAYBE are refused",
    () => {
      for (const [response, value] of [
        ["accepted", "ACCEPTED"],
        ["declined", "DECLINED"],
        ["tentative", "TENTATIVE"],
      ] as const)
        expect(partstats(master(unwrap(respond(invitation(), { response }))))[`mailto:${ME}`]).toBe(value);
      for (const bad of ["completed", "maybe", "needs-action"])
        expect(failure(respond(invitation(), { response: bad })).message).toMatch(
          /must be accepted, declined or tentative/,
        );
    },
  );

  itReq(
    "RFC5545:3.2.12:partstat-default",
    "an ATTENDEE without PARTSTAT ends up with exactly one PARTSTAT=ACCEPTED",
    () => {
      const lines = invitation().map((l) => (l === MINE ? `ATTENDEE:mailto:${ME}` : l));
      const mine = props(master(unwrap(respond(lines))), "ATTENDEE")[0];
      expect(mine?.params).toBe(";PARTSTAT=ACCEPTED");
    },
  );

  itReq(
    [
      "POLICY:respond-local-partstat-only",
      "RFC6047:2.2.1:only-respondent-sets-status",
      "RFC6047:2.3:mailto-addresses",
    ],
    "the diff is exactly my ATTENDEE value, DTSTAMP and LAST-MODIFIED; every other line stays",
    () => {
      const before = invitation();
      const after = unwrap(respond(before));
      const removed = before.filter((l) => !after.includes(l)).sort();
      const added = after.filter((l) => !before.includes(l)).sort();
      expect(removed).toEqual([MINE, "DTSTAMP:20261114T100000Z"].sort());
      expect(added).toEqual(
        [
          `ATTENDEE;PARTSTAT=ACCEPTED;RSVP=TRUE:mailto:${ME}`,
          "DTSTAMP:20261114T101500Z",
          "LAST-MODIFIED:20261114T101500Z",
        ].sort(),
      );
      expect(after).toContain(ORGANIZER);
      expect(after).toContain(OTHER);
    },
  );

  itReq(
    ["RFC5545:3.2:ignore-unknown-params", "RFC5545:3.2:ignore-unknown-x-iana-param"],
    "an unknown parameter such as X-NUM-GUESTS survives an edit of PARTSTAT",
    () => {
      const lines = invitation().map((l) =>
        l === MINE ? `ATTENDEE;X-NUM-GUESTS=2;PARTSTAT=NEEDS-ACTION:mailto:${ME}` : l,
      );
      const mine = props(master(unwrap(respond(lines))), "ATTENDEE")[0];
      expect(mine?.params).toBe(";X-NUM-GUESTS=2;PARTSTAT=ACCEPTED");
    },
  );

  itReq(
    "RFC5545:3.2.4:delegated-addresses-quoted",
    "a quoted DELEGATED-FROM list comes back unchanged next to the new PARTSTAT",
    () => {
      const list = '"mailto:a@x","mailto:b@x"';
      const lines = invitation().map((l) =>
        l === MINE ? `ATTENDEE;DELEGATED-FROM=${list};PARTSTAT=NEEDS-ACTION:mailto:${ME}` : l,
      );
      const mine = props(master(unwrap(respond(lines))), "ATTENDEE")[0];
      expect(mine?.params).toBe(`;DELEGATED-FROM=${list};PARTSTAT=ACCEPTED`);
    },
  );

  it("tolerates mailto: in any case on the ORGANIZER line and keeps it as it was", () => {
    const lines = invitation().map((l) => (l === ORGANIZER ? "ORGANIZER:MailTo:boss@example.com" : l));
    expect(unwrap(respond(lines))).toContain("ORGANIZER:MailTo:boss@example.com");
  });
});

describe("organizer lines", () => {
  itReq(
    ["RFC5545:3.8.4.3:organizer-params-preserved", "RFC5545:3.2.18:sent-by-quoted-mailto"],
    "ORGANIZER with CN, SENT-BY and an unknown parameter is kept as it was when SUMMARY changes",
    () => {
      const organizer = 'ORGANIZER;CN="John Smith";SENT-BY="mailto:j@x";X-FOO=1:mailto:o@x';
      const lines = invitation().map((l) => (l === ORGANIZER ? organizer : l));
      expect(unwrap(update(lines, { summary: "x" }))).toContain(organizer);
    },
  );

  itReq(
    "POLICY:refuse-organizer-change",
    "a new organizer in the input is refused and the ORGANIZER line stays",
    () => {
      const r = update(invitation(), { organizer: "new@example.com", summary: "x" });
      expect(failure(r).message).toMatch(/organizer of an event cannot be changed/);
      expect(invitation()).toContain(ORGANIZER);
    },
  );

  itReq(
    "POLICY:organizer-without-attendee-valid",
    "an event with ORGANIZER and no ATTENDEE is edited normally and gets no ATTENDEE",
    () => {
      const lines = invitation().filter((l) => !l.startsWith("ATTENDEE"));
      const out = unwrap(update(lines, { summary: "x" }));
      expect(prop(master(out), "ORGANIZER")?.value).toBe("mailto:boss@example.com");
      expect(props(master(out), "ATTENDEE")).toEqual([]);
    },
  );
});

describe("what is kept and what is refused in a file", () => {
  const rich = calendar(
    ["X-WR-CALNAME:Work", "NAME:Work calendar", "BEGIN:X-VENDOR", "X-FOO:bar", "END:X-VENDOR"],
    vevent(
      "UID:u",
      "DTSTAMP:20261114T100000Z",
      "DTSTART:20261120T100000Z",
      "DTEND:20261120T110000Z",
      "SUMMARY:Old",
      'ORGANIZER;CN="John Smith";SENT-BY="mailto:j@x";X-FOO=1:mailto:o@x',
      "ATTENDEE;CN=a^xb;X-NUM-GUESTS=2;PARTSTAT=ACCEPTED:mailto:me@example.com",
      "X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC",
      "CONFERENCE;VALUE=URI;FEATURE=AUDIO,VIDEO;LABEL=Join:https://chat.example/x",
      "CONFERENCE;VALUE=URI:https://chat.example/y",
      `IMAGE;VALUE=BINARY;ENCODING=BASE64;FMTTYPE=image/png:${"iVBORw0KGgo".repeat(30)}`,
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      "DESCRIPTION:x",
      "TRIGGER:-PT15M",
      "END:VALARM",
    ),
  );
  const edited = unwrap(update(rich, { summary: "New" }));
  const volatile = (l: string) => /^(SUMMARY|DTSTAMP|LAST-MODIFIED)[:;]/.test(l);

  itReq(
    [
      "POLICY:preserve-unknown-and-raw",
      "RFC5546:3.7.3:save-iana-tokens",
      "RFC5546:3.7.3:save-x-names",
      "RFC7986:5.1:name-vcalendar-level",
      "RFC7986:5.10:image-media-type",
      "RFC7986:5.11:conference-vevent-todo-only",
      "RFC5545:3.6:no-silent-drop",
      "RFC5545:3.6:do-not-silently-drop-components",
    ],
    "every line that was not changed is kept: calendar properties, unknown components, X- and IANA properties, IMAGE, CONFERENCE, VALARM, raw parameters",
    () => {
      expect(edited.filter((l) => !volatile(l))).toEqual(rich.filter((l) => !volatile(l)));
      expect(edited).toContain("ATTENDEE;CN=a^xb;X-NUM-GUESTS=2;PARTSTAT=ACCEPTED:mailto:me@example.com");
      expect(edited).toContain("BEGIN:X-VENDOR");
      expect(edited.filter((l) => l.startsWith("CONFERENCE"))).toHaveLength(2);
    },
  );

  itReq(
    "RFC5545:3.5:no-property-ordering",
    "an edit keeps the order of the properties; the changed one stays in its place",
    () => {
      const at = (lines: readonly string[]) => lines.findIndex((l) => l.startsWith("SUMMARY"));
      expect(at(edited)).toBe(at(rich));
      expect(edited.findIndex((l) => l.startsWith("DTEND"))).toBe(
        rich.findIndex((l) => l.startsWith("DTEND")),
      );
    },
  );

  itReq("RFC5545:3.6.1:optional-props-at-most-once", "two SUMMARY lines come back as exactly one", () => {
    const twice = invitation().flatMap((l) => (l.startsWith("SUMMARY") ? [l, "SUMMARY:Second"] : [l]));
    expect(props(master(unwrap(update(twice, { summary: "x" }))), "SUMMARY")).toHaveLength(1);
  });

  itReq(
    "RFC5545:3.8.5.1:exdate-excludes-dtstart-keep-original",
    "an EXDATE equal to DTSTART does not move DTSTART when the event is edited",
    () => {
      const lines = weekly(["EXDATE:20261114T100000Z"]);
      const out = unwrap(update(lines, { summary: "x" }));
      expect(prop(master(out), "DTSTART")?.value).toBe("20261114T100000Z");
      expect(prop(master(out), "EXDATE")?.value).toBe("20261114T100000Z");
    },
  );

  itReq(["RFC5545:3.2.13:thisandprior-not-generated"], "no edit writes a RANGE parameter", () => {
    const mine = asOrganizer(weekly());
    const outputs = [
      unwrap(respond(weekly(), { response: "declined", scope: "instance", date: "2026-11-21" })),
      unwrap(
        updateInstance(mine, { ...base, scope: "instance", date: "2026-11-21", summary: "x" }, NOW, ENV),
      ),
      unwrap(end(mine, "2026-11-28")),
      unwrap(
        splitSeries(mine, { ...base, scope: "from_date", date: "2026-11-28", summary: "x" }, "n", NOW, ENV),
      ).created,
    ];
    for (const out of outputs) expect(out.some((l) => /RANGE=/i.test(l))).toBe(false);
  });

  itReq(
    ["POLICY:strip-method-on-write", "RFC4791:4.1:no-method"],
    "a METHOD line from an invitation mail is gone after every tool",
    () => {
      const withMethod = (lines: readonly string[]) => [lines[0] ?? "", "METHOD:REQUEST", ...lines.slice(1)];
      const mine = asOrganizer(weekly());
      const outputs = [
        unwrap(update(withMethod(invitation()), { summary: "x" })),
        unwrap(respond(withMethod(invitation()))),
        unwrap(respond(withMethod(weekly()), { scope: "instance", date: "2026-11-21" })),
        unwrap(end(withMethod(mine), "2026-11-28")),
        unwrap(
          splitSeries(
            withMethod(mine),
            { ...base, scope: "from_date", date: "2026-11-28", summary: "x" },
            "n",
            NOW,
            ENV,
          ),
        ).created,
        unwrap(
          splitSeries(
            withMethod(mine),
            { ...base, scope: "from_date", date: "2026-11-28", summary: "x" },
            "n",
            NOW,
            ENV,
          ),
        ).original,
        unwrap(
          updateInstance(
            withMethod(mine),
            { ...base, scope: "instance", date: "2026-11-21", summary: "x" },
            NOW,
            ENV,
          ),
        ),
      ];
      for (const out of outputs) expect(out.some((l) => /^METHOD[:;]/i.test(l))).toBe(false);
    },
  );

  itReq(
    [
      "POLICY:refuse-multi-uid-or-multi-type-files",
      "RFC4791:4.1:different-uid-separate-resource",
      "VDIR:uid-values-equal",
      "RFC4791:4.1:one-component-type",
    ],
    "a file with two UIDs, or a VEVENT plus a VTODO, is refused by update, respond and end",
    () => {
      const twoUids = calendar(vevent("UID:a", "SUMMARY:A"), vevent("UID:b", "SUMMARY:B"));
      const withTodo = [...weekly().slice(0, -1), "BEGIN:VTODO", "UID:u", "END:VTODO", "END:VCALENDAR"];
      for (const lines of [twoUids, withTodo]) {
        expect(failure(update(lines, { summary: "x" })).message).toMatch(/the event tools do not change it/);
        expect(failure(respond(lines)).message).toMatch(/the event tools do not change it/);
        expect(failure(end(lines, "2026-11-28")).message).toMatch(/the event tools do not change it/);
      }
    },
  );
});

describe("the files of a calendar directory", () => {
  let dir: string;
  let vdir: string;
  const settings = () => testSettings({ calendars: { work: { path: vdir, email: ME } }, timezone: "UTC" });
  const put = (name: string, lines: readonly string[]) =>
    writeFile(join(vdir, name), `${lines.join("\r\n")}\r\n`);
  const stored = async (name: string) => unfoldLines(await readFile(join(vdir, name), "utf8"));

  beforeEach(async () => {
    dir = await tempDir();
    vdir = join(dir, "work");
    await mkdir(vdir);
  });
  afterEach(() => removeDir(dir));

  itReq(
    [
      "VDIR:filename-no-requirement",
      "VDIR:keep-original-filename",
      "RFC4791:5.3.2:url-arbitrary",
      "VDIR:filename-metadata-not-preserved",
    ],
    "abc.ics holding UID xyz is found by its UID and rewritten in place under its own name",
    async () => {
      await put(
        "abc.ics",
        invitation().map((l) => (l === "UID:u" ? "UID:xyz" : l)),
      );
      await runOk(updateEvent(settings(), { ...base, uid: "xyz", summary: "Renamed" }, "n1", NOW));
      expect(await readdir(vdir)).toEqual(["abc.ics"]);
      expect(prop(master(await stored("abc.ics")), "SUMMARY")?.value).toBe("Renamed");
    },
  );

  itReq(
    ["RFC4791:4.1:same-uid-same-resource", "VDIR:recurrence-exceptions-in-same-file"],
    "exceptions of a series are appended to the file of the series; two exceptions make three VEVENTs with one UID",
    async () => {
      await put("u.ics", asOrganizer(weekly()));
      for (const date of ["2026-11-21", "2026-11-28"])
        await runOk(updateEvent(settings(), { ...base, scope: "instance", date, summary: date }, "n1", NOW));
      expect(await readdir(vdir)).toEqual(["u.ics"]);
      const all = events(await stored("u.ics"));
      expect(all).toHaveLength(3);
      expect(all.map((e) => prop(e, "UID")?.value)).toEqual(["u", "u", "u"]);
    },
  );

  itReq(
    ["POLICY:reject-respond-when-not-attendee", "RFC5546:3.7.2:own-attendee-not-found"],
    "a refused answer leaves the file untouched",
    async () => {
      await put("u.ics", invitation());
      const before = await readFile(join(vdir, "u.ics"), "utf8");
      const s = testSettings({
        calendars: { work: { path: vdir, email: "nobody@example.com" } },
        timezone: "UTC",
      });
      const e = await runFail(respondToEvent(s, { ...base, response: "accepted" }, NOW));
      expect(e.message).toMatch(/not invited to event u/);
      expect(await readFile(join(vdir, "u.ics"), "utf8")).toBe(before);
    },
  );

  itReq(
    ["POLICY:respond-requires-organizer", "RFC5545:3.8.4.3:organizer-in-group-scheduled"],
    "an event without ORGANIZER is not rewritten when the user answers it",
    async () => {
      await put(
        "u.ics",
        invitation().filter((l) => !l.startsWith("ORGANIZER")),
      );
      const before = await readFile(join(vdir, "u.ics"), "utf8");
      const e = await runFail(respondToEvent(settings(), { ...base, response: "accepted" }, NOW));
      expect(e.message).toMatch(/no ORGANIZER/);
      expect(await readFile(join(vdir, "u.ics"), "utf8")).toBe(before);
    },
  );

  itReq(
    ["POLICY:refuse-multi-uid-or-multi-type-files", "RFC4791:4.1:different-uid-separate-resource"],
    "a file with two UIDs is not written by update_event, respond_to_event or end_event_series",
    async () => {
      const lines = calendar(
        vevent(
          "UID:u",
          "DTSTAMP:20261114T100000Z",
          "DTSTART:20261114T100000Z",
          "RRULE:FREQ=WEEKLY",
          ORGANIZER,
          MINE,
        ),
        vevent("UID:other", "DTSTART:20261114T100000Z"),
      );
      await put("u.ics", lines);
      const before = await readFile(join(vdir, "u.ics"), "utf8");
      const s = settings();
      for (const eff of [
        updateEvent(s, { ...base, summary: "x" }, "n1", NOW),
        respondToEvent(s, { ...base, response: "accepted" }, NOW),
        endSeries(s, { ...base, lastDate: "2026-11-28" }, NOW),
      ])
        expect((await runFail(eff)).message).toMatch(/UIDs/);
      expect(await readFile(join(vdir, "u.ics"), "utf8")).toBe(before);
    },
  );

  itReq(
    "POLICY:refuse-organizer-change",
    "update_event never changes the ORGANIZER line of the stored file",
    async () => {
      await put("u.ics", invitation());
      const before = await readFile(join(vdir, "u.ics"), "utf8");
      const e = await runFail(
        updateEvent(settings(), { ...base, summary: "x", organizer: "new@example.com" }, "n1", NOW),
      );
      expect(e.message).toMatch(/cannot be changed/);
      expect(await readFile(join(vdir, "u.ics"), "utf8")).toBe(before);
    },
  );
});
