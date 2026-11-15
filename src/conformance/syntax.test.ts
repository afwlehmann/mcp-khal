import { describe, expect, it } from "vitest";
import { updateLines } from "../editEvent.js";
import {
  attendeeOf,
  binaryProblems,
  calendarWarnings,
  checkedLines,
  classifyFile,
  decodeIcs,
  decodeParamValue,
  encodeParamValue,
  escapeText,
  events,
  formatParam,
  mapEvents,
  mapProps,
  param,
  paramsOf,
  parseProp,
  prop,
  props,
  serialize,
  setProp,
  stripMethod,
  structureProblems,
  tzidProblems,
  unescapeText,
  unfoldLines,
  valueProblems,
} from "../ics.js";
import { failure, itReq, unwrap } from "../testlib.js";

// RFC 5545 sections 3.1 to 3.7 (syntax of content lines and parameters, calendar object), RFC 6868,
// RFC 6047 / 7986 preservation. Everything here is pure.

const NOW = new Date("2030-01-01T10:00:00Z");

const bytes = (s: string): Buffer => Buffer.from(s, "utf8");
const decoded = (b: Uint8Array | string): string[] => unwrap(decodeIcs(typeof b === "string" ? bytes(b) : b));

/** physical lines of serialized output, without the final empty one */
const physical = (out: string): string[] => out.split("\r\n").slice(0, -1);

const wrapped = (...body: string[]): string[] => [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//test//EN",
  "BEGIN:VEVENT",
  "UID:u1",
  "DTSTAMP:20300101T000000Z",
  "DTSTART:20300116T090000Z",
  "DTEND:20300116T100000Z",
  ...body,
  "END:VEVENT",
  "END:VCALENDAR",
];

describe("3.1 content lines: folding", () => {
  const long = `SUMMARY:${"x".repeat(200)}`;

  itReq(
    ["RFC5545:3.1:line-length-75-octets", "RFC5545:3.1:fold-at-75-octets"],
    "no physical line is longer than 75 octets and continuations start with one space",
    () => {
      const lines = physical(serialize([long]));
      expect(lines.length).toBeGreaterThan(2);
      expect(lines.every((l) => Buffer.byteLength(l) <= 75)).toBe(true);
      expect(lines.slice(1).every((l) => l.startsWith(" ") && !l.startsWith("  "))).toBe(true);
    },
  );

  itReq("RFC5545:3.1:fold-long-lines", "unfolding the output restores the line byte for byte", () => {
    expect(unfoldLines(serialize(["A:1", long]))).toEqual(["A:1", long]);
  });

  itReq(
    "RFC5545:3.1:fold-crlf-plus-wsp",
    "folds are read after CRLF+SPACE and CRLF+HTAB, and written as CRLF+SPACE",
    () => {
      expect(decoded("DESCRIPTION:ab\r\n cd\r\n\tef\r\n")).toEqual(["DESCRIPTION:abcdef"]);
      const out = serialize([long]);
      expect(out).toContain("\r\n ");
      expect(out).not.toContain("\t");
    },
  );

  itReq(
    "RFC5545:3.1:unfold-removes-one-wsp",
    "only one white space character is removed with the line break",
    () => {
      expect(decoded("DESCRIPTION:ab\r\n cd\r\n\tef\r\n")).toEqual(["DESCRIPTION:abcdef"]);
      expect(decoded("X:a\r\n  b\r\n")).toEqual(["X:a b"]);
    },
  );

  itReq("RFC5545:3.1:unfold-before-parse", "a property name split across a fold is recognised", () => {
    const [line] = decoded("DTSTA\r\n RT:20240101T100000Z\r\n");
    expect(parseProp(line ?? "")).toEqual({ name: "DTSTART", params: "", value: "20240101T100000Z" });
  });

  itReq(
    "RFC5545:3.1:utf8-unfold-restores-sequence",
    "a 3-byte character split across a fold decodes again (unfolding happens on bytes)",
    () => {
      const euro = Buffer.from("€", "utf8"); // E2 82 AC
      const file = Buffer.concat([
        bytes("SUMMARY:"),
        euro.subarray(0, 1),
        bytes("\r\n "),
        euro.subarray(1),
        bytes("!\r\n"),
      ]);
      expect(decoded(file)).toEqual(["SUMMARY:€!"]);
    },
  );

  itReq(
    ["RFC5545:3.1:utf8-fold-4-byte-chars", "RFC5545:3.1:no-split-utf8"],
    "folding never splits a multi-byte character and the text round-trips",
    () => {
      for (const ch of ["😀", "é", "€"]) {
        const line = `SUMMARY:${ch.repeat(30)}`;
        const out = serialize([line]);
        const lines = physical(out);
        expect(lines.every((l) => Buffer.byteLength(l) <= 75)).toBe(true);
        // no character was cut: reading the bytes back gives the same text
        expect(decoded(bytes(out))).toEqual([line]);
      }
    },
  );

  itReq("RFC5545:3.1:no-split-utf8", "a file split in the middle of a character is restored", () => {
    const e = Buffer.from("é", "utf8"); // C3 A9
    const file = Buffer.concat([
      bytes("SUMMARY:a"),
      e.subarray(0, 1),
      bytes("\r\n "),
      e.subarray(1),
      bytes("b\r\n"),
    ]);
    expect(decoded(file)).toEqual(["SUMMARY:aéb"]);
  });
});

