import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect } from "vitest";
import { type EditEnv, splitSeries, updateInstance, updateLines } from "../editEvent.js";
import { endSeriesLines } from "../endSeries.js";
import { renderFile } from "../events.js";
import { occurrencesIn } from "../expand.js";
import { calendarWarnings, classifyFile, events, isMaster, prop, props, unfoldLines } from "../ics.js";
import { parseEventTimes } from "../range.js";
import { buildIcs } from "../recurrence.js";
import { respondLines } from "../respondEvent.js";
import { createServer } from "../server.js";
import { failure, itReq, testSettings, unwrap } from "../testlib.js";

// Rules about what the server does NOT write or interpret (alarms, colours, notifications), and a
// few scattered rows of RFC 5545 / 5546 / 4791 that no other suite proves. Everything is evaluated
// in UTC (the host zone) unless a test says otherwise. The registry rows about the content of a
// VALARM (triggers, repeat, audio, e-mail) are marked n/a in spec/rfc5545.json: the server never
// interprets a foreign alarm, it only keeps it (proved by the preservation tests below).

const NOW = new Date("2026-11-14T10:15:00Z");
const ENV: EditEnv = { hostZone: "UTC", me: undefined };
const BERLIN = "Europe/Berlin";
const base = { calendar: "work", uid: "u" };

const ev = (...inner: string[]): string[] => ["BEGIN:VEVENT", ...inner, "END:VEVENT"];
const cal = (...inner: string[][]): string[] => [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//test//EN",
  ...inner.flat(),
  "END:VCALENDAR",
];

const iso = (ms: number): string => new Date(ms).toISOString().replace(".000Z", "Z");
const DAY = (d: string): number => Date.parse(`${d}T00:00:00Z`);
/** start instants (ISO, UTC) of the occurrences between two days */
const starts = (lines: readonly string[], from = "2026-11-01", to = "2026-12-01"): string[] =>
  unwrap(occurrencesIn(lines, DAY(from), DAY(to), "UTC")).map((i) => iso(i.start));

const master = (lines: readonly string[]) => events(lines).find(isMaster) ?? [];
const summaryOf = (e: readonly string[]) => prop(e, "SUMMARY")?.value;
const block = (lines: readonly string[], name: string): string[] =>
  lines
    .flatMap((l, i) => (l === `BEGIN:${name}` ? [lines.slice(i, lines.indexOf(`END:${name}`, i) + 1)] : []))
    .flat();

// ---------- nobody is notified ----------

describe("no scheduling messages", () => {
  const connect = async (): Promise<Client> => {
    const server = createServer(testSettings(), { uid: () => "fixed-uid", now: () => NOW });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "conformance", version: "0.0.0" });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    return client;
  };

  /** modules and calls through which a program could send mail or reach a network */
  const REACH = /from "node:(?:http|https|http2|net|tls|dgram|dns|child_process)"|\bfetch\(|nodemailer/;

  itReq(
    "POLICY:no-itip-emission",
    "the tools that change an event say that nobody is notified, and no source file can send or fetch anything",
    async () => {
      const client = await connect();
      try {
        const { tools } = await client.listTools();
        const text = (name: string): string => tools.find((t) => t.name === name)?.description ?? "";
        expect(text("respond_to_event")).toMatch(/Nothing is sent to the organizer: they are not notified/);
        expect(text("update_event")).toMatch(/no invitation update is sent/);
        expect(text("end_event_series")).toMatch(/no cancellation is sent to attendees/);
      } finally {
        await client.close();
      }
      const src = join(dirname(fileURLToPath(import.meta.url)), "..");
      const files = (await readdir(src)).filter(
        (n) => n.endsWith(".ts") && !n.endsWith(".test.ts") && n !== "testlib.ts",
      );
      expect(files.length).toBeGreaterThan(10);
      for (const f of files) {
        const code = await readFile(join(src, f), "utf8");
        expect([f, REACH.test(code)]).toEqual([f, false]);
      }
    },
  );
});

// ---------- VTIMEZONE ----------

