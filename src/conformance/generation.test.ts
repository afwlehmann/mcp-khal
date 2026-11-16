import { readdir, readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type NewEventInput, newEvent } from "../newEvent.js";
import { type EventTimes, parseEventTimes } from "../range.js";
import { buildIcs, type IcsEventParams, type Recurrence } from "../recurrence.js";
import type { Settings } from "../settings.js";
import { failure, itReq, runFail, runOk, type Sandbox, sandbox, unwrap } from "../testlib.js";
import { vtimezone } from "../vtimezone.js";

// What we WRITE conforms to RFC 5545 (and the storage rules of RFC 4791 / RFC 7986 / the vdir
// format). The assertions do not use the generator's own helpers: the file is read back by the small
// independent reader below, which is strict about the content line grammar.

// ---------- an independent reader of what we wrote ----------

interface Prop {
  readonly name: string;
  readonly params: Readonly<Record<string, string>>;
  readonly value: string;
  readonly line: string;
}

interface Comp {
  readonly name: string;
  readonly props: readonly Prop[];
  readonly children: readonly Comp[];
}

/** name *(";" param) ":" value, with quoted parameter values (RFC 5545 3.1) */
const CONTENT_LINE =
  /^([A-Za-z0-9-]+)((?:;[A-Za-z0-9-]+=(?:"[^"]*"|[^";:,]*)(?:,(?:"[^"]*"|[^";:,]*))*)*):(.*)$/;
const PARAM = /;([A-Za-z0-9-]+)=((?:"[^"]*"|[^";:,]*)(?:,(?:"[^"]*"|[^";:,]*))*)/g;
/** CONTROL of the grammar: everything but HTAB */
const CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f]/;