describe("3.1 content lines: line breaks and names", () => {
  itReq(
    ["RFC5545:3.1:crlf-line-break", "RFC5545:3.1:crlf-line-breaks"],
    "output uses CRLF after every line, also the last, and no bare LF or CR",
    () => {
      const out = serialize(["BEGIN:VCALENDAR", `SUMMARY:${"y".repeat(100)}`, "END:VCALENDAR"]);
      expect(out.endsWith("END:VCALENDAR\r\n")).toBe(true);
      expect(out.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    },
  );

  itReq("RFC5545:3.1:parse-bare-lf-lenient", "tolerates bare LF line endings", () => {
    expect(decoded("A:1\nB:2\n")).toEqual(decoded("A:1\r\nB:2\r\n"));
  });

  it("tolerates a lone CR as line ending", () => {
    expect(decoded("A:1\rB:2\r")).toEqual(["A:1", "B:2"]);
  });

  it("tolerates a UTF-8 byte order mark", () => {
    expect(decoded(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes("BEGIN:VCALENDAR\r\n")]))).toEqual([
      "BEGIN:VCALENDAR",
    ]);
  });

  it("tolerates a tab as fold character", () => {
    expect(decoded("A:1\r\n\t2\r\n")).toEqual(["A:12"]);
  });

  it("reports bytes that are not UTF-8 instead of replacing them", () => {
    expect(failure(decodeIcs(Buffer.from([0x41, 0x3a, 0xff, 0x0d, 0x0a]))).message).toMatch(
      /not valid UTF-8/,
    );
  });

  itReq("RFC5545:3.1:names-case-insensitive", "names, parameters and enumerated values ignore case", () => {
    const lower = parseProp("dtstart;tzid=Europe/Berlin:20240101T100000");
    const upper = parseProp("DTSTART;TZID=Europe/Berlin:20240101T100000");
    expect(lower.name).toBe(upper.name);
    expect(param(lower, "TZID")).toBe(param(upper, "TZID"));
    expect(param(lower, "tzid")).toBe("Europe/Berlin");
    expect(attendeeOf(parseProp("ATTENDEE;PARTSTAT=accepted:mailto:a@x.co")).partstat).toBe("ACCEPTED");
  });
});