describe("VTIMEZONE of a zoned series", () => {
  const berlinSeries = (): string[] => {
    const times = unwrap(
      parseEventTimes({ start: "2026-11-04T10:00", end: "2026-11-04T11:00", zone: BERLIN }, BERLIN),
    );
    return unfoldLines(
      unwrap(
        buildIcs(
          {
            summary: "Sync",
            times,
            recurrence: { kind: "weekly", weekdays: ["wednesday"] },
            ending: { kind: "count", count: 6 },
          },
          "uid-1",
          "20261102T100000Z",
        ),
      ),
    );
  };
  const defined = (lines: readonly string[]): string[] =>
    lines.filter((l) => l.startsWith("TZID:")).map((l) => l.slice("TZID:".length));
  const used = (lines: readonly string[]): string[] =>
    [...new Set(lines.flatMap((l) => [...l.matchAll(/;TZID=([^:;]+)/g)].map((m) => m[1] ?? "")))].sort();
  const BERLIN_ENV: EditEnv = { hostZone: BERLIN, me: undefined };

  itReq(
    ["RFC4791:4.1:vtimezone-per-tzid", "RFC5545:3.6.5:vtimezone-unique-definition"],
    "has exactly one VTIMEZONE for the one TZID used, and edits neither add nor repeat a definition",
    () => {
      const lines = berlinSeries();
      expect(lines.filter((l) => l === "BEGIN:VTIMEZONE")).toHaveLength(1);
      expect(defined(lines)).toEqual([BERLIN]);
      expect(used(lines)).toEqual([BERLIN]);

      // an exception adds RECURRENCE-ID with the same TZID: still one definition of it
      const moved = unwrap(
        updateInstance(
          lines,
          {
            ...base,
            uid: "uid-1",
            scope: "instance",
            date: "2026-11-11",
            start: "2026-11-11 12:00",
            end: "13:00",
          },
          NOW,
          BERLIN_ENV,
        ),
      );
      expect(moved.some((l) => l.startsWith("RECURRENCE-ID;TZID=Europe/Berlin:"))).toBe(true);
      expect(moved.filter((l) => l === "BEGIN:VTIMEZONE")).toHaveLength(1);
      expect(defined(moved)).toEqual([BERLIN]);
      expect(used(moved)).toEqual([BERLIN]);

      // a text change, ending the series and splitting it keep the definition, once, in every file
      const edited = unwrap(
        updateLines(lines, { ...base, uid: "uid-1", summary: "Sync 2" }, NOW, BERLIN_ENV),
      );
      const ended = unwrap(
        endSeriesLines(lines, { ...base, uid: "uid-1", lastDate: "2026-11-18" }, NOW, BERLIN_ENV),
      );
      const split = unwrap(
        splitSeries(
          lines,
          { ...base, uid: "uid-1", scope: "from_date", date: "2026-11-18", summary: "Later" },
          "new-uid",
          NOW,
          BERLIN_ENV,
        ),
      );
      for (const out of [edited, ended, split.original, split.created]) {
        expect(defined(out)).toEqual([BERLIN]);
        expect(used(out)).toEqual([BERLIN]);
      }
    },
  );
});

// ---------- RANGE ----------