/** The logical lines of a file: CRLF everywhere, folds (CRLF + one space) undone. */
const logical = (ics: string): string[] => {
  expect(ics.endsWith("\r\n")).toBe(true);
  expect(ics.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
  return ics
    .slice(0, -2)
    .split("\r\n")
    .reduce<string[]>(
      (acc, l) =>
        l.startsWith(" ") ? [...acc.slice(0, -1), `${acc.at(-1) ?? ""}${l.slice(1)}`] : [...acc, l],
      [],
    );
};

const readProp = (line: string): Prop => {
  const m = CONTENT_LINE.exec(line);
  if (m === null || CONTROL.test(line)) throw new Error(`not a valid content line: ${JSON.stringify(line)}`);
  const params = Object.fromEntries(
    [...(m[2] ?? "").matchAll(PARAM)].map((p) => [(p[1] ?? "").toUpperCase(), p[2] ?? ""]),
  );
  return { name: (m[1] ?? "").toUpperCase(), params, value: m[3] ?? "", line };
};

const parseCal = (ics: string): Comp => {
  interface Open {
    readonly name: string;
    readonly props: Prop[];
    readonly children: Comp[];
  }
  const stack: Open[] = [];
  const done: Comp[] = [];
  for (const line of logical(ics)) {
    const p = readProp(line);
    const top = stack.at(-1);
    if (p.name === "BEGIN") stack.push({ name: p.value, props: [], children: [] });
    else if (p.name === "END") {
      const closed = stack.pop();
      if (closed === undefined || closed.name !== p.value) throw new Error(`unbalanced: ${line}`);
      const parent = stack.at(-1);
      if (parent === undefined) done.push(closed);
      else parent.children.push(closed);
    } else if (top === undefined) throw new Error(`property outside a component: ${line}`);
    else top.props.push(p);
  }
  const [root, ...rest] = done;
  if (root === undefined || rest.length > 0 || stack.length > 0 || root.name !== "VCALENDAR")
    throw new Error("not exactly one VCALENDAR");
  return root;
};

const named = (c: Comp, name: string): Comp[] => c.children.filter((x) => x.name === name);
const propsOf = (c: Comp, name: string): Prop[] => c.props.filter((p) => p.name === name);
const one = (c: Comp, name: string): Prop => {
  const ps = propsOf(c, name);
  const [p] = ps;
  if (p === undefined || ps.length !== 1) throw new Error(`${c.name} has ${ps.length} ${name}`);
  return p;
};
const event = (ics: string): Comp => {
  const [e] = named(parseCal(ics), "VEVENT");
  if (e === undefined) throw new Error("no VEVENT");
  return e;
};
const walk = (c: Comp): Comp[] => [c, ...c.children.flatMap(walk)];
const allProps = (c: Comp): Prop[] => walk(c).flatMap((x) => x.props);

// ---------- value checks, written from the RFC ----------

const isRealDate = (s: string): boolean => {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (m === null) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
};

const LOCAL_TIME = /^(\d{8})T([01]\d|2[0-3])([0-5]\d)([0-5]\d|60)$/;
const UTC_TIME = /^(\d{8})T([01]\d|2[0-3])([0-5]\d)([0-5]\d|60)Z$/;
const isLocal = (s: string): boolean => LOCAL_TIME.test(s) && isRealDate(s.slice(0, 8));
const isUtc = (s: string): boolean => UTC_TIME.test(s) && isRealDate(s.slice(0, 8));

/** dur-value of RFC 5545 3.3.6: dur-week alone, or dur-day with an optional time, or a time. */
const DURATION =
  /^[+-]?P(?:\d+W|\d+D(?:T(?:\d+H(?:\d+M)?(?:\d+S)?|\d+M(?:\d+S)?|\d+S))?|T(?:\d+H(?:\d+M)?(?:\d+S)?|\d+M(?:\d+S)?|\d+S))$/;

/** DATE, UTC date-time, local date-time with TZID, or something else */
const kindOf = (p: Prop): "date" | "utc" | "tzid" | "floating" | "invalid" => {
  if (p.params.VALUE === "DATE")
    return isRealDate(p.value) && p.params.TZID === undefined ? "date" : "invalid";
  if (p.params.VALUE !== undefined) return "invalid";
  if (isUtc(p.value)) return p.params.TZID === undefined ? "utc" : "invalid";
  if (isLocal(p.value)) return p.params.TZID === undefined ? "floating" : "tzid";
  return "invalid";
};

const UNESCAPE = /\\([\\;,nN])/g;
/** TEXT decoding of RFC 5545 3.3.11 */
const decode = (s: string): string =>
  s.replace(UNESCAPE, (_, c: string) => (c === "n" || c === "N" ? "\n" : c));

/** The rules of RFC 5545 3.3.10 for the parts of one RRULE; a list of what is wrong. */
const violations = (value: string, dtstartIsDate = false): string[] => {
  const parts = value.split(";").map((p): [string, string] => {
    const i = p.indexOf("=");
    return i < 1 ? [p, ""] : [p.slice(0, i), p.slice(i + 1)];
  });
  const keys = parts.map(([k]) => k);
  const get = (k: string): string | undefined => parts.find(([x]) => x === k)?.[1];
  const freq = get("FREQ");
  const known = [
    "FREQ",
    "UNTIL",
    "COUNT",
    "INTERVAL",
    "BYSECOND",
    "BYMINUTE",
    "BYHOUR",
    "BYDAY",
    "BYMONTHDAY",
    "BYYEARDAY",
    "BYWEEKNO",
    "BYMONTH",
    "BYSETPOS",
    "WKST",
  ];
  const byday = get("BYDAY")?.split(",") ?? [];
  const numeric = byday.some((d) => /^[+-]?\d/.test(d));
  const check = (bad: boolean, what: string): string[] => (bad ? [what] : []);
  return [
    ...check(freq === undefined, "no FREQ"),
    ...check(keys[0] !== "FREQ", "FREQ is not first"),
    ...check(new Set(keys).size !== keys.length, "a rule part occurs twice"),
    ...keys.filter((k) => !known.includes(k)).map((k) => `unknown rule part ${k}`),
    ...check(get("COUNT") !== undefined && get("UNTIL") !== undefined, "COUNT together with UNTIL"),
    ...byday
      .filter((d) => !/^(?:[+-]?(?:[1-9]|[1-4]\d|5[0-3]))?(?:SU|MO|TU|WE|TH|FR|SA)$/.test(d))
      .map((d) => `bad BYDAY ${d}`),
    ...check(numeric && freq !== "MONTHLY" && freq !== "YEARLY", "numeric BYDAY needs MONTHLY or YEARLY"),
    ...check(numeric && freq === "YEARLY" && get("BYWEEKNO") !== undefined, "numeric BYDAY with BYWEEKNO"),
    ...check(get("BYMONTHDAY") !== undefined && freq === "WEEKLY", "BYMONTHDAY with WEEKLY"),
    ...check(
      get("BYYEARDAY") !== undefined && ["DAILY", "WEEKLY", "MONTHLY"].includes(freq ?? ""),
      "BYYEARDAY with DAILY, WEEKLY or MONTHLY",
    ),
    ...check(get("BYWEEKNO") !== undefined && freq !== "YEARLY", "BYWEEKNO without YEARLY"),
    ...check(
      get("BYSETPOS") !== undefined && !keys.some((k) => k.startsWith("BY") && k !== "BYSETPOS"),
      "BYSETPOS without another BYxxx",
    ),
    ...check(
      dtstartIsDate && ["BYHOUR", "BYMINUTE", "BYSECOND"].some((k) => keys.includes(k)),
      "a time rule part with a DATE DTSTART",
    ),
  ];
};

// ---------- fixtures ----------

const STAMP = "20261102T100000Z";
const NOW = new Date("2026-11-02T10:00:00.000Z");
const BERLIN = "Europe/Berlin";

const at = (date: string, start = "10:00", end = "11:00", zone = BERLIN): EventTimes =>
  unwrap(parseEventTimes({ start: `${date}T${start}`, end: `${date}T${end}`, zone }, BERLIN));
const day = (start: string, end?: string): EventTimes => unwrap(parseEventTimes({ start, end }, BERLIN));

// 2026-11-04 is a Wednesday
// (UTC by default: no VTIMEZONE to compute; the tests of zones say so)
const params = (p: Partial<IcsEventParams> = {}): IcsEventParams => ({
  summary: "Sync",
  times: at("2026-11-04", "10:00", "11:00", "UTC"),
  ...p,
});
const build = (p: Partial<IcsEventParams> = {}, uid = "uid-1", stamp = STAMP) =>
  buildIcs(params(p), uid, stamp);
const make = (p: Partial<IcsEventParams> = {}): string => unwrap(build(p));

const checkFolding = (ics: string, wanted: readonly string[]): void => {
  const physical = ics.split("\r\n");
  for (const l of physical) {
    expect(Buffer.byteLength(l)).toBeLessThanOrEqual(75);
    expect(l).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  }
  const unfolded = logical(ics);
  for (const w of wanted) expect(unfolded).toContain(w);
  // a fold is exactly CRLF and one space: no other whitespace starts a physical line
  for (const l of physical.slice(1)) expect(l).not.toMatch(/^\t/);
};

// ---------- the calendar object ----------

describe("a generated calendar object", () => {
  itReq(
    [
      "RFC5545:3.6:prodid-version-required",
      "RFC5545:3.7.3:prodid-once",
      "RFC5545:3.7.4:version-once",
      "RFC5545:3.7.4:version-2-0",
      "RFC5545:3.7:calprops-before-components",
    ],
    "has one VERSION:2.0 and one PRODID, both before the first component",
    () => {
      const ics = make({ times: at("2026-11-04") });
      const cal = parseCal(ics);
      expect(propsOf(cal, "VERSION").map((p) => p.value)).toEqual(["2.0"]);
      expect(propsOf(cal, "PRODID")).toHaveLength(1);
      expect(one(cal, "PRODID").value).not.toBe("");
      const lines = logical(ics);
      const firstComponent = lines.findIndex((l, i) => i > 0 && l.startsWith("BEGIN:"));
      expect(lines.indexOf("VERSION:2.0")).toBeLessThan(firstComponent);
      expect(lines.findIndex((l) => l.startsWith("PRODID:"))).toBeLessThan(firstComponent);
      expect(named(cal, "VTIMEZONE")).toHaveLength(1);
    },
  );

  itReq(
    ["RFC5545:3.4:object-begin-end-delimiters", "RFC5545:3.6:at-least-one-component"],
    "starts with BEGIN:VCALENDAR, ends with END:VCALENDAR + CRLF and holds a component",
    () => {
      const ics = make();
      expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
      expect(ics.endsWith("\r\nEND:VCALENDAR\r\n")).toBe(true);
      expect(named(parseCal(ics), "VEVENT")).toHaveLength(1);
    },
  );

  itReq(
    ["RFC5545:3.1:crlf-line-break", "RFC5545:3.1:crlf-line-breaks"],
    "ends every line, the last one included, with CRLF and has no bare LF or CR",
    () => {
      const ics = make({
        summary: "S".repeat(200),
        description: "one\ntwo\r\nthree",
        location: "L".repeat(100),
        alarm: "15m",
      });
      expect(ics.endsWith("\r\n")).toBe(true);
      expect(ics.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
      expect(ics).not.toMatch(/(?<!\r)\n/);
      expect(ics).not.toMatch(/\r(?!\n)/);
    },
  );

  itReq(
    ["RFC5545:3.1:line-length-75-octets", "RFC5545:3.1:fold-long-lines", "RFC5545:3.1:fold-at-75-octets"],
    "folds long lines at 75 octets as CRLF + space, and unfolding restores the line",
    () => {
      const summary = "x".repeat(200);
      const description = "d".repeat(200);
      const ics = make({ summary, description });
      expect(ics.split("\r\n").some((l) => l.startsWith(" "))).toBe(true);
      checkFolding(ics, [`SUMMARY:${summary}`, `DESCRIPTION:${description}`]);
    },
  );

  itReq(
    ["RFC5545:3.1:utf8-fold-4-byte-chars", "RFC5545:3.1:no-split-utf8"],
    "never splits a multi-octet character: 4-byte emoji, 3-byte and 2-byte characters",
    () => {
      for (const unit of ["😀", "€", "é"]) {
        const summary = unit.repeat(unit === "😀" ? 25 : 80);
        const ics = make({ summary });
        expect(ics.split("\r\n").length).toBeGreaterThan(8);
        checkFolding(ics, [`SUMMARY:${summary}`]);
        const bytes = Buffer.from(ics, "utf8");
        // every physical line of the bytes is valid UTF-8 on its own
        let start = 0;
        for (let i = 0; i + 1 < bytes.length; i += 1) {
          if (bytes[i] === 0x0d && bytes[i + 1] === 0x0a) {
            expect(() =>
              new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(start, i)),
            ).not.toThrow();
            start = i + 2;
          }
        }
      }
    },
  );
});

// ---------- values ----------

describe("date and time values", () => {
  itReq(
    [
      "RFC5545:3.3.5:fixed-time-needs-utc-or-tzid",
      "RFC5545:3.2.19:tzid-required-for-local-datetime",
      "RFC5545:3.3.5:utc-datetime-no-tzid",
      "RFC5545:3.8.2.2:dtend-local-iff-dtstart-local",
      "RFC5545:3.2.19:vtimezone-per-tzid",
    ],
    "writes a zoned event as a local time with TZID (never floating, never Z) and embeds its VTIMEZONE once",
    () => {
      for (const zone of [BERLIN, "America/New_York"]) {
        const ics = make({ times: at("2026-11-04", "10:00", "11:30", zone) });
        const cal = parseCal(ics);
        const ev = event(ics);
        const start = one(ev, "DTSTART");
        const end = one(ev, "DTEND");
        expect(kindOf(start)).toBe("tzid");
        expect(kindOf(end)).toBe("tzid");
        expect(start.params.TZID).toBe(zone);
        expect(end.params.TZID).toBe(zone);
        expect(start.value).toBe("20261104T100000");
        expect(end.value).toBe("20261104T113000");
        const zones = named(cal, "VTIMEZONE");
        expect(zones).toHaveLength(1);
        expect(one(zones[0] as Comp, "TZID").value).toBe(zone);
        const used = new Set(
          allProps(ev).flatMap((p) => (p.params.TZID === undefined ? [] : [p.params.TZID])),
        );
        expect([...used]).toEqual([zone]);
      }
    },
  );

  itReq(
    [
      "RFC5545:3.3.5:utc-datetime-no-tzid",
      "RFC5545:3.2.19:tzid-not-on-date-or-utc",
      "RFC5545:3.3.5:fixed-time-needs-utc-or-tzid",
      "RFC5545:3.8.2.2:dtend-local-iff-dtstart-local",
    ],
    "writes a UTC event with the Z form, without TZID and without VTIMEZONE",
    () => {
      const ics = make({ times: at("2026-11-04", "10:00", "11:00", "UTC") });
      const ev = event(ics);
      expect(one(ev, "DTSTART").params).toEqual({});
      expect(one(ev, "DTEND").params).toEqual({});
      expect(one(ev, "DTSTART").value).toBe("20261104T100000Z");
      expect(one(ev, "DTEND").value).toBe("20261104T110000Z");
      expect(kindOf(one(ev, "DTSTART"))).toBe("utc");
      expect(named(parseCal(ics), "VTIMEZONE")).toEqual([]);
      expect(allProps(parseCal(ics)).some((p) => p.params.TZID !== undefined)).toBe(false);
    },
  );

  itReq(
    [
      "RFC5545:3.3.4:date-format-yyyymmdd",
      "RFC5545:3.2.20:value-param-required-when-overridden",
      "RFC5545:3.2.19:tzid-not-on-date-or-utc",
      "RFC5545:3.6.1:date-dtend-must-be-date",
      "RFC5545:3.3:alternate-type-explicit-value",
      "RFC5545:3.6.1:dtend-non-inclusive",
    ],
    "writes an all-day event as DATE values with VALUE=DATE and an exclusive end",
    () => {
      const ics = make({ times: day("2024-02-29") });
      const ev = event(ics);
      expect(one(ev, "DTSTART").params).toEqual({ VALUE: "DATE" });
      expect(one(ev, "DTEND").params).toEqual({ VALUE: "DATE" });
      expect(one(ev, "DTSTART").value).toBe("20240229");
      // a one-day event ends on the next day (DTEND is not inclusive)
      expect(one(ev, "DTEND").value).toBe("20240301");
      expect(kindOf(one(ev, "DTSTART"))).toBe("date");
      expect(kindOf(one(ev, "DTEND"))).toBe("date");
      expect(named(parseCal(ics), "VTIMEZONE")).toEqual([]);
      // the example of RFC 5545 3.6.1: June 28 through July 8 is DTEND 20070709
      const span = event(make({ times: day("2007-06-28", "2007-07-08") }));
      expect(one(span, "DTSTART").value).toBe("20070628");
      expect(one(span, "DTEND").value).toBe("20070709");
    },
  );

  itReq("RFC5545:3.3.4:date-format-yyyymmdd", "never writes a date that does not exist", () => {
    const times = { allDay: true, startDate: "2023-02-29", endDate: "2023-03-01" } as const;
    expect(failure(build({ times }))._tag).toBe("InvalidInput");
    const timed: EventTimes = {
      allDay: false,
      start: "2023-02-29T10:00:00",
      end: "2023-02-29T11:00:00",
      zone: "UTC",
      startInstant: new Date("2023-03-01T10:00:00Z"),
      endInstant: new Date("2023-03-01T11:00:00Z"),
    };
    expect(failure(build({ times: timed }))._tag).toBe("InvalidInput");
  });

  itReq(
    ["RFC5545:3.8.2.2:dtend-same-type-and-later", "RFC5545:3.6.1:date-dtend-must-be-date"],
    "writes DTEND of the type of DTSTART, and refuses an end that is not later than the start",
    () => {
      for (const times of [at("2026-11-04"), at("2026-11-04", "10:00", "11:00", "UTC"), day("2026-11-04")]) {
        const ev = event(make({ times }));
        expect(kindOf(one(ev, "DTEND"))).toBe(kindOf(one(ev, "DTSTART")));
        expect(one(ev, "DTEND").value > one(ev, "DTSTART").value).toBe(true);
      }
      expect(failure(build({ times: at("2026-11-04", "10:00", "10:00") })).message).toMatch(
        /later than start/,
      );
      const early: EventTimes = {
        allDay: false,
        start: "2026-11-04T10:00:00",
        end: "2026-11-04T09:00:00",
        zone: "UTC",
        startInstant: new Date("2026-11-04T10:00:00Z"),
        endInstant: new Date("2026-11-04T09:00:00Z"),
      };
      expect(failure(build({ times: early })).message).toMatch(/later than start/);
    },
  );

  itReq(
    [
      "RFC5545:3.3.12:no-fractional-seconds",
      "RFC5545:3.3.12:no-utc-offset-time",
      "RFC5545:3.3.5:no-utc-offset-form",
    ],
    "writes only whole seconds and no UTC offset inside a time value",
    () => {
      const times = unwrap(
        parseEventTimes({ start: "2026-11-04T10:00:30", end: "2026-11-04T11:00:45", zone: BERLIN }, BERLIN),
      );
      const ics = make({
        times,
        recurrence: { kind: "daily" },
        ending: { kind: "until", date: "2026-12-01" },
      });
      const values = allProps(parseCal(ics))
        .filter((p) => ["DTSTART", "DTEND", "DTSTAMP"].includes(p.name))
        .map((p) => p.value);
      expect(values.length).toBeGreaterThan(2);
      for (const v of values) expect(v).toMatch(/^\d{8}T\d{6}Z?$/);
      expect(one(event(ics), "DTSTART").value).toBe("20261104T100030");
      expect(one(event(ics), "RRULE").value).toMatch(/UNTIL=\d{8}T\d{6}Z$/);
    },
  );
});

// ---------- the VEVENT ----------

describe("a generated VEVENT", () => {
  itReq(
    [
      "RFC5545:3.8.4.7:vevent-uid-required",
      "RFC5545:3.8.7.2:vevent-dtstamp-required",
      "RFC5545:3.8.2.4:dtstart-required-without-method",
      "RFC5545:3.6.1:dtstart-required-without-method",
    ],
    "has exactly one UID, DTSTAMP and DTSTART, and the file has no METHOD",
    () => {
      const ics = make();
      const ev = event(ics);
      for (const name of ["UID", "DTSTAMP", "DTSTART"]) expect(propsOf(ev, name)).toHaveLength(1);
      expect(one(ev, "UID").value).toBe("uid-1");
      expect(propsOf(parseCal(ics), "METHOD")).toEqual([]);
    },
  );

  itReq(
    [
      "RFC5545:3.6.1:dtend-xor-duration",
      "RFC5545:3.8.2.5:duration-positive-only",
      "RFC5545:3.8.2.5:duration-date-dtstart-day-week",
    ],
    "writes DTEND and never a DURATION property in the event, so no sign or unit can be wrong",
    () => {
      for (const times of [
        at("2026-11-04"),
        at("2026-11-04", "10:00", "11:00", "UTC"),
        day("2026-11-04", "2026-11-06"),
      ]) {
        const ev = event(make({ times, alarm: "30m" }));
        expect(propsOf(ev, "DTEND")).toHaveLength(1);
        expect(propsOf(ev, "DURATION")).toEqual([]);
      }
    },
  );

  itReq(
    ["RFC5545:3.8.7.2:dtstamp-utc", "RFC5545:3.8.7.2:dtstamp-required"],
    "writes DTSTAMP once, in UTC, from the injected stamp, and refuses a stamp that is not UTC",
    () => {
      const ev = event(make());
      expect(propsOf(ev, "DTSTAMP")).toHaveLength(1);
      expect(one(ev, "DTSTAMP").value).toBe(STAMP);
      expect(one(ev, "DTSTAMP").params).toEqual({});
      expect(isUtc(one(ev, "DTSTAMP").value)).toBe(true);
      for (const bad of ["20261102T100000", "2026-11-02T10:00:00Z", "20261102T100000+0100", ""])
        expect(failure(build({}, "uid-1", bad))._tag).toBe("InvalidInput");
    },
  );

  itReq(
    ["RFC5545:3.8.7.4:sequence-initial-zero", "RFC5545:3.8.7.4:sequence-created-zero"],
    "starts at SEQUENCE 0: the property is absent (read as 0) or 0, never 1",
    () => {
      const values = propsOf(event(make()), "SEQUENCE").map((p) => p.value);
      expect(values.every((v) => v === "0")).toBe(true);
      expect(values.length).toBeLessThanOrEqual(1);
    },
  );

  itReq(
    ["RFC5545:3.6.1:optional-props-at-most-once", "RFC5545:3.6.1:rrule-should-not-repeat"],
    "writes every property that may occur once at most once, and one RRULE",
    () => {
      const ev = event(
        make({
          location: "Room",
          description: "Text",
          alarm: "15m",
          recurrence: { kind: "weekly", weekdays: ["wednesday"] },
          organizer: "me@x.com",
          attendees: ["a@x.com", "b@x.com"],
        }),
      );
      for (const name of [
        "CLASS",
        "CREATED",
        "DESCRIPTION",
        "GEO",
        "LAST-MODIFIED",
        "LOCATION",
        "ORGANIZER",
        "PRIORITY",
        "SEQUENCE",
        "STATUS",
        "SUMMARY",
        "TRANSP",
        "URL",
        "RECURRENCE-ID",
        "DTSTART",
        "DTEND",
        "UID",
        "DTSTAMP",
        "RRULE",
      ])
        expect(propsOf(ev, name).length).toBeLessThanOrEqual(1);
      expect(propsOf(ev, "ATTENDEE")).toHaveLength(2);
    },
  );

  itReq(
    ["RFC5545:3.8.1.11:status-vevent-values", "RFC5545:3.8.2.7:transp-default-opaque"],
    "writes STATUS and TRANSP only with VEVENT values (none by default: OPAQUE, no status)",
    () => {
      const ev = event(make({ alarm: "5m", organizer: "me@x.com", attendees: ["a@x.com"] }));
      for (const p of propsOf(ev, "STATUS"))
        expect(["TENTATIVE", "CONFIRMED", "CANCELLED"]).toContain(p.value);
      for (const p of propsOf(ev, "TRANSP")) expect(["OPAQUE", "TRANSPARENT"]).toContain(p.value);
      expect(propsOf(ev, "CLASS")).toEqual([]);
    },
  );
});

// ---------- TEXT ----------

describe("TEXT values", () => {
  const raw = (field: "summary" | "location" | "description", value: string): string => {
    const ev = event(make({ [field]: value }));
    return one(ev, field.toUpperCase()).value;
  };

  itReq(
    ["RFC5545:3.3.11:text-backslash-escape", "RFC5545:3.3.11:text-backslash"],
    "writes a backslash as two backslashes",
    () => {
      const written = raw("summary", "a\\b");
      expect(written).toBe("a\\\\b");
      expect(decode(written)).toBe("a\\b");
    },
  );

  itReq(
    ["RFC5545:3.3.11:text-comma-escape", "RFC5545:3.3.11:text-comma"],
    "writes a comma as backslash comma",
    () => {
      expect(raw("location", "Room 1, Bldg 2")).toBe("Room 1\\, Bldg 2");
      expect(decode(raw("location", "Room 1, Bldg 2"))).toBe("Room 1, Bldg 2");
    },
  );

  itReq(
    ["RFC5545:3.3.11:text-semicolon-escape", "RFC5545:3.3.11:text-semicolon"],
    "writes a semicolon as backslash semicolon",
    () => {
      expect(raw("summary", "a;b")).toBe("a\\;b");
      expect(decode(raw("summary", "a;b"))).toBe("a;b");
    },
  );

  itReq(
    ["RFC5545:3.3.11:text-newline-escape", "RFC5545:3.3.11:text-newline"],
    "writes a line break as backslash n on one logical line, never as a raw break",
    () => {
      for (const input of ["line1\nline2", "line1\r\nline2"]) {
        const ics = make({ description: input });
        const written = one(event(ics), "DESCRIPTION").value;
        expect(written).toBe("line1\\nline2");
        expect(written).not.toMatch(/[\r\n]/);
        expect(decode(written)).toBe("line1\nline2");
        expect(logical(ics).filter((l) => l.startsWith("DESCRIPTION"))).toHaveLength(1);
      }
      // both spellings decode to a line break
      expect(decode("a\\nb\\Nc")).toBe("a\nb\nc");
    },
  );

  itReq("RFC5545:3.3.11:text-colon-not-escaped", "does not put a backslash before a colon", () => {
    expect(raw("summary", "Meeting: planning")).toBe("Meeting: planning");
    expect(logical(make({ summary: "Meeting: planning" }))).toContain("SUMMARY:Meeting: planning");
  });

  itReq(
    ["RFC5545:3.3.11:text-backslash-escape", "RFC5545:3.3.11:text-newline-escape"],
    "decodes back to the input, also when the text contains a literal backslash n",
    () => {
      const input = "a\\nb, c; d\\\\e\nf: g";
      expect(decode(raw("description", input))).toBe(input);
    },
  );

  it("rejects control characters and everything an ICS reader may treat as a line break", () => {
    for (const c of [0x00, 0x08, 0x0b, 0x0c, 0x0d, 0x1f, 0x7f, 0x85, 0x2028, 0x2029]) {
      const bad = `a${String.fromCodePoint(c)}b`;
      for (const field of ["summary", "location", "description"] as const)
        expect(failure(build({ [field]: bad }))._tag).toBe("InvalidInput");
    }
    expect(one(event(make({ summary: "tab\there" })), "SUMMARY").value).toBe("tab\there");
  });
});

// ---------- RECUR ----------

describe("recurrence rules as written", () => {
  const kinds: readonly Recurrence[] = [
    { kind: "daily" },
    { kind: "daily", interval: 3 },
    { kind: "weekly", interval: 2, weekdays: ["wednesday", "friday"] },
    { kind: "monthly_day", day: 4 },
    { kind: "monthly_weekday", nth: 1, weekday: "wednesday" },
    { kind: "yearly" },
  ];
  const endings = [
    { kind: "never" },
    { kind: "count", count: 5 },
    { kind: "until", date: "2027-01-31" },
  ] as const;
  const calendars = [
    { name: "UTC", times: at("2026-11-04", "10:00", "11:00", "UTC"), isDate: false },
    { name: "all-day", times: day("2026-11-04"), isDate: true },
  ] as const;

  const rules = (): { value: string; isDate: boolean; ending: string; tz: string }[] =>
    calendars.flatMap((c) =>
      kinds.flatMap((recurrence) =>
        endings.map((ending) => ({
          value: one(event(make({ times: c.times, recurrence, ending })), "RRULE").value,
          isDate: c.isDate,
          ending: ending.kind,
          tz: c.name,
        })),
      ),
    );

  itReq(
    [
      "RFC5545:3.3.10:freq-required",
      "RFC5545:3.3.10:freq-first-accept-any-order",
      "RFC5545:3.3.10:rule-parts-at-most-once",
      "RFC5545:3.1.1:structured-values-semicolon",
    ],
    "starts every rule with FREQ, writes each part once and joins the parts with semicolons",
    () => {
      const all = rules();
      expect(all.length).toBe(36);
      for (const r of all) {
        const parts = r.value.split(";");
        expect(parts[0]).toMatch(/^FREQ=(?:DAILY|WEEKLY|MONTHLY|YEARLY)$/);
        for (const p of parts) expect(p).toMatch(/^[A-Z]+=[^;=]+$/);
        const keys = parts.map((p) => p.split("=")[0]);
        expect(new Set(keys).size).toBe(keys.length);
        expect(violations(r.value, r.isDate)).toEqual([]);
      }
    },
  );

  itReq("RFC5545:3.3.10:count-and-until-exclusive", "never writes COUNT together with UNTIL", () => {
    for (const r of rules()) {
      const keys = r.value.split(";").map((p) => p.split("=")[0]);
      expect(keys.includes("COUNT") && keys.includes("UNTIL")).toBe(false);
      expect(keys.includes("COUNT")).toBe(r.ending === "count");
      expect(keys.includes("UNTIL")).toBe(r.ending === "until");
    }
  });

  itReq(
    [
      "RFC5545:3.3.10:until-same-type-as-dtstart",
      "RFC5545:3.3.10:until-utc-for-utc-or-tzid-dtstart",
      "RFC5545:3.3.10:until-datetime-in-utc",
    ],
    "writes UNTIL as a DATE for an all-day event and as a UTC time for a UTC or zoned event",
    () => {
      const ending = { kind: "until", date: "2026-12-31" } as const;
      const until = (times: EventTimes, date = "2026-12-31"): string => {
        const value = one(
          event(make({ times, recurrence: { kind: "daily" }, ending: { ...ending, date } })),
          "RRULE",
        ).value;
        const found = /(?:^|;)UNTIL=([^;]+)/.exec(value)?.[1];
        if (found === undefined) throw new Error(`no UNTIL in ${value}`);
        return found;
      };
      expect(until(day("2026-11-04"))).toBe("20261231");
      expect(isRealDate(until(day("2026-11-04")))).toBe(true);
      expect(until(at("2026-11-04", "10:00", "11:00", "UTC"))).toBe("20261231T235959Z");
      // Berlin 10:00 on the last day is 09:00Z; UNTIL is at or after it, in UTC (end of the local day)
      const zoned = until(at("2026-11-04"));
      expect(zoned).toBe("20261231T225959Z");
      expect(isUtc(zoned)).toBe(true);
      expect(zoned >= "20261231T090000Z").toBe(true);
      // in summer time the end of the local day is two hours before midnight UTC
      expect(until(at("2026-06-01"), "2026-07-31")).toBe("20260731T215959Z");
    },
  );

  itReq(
    [
      "RFC5545:3.3.10:bytime-not-with-date-dtstart",
      "RFC5545:3.3.10:byday-numeric-only-monthly-yearly",
      "RFC5545:3.3.10:byday-numeric-not-yearly-byweekno",
      "RFC5545:3.3.10:bymonthday-not-weekly",
      "RFC5545:3.3.10:byyearday-not-daily-weekly-monthly",
      "RFC5545:3.3.10:byweekno-only-yearly",
      "RFC5545:3.3.10:bysetpos-needs-other-byxxx",
      "RFC5545:3.3.10:na-means-must-not-use",
    ],
    "writes no combination of rule parts that the table of RFC 5545 3.3.10 forbids",
    () => {
      for (const r of rules()) {
        const keys = r.value.split(";").map((p) => p.split("=")[0] ?? "");
        // the generator only ever writes these parts, and only in the allowed pairings
        for (const k of keys)
          expect(["FREQ", "INTERVAL", "BYDAY", "BYMONTHDAY", "COUNT", "UNTIL"]).toContain(k);
        expect(violations(r.value, r.isDate)).toEqual([]);
      }
    },
  );

  it("the checker catches every forbidden combination (it is not vacuous)", () => {
    for (const bad of [
      "FREQ=WEEKLY;BYDAY=1MO",
      "FREQ=WEEKLY;BYMONTHDAY=1",
      "FREQ=DAILY;BYYEARDAY=1",
      "FREQ=MONTHLY;BYYEARDAY=1",
      "FREQ=MONTHLY;BYWEEKNO=1",
      "FREQ=MONTHLY;BYSETPOS=1",
      "FREQ=YEARLY;BYWEEKNO=20;BYDAY=1MO",
      "FREQ=DAILY;COUNT=3;UNTIL=20240110",
      "COUNT=3;FREQ=DAILY",
      "FREQ=DAILY;FREQ=WEEKLY",
      "COUNT=3",
    ])
      expect(violations(bad)).not.toEqual([]);
    expect(violations("FREQ=DAILY;BYHOUR=9", true)).not.toEqual([]);
    for (const good of [
      "FREQ=MONTHLY;BYDAY=-1FR",
      "FREQ=MONTHLY;BYMONTHDAY=-1",
      "FREQ=YEARLY;BYYEARDAY=-1",
      "FREQ=YEARLY;BYWEEKNO=20;BYDAY=MO",
      "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1",
      "FREQ=WEEKLY;INTERVAL=2;BYDAY=WE;COUNT=3",
    ])
      expect(violations(good)).toEqual([]);
  });

  itReq("RFC5545:3.1.1:list-values-comma", "separates the values of a list with commas", () => {
    const value = one(
      event(make({ recurrence: { kind: "weekly", weekdays: ["wednesday", "friday"] } })),
      "RRULE",
    ).value;
    expect(value).toBe("FREQ=WEEKLY;BYDAY=WE,FR");
  });

  itReq(
    "RFC5545:3.6.1:rrule-should-not-repeat",
    "writes one RRULE for a series and none for a single event",
    () => {
      expect(propsOf(event(make({ recurrence: { kind: "daily" } })), "RRULE")).toHaveLength(1);
      expect(propsOf(event(make()), "RRULE")).toEqual([]);
    },
  );

  itReq(
    "RFC5545:3.8.5.3:dtstart-synchronized-with-rule",
    "refuses a DTSTART that does not match the rule instead of writing an unsynchronised series",
    () => {
      // 2026-11-04 is a Wednesday and the 4th
      expect(failure(build({ recurrence: { kind: "weekly", weekdays: ["monday"] } }))._tag).toBe(
        "InvalidInput",
      );
      expect(failure(build({ recurrence: { kind: "monthly_day", day: 5 } }))._tag).toBe("InvalidInput");
      expect(
        failure(build({ recurrence: { kind: "monthly_weekday", nth: 2, weekday: "wednesday" } }))._tag,
      ).toBe("InvalidInput");
      expect(
        failure(build({ recurrence: { kind: "monthly_weekday", nth: -1, weekday: "wednesday" } }))._tag,
      ).toBe("InvalidInput");
      expect(make({ recurrence: { kind: "weekly", weekdays: ["monday", "wednesday"] } })).toContain(
        "RRULE:FREQ=WEEKLY;BYDAY=MO,WE\r\n",
      );
    },
  );

  itReq(
    ["RFC5545:3.8.5.3:dtstart-tzid-for-recurring-datetime", "RFC5545:3.6.5:vtimezone-covers-all-instances"],
    "writes a weekly zoned series in local time with TZID and a VTIMEZONE whose DST rules repeat",
    () => {
      const ics = make({ times: at("2026-11-04"), recurrence: { kind: "weekly", weekdays: ["wednesday"] } });
      const start = one(event(ics), "DTSTART");
      expect(start.params.TZID).toBe(BERLIN);
      // 10:00 local, not the UTC time of the first instance (09:00Z in winter)
      expect(start.value).toBe("20261104T100000");
      const zone = named(parseCal(ics), "VTIMEZONE")[0];
      expect(zone).toBeDefined();
      const open = (zone as Comp).children.filter((o) => {
        const rule = propsOf(o, "RRULE")[0];
        return rule !== undefined && !rule.value.includes("UNTIL=");
      });
      // the rules of the current era have no end, so every future instance resolves
      expect(
        open.map((o) => `${o.name} ${one(o, "RRULE").value} ${one(o, "TZOFFSETTO").value}`).sort(),
      ).toEqual([
        "DAYLIGHT FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU +0200",
        "STANDARD FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU +0100",
      ]);
    },
  );
});

// ---------- VALARM ----------

describe("a generated VALARM", () => {
  const cases: readonly (readonly [string, string])[] = [
    ["15m", "-PT15M"],
    ["90m", "-PT90M"],
    ["2h", "-PT2H"],
    ["1d", "-P1D"],
  ];

  itReq(
    [
      "RFC5545:3.6.6:valarm-action-trigger-required",
      "RFC5545:3.6.6:valarm-display-description",
      "RFC5545:3.8.6.1:action-once",
      "RFC5545:3.8.6.3:trigger-default-duration-start",
      "RFC5545:3.8.6.3:relative-start-needs-dtstart",
      "RFC5545:3.8.6.3:related-invalid-with-datetime",
      "RFC5545:3.6.6:valarm-grammar-duration-repeat-pair",
    ],
    "has one ACTION:DISPLAY, a DESCRIPTION and a negative DURATION TRIGGER relative to the start",
    () => {
      for (const times of [at("2026-11-04"), day("2026-11-04")])
        for (const [alarm, trigger] of cases) {
          const ev = event(make({ times, alarm }));
          expect(propsOf(ev, "DTSTART")).toHaveLength(1);
          const [valarm, ...others] = named(ev, "VALARM");
          expect(valarm).toBeDefined();
          expect(others).toEqual([]);
          const a = valarm as Comp;
          expect(one(a, "ACTION").value).toBe("DISPLAY");
          expect(one(a, "DESCRIPTION").value).not.toBe("");
          expect(one(a, "TRIGGER").value).toBe(trigger);
          // default value type DURATION and default RELATED=START: no parameter at all
          expect(one(a, "TRIGGER").params).toEqual({});
          expect(a.props.map((p) => p.name).sort()).toEqual(["ACTION", "DESCRIPTION", "TRIGGER"]);
          expect(a.children).toEqual([]);
        }
    },
  );

  itReq(
    ["RFC5545:3.3.6:duration-no-year-month", "RFC5545:3.3.6:duration-week-form-alone"],
    "writes trigger durations in the grammar of RFC 5545 3.3.6: days or time, no years or months, no weeks mix",
    () => {
      for (const [alarm, trigger] of cases) {
        const value = one(named(event(make({ alarm })), "VALARM")[0] as Comp, "TRIGGER").value;
        expect(value).toBe(trigger);
        expect(value).toMatch(DURATION);
        expect(value).not.toMatch(/[YW]|P\d+M/);
      }
      // the checker itself
      for (const bad of ["P1M", "P1Y", "P1W2D", "P1WT1H", "PT", "P"]) expect(bad).not.toMatch(DURATION);
      for (const good of ["P15DT5H0M20S", "-PT15M", "P7W", "PT0S"]) expect(good).toMatch(DURATION);
    },
  );

  itReq(
    "RFC5545:3.6.6:valarm-only-in-vevent-vtodo-no-nesting",
    "puts alarms only inside the VEVENT and never inside another alarm",
    () => {
      const cal = parseCal(make({ alarm: "10m", recurrence: { kind: "daily" } }));
      expect(named(cal, "VALARM")).toEqual([]);
      for (const c of walk(cal).filter((x) => x.name === "VALARM")) expect(c.children).toEqual([]);
      const ev = named(cal, "VEVENT")[0] as Comp;
      expect(named(ev, "VALARM")).toHaveLength(1);
      expect(
        named(cal, "VTIMEZONE")
          .flatMap((z) => walk(z))
          .some((c) => c.name === "VALARM"),
      ).toBe(false);
    },
  );

  it("rejects what is not a reminder", () => {
    for (const alarm of ["soon", "", "-5m", "5", "1w", "99999m", "15 m", "1.5h"])
      expect(failure(build({ alarm }))._tag).toBe("InvalidInput");
  });
});

// ---------- invites ----------

describe("invitations", () => {
  const invite = (p: Partial<IcsEventParams> = {}) =>
    make({ organizer: "Me@Work.com", attendees: ["You@X.org", "him@y.org"], ...p });

  itReq(
    [
      "RFC5545:3.3.3:cal-address-mailto",
      "RFC6047:2.3:mailto-addresses",
      "RFC5545:3.8.4.1:attendee-in-group-scheduled",
    ],
    "writes ORGANIZER and ATTENDEE as mailto URIs, and an ATTENDEE only together with an ORGANIZER",
    () => {
      const ev = event(invite());
      expect(one(ev, "ORGANIZER").value).toBe("mailto:Me@Work.com");
      expect(propsOf(ev, "ATTENDEE").map((p) => p.value)).toEqual(["mailto:You@X.org", "mailto:him@y.org"]);
      for (const p of [...propsOf(ev, "ORGANIZER"), ...propsOf(ev, "ATTENDEE")])
        expect(p.value).toMatch(/^mailto:[^\s:]+$/);
      // no organizer, no attendee
      expect(failure(build({ attendees: ["a@x.org"] }))._tag).toBe("InvalidInput");
    },
  );

  itReq(
    [
      "RFC5545:3.2.12:partstat-values-match-component",
      "RFC5545:3.1.1:param-list-semicolon",
      "RFC5545:3.3.2:boolean-case-insensitive",
    ],
    "writes ROLE, PARTSTAT and RSVP of a VEVENT attendee as separate parameters with upper case values",
    () => {
      const ev = event(invite());
      for (const a of propsOf(ev, "ATTENDEE")) {
        expect(a.params).toEqual({ ROLE: "REQ-PARTICIPANT", PARTSTAT: "NEEDS-ACTION", RSVP: "TRUE" });
        expect(["NEEDS-ACTION", "ACCEPTED", "DECLINED", "TENTATIVE", "DELEGATED"]).toContain(
          a.params.PARTSTAT,
        );
        expect(a.line).toMatch(/^ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:/);
      }
    },
  );

  itReq(
    ["RFC5545:3.8.4.1:attendee-not-when-publishing", "RFC5545:3.8.4.3:organizer-not-for-single-user"],
    "writes neither ATTENDEE nor ORGANIZER for an event without invitees",
    () => {
      const ev = event(make({ alarm: "10m", recurrence: { kind: "daily" } }));
      expect(propsOf(ev, "ATTENDEE")).toEqual([]);
      expect(propsOf(ev, "ORGANIZER")).toEqual([]);
    },
  );

  itReq(
    "RFC5545:3.8.4.1:attendee-params-not-in-valarm",
    "puts no ATTENDEE, and so no attendee parameters, into the alarm",
    () => {
      const ev = event(invite({ alarm: "10m" }));
      const alarm = named(ev, "VALARM")[0] as Comp;
      expect(propsOf(alarm, "ATTENDEE")).toEqual([]);
      for (const p of alarm.props)
        for (const name of ["CN", "ROLE", "PARTSTAT", "RSVP", "CUTYPE", "MEMBER", "SENT-BY", "DIR"])
          expect(p.params[name]).toBeUndefined();
    },
  );

  it("refuses addresses that are not a URI of the form mailto:<address>", () => {
    for (const bad of [
      "a\u0085b@x.org",
      "a\u2028b@x.org",
      "a\u2029b@x.org",
      "a\rb@x.org",
      "a\u0000b@x.org",
      'a"b@x.org',
      "no-at-sign",
    ])
      expect(failure(build({ organizer: "me@x.org", attendees: [bad] }))._tag).toBe("InvalidInput");
    expect(failure(build({ organizer: "me@x.org\u0085", attendees: ["a@x.org"] }))._tag).toBe("InvalidInput");
  });
});

// ---------- the files new_event stores ----------

describe("the file new_event stores", () => {
  let sb: Sandbox;
  let settings: Settings;
  let counter = 0;

  beforeAll(async () => {
    sb = await sandbox();
    settings = await sb.settings(["work", "home", "clash"]);
  });
  afterAll(() => sb.cleanup());

  const uuid = (): string => `3b9f6a2e-0c1d-4e5f-8a7b-${String(++counter).padStart(12, "0")}`;
  const BASE = { calendar: "work", start: "2030-01-15T12:00", end: "2030-01-15T13:00", summary: "Lunch" };
  const stored = async (over: Partial<NewEventInput> = {}, id = uuid()) => {
    await runOk(newEvent(settings, { ...BASE, ...over }, id, NOW));
    const file = `${id}.ics`;
    const ics = await sb.read(`calendars/${over.calendar ?? "work"}/${file}`);
    if (ics === undefined) throw new Error(`${file} was not written`);
    return { id, file, ics };
  };
  const dirOf = async (name: string): Promise<string[]> => (await readdir(await sb.vdir(name))).sort();

  const rich: Partial<NewEventInput> = {
    summary: "Review, part 1; with: stuff",
    location: "Room 1, Bldg 2",
    description: "line1\nline2 \\ end",
    alarm: "15m",
    recurrence: { pattern: { kind: "weekly", weekdays: ["tuesday"] }, ending: { kind: "count", count: 3 } },
    attendees: ["you@x.org", "him@y.org"],
    organizer: "me@work.com",
  };

  itReq(
    [
      "RFC4791:4.1:no-method",
      "VDIR:one-item-per-file",
      "RFC5545:3.8.4.7:vevent-uid-required",
      "VDIR:uid-should-be-present",
      "RFC5546:3.1.1:version-2.0",
    ],
    "holds one VEVENT with one UID, VERSION:2.0 and PRODID, and no METHOD",
    async () => {
      for (const over of [{}, rich, { start: "2030-01-15", end: "2030-01-16" }]) {
        const { id, ics } = await stored(over);
        const cal = parseCal(ics);
        expect(propsOf(cal, "METHOD")).toEqual([]);
        expect(allProps(cal).some((p) => p.name === "METHOD")).toBe(false);
        expect(named(cal, "VEVENT")).toHaveLength(1);
        expect(one(event(ics), "UID").value).toBe(`${id}`);
        expect(propsOf(cal, "VERSION").map((p) => p.value)).toEqual(["2.0"]);
        expect(propsOf(cal, "PRODID")).toHaveLength(1);
        expect(ics.charCodeAt(0)).not.toBe(0xfeff);
      }
    },
  );

  itReq(
    "RFC4791:4.1:no-method",
    "never writes a vendor X- property or a METHOD, in any component",
    async () => {
      const { ics } = await stored(rich);
      const names = allProps(parseCal(ics)).map((p) => p.name);
      expect(names.filter((n) => n.startsWith("X-"))).toEqual([]);
      expect(names).not.toContain("METHOD");
      const components = new Set(walk(parseCal(ics)).map((c) => c.name));
      expect([...components].sort()).toEqual(
        ["DAYLIGHT", "STANDARD", "VALARM", "VCALENDAR", "VEVENT", "VTIMEZONE"].sort(),
      );
    },
  );

  itReq(
    ["RFC5545:3.1:crlf-line-break", "RFC5545:3.1:line-length-75-octets", "RFC5545:3.1:no-split-utf8"],
    "stores CRLF line ends and folded lines of at most 75 octets, unfolding to the original",
    async () => {
      const summary = `${"x".repeat(100)}😀${"é".repeat(60)}`;
      const description = "😀".repeat(40);
      const { ics } = await stored({ summary, description });
      checkFolding(ics, [`SUMMARY:${summary}`, `DESCRIPTION:${description}`]);
      expect(ics.endsWith("\r\n")).toBe(true);
    },
  );

  itReq(
    [
      "RFC5545:3.8.7.2:dtstamp-utc",
      "RFC5545:3.8.7.4:sequence-initial-zero",
      "RFC5545:3.8.7.4:sequence-created-zero",
    ],
    "stamps with the injected clock in UTC and starts at SEQUENCE 0",
    async () => {
      const { ics } = await stored();
      const ev = event(ics);
      expect(one(ev, "DTSTAMP").value).toBe("20261102T100000Z");
      expect(propsOf(ev, "SEQUENCE").every((p) => p.value === "0")).toBe(true);
      expect(propsOf(ev, "CREATED")).toEqual([]);
      expect(propsOf(ev, "LAST-MODIFIED")).toEqual([]);
    },
  );

  itReq(
    ["RFC5545:3.6.1:dtend-xor-duration", "RFC5545:3.6.1:dtend-duration-exclusive"],
    "turns a duration of the call into a DTEND and never writes a DURATION",
    async () => {
      for (const over of [
        { end: undefined, duration: "90m" },
        { start: "2030-01-15", end: undefined, duration: "2d" },
      ]) {
        const ev = event((await stored(over)).ics);
        expect(propsOf(ev, "DTEND")).toHaveLength(1);
        expect(propsOf(ev, "DURATION")).toEqual([]);
      }
    },
  );

  itReq(
    ["RFC5545:3.8.4.7:uid-globally-unique", "RFC7986:5.3:uid-no-identifying-data"],
    "gives each event its own UID: the random uuid plus a fixed tool suffix, no e-mail, host or domain",
    async () => {
      const a = await stored({ organizer: "me@work.com", attendees: ["you@x.org"] });
      const b = await stored();
      const uidA = one(event(a.ics), "UID").value;
      const uidB = one(event(b.ics), "UID").value;
      expect(uidA).not.toBe(uidB);
      expect(uidA).toBe(`${a.id}`);
      for (const uid of [uidA, uidB]) {
        expect(uid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        expect(uid).not.toContain(".");
        const host = hostname().toLowerCase();
        if (/[^0-9a-f.-]/.test(host)) expect(uid.split("@")[0]).not.toContain(host);
        expect(uid).not.toMatch(/work\.com|x\.org/);
      }
    },
  );

  itReq(
    [
      "VDIR:filename-similar-to-uid",
      "RFC4791:5.3.2:ics-suffix",
      "VDIR:ics-extension",
      "POLICY:new-event-filename-and-uid",
    ],
    "names the file after the UID with the .ics extension, inside the calendar directory",
    async () => {
      const before = await dirOf("work");
      const { id, file } = await stored();
      expect(file).toBe(`${id}.ics`);
      expect(file).toMatch(/^[A-Za-z0-9_@-][A-Za-z0-9._@-]*\.ics$/);
      expect(file).not.toMatch(/\.\.|\//);
      expect((await dirOf("work")).filter((n) => !before.includes(n))).toEqual([file]);
      expect(await dirOf("home")).toEqual([]);
    },
  );

  itReq(
    ["RFC7986:5.3:uid-opaque-length", "POLICY:new-event-filename-and-uid"],
    "refuses a UID with a path, with characters outside the plain set or of 255 octets, and writes nothing",
    async () => {
      const before = await dirOf("work");
      for (const bad of [
        "../evil",
        "a/b",
        ".hidden",
        "a b",
        "a\nb",
        "a;b",
        "a..b",
        "ä",
        "x".repeat(255),
        "x".repeat(300),
        "",
      ]) {
        const e = await runFail(newEvent(settings, { ...BASE }, bad, NOW));
        expect(e._tag).toBe("InvalidInput");
      }
      expect(await dirOf("work")).toEqual(before);
      const ok = await runOk(newEvent(settings, { ...BASE }, "x".repeat(100), NOW));
      expect(ok).toMatch(/Created event/);
    },
  );

  itReq(
    ["RFC4791:5.3.2:create-only-if-absent", "POLICY:new-event-filename-and-uid"],
    "never overwrites an existing file",
    async () => {
      const { id, file, ics } = await stored();
      const e = await runFail(newEvent(settings, { ...BASE, summary: "Other" }, id, NOW));
      expect(e._tag).toBe("IoError");
      expect(await sb.read(`calendars/work/${file}`)).toBe(ics);
    },
  );

  itReq(
    "RFC4791:4.1:uid-unique-in-collection",
    "fails and writes nothing when another file of the calendar already has the UID",
    async () => {
      const id = uuid();
      const dir = await sb.vdir("clash");
      const held = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//x//EN",
        "BEGIN:VEVENT",
        `UID:${id}`,
        "DTSTAMP:20260101T000000Z",
        "DTSTART;VALUE=DATE:20260101",
        "SUMMARY:Imported",
        "END:VEVENT",
        "END:VCALENDAR",
        "",
      ].join("\r\n");
      await writeFile(join(dir, "imported-elsewhere.ics"), held);
      const e = await runFail(newEvent(settings, { ...BASE, calendar: "clash" }, id, NOW));
      expect(e._tag).toBe("InvalidInput");
      expect(await dirOf("clash")).toEqual(["imported-elsewhere.ics"]);
      expect(await readFile(join(dir, "imported-elsewhere.ics"), "utf8")).toBe(held);
    },
  );

  itReq(
    [
      "RFC5545:3.2.19:vtimezone-per-tzid",
      "POLICY:vtimezone-generated-per-tzid",
      "RFC5545:3.2.19:tzid-required-for-local-datetime",
    ],
    "embeds one VTIMEZONE for the zone of the call and uses its TZID on DTSTART and DTEND",
    async () => {
      const { ics } = await stored({ zone: "America/New_York" });
      const cal = parseCal(ics);
      const zones = named(cal, "VTIMEZONE");
      expect(zones.map((z) => one(z, "TZID").value)).toEqual(["America/New_York"]);
      const ev = event(ics);
      expect(one(ev, "DTSTART").params.TZID).toBe("America/New_York");
      expect(one(ev, "DTEND").params.TZID).toBe("America/New_York");
    },
  );

  itReq(
    ["RFC5545:3.8.4.1:attendee-not-when-publishing", "RFC5545:3.8.4.3:organizer-not-for-single-user"],
    "writes no ORGANIZER or ATTENDEE for a call without attendees",
    async () => {
      const ev = event((await stored()).ics);
      expect(propsOf(ev, "ORGANIZER")).toEqual([]);
      expect(propsOf(ev, "ATTENDEE")).toEqual([]);
    },
  );

  itReq(
    [
      "RFC6047:2.3:mailto-addresses",
      "RFC5545:3.3.3:cal-address-mailto",
      "RFC5545:3.8.4.1:attendee-in-group-scheduled",
    ],
    "writes the organizer and the attendees of a call as mailto URIs",
    async () => {
      const ev = event((await stored({ organizer: "me@work.com", attendees: ["you@x.org"] })).ics);
      expect(one(ev, "ORGANIZER").value).toBe("mailto:me@work.com");
      expect(propsOf(ev, "ATTENDEE").map((p) => p.value)).toEqual(["mailto:you@x.org"]);
    },
  );

  itReq(
    [
      "RFC5545:3.3.11:text-comma",
      "RFC5545:3.3.11:text-semicolon",
      "RFC5545:3.3.11:text-newline",
      "RFC5545:3.3.11:text-backslash",
    ],
    "stores escaped TEXT that decodes back to what the call said",
    async () => {
      const ev = event((await stored(rich)).ics);
      expect(one(ev, "SUMMARY").value).toBe("Review\\, part 1\\; with: stuff");
      expect(decode(one(ev, "SUMMARY").value)).toBe(rich.summary);
      expect(one(ev, "LOCATION").value).toBe("Room 1\\, Bldg 2");
      expect(one(ev, "DESCRIPTION").value).toBe("line1\\nline2 \\\\ end");
      expect(decode(one(ev, "DESCRIPTION").value)).toBe(rich.description);
    },
  );

  itReq(
    ["RFC5545:3.3.10:freq-first-accept-any-order", "RFC5545:3.3.10:count-and-until-exclusive"],
    "stores a series whose rule starts with FREQ and ends with COUNT or UNTIL, not both",
    async () => {
      const counted = one(event((await stored(rich)).ics), "RRULE").value;
      expect(counted).toBe("FREQ=WEEKLY;BYDAY=TU;COUNT=3");
      const until = one(
        event(
          (
            await stored({
              ...rich,
              recurrence: { pattern: { kind: "daily" }, ending: { kind: "until", date: "2030-02-01" } },
              start: "2030-01-15T12:00",
            })
          ).ics,
        ),
        "RRULE",
      ).value;
      expect(until).toBe("FREQ=DAILY;UNTIL=20300201T225959Z");
      expect(violations(until)).toEqual([]);
    },
  );
});

// ---------- VTIMEZONE ----------

describe("a generated VTIMEZONE", () => {
  const cache = new Map<string, Comp>();
  const zoneOf = (name: string): Comp => {
    const known = cache.get(name);
    if (known !== undefined) return known;
    const { lines } = unwrap(vtimezone(name));
    const cal = parseCal(
      ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//t//EN", ...lines, "END:VCALENDAR", ""].join("\r\n"),
    );
    const zone = named(cal, "VTIMEZONE")[0];
    if (zone === undefined) throw new Error(`no VTIMEZONE for ${name}`);
    cache.set(name, zone);
    return zone;
  };
  const ZONES = [
    BERLIN,
    "America/New_York",
    "Europe/London",
    "Asia/Kolkata",
    "Australia/Lord_Howe",
    "Asia/Jerusalem",
  ];
  const observances = (zone: Comp): readonly Comp[] => zone.children;

  itReq(
    [
      "RFC5545:3.6.5:vtimezone-tzid-and-observance-required",
      "POLICY:vtimezone-generated-per-tzid",
      "RFC5545:3.6.5:observance-required-props",
      "RFC5545:3.8.2.4:observance-dtstart-no-tzid",
      "RFC5545:3.6.5:observance-dtstart-local",
    ],
    "has a TZID and observances that each carry a local DTSTART (no TZID, no Z), TZOFFSETFROM and TZOFFSETTO",
    () => {
      for (const name of ZONES) {
        const zone = zoneOf(name);
        expect(one(zone, "TZID").value).toBe(name);
        expect(zone.props.map((p) => p.name)).toEqual(["TZID"]);
        const obs = observances(zone);
        expect(obs.length).toBeGreaterThan(0);
        for (const o of obs) {
          expect(["STANDARD", "DAYLIGHT"]).toContain(o.name);
          expect(o.children).toEqual([]);
          expect(propsOf(o, "DTSTART")).toHaveLength(1);
          expect(propsOf(o, "TZOFFSETFROM")).toHaveLength(1);
          expect(propsOf(o, "TZOFFSETTO")).toHaveLength(1);
          expect(one(o, "DTSTART").params).toEqual({});
          expect(isLocal(one(o, "DTSTART").value)).toBe(true);
        }
      }
    },
  );

  itReq(
    [
      "RFC5545:3.3.14:utc-offset-plus-for-positive",
      "RFC5545:3.3.14:utc-offset-minus-for-negative",
      "RFC5545:3.3.14:utc-offset-minus-zero-invalid",
    ],
    "writes offsets with an explicit sign, minus for west, plus for east, and +0000 for zero",
    () => {
      const offsets = (name: string): string[] =>
        observances(zoneOf(name)).flatMap((o) => [one(o, "TZOFFSETFROM").value, one(o, "TZOFFSETTO").value]);
      for (const name of ZONES)
        for (const off of offsets(name)) {
          expect(off).toMatch(/^[+-]\d{4}(?:\d{2})?$/);
          expect(off).not.toMatch(/^-0+$/);
        }
      expect(new Set(offsets(BERLIN))).toEqual(new Set(["+0100", "+0200"]));
      expect(new Set(offsets("America/New_York"))).toEqual(new Set(["-0500", "-0400"]));
      expect(offsets("Asia/Kolkata")).toContain("+0530");
      expect(offsets("Europe/London")).toContain("+0000");
      expect(offsets("Australia/Lord_Howe")).toContain("+1030");
    },
  );

  itReq(
    [
      "RFC5545:3.3.10:until-utc-in-vtimezone-observance",
      "RFC5545:3.3.10:until-utc-for-utc-or-tzid-dtstart",
      "RFC5545:3.3.10:freq-first-accept-any-order",
    ],
    "ends a bounded rule with a UTC UNTIL that is not before its DTSTART, and writes the rules FREQ first",
    () => {
      const bounded = ZONES.flatMap((name) =>
        observances(zoneOf(name)).flatMap((o) =>
          propsOf(o, "RRULE").map((r) => ({ rule: r.value, start: one(o, "DTSTART").value })),
        ),
      );
      expect(bounded.length).toBeGreaterThan(5);
      let withUntil = 0;
      for (const { rule, start } of bounded) {
        expect(violations(rule)).toEqual([]);
        const until = /(?:^|;)UNTIL=([^;]+)/.exec(rule)?.[1];
        if (until === undefined) continue;
        withUntil += 1;
        expect(isUtc(until)).toBe(true);
        expect(until.slice(0, 15) >= start).toBe(true);
      }
      expect(withUntil).toBeGreaterThan(0);
    },
  );

  itReq(
    "RFC5545:3.6.5:vtimezone-covers-all-instances",
    "keeps the current rule open ended, so every year to come resolves (checked against the platform)",
    () => {
      const open = (name: string): string[] =>
        observances(zoneOf(name))
          .filter(
            (o) =>
              propsOf(o, "RRULE").every((r) => !r.value.includes("UNTIL=")) &&
              propsOf(o, "RRULE").length === 1,
          )
          .map((o) => `${o.name} ${one(o, "RRULE").value} ${one(o, "TZOFFSETTO").value}`)
          .sort();
      expect(open(BERLIN)).toEqual([
        "DAYLIGHT FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU +0200",
        "STANDARD FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU +0100",
      ]);
      expect(open("America/New_York")).toEqual([
        "DAYLIGHT FREQ=YEARLY;BYMONTH=3;BYDAY=2SU -0400",
        "STANDARD FREQ=YEARLY;BYMONTH=11;BYDAY=1SU -0500",
      ]);
      // the platform agrees with the open rule far in the future
      const offset = (iso: string): string =>
        new Intl.DateTimeFormat("en-US", { timeZone: BERLIN, timeZoneName: "shortOffset" })
          .formatToParts(new Date(iso))
          .find((p) => p.type === "timeZoneName")?.value ?? "";
      for (const year of [2030, 2060, 2099]) {
        expect(offset(`${year}-07-15T12:00:00Z`)).toBe("GMT+2");
        expect(offset(`${year}-01-15T12:00:00Z`)).toBe("GMT+1");
      }
    },
  );

  it("writes a zone without daylight saving as one STANDARD observance with equal offsets", () => {
    const obs = observances(zoneOf("Asia/Kolkata"));
    expect(obs.map((o) => o.name)).toEqual(["STANDARD"]);
    const [o] = obs;
    expect(one(o as Comp, "TZOFFSETFROM").value).toBe("+0530");
    expect(one(o as Comp, "TZOFFSETTO").value).toBe("+0530");
    expect(propsOf(o as Comp, "RRULE")).toEqual([]);
  });
});