describe("3.1.1 and 3.2 parameters", () => {
  itReq(
    "RFC5545:3.1.1:param-list-semicolon",
    "parameters are separated by semicolons, read and written",
    () => {
      const p = parseProp("ATTENDEE;ROLE=CHAIR;PARTSTAT=ACCEPTED:mailto:a@x");
      expect(paramsOf(p.params).map((x) => [x.name, x.values])).toEqual([
        ["ROLE", ["CHAIR"]],
        ["PARTSTAT", ["ACCEPTED"]],
      ]);
      const written = ["ROLE", "PARTSTAT"].map((n, i) =>
        unwrap(formatParam(n, ["CHAIR", "ACCEPTED"][i] ?? "")),
      );
      expect(`ATTENDEE${written.join("")}:mailto:a@x`).toBe(
        "ATTENDEE;ROLE=CHAIR;PARTSTAT=ACCEPTED:mailto:a@x",
      );
    },
  );

  itReq(
    "RFC5545:3.1.1:param-special-chars-quoted",
    "a value with colon, semicolon or comma is quoted; the value starts at the first unquoted colon",
    () => {
      expect(unwrap(formatParam("CN", "Doe, John"))).toBe(';CN="Doe, John"');
      const p = parseProp('ATTENDEE;CN="a:b;c,d":mailto:x');
      expect(param(p, "CN")).toBe("a:b;c,d");
      expect(p.value).toBe("mailto:x");
    },
  );

  itReq(
    ["RFC5545:3.2:param-value-quoted-string", "RFC5545:3.2:param-values-quoted-when-separators"],
    "a value with separators is generated as quoted-string, others stay plain, never with a backslash",
    () => {
      expect(unwrap(formatParam("CN", "Smith; Jr"))).toBe(';CN="Smith; Jr"');
      expect(unwrap(formatParam("CN", "Smith, Jane"))).toBe(';CN="Smith, Jane"');
      expect(unwrap(formatParam("CN", "Alice"))).toBe(";CN=Alice");
    },
  );

  itReq(
    ["RFC5545:3.2:param-value-no-dquote", "RFC5545:3.2:param-values-no-dquote"],
    "a double quote in a value is never written raw (RFC 6868 ^')",
    () => {
      const written = unwrap(formatParam("CN", 'Al "Bob"'));
      expect(written).toBe(";CN=Al ^'Bob^'");
      expect(written.slice(";CN=".length)).not.toContain('"');
      expect(unwrap(formatParam("CN", 'a,"b"'))).toBe(`;CN="a,^'b^'"`);
    },
  );

  it("refuses parameter names and values that cannot be written", () => {
    expect(failure(formatParam("CN", `a${String.fromCharCode(0x2029)}b`)).message).toMatch(
      /control characters/,
    );
    expect(unwrap(formatParam("CN", "a\tb"))).toBe(";CN=a\tb");
    expect(failure(formatParam("C N", "x")).message).toMatch(/not a parameter name/);
    expect(failure(formatParam("CN", "a\u0000b")).message).toMatch(/control characters/);
    expect(failure(formatParam("CN", "a b")).message).toMatch(/control characters/);
  });

  itReq(
    ["RFC5545:3.2:ignore-unknown-x-iana-param", "RFC5545:3.2:ignore-unknown-params"],
    "unknown parameters are ignored when reading and kept when the event is edited",
    () => {
      const dtstart = parseProp("DTSTART;X-FOO=1:20240101T100000Z");
      expect([dtstart.name, dtstart.value, param(dtstart, "X-FOO")]).toEqual([
        "DTSTART",
        "20240101T100000Z",
        "1",
      ]);
      const attendee = "ATTENDEE;X-NUM-GUESTS=2;PARTSTAT=ACCEPTED:mailto:me@x.co";
      const [event] = events(wrapped(attendee, "SUMMARY:Old"));
      const edited = setProp(event ?? [], "SUMMARY", "SUMMARY:New");
      expect(edited).toContain(attendee);
      expect(attendeeOf(parseProp(attendee)).partstat).toBe("ACCEPTED");
    },
  );

  itReq(
    "RFC5545:3.2.1:altrep-quoted-uri",
    "ALTREP is read unquoted and always written in a quoted-string",
    () => {
      const p = parseProp('DESCRIPTION;ALTREP="cid:p@x":text');
      expect(param(p, "ALTREP")).toBe("cid:p@x");
      expect(p.value).toBe("text");
      expect(unwrap(formatParam("ALTREP", "cid:p@x"))).toBe(';ALTREP="cid:p@x"');
    },
  );

  itReq(
    "RFC5545:3.2.4:delegated-addresses-quoted",
    "DELEGATED-TO reads as a list and the line is kept as written",
    () => {
      const line = 'ATTENDEE;DELEGATED-TO="mailto:a@x","mailto:b@x":mailto:me@x';
      expect(paramsOf(parseProp(line).params)[0]?.values).toEqual(["mailto:a@x", "mailto:b@x"]);
      const [event] = events(wrapped(line));
      expect(setProp(event ?? [], "SUMMARY", "SUMMARY:x")).toContain(line);
    },
  );

  itReq(
    "RFC5545:3.3.13:uri-param-quoted",
    "URI-valued parameters (SENT-BY, DIR, DELEGATED-TO, DELEGATED-FROM, MEMBER, ALTREP) are quoted",
    () => {
      const uris: [string, string][] = [
        ["SENT-BY", "mailto:s@x"],
        ["DIR", "ldap://example.com/o=x"],
        ["DELEGATED-TO", "mailto:a@x"],
        ["DELEGATED-FROM", "mailto:a@x"],
        ["MEMBER", "mailto:list@x"],
        ["ALTREP", "cid:p@x"],
      ];
      for (const [name, uri] of uris) expect(unwrap(formatParam(name, uri))).toBe(`;${name}="${uri}"`);
    },
  );

  itReq("RFC5545:3.2.18:sent-by-quoted-mailto", "SENT-BY survives an edit of SUMMARY unchanged", () => {
    const org = 'ORGANIZER;SENT-BY="mailto:s@x":mailto:o@x';
    const [event] = events(wrapped(org, "SUMMARY:a"));
    const edited = setProp(event ?? [], "SUMMARY", "SUMMARY:b");
    expect(edited).toContain(org);
    expect(param(parseProp(org), "SENT-BY")).toBe("mailto:s@x");
  });

  itReq(
    [
      "RFC5545:3.2.3:cutype-default-individual",
      "RFC5545:3.2.16:role-default-req-participant",
      "RFC5545:3.2.17:rsvp-default-false",
    ],
    "missing CUTYPE, ROLE and RSVP read as INDIVIDUAL, REQ-PARTICIPANT and FALSE",
    () => {
      const a = attendeeOf(parseProp("ATTENDEE:mailto:a@x.co"));
      expect([a.cutype, a.role, a.rsvp]).toEqual(["INDIVIDUAL", "REQ-PARTICIPANT", false]);
      const b = attendeeOf(parseProp("ATTENDEE;CUTYPE=X-ALIEN;ROLE=X-BOSS;RSVP=true:mailto:b@x.co"));
      expect([b.cutype, b.role, b.rsvp]).toEqual(["UNKNOWN", "REQ-PARTICIPANT", true]);
      const c = attendeeOf(parseProp("ATTENDEE;CUTYPE=room;ROLE=chair;RSVP=FALSE:mailto:c@x.co"));
      expect([c.cutype, c.role, c.rsvp]).toEqual(["ROOM", "CHAIR", false]);
    },
  );

  itReq(
    "RFC5545:3.2.12:partstat-default-needs-action",
    "an ATTENDEE without PARTSTAT is NEEDS-ACTION",
    () => {
      expect(attendeeOf(parseProp("ATTENDEE:mailto:a@x.co")).partstat).toBe("NEEDS-ACTION");
      expect(attendeeOf(parseProp("ATTENDEE;PARTSTAT=:mailto:a@x.co")).partstat).toBe("NEEDS-ACTION");
    },
  );

  itReq(
    ["RFC5545:3.2.12:partstat-unknown-as-needs-action", "RFC5545:3.2.12:partstat-unknown-token"],
    "an unknown PARTSTAT counts as NEEDS-ACTION and its text is kept",
    () => {
      const line = "ATTENDEE;PARTSTAT=X-FOO:mailto:a@x.co";
      expect(attendeeOf(parseProp(line)).partstat).toBe("NEEDS-ACTION");
      const [event] = events(wrapped(line));
      expect(setProp(event ?? [], "SUMMARY", "SUMMARY:x")).toContain(line);
      // a VTODO-only value is not a VEVENT value either
      expect(attendeeOf(parseProp("ATTENDEE;PARTSTAT=COMPLETED:mailto:a@x.co")).partstat).toBe(
        "NEEDS-ACTION",
      );
    },
  );

  itReq(
    "RFC5545:3.2.7:encoding-default-8bit",
    "a value without ENCODING is plain text, never decoded",
    () => {
      const line = "ATTACH:aGk=";
      expect(parseProp(line).value).toBe("aGk=");
      expect(binaryProblems([line])).toEqual([]);
    },
  );

  itReq(
    ["RFC5545:3.2.7:binary-requires-base64-encoding", "RFC5545:3.3.1:binary-encoding-base64"],
    "VALUE=BINARY without ENCODING=BASE64 is reported",
    () => {
      expect(binaryProblems(["ATTACH;VALUE=BINARY;ENCODING=BASE64:aGk="])).toEqual([]);
      expect(binaryProblems(["ATTACH;VALUE=BINARY:aGk="])).toEqual([
        "ATTACH has VALUE=BINARY without ENCODING=BASE64 (RFC 5545 3.2.7)",
      ]);
      expect(calendarWarnings(wrapped("ATTACH;VALUE=BINARY:aGk="))).toContain(
        "ATTACH has VALUE=BINARY without ENCODING=BASE64 (RFC 5545 3.2.7)",
      );
    },
  );

  itReq(
    "RFC5545:3.2.19:tzid-not-on-date-or-utc",
    "TZID on a DATE or on a UTC value makes the file unusable",
    () => {
      expect(tzidProblems(["DTSTART;VALUE=DATE;TZID=Europe/Berlin:20240101"])).toHaveLength(1);
      expect(tzidProblems(["DTSTART;TZID=Europe/Berlin:20240101T100000Z"])).toHaveLength(1);
      expect(tzidProblems(["DTSTART;TZID=Europe/Berlin:20240101T100000"])).toEqual([]);
      const cls = classifyFile(
        wrapped("X-A:1").map((l) =>
          l.startsWith("DTSTART") ? "DTSTART;TZID=Europe/Berlin:20300116T090000Z" : l,
        ),
      );
      expect(cls).toMatchObject({
        kind: "unusable",
        reason: expect.stringContaining("TZID parameter on a DATE or UTC"),
      });
    },
  );

  itReq("RFC5545:3.2.20:value-single-type", "all values of a property have one type", () => {
    expect(valueProblems(["RDATE;VALUE=DATE:20240101,20240102"])).toEqual([]);
    expect(valueProblems(["RDATE:20240101,20240102T100000"])[0]).toMatch(/mixes value types/);
  });

  itReq(
    ["RFC5545:3.2.20:value-param-required-when-overridden", "RFC5545:3.8.2.4:dtstart-default-datetime"],
    "a DATE needs VALUE=DATE, the default type is DATE-TIME",
    () => {
      expect(valueProblems(["DTSTART;VALUE=DATE:20240105"])).toEqual([]);
      expect(valueProblems(["DTSTART:20240105T100000Z"])).toEqual([]);
      expect(valueProblems(["DTSTART:20240105"])[0]).toMatch(/no VALUE=DATE/);
      expect(valueProblems(["DTSTART;VALUE=DATE:20240105T100000Z"])[0]).toMatch(
        /VALUE=DATE but holds a DATE-TIME/,
      );
      expect(valueProblems(["RDATE;VALUE=PERIOD:19970101T180000Z/PT5H"])).toEqual([]);
    },
  );
});