describe("RANGE of a RECURRENCE-ID", () => {
  const daily = (exception: string[]): string[] =>
    cal(
      ev(
        "UID:u",
        "DTSTAMP:20261114T100000Z",
        "SUMMARY:Daily",
        "DTSTART:20261102T100000Z",
        "DTEND:20261102T110000Z",
        "RRULE:FREQ=DAILY;COUNT=5",
      ),
      ev(
        "UID:u",
        "DTSTAMP:20261114T100000Z",
        "SUMMARY:Later",
        ...exception,
        "DTSTART:20261104T120000Z",
        "DTEND:20261104T130000Z",
      ),
    );

  itReq(
    "RFC5545:3.2.13:range-only-thisandfuture",
    "THISANDFUTURE moves the instance and every later one; no RANGE moves only that instance; other values are refused",
    () => {
      expect(starts(daily(["RECURRENCE-ID;RANGE=THISANDFUTURE:20261104T100000Z"]))).toEqual([
        "2026-11-02T10:00:00Z",
        "2026-11-03T10:00:00Z",
        "2026-11-04T12:00:00Z",
        "2026-11-05T12:00:00Z",
        "2026-11-06T12:00:00Z",
      ]);
      expect(starts(daily(["RECURRENCE-ID:20261104T100000Z"]))).toEqual([
        "2026-11-02T10:00:00Z",
        "2026-11-03T10:00:00Z",
        "2026-11-04T12:00:00Z",
        "2026-11-05T10:00:00Z",
        "2026-11-06T10:00:00Z",
      ]);
      for (const range of ["THISANDPRIOR", "THISANDPAST", "ALL"]) {
        const lines = daily([`RECURRENCE-ID;RANGE=${range}:20261104T100000Z`]);
        const message = failure(occurrencesIn(lines, DAY("2026-11-01"), DAY("2026-12-01"), "UTC")).message;
        expect(message).toContain("RANGE");
      }
    },
  );

  itReq(
    "RFC5545:3.8.4.4:range-instances-by-recurrence-id",
    "an instance shifted by THISANDFUTURE is still addressed by its original RECURRENCE-ID: one entry, not a duplicate or a drop",
    () => {
      const lines = cal(
        ev(
          "UID:u",
          "DTSTAMP:20261114T100000Z",
          "SUMMARY:Daily",
          "DTSTART:20261102T100000Z",
          "DTEND:20261102T110000Z",
          "RRULE:FREQ=DAILY;COUNT=5",
        ),
        ev(
          "UID:u",
          "DTSTAMP:20261114T100000Z",
          "SUMMARY:Later",
          "RECURRENCE-ID;RANGE=THISANDFUTURE:20261104T100000Z",
          "DTSTART:20261104T120000Z",
          "DTEND:20261104T130000Z",
        ),
        ev(
          "UID:u",
          "DTSTAMP:20261114T100000Z",
          "SUMMARY:Single",
          "RECURRENCE-ID:20261105T100000Z",
          "DTSTART:20261105T140000Z",
          "DTEND:20261105T150000Z",
        ),
      );
      // the slot of 5 November is matched by its RECURRENCE-ID (10:00), not by its shifted start (12:00)
      expect(starts(lines)).toEqual([
        "2026-11-02T10:00:00Z",
        "2026-11-03T10:00:00Z",
        "2026-11-04T12:00:00Z",
        "2026-11-05T14:00:00Z",
        "2026-11-06T12:00:00Z",
      ]);
    },
  );
});

// ---------- integers ----------

describe("SEQUENCE as an RFC 5545 integer", () => {
  /** SEQUENCE written after the (organizer-less, so ours to revise) event was moved */
  const bumped = (sequence: string | undefined): string | undefined => {
    const lines = cal(
      ev(
        "UID:u",
        "DTSTAMP:20261114T100000Z",
        ...(sequence === undefined ? [] : [`SEQUENCE:${sequence}`]),
        "SUMMARY:S",
        "DTSTART:20261120T100000Z",
        "DTEND:20261120T110000Z",
      ),
    );
    const out = unwrap(updateLines(lines, { ...base, start: "2026-11-20 12:00", end: "13:00" }, NOW, ENV));
    return prop(master(out), "SEQUENCE")?.value;
  };

  itReq(
    "RFC5545:3.3.8:integer-range",
    "never writes a SEQUENCE outside -2147483648 to 2147483647 (the top stays, a value out of range counts as 0)",
    () => {
      expect(bumped("2147483646")).toBe("2147483647");
      expect(bumped("2147483647")).toBe("2147483647");
      for (const bad of ["2147483648", "99999999999", "-5", "abc"]) {
        const written = Number(bumped(bad));
        expect(Number.isInteger(written)).toBe(true);
        expect(written).toBeGreaterThanOrEqual(-2147483648);
        expect(written).toBeLessThanOrEqual(2147483647);
        expect(bumped(bad)).toBe("1");
      }
    },
  );

  itReq(
    "RFC5545:3.3.8:integer-unsigned-positive",
    "reads a SEQUENCE without sign as positive: 5 and +5 both become 6",
    () => {
      expect(bumped("5")).toBe("6");
      expect(bumped("+5")).toBe("6");
      expect(bumped(undefined)).toBe("1");
    },
  );
});