describe("RFC 6868 parameter encoding", () => {
  itReq("RFC6868:3:caret-escape-scope", "^n decodes in quoted and unquoted parameter values", () => {
    expect(param(parseProp('ATTENDEE;CN="Smith^n, J":mailto:x'), "CN")).toBe("Smith\n, J");
    expect(param(parseProp("ATTENDEE;CN=Smith^nJ:mailto:x"), "CN")).toBe("Smith\nJ");
  });

  itReq("RFC6868:3:encode-line-break", "a line feed in a value is written ^n, never raw", () => {
    const written = unwrap(formatParam("CN", "a\nb"));
    expect(written).toBe(";CN=a^nb");
    expect(unwrap(formatParam("CN", "a\r\nb"))).toBe(";CN=a^nb");
    expect(written).not.toMatch(/[\r\n]/);
  });

  itReq("RFC6868:3:encode-caret", "a caret is written ^^", () => {
    expect(unwrap(formatParam("CN", "a^b"))).toBe(";CN=a^^b");
    expect(encodeParamValue("^")).toBe("^^");
  });

  itReq("RFC6868:3:encode-dquote", "a double quote is written ^' (the RFC's example)", () => {
    expect(unwrap(formatParam("CN", 'George Herman "Babe" Ruth'))).toBe(";CN=George Herman ^'Babe^' Ruth");
  });

  itReq("RFC6868:3:decode-line-break", "^n decodes to a line break", () => {
    expect(decodeParamValue("Pittsburgh Pirates^n115 Federal St")).toBe("Pittsburgh Pirates\n115 Federal St");
  });

  itReq("RFC6868:3:decode-caret", "^^ decodes to a caret", () => {
    expect(decodeParamValue("a^^b")).toBe("a^b");
    expect(decodeParamValue("a^^nb")).toBe("a^nb");
  });

  itReq("RFC6868:3:decode-dquote", "^' decodes to a double quote", () => {
    expect(param(parseProp("ATTENDEE;CN=George Herman ^'Babe^' Ruth:mailto:x"), "CN")).toBe(
      'George Herman "Babe" Ruth',
    );
  });

  itReq(
    "RFC6868:3:unknown-sequence-kept",
    "an unknown ^x stays, and the line is not re-encoded when its value was not edited",
    () => {
      const line = "ATTENDEE;CN=a^xb:mailto:x@y.co";
      expect(param(parseProp(line), "CN")).toBe("a^xb");
      const [event] = events(wrapped(line, "SUMMARY:s"));
      const edited = setProp(event ?? [], "SUMMARY", "SUMMARY:t");
      expect(edited).toContain(line);
      expect(serialize(edited)).toContain(`${line}\r\n`);
      expect(edited.join("")).not.toContain("a^^xb");
    },
  );

  itReq(
    "RFC6868:1:not-backslash-escaping",
    "a parameter value is quoted, never backslash-escaped, while TEXT keeps backslashes",
    () => {
      expect(unwrap(formatParam("CN", "a,b"))).toBe(';CN="a,b"');
      expect(unwrap(formatParam("CN", "a,b"))).not.toContain("\\");
      expect(escapeText("a,b")).toBe("a\\,b");
    },
  );
});

describe("3.3.11 TEXT escaping", () => {
  const SUMMARY_SOURCE = wrapped("SUMMARY:old");

  /** the SUMMARY line the update tool writes for this text */
  const written = (summary: string): string => {
    const out = unwrap(updateLines(SUMMARY_SOURCE, { calendar: "work", uid: "u1", summary }, NOW));
    const [event] = events(out);
    return `SUMMARY:${prop(event ?? [], "SUMMARY")?.value}`;
  };

  itReq(
    ["RFC5545:3.3.11:text-newline-escape", "RFC5545:3.3.11:text-newline"],
    "a line break is written \\n and both \\n and \\N read as a line feed",
    () => {
      expect(escapeText("line1\nline2")).toBe("line1\\nline2");
      expect(escapeText("line1\r\nline2")).toBe("line1\\nline2");
      expect(unescapeText("line1\\nline2")).toBe("line1\nline2");
      expect(unescapeText("line1\\Nline2")).toBe("line1\nline2");
      expect(written("a\r\nb")).toBe("SUMMARY:a\\nb");
    },
  );

  itReq(
    ["RFC5545:3.3.11:text-backslash-escape", "RFC5545:3.3.11:text-backslash"],
    "a backslash is written doubled and read as one",
    () => {
      expect(escapeText("a\\b")).toBe("a\\\\b");
      expect(unescapeText("a\\\\b")).toBe("a\\b");
      expect(written("a\\b")).toBe("SUMMARY:a\\\\b");
      expect(unescapeText(escapeText("a\\nb"))).toBe("a\\nb");
    },
  );

  itReq(
    ["RFC5545:3.3.11:text-comma-escape", "RFC5545:3.3.11:text-comma"],
    "a comma is written \\, and read back unchanged",
    () => {
      expect(written("Room 1, Bldg 2")).toBe("SUMMARY:Room 1\\, Bldg 2");
      expect(unescapeText(escapeText("Room 1, Bldg 2"))).toBe("Room 1, Bldg 2");
    },
  );

  itReq(
    ["RFC5545:3.3.11:text-semicolon-escape", "RFC5545:3.3.11:text-semicolon"],
    "a semicolon is written \\; and read back unchanged",
    () => {
      expect(written("a;b")).toBe("SUMMARY:a\\;b");
      expect(unescapeText(escapeText("a;b"))).toBe("a;b");
    },
  );

  itReq(
    "RFC5545:3.3.11:text-colon-not-escaped",
    "a colon is not escaped; an escaped one is read as a colon",
    () => {
      expect(written("Meeting: planning")).toBe("SUMMARY:Meeting: planning");
      expect(escapeText("a:b")).toBe("a:b");
      expect(unescapeText("a\\:b")).toBe("a:b");
    },
  );
});