// ---------- URIs we write ----------

describe("URI values we write", () => {
  const times = unwrap(
    parseEventTimes({ start: "2026-11-04T10:00", end: "2026-11-04T11:00", zone: "UTC" }, BERLIN),
  );
  const build = (organizer: string, attendees: readonly string[]) =>
    buildIcs({ summary: "Sync", times, organizer, attendees, alarm: "15m" }, "uid-1", "20261102T100000Z");
  /** scheme ":" and the characters RFC 3986 allows in the rest of a mailto URI (no percent, query or fragment) */
  const URI = /^[A-Za-z][A-Za-z0-9+.-]*:[A-Za-z0-9._~!$&'()*+,;=:@-]+$/;

  itReq(
    "RFC5545:3.3.13:uri-generic-syntax",
    "the only URIs written are mailto addresses of generic URI syntax; characters outside it are refused",
    () => {
      const lines = unfoldLines(
        unwrap(build("me@example.org", ["first.last@example.org", "a-b_c@sub.example.org"])),
      );
      const uris = lines
        .filter((l) => /^(?:ORGANIZER|ATTENDEE)[;:]/.test(l))
        .map((l) => l.slice(l.indexOf(":mailto:") + 1));
      expect(uris).toHaveLength(3);
      for (const u of uris) expect(u).toMatch(URI);
      // no other property of a URI type is written
      const names = lines.map((l) => /^[A-Za-z0-9-]+/.exec(l)?.[0] ?? "");
      for (const n of ["URL", "TZURL", "ATTACH", "CONFERENCE", "IMAGE", "SOURCE"])
        expect(names).not.toContain(n);
      for (const c of ['"', "\\", "^", "`", "{", "}", "|", "%", "?", "#"])
        expect(failure(build("me@example.org", [`a${c}b@example.org`]))._tag).toBe("InvalidInput");
    },
  );
});

// ---------- STATUS ----------

describe("STATUS", () => {
  const tentative = cal(
    ev(
      "UID:u",
      "DTSTAMP:20261114T100000Z",
      "SUMMARY:Weekly",
      "STATUS:TENTATIVE",
      "DTSTART:20261114T100000Z",
      "DTEND:20261114T110000Z",
      "RRULE:FREQ=WEEKLY",
    ),
  );
  const statuses = (lines: readonly string[]): string[][] =>
    events(lines).map((e) => props(e, "STATUS").map((p) => p.value));

  itReq(
    "RFC5545:3.8.1.11:status-at-most-once",
    "no edit adds a second STATUS or drops the one that is there, in the series or in an exception",
    () => {
      expect(statuses(unwrap(updateLines(tentative, { ...base, summary: "New" }, NOW, ENV)))).toEqual([
        ["TENTATIVE"],
      ]);
      const instance = unwrap(
        updateInstance(
          tentative,
          { ...base, scope: "instance", date: "2026-11-21", summary: "One" },
          NOW,
          ENV,
        ),
      );
      expect(statuses(instance)).toEqual([["TENTATIVE"], ["TENTATIVE"]]);
      const ended = unwrap(endSeriesLines(tentative, { ...base, lastDate: "2026-11-21" }, NOW, ENV));
      expect(statuses(ended)).toEqual([["TENTATIVE"]]);
    },
  );
});

// ---------- offsets of a VTIMEZONE ----------

describe("TZOFFSETTO of a VTIMEZONE", () => {
  const zone = (tzid: string, offset: string): string[] => [
    "BEGIN:VTIMEZONE",
    `TZID:${tzid}`,
    "BEGIN:STANDARD",
    "DTSTART:19700101T000000",
    `TZOFFSETFROM:${offset}`,
    `TZOFFSETTO:${offset}`,
    "END:STANDARD",
    "END:VTIMEZONE",
  ];
  const startsIn = (tzid: string, offset: string): string[] =>
    starts(
      cal(
        zone(tzid, offset),
        ev(
          "UID:u",
          "DTSTAMP:20261114T100000Z",
          `DTSTART;TZID=${tzid}:20261105T100000`,
          `DTEND;TZID=${tzid}:20261105T110000`,
        ),
      ),
    );

  itReq(
    "RFC5545:3.8.3.3:tzoffset-sign-semantics",
    "a positive offset is ahead of UTC (local = UTC + offset), a negative one behind it",
    () => {
      expect(startsIn("Test/East", "+0100")).toEqual(["2026-11-05T09:00:00Z"]);
      expect(startsIn("Test/West", "-0500")).toEqual(["2026-11-05T15:00:00Z"]);
      expect(startsIn("Test/India", "+0530")).toEqual(["2026-11-05T04:30:00Z"]);
      expect(startsIn("Test/Newfoundland", "-0330")).toEqual(["2026-11-05T13:30:00Z"]);
    },
  );
});

// ---------- UID and RECURRENCE-ID as the key ----------

describe("an exception is addressed by UID and RECURRENCE-ID", () => {
  const exception = (rid: string, summary: string): string[] =>
    ev(
      "UID:u",
      "DTSTAMP:20261114T100000Z",
      "SEQUENCE:1",
      `RECURRENCE-ID:${rid}`,
      `DTSTART:${rid}`,
      `SUMMARY:${summary}`,
    );
  const series = cal(
    ev(
      "UID:u",
      "DTSTAMP:20261114T100000Z",
      "SEQUENCE:2",
      "SUMMARY:Weekly",
      "DTSTART:20261114T100000Z",
      "DTEND:20261114T110000Z",
      "RRULE:FREQ=WEEKLY",
    ),
    exception("20261121T100000Z", "One"),
    exception("20261128T100000Z", "Two"),
  );

  itReq(
    "RFC5546:2.1.5:primary-key-uid-recurrence-id",
    "editing the instance of 2026-11-21 changes its exception only, not the series and not the other exception",
    () => {
      const out = unwrap(
        updateInstance(
          series,
          { ...base, scope: "instance", date: "2026-11-21", summary: "Edited" },
          NOW,
          ENV,
        ),
      );
      const all = events(out);
      expect(all).toHaveLength(3);
      expect(all.map((e) => prop(e, "UID")?.value)).toEqual(["u", "u", "u"]);
      expect(all.map(summaryOf)).toEqual(["Weekly", "Edited", "Two"]);
      expect(all.map((e) => prop(e, "RECURRENCE-ID")?.value)).toEqual([
        undefined,
        "20261121T100000Z",
        "20261128T100000Z",
      ]);
      expect(master(out)).toEqual(master(series));
      expect(all[2]).toEqual(events(series)[2]);
    },
  );
});

// ---------- foreign alarms and properties are kept, not interpreted ----------

describe("alarms and properties the server does not interpret", () => {
  const ALARMS = [
    "BEGIN:VALARM",
    "ACTION:X-FOO",
    "TRIGGER;RELATED=END:PT5M",
    "X-FOO-PARAM:1",
    "END:VALARM",
    "BEGIN:VALARM",
    "ACTION:PROCEDURE",
    "TRIGGER;VALUE=DATE-TIME:19980101T050000Z",
    "REPEAT:2",
    "DURATION:PT5M",
    "END:VALARM",
    "BEGIN:VALARM",
    "ACTION:AUDIO",
    "TRIGGER:-PT30M",
    "ATTACH;FMTTYPE=audio/basic:ftp://example.com/pub/sounds/bell-01.aud",
    "END:VALARM",
  ];
  const withAlarms = cal(
    ev(
      "UID:u",
      "DTSTAMP:20261114T100000Z",
      "CREATED:19960329T133000Z",
      "SUMMARY:Review",
      "DTSTART:20261120T100000Z",
      "DTEND:20261120T110000Z",
      ...ALARMS,
    ),
  );

  itReq(
    "RFC5545:3.8.6.1:ignore-unknown-alarm-action",
    "alarms with an action the server does not know are no error for reading and survive an edit unchanged",
    () => {
      expect(classifyFile(withAlarms).kind).toBe("event");
      expect(calendarWarnings(withAlarms)).toEqual([]);
      expect(starts(withAlarms)).toEqual(["2026-11-20T10:00:00Z"]);
      const shown = renderFile(
        "work",
        { file: "/x/u.ics", lines: withAlarms, uid: "u" },
        DAY("2026-11-01"),
        DAY("2026-12-01"),
        "UTC",
      );
      expect(shown.problems).toEqual([]);
      expect(shown.events.map((r) => r.event.title)).toEqual(["Review"]);

      const out = unwrap(updateLines(withAlarms, { ...base, summary: "Retitled" }, NOW, ENV));
      expect(summaryOf(master(out))).toBe("Retitled");
      expect(block(out, "VALARM")).toEqual(ALARMS);
      expect(out).toContain("CREATED:19960329T133000Z");
    },
  );

  const emailAlarm = [
    "BEGIN:VALARM",
    "ACTION:EMAIL",
    "TRIGGER:-PT15M",
    "DESCRIPTION:Mail",
    "SUMMARY:Reminder",
    "ATTENDEE:mailto:me@example.com",
    "END:VALARM",
  ];
  const invitation = cal(
    ev(
      "UID:u",
      "DTSTAMP:20261114T100000Z",
      "SUMMARY:Review",
      "DTSTART:20261120T100000Z",
      "DTEND:20261120T110000Z",
      "ORGANIZER:mailto:boss@example.com",
      "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:me@example.com",
      ...emailAlarm,
    ),
  );

  itReq(
    "RFC5545:3.8.4.1:attendee-allowed-in-email-valarm",
    "an EMAIL alarm with its own ATTENDEE reads without complaint, is no attendee of the event and is left alone by a reply",
    () => {
      expect(classifyFile(invitation).kind).toBe("event");
      expect(calendarWarnings(invitation)).toEqual([]);
      const shown = renderFile(
        "work",
        { file: "/x/u.ics", lines: invitation, uid: "u" },
        DAY("2026-11-01"),
        DAY("2026-12-01"),
        "UTC",
      );
      expect(shown.problems).toEqual([]);
      expect(shown.events.map((r) => r.event.attendees)).toEqual(["me@example.com"]);

      const out = unwrap(
        respondLines(invitation, { ...base, response: "accepted" }, "me@example.com", NOW, "UTC"),
      );
      expect(props(master(out), "ATTENDEE").map((a) => a.params)).toEqual([";PARTSTAT=ACCEPTED"]);
      expect(block(out, "VALARM")).toEqual(emailAlarm);
    },
  );

  itReq(
    "RFC7986:5.9:color-clients-may-use",
    "an event with a COLOR the server does not know is listed and editable, and the COLOR line stays",
    () => {
      const colored = cal(
        ev(
          "UID:u",
          "DTSTAMP:20261114T100000Z",
          "COLOR:not-a-css-colour",
          "SUMMARY:Review",
          "DTSTART:20261120T100000Z",
          "DTEND:20261120T110000Z",
        ),
      );
      const shown = renderFile(
        "work",
        { file: "/x/u.ics", lines: colored, uid: "u" },
        DAY("2026-11-01"),
        DAY("2026-12-01"),
        "UTC",
      );
      expect(shown.problems).toEqual([]);
      expect(shown.events.map((r) => r.event.title)).toEqual(["Review"]);
      const out = unwrap(updateLines(colored, { ...base, summary: "Retitled" }, NOW, ENV));
      expect(summaryOf(master(out))).toBe("Retitled");
      expect(props(master(out), "COLOR").map((p) => p.value)).toEqual(["not-a-css-colour"]);
    },
  );
});