describe("3.4 to 3.7 calendar object", () => {
  itReq(
    "RFC5545:3.4:object-begin-end-delimiters",
    "generated files start with BEGIN:VCALENDAR and end with END:VCALENDAR; a missing END is an error",
    () => {
      const out = serialize(
        unwrap(updateLines(wrapped("SUMMARY:s"), { calendar: "work", uid: "u1", summary: "t" }, NOW)),
      );
      expect(out.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
      expect(out.endsWith("\r\nEND:VCALENDAR\r\n")).toBe(true);
      const truncated = wrapped("SUMMARY:s").slice(0, -1);
      expect(structureProblems(truncated)[0]).toMatch(/BEGIN:VCALENDAR .* has no matching END:VCALENDAR/);
      expect(classifyFile(truncated)).toMatchObject({
        kind: "unusable",
        reason: expect.stringContaining("malformed"),
      });
    },
  );

  itReq(
    "RFC5545:3.4:stream-multiple-objects",
    "two sequential VCALENDAR objects yield all their events",
    () => {
      const stream = [
        ...wrapped("SUMMARY:one"),
        ...wrapped("SUMMARY:two").map((l) => (l === "UID:u1" ? "UID:u2" : l)),
      ];
      expect(structureProblems(stream)).toEqual([]);
      expect(events(stream).map((e) => prop(e, "SUMMARY")?.value)).toEqual(["one", "two"]);
    },
  );

  itReq("RFC5545:3.5:no-property-ordering", "property order does not matter and edits keep it", () => {
    const canonical = [
      "BEGIN:VEVENT",
      "UID:u",
      "DTSTART:20300116T090000Z",
      "DTEND:20300116T100000Z",
      "SUMMARY:a",
      "END:VEVENT",
    ];
    const shuffled = [
      "BEGIN:VEVENT",
      "SUMMARY:a",
      "DTEND:20300116T100000Z",
      "UID:u",
      "DTSTART:20300116T090000Z",
      "END:VEVENT",
    ];
    for (const n of ["UID", "DTSTART", "DTEND", "SUMMARY"])
      expect(prop(shuffled, n)?.value).toBe(prop(canonical, n)?.value);
    expect(setProp(shuffled, "SUMMARY", "SUMMARY:b")).toEqual([
      "BEGIN:VEVENT",
      "SUMMARY:b",
      "DTEND:20300116T100000Z",
      "UID:u",
      "DTSTART:20300116T090000Z",
      "END:VEVENT",
    ]);
  });

  itReq("RFC5545:3.6:prodid-version-required", "a VCALENDAR without VERSION or PRODID is reported", () => {
    expect(calendarWarnings(wrapped())).toEqual([]);
    const without = wrapped().filter((l) => !/^(VERSION|PRODID)/.test(l));
    expect(calendarWarnings(without)).toEqual([
      "VERSION is missing (RFC 5545 3.6)",
      "PRODID is missing (RFC 5545 3.6)",
    ]);
    expect(calendarWarnings(wrapped().filter((l) => l !== "VERSION:2.0"))).toEqual([
      "VERSION is missing (RFC 5545 3.6)",
    ]);
    expect(calendarWarnings(wrapped().map((l) => (l === "VERSION:2.0" ? "VERSION:1.0" : l)))).toEqual([
      "VERSION is '1.0', not 2.0",
    ]);
    expect(calendarWarnings(["BEGIN:VEVENT", "UID:u", "END:VEVENT"])).toEqual([
      "no VCALENDAR object around the components (RFC 5545 3.4)",
    ]);
  });

  itReq(
    ["RFC5545:3.7.3:prodid-once", "RFC5545:3.7.4:version-once"],
    "two PRODID or two VERSION lines are reported",
    () => {
      const twice = wrapped().flatMap((l) =>
        l.startsWith("PRODID") || l.startsWith("VERSION") ? [l, l] : [l],
      );
      expect(calendarWarnings(twice)).toEqual([
        "VERSION appears 2 times (RFC 5545 3.7 allows one)",
        "PRODID appears 2 times (RFC 5545 3.7 allows one)",
      ]);
    },
  );

  itReq(
    "RFC5545:3.7.1:calscale-default-gregorian",
    "no CALSCALE is Gregorian, another one is reported",
    () => {
      expect(calendarWarnings(wrapped())).toEqual([]);
      const withScale = (v: string): string[] =>
        wrapped().flatMap((l) => (l === "VERSION:2.0" ? [l, `CALSCALE:${v}`] : [l]));
      expect(calendarWarnings(withScale("gregorian"))).toEqual([]);
      expect(calendarWarnings(withScale("HEBREW"))[0]).toMatch(/CALSCALE 'HEBREW' is not GREGORIAN/);
    },
  );

  itReq(
    "RFC5545:3.7.2:method-absent-no-scheduling",
    "a file without METHOD is a plain calendar snapshot",
    () => {
      expect(classifyFile(wrapped())).toEqual({ kind: "event", uid: "u1" });
      expect(stripMethod(wrapped())).toEqual(wrapped());
    },
  );

  itReq("RFC5545:3.6:at-least-one-component", "a VCALENDAR with only VERSION and PRODID is unusable", () => {
    expect(
      classifyFile(["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//t//EN", "END:VCALENDAR"]),
    ).toMatchObject({
      kind: "unusable",
      reason: "no event with a UID",
    });
  });

  itReq(
    "RFC5545:3.6:ignore-unknown-components",
    "an unknown X- component next to the VEVENT is ignored",
    () => {
      const file = [
        "BEGIN:VCALENDAR",
        "BEGIN:X-FOO",
        "X-A:1",
        "END:X-FOO",
        "BEGIN:VEVENT",
        "UID:u1",
        "END:VEVENT",
        "END:VCALENDAR",
      ];
      expect(classifyFile(file)).toEqual({ kind: "event", uid: "u1" });
    },
  );

  itReq(
    ["RFC5545:3.6:do-not-silently-drop-components", "RFC5545:3.6:no-silent-drop"],
    "editing one VEVENT keeps a VTODO, a VJOURNAL, an X- component, a VTIMEZONE and the alarms",
    () => {
      const file = [
        "BEGIN:VCALENDAR",
        "BEGIN:VTIMEZONE",
        "TZID:Europe/Berlin",
        "END:VTIMEZONE",
        "BEGIN:VTODO",
        "UID:t",
        "END:VTODO",
        "BEGIN:VJOURNAL",
        "UID:j",
        "END:VJOURNAL",
        "BEGIN:X-COMP",
        "X-P:1",
        "END:X-COMP",
        "BEGIN:VEVENT",
        "UID:u1",
        "SUMMARY:a",
        "BEGIN:VALARM",
        "TRIGGER:-PT5M",
        "END:VALARM",
        "BEGIN:VALARM",
        "TRIGGER:-PT1H",
        "END:VALARM",
        "END:VEVENT",
        "END:VCALENDAR",
      ];
      const out = mapEvents(file, (e) => setProp(e, "SUMMARY", "SUMMARY:b"));
      expect(out.filter((l) => !l.startsWith("SUMMARY"))).toEqual(
        file.filter((l) => !l.startsWith("SUMMARY")),
      );
      expect(out).toContain("SUMMARY:b");
    },
  );

  itReq(
    "RFC5545:3.8.4.7:vevent-uid-required",
    "a VEVENT without UID, or with two UID properties, is unusable",
    () => {
      expect(classifyFile(["BEGIN:VEVENT", "SUMMARY:x", "END:VEVENT"])).toMatchObject({ kind: "unusable" });
      expect(classifyFile(["BEGIN:VEVENT", "UID:a", "UID:a", "END:VEVENT"])).toMatchObject({
        kind: "unusable",
        reason: "a VEVENT has several UID properties, skipped",
      });
      expect(classifyFile(["BEGIN:VEVENT", "UID:a", "END:VEVENT"])).toEqual({ kind: "event", uid: "a" });
    },
  );
});

describe("preservation of what we do not understand", () => {
  const rich = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//test//EN",
    "NAME;LANGUAGE=en:Work",
    "NAME;LANGUAGE=de:Arbeit",
    "X-WR-CALNAME:Work",
    "BEGIN:VEVENT",
    "UID:u1",
    "DTSTAMP:20300101T000000Z",
    "DTSTART:20300116T090000Z",
    "SUMMARY:old",
    "X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC",
    "CONFERENCE;VALUE=URI;FEATURE=AUDIO,VIDEO;LABEL=Join:https://chat.example/x",
    "CONFERENCE;VALUE=URI:https://meet.example/y",
    "ATTENDEE;CN=a^xb:mailto:x@y.co",
    `IMAGE;VALUE=BINARY;ENCODING=BASE64;FMTTYPE=image/png:${"QUJD".repeat(60)}`,
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    "TRIGGER:-PT10M",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  const edited = mapEvents(rich, (e) => setProp(e, "SUMMARY", "SUMMARY:new"));

  itReq(
    "POLICY:preserve-unknown-and-raw",
    "every line that was not changed is identical after unfold and refold",
    () => {
      expect(edited.filter((l) => !l.startsWith("SUMMARY"))).toEqual(
        rich.filter((l) => !l.startsWith("SUMMARY")),
      );
      expect(unfoldLines(serialize(edited))).toEqual(edited);
    },
  );

  itReq(
    ["RFC7986:5.1:name-vcalendar-level", "RFC7986:5.1:name-one-per-language"],
    "VCALENDAR-level NAME (per language) and X-WR-CALNAME survive an event edit and are no event data",
    () => {
      expect(edited.filter((l) => l.startsWith("NAME;"))).toEqual([
        "NAME;LANGUAGE=en:Work",
        "NAME;LANGUAGE=de:Arbeit",
      ]);
      expect(edited).toContain("X-WR-CALNAME:Work");
      expect(events(edited).flatMap((e) => props(e, "NAME"))).toEqual([]);
    },
  );

  itReq("RFC7986:5.10:image-media-type", "an inline IMAGE survives a rewrite byte for byte, refolded", () => {
    const image = rich.find((l) => l.startsWith("IMAGE")) ?? "";
    const back = unfoldLines(serialize(edited));
    expect(back).toContain(image);
    expect(physical(serialize(edited)).every((l) => Buffer.byteLength(l) <= 75)).toBe(true);
  });

  itReq(
    ["RFC7986:5.11:conference-vevent-todo-only", "RFC7986:5.11:conference-value-uri-required"],
    "two CONFERENCE lines are kept in order with all their parameters",
    () => {
      const [event] = events(edited);
      expect(props(event ?? [], "CONFERENCE").map((p) => p.params)).toEqual([
        ";VALUE=URI;FEATURE=AUDIO,VIDEO;LABEL=Join",
        ";VALUE=URI",
      ]);
      expect(edited).toContain("CONFERENCE;VALUE=URI;FEATURE=AUDIO,VIDEO;LABEL=Join:https://chat.example/x");
    },
  );

  it("changes a parameter only when its value is edited", () => {
    const [event] = events(rich);
    const changed = mapProps(event ?? [], "ATTENDEE", (p, line) =>
      p.value === "mailto:x@y.co" ? line : "x",
    );
    expect(changed).toEqual(event);
  });

  it("checkedLines refuses what mapEvents would have to guess", () => {
    expect(unwrap(checkedLines(rich))).toBe(rich);
    expect(failure(checkedLines(["BEGIN:VEVENT", "UID:a"])).message).toMatch(/malformed/);
  });
});
