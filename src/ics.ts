import { Result } from "effect";
import { InvalidInput } from "./errors.js";

// Pure helpers to read and edit an existing .ics file line by line (RFC 5545). Only what the tools
// that change events need: VEVENT components and their own (not VALARM) properties. Lines that are
// not changed are passed through byte for byte (unknown properties, parameters, components and
// VTIMEZONEs survive an edit untouched).

const invalid = (message: string): InvalidInput => new InvalidInput({ message });

// ---------- bytes and lines ----------

/** The three bytes of a UTF-8 byte order mark, as the latin1 characters they decode to. */
const BOM_LATIN1 = new RegExp(`^${String.fromCharCode(0xef, 0xbb, 0xbf)}`);

/** One content line break: CRLF (RFC 5545 3.1); a lone LF or lone CR is tolerated when reading. */
const LINE_BREAK = /\r\n|\n|\r/;

/**
 * Content lines of a file, from its bytes. Unfolding (RFC 5545 3.1: remove the line break and the one
 * white space character after it) happens on the bytes before UTF-8 decoding, so a multi-octet
 * character that a naive producer split across a fold is restored. Blank lines are dropped.
 *
 * Tolerated on reading (the writer never produces them): a UTF-8 byte order mark, LF or lone CR as
 * line break, a tab as fold character. Bytes that are not valid UTF-8 are an error, never replaced.
 */
export const decodeIcs = (bytes: Uint8Array): Result.Result<string[], InvalidInput> => {
  const unfolded = Buffer.from(
    Buffer.from(bytes)
      .toString("latin1") // one char per byte, so the regexes below work on bytes
      .replace(BOM_LATIN1, "") // tolerates a UTF-8 BOM (EF BB BF)
      .replace(/(?:\r\n|\n|\r)[ \t]/g, ""),
    "latin1",
  );
  const text = unfolded.toString("utf8");
  return Buffer.from(text, "utf8").equals(unfolded)
    ? Result.succeed(text.split(LINE_BREAK).filter((l) => l !== ""))
    : Result.fail(invalid("the file is not valid UTF-8"));
};

/** Content lines of a text; folding undone, blank lines dropped. */
export const unfoldLines = (ics: string): string[] =>
  Result.getOrElse(decodeIcs(Buffer.from(ics, "utf8")), () => []);

/** RFC 5545 line folding: at most 75 octets per physical line, never inside a UTF-8 sequence. */
export const foldLine = (line: string): string => {
  const { done, cur } = [...line].reduce(
    (acc, ch) => {
      const n = Buffer.byteLength(ch);
      const limit = acc.done.length === 0 ? 75 : 74; // continuation lines start with one space
      return acc.bytes + n > limit
        ? { done: [...acc.done, acc.cur], cur: ch, bytes: n }
        : { done: acc.done, cur: acc.cur + ch, bytes: acc.bytes + n };
    },
    { done: [] as string[], cur: "", bytes: 0 },
  );
  return [...done, cur].join("\r\n ");
};

/** Folded lines, CRLF-terminated (also the last one). */
export const serialize = (lines: readonly string[]): string => `${lines.map(foldLine).join("\r\n")}\r\n`;

// ---------- TEXT values (RFC 5545 3.3.11) ----------

/** Escapes a TEXT value: backslash, semicolon and comma get a backslash, line breaks become `\n`; a colon stays. */
export const escapeText = (s: string): string =>
  s
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\n|\r/g, "\\n");

/**
 * Undoes `escapeText`; `\n` and `\N` are line feeds. A backslash before a colon is not standard (a
 * colon is never escaped) but some producers write it; it is read as a plain colon.
 */
export const unescapeText = (s: string): string =>
  s.replace(/\\([nN,;:\\])/g, (_m, c: string) => (c === "n" || c === "N" ? "\n" : c));

// ---------- parameters (RFC 5545 3.2, RFC 6868) ----------

/**
 * RFC 6868 decoding of a parameter value: `^n` is a line feed, `^^` a caret, `^'` a double quote;
 * any other `^x` stays as it is.
 */
export const decodeParamValue = (s: string): string =>
  s.replace(/\^([n^'])/g, (_m, c: string) => (c === "n" ? "\n" : c === "'" ? '"' : "^"));

/** RFC 6868 encoding of a parameter value: caret to `^^`, line break to `^n`, double quote to `^'`. */
export const encodeParamValue = (s: string): string =>
  s
    .replace(/\^/g, "^^")
    .replace(/\r\n|\n|\r/g, "^n")
    .replace(/"/g, "^'");

/** control characters and line/paragraph separators (tab and the line breaks RFC 6868 encodes are exempt) */
const PARAM_CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]/u;

/**
 * A parameter as it is written: `;NAME=value`. The value is RFC 6868 encoded (so it never contains a
 * double quote or a line break) and put in a quoted-string when it contains a colon, semicolon or
 * comma (RFC 5545 3.2). Never a backslash escape (RFC 6868 section 1).
 */
export const formatParam = (name: string, value: string): Result.Result<string, InvalidInput> => {
  if (!/^[A-Za-z0-9-]+$/.test(name)) return Result.fail(invalid(`'${name}' is not a parameter name`));
  if (PARAM_CONTROL.test(value.replace(/[\t\r\n]/g, "")))
    return Result.fail(invalid(`parameter ${name} contains control characters`));
  const encoded = encodeParamValue(value);
  return Result.succeed(`;${name.toUpperCase()}=${/[:;,]/.test(encoded) ? `"${encoded}"` : encoded}`);
};

export interface Param {
  /** upper case */
  readonly name: string;
  /** the comma separated values, quotes removed and RFC 6868 decoded */
  readonly values: readonly string[];
}

/** Splits at commas outside quoted-strings (linear scan). */
const splitValues = (s: string): string[] => {
  const out: string[] = [];
  let start = 0;
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') quoted = !quoted;
    else if (c === "," && !quoted) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out;
};

/** All parameters of a property (the text between name and colon), in order. */
export const paramsOf = (params: string): Param[] =>
  (params.match(/(?:[^";]|"[^"]*")+/g) ?? []).flatMap((segment): Param[] => {
    const eq = segment.indexOf("=");
    return eq <= 0
      ? []
      : [
          {
            name: segment.slice(0, eq).toUpperCase(),
            values: splitValues(segment.slice(eq + 1)).map((v) =>
              decodeParamValue(v.replace(/^"([\s\S]*)"$/, "$1")),
            ),
          },
        ];
  });

// ---------- properties ----------

export interface Prop {
  readonly name: string;
  /** everything between the name and the colon, including the leading ';', e.g. ";TZID=Europe/Berlin" */
  readonly params: string;
  readonly value: string;
}

/** Name and parameters (everything before the first colon outside double quotes). */
const HEAD = /^((?:[^":]|"[^"]*")*):/;

export const parseProp = (line: string): Prop => {
  const m = HEAD.exec(line);
  const head = m?.[1] ?? line;
  const semi = head.indexOf(";");
  return {
    name: (semi < 0 ? head : head.slice(0, semi)).toUpperCase(),
    params: semi < 0 ? "" : head.slice(semi),
    value: m === null ? "" : line.slice(head.length + 1),
  };
};

/**
 * The value of a parameter, e.g. `param(prop, "TZID")`: quotes removed, RFC 6868 decoded, several
 * values joined by a comma, the first of two parameters of the same name wins. Parameter names are
 * case-insensitive (RFC 5545 3.1); unknown parameters are simply never asked for.
 */
export const param = (p: Prop, name: string): string | undefined =>
  paramsOf(p.params)
    .find((x) => x.name === name.toUpperCase())
    ?.values.join(",");

export const formatProp = (name: string, params: string, value: string): string =>
  `${name}${params}:${value}`;

// ---------- structure ----------

/** One BEGIN/END pair: indexes of its two lines and the name of the component around it. */
interface Span {
  readonly name: string;
  readonly start: number;
  readonly end: number;
  readonly parent: string | undefined;
}

interface Open {
  readonly name: string;
  readonly start: number;
}

interface Scan {
  readonly spans: readonly Span[];
  /** one message per BEGIN without END, END without BEGIN */
  readonly problems: readonly string[];
}

const BEGIN = /^BEGIN:(.*)$/i;
const END = /^END:(.*)$/i;
const nameOf = (s: string | undefined): string => (s ?? "").trim().toUpperCase();

const unclosed = (o: Open): string =>
  `BEGIN:${o.name} (content line ${o.start + 1}) has no matching END:${o.name}`;

/** Pairs every BEGIN with its END; unbalanced lines are reported and never paired. */
const scan = (lines: readonly string[]): Scan => {
  const end = lines.reduce<{ stack: readonly Open[]; spans: readonly Span[]; problems: readonly string[] }>(
    (acc, line, i) => {
      const b = BEGIN.exec(line);
      if (b) return { ...acc, stack: [...acc.stack, { name: nameOf(b[1]), start: i }] };
      const e = END.exec(line);
      if (!e) return acc;
      const name = nameOf(e[1]);
      const at = acc.stack.map((o) => o.name).lastIndexOf(name);
      if (at < 0)
        return {
          ...acc,
          problems: [...acc.problems, `END:${name} (content line ${i + 1}) has no matching BEGIN:${name}`],
        };
      const open = acc.stack[at] as Open;
      return {
        stack: acc.stack.slice(0, at),
        spans: [...acc.spans, { name, start: open.start, end: i, parent: acc.stack[at - 1]?.name }],
        problems: [...acc.problems, ...acc.stack.slice(at + 1).map(unclosed)],
      };
    },
    { stack: [], spans: [], problems: [] },
  );
  return { spans: end.spans, problems: [...end.problems, ...end.stack.map(unclosed)] };
};

/** What is wrong with the BEGIN/END nesting of these lines; empty when it is balanced. */
export const structureProblems = (lines: readonly string[]): string[] => [...scan(lines).problems];

/** The lines when their BEGIN/END nesting is balanced, else why not. */
export const checkedLines = (lines: readonly string[]): Result.Result<readonly string[], InvalidInput> => {
  const problems = structureProblems(lines);
  return problems.length === 0
    ? Result.succeed(lines)
    : Result.fail(invalid(`the calendar is malformed: ${problems.join("; ")}`));
};

/** Depth of component nesting before each line (BEGIN +1, END -1). */
const depths = (lines: readonly string[]): number[] =>
  lines.reduce<number[]>((acc, _line, i) => {
    const before = i === 0 ? 0 : (acc[i - 1] as number) + depthChange(lines[i - 1] as string);
    acc.push(before);
    return acc;
  }, []);

const depthChange = (line: string): number => {
  const u = line.toUpperCase();
  return u.startsWith("BEGIN:") ? 1 : u.startsWith("END:") ? -1 : 0;
};

/** Indexes of the property lines directly inside a component span (not in a nested component). */
const directProps = (lines: readonly string[], d: readonly number[], span: Span): number[] =>
  lines.flatMap((l, i) =>
    i > span.start && i < span.end && d[i] === (d[span.start] as number) + 1 && depthChange(l) === 0
      ? [i]
      : [],
  );

/** Content lines with the calendar-level METHOD property removed (RFC 4791 4.1: no METHOD in stored objects). */
export const stripMethod = (lines: readonly string[]): string[] => {
  const d = depths(lines);
  const drop = new Set(
    scan(lines)
      .spans.filter((s) => s.name === "VCALENDAR")
      .flatMap((s) => directProps(lines, d, s))
      .filter((i) => parseProp(lines[i] as string).name === "METHOD"),
  );
  return lines.filter((_, i) => !drop.has(i));
};

/** The components RFC 4791 4.1 counts as "types"; VTIMEZONE does not count, unknown ones are only preserved. */
const COMPONENT_TYPES = ["VEVENT", "VTODO", "VJOURNAL", "VFREEBUSY"];

/** Every property line (not BEGIN/END) with its parsed form. */
const allProps = (lines: readonly string[]): Prop[] =>
  lines.filter((l) => depthChange(l) === 0).map(parseProp);

/** The properties whose value is a DATE, DATE-TIME (or PERIOD) and may carry TZID and VALUE. */
const TIME_PROPS = ["DTSTART", "DTEND", "DUE", "EXDATE", "RDATE", "RECURRENCE-ID"];

const DATE_VALUE = /^\d{8}$/;
const DATE_TIME_VALUE = /^\d{8}T\d{6}Z?$/;

const items = (p: Prop): string[] => p.value.split(",").map((v) => v.trim());

/**
 * TZID on a DATE or on a UTC value (RFC 5545 3.2.19: "MUST NOT be applied"). Such a file is not
 * usable: the tools would have to guess which of the two is meant.
 */
export const tzidProblems = (lines: readonly string[]): string[] =>
  allProps(lines)
    .filter(
      (p) =>
        TIME_PROPS.includes(p.name) &&
        param(p, "TZID") !== undefined &&
        items(p).some((v) => DATE_VALUE.test(v) || (DATE_TIME_VALUE.test(v) && v.endsWith("Z"))),
    )
    .map((p) => `${p.name} has a TZID parameter on a DATE or UTC value (RFC 5545 3.2.19)`);

const formOf = (v: string): string =>
  v.includes("/") ? "PERIOD" : DATE_VALUE.test(v) ? "DATE" : DATE_TIME_VALUE.test(v) ? "DATE-TIME" : "other";

/**
 * VALUE parameter against the values (RFC 5545 3.2.20): all values of one property have one type,
 * it is the declared one, and a DATE needs an explicit VALUE=DATE because the default is DATE-TIME.
 * Values of any other shape are not judged here.
 */
export const valueProblems = (lines: readonly string[]): string[] =>
  allProps(lines)
    .filter((p) => TIME_PROPS.includes(p.name))
    .flatMap((p): string[] => {
      const forms = [...new Set(items(p).map(formOf))].filter((f) => f !== "other");
      const declared = param(p, "VALUE")?.toUpperCase();
      return forms.length > 1
        ? [`${p.name} mixes value types (${forms.join(", ")}) (RFC 5545 3.2.20)`]
        : forms.length === 1 && forms[0] !== (declared ?? "DATE-TIME")
          ? [
              declared === undefined
                ? `${p.name} holds a ${forms[0]} but has no VALUE=${forms[0]} (RFC 5545 3.2.20: the default type is DATE-TIME)`
                : `${p.name} has VALUE=${declared} but holds a ${forms[0]} (RFC 5545 3.2.20)`,
            ]
          : [];
    });

/** VALUE=BINARY needs ENCODING=BASE64 (RFC 5545 3.2.7, 3.3.1). Without ENCODING a value is plain text (8BIT). */
export const binaryProblems = (lines: readonly string[]): string[] =>
  allProps(lines)
    .filter(
      (p) =>
        param(p, "VALUE")?.toUpperCase() === "BINARY" && param(p, "ENCODING")?.toUpperCase() !== "BASE64",
    )
    .map((p) => `${p.name} has VALUE=BINARY without ENCODING=BASE64 (RFC 5545 3.2.7)`);

/** What the ATTENDEE parameters mean, with the defaults of RFC 5545 3.2 applied. */
export interface Attendee {
  /** the calendar address as written (usually `mailto:...`) */
  readonly address: string;
  readonly cutype: string;
  readonly role: string;
  readonly rsvp: boolean;
  readonly partstat: string;
}

const CUTYPES = ["INDIVIDUAL", "GROUP", "RESOURCE", "ROOM", "UNKNOWN"];
const ROLES = ["CHAIR", "REQ-PARTICIPANT", "OPT-PARTICIPANT", "NON-PARTICIPANT"];
/** the PARTSTAT values a VEVENT allows (RFC 5545 3.2.12) */
export const EVENT_PARTSTATS = ["NEEDS-ACTION", "ACCEPTED", "DECLINED", "TENTATIVE", "DELEGATED"];

/**
 * An ATTENDEE as the logic sees it: CUTYPE defaults to INDIVIDUAL (an unknown value is UNKNOWN), ROLE
 * to REQ-PARTICIPANT (also for an unknown value), RSVP to FALSE, PARTSTAT to NEEDS-ACTION (also for
 * an unknown or x-name value). The line itself is not changed by reading it this way.
 */
export const attendeeOf = (p: Prop): Attendee => {
  const pick = (name: string, allowed: readonly string[], fallback: string, unknown = fallback): string => {
    const v = param(p, name)?.trim().toUpperCase();
    return v === undefined || v === "" ? fallback : allowed.includes(v) ? v : unknown;
  };
  return {
    address: p.value.trim(),
    cutype: pick("CUTYPE", CUTYPES, "INDIVIDUAL", "UNKNOWN"),
    role: pick("ROLE", ROLES, "REQ-PARTICIPANT"),
    rsvp: param(p, "RSVP")?.trim().toUpperCase() === "TRUE",
    partstat: pick("PARTSTAT", EVENT_PARTSTATS, "NEEDS-ACTION"),
  };
};

/** Calendar-level problems that do not make the file unusable (RFC 5545 3.6, 3.7), and value type deviations. */
export const calendarWarnings = (lines: readonly string[]): string[] => [
  ...calendarObjectWarnings(lines),
  ...valueProblems(lines),
  ...binaryProblems(lines),
];

const calendarObjectWarnings = (lines: readonly string[]): string[] => {
  const { spans } = scan(lines);
  const d = depths(lines);
  const calendars = spans.filter((s) => s.name === "VCALENDAR");
  if (calendars.length === 0) return ["no VCALENDAR object around the components (RFC 5545 3.4)"];
  return calendars.flatMap((cal) => {
    const own = directProps(lines, d, cal).map((i) => parseProp(lines[i] as string));
    const named = (n: string): Prop[] => own.filter((p) => p.name === n);
    const once = (n: string): string[] =>
      named(n).length === 0
        ? [`${n} is missing (RFC 5545 3.6)`]
        : named(n).length > 1
          ? [`${n} appears ${named(n).length} times (RFC 5545 3.7 allows one)`]
          : [];
    const version = named("VERSION")[0]?.value.trim();
    const scale = named("CALSCALE")[0]?.value.trim();
    return [
      ...once("VERSION"),
      ...once("PRODID"),
      ...(version !== undefined && version !== "2.0" ? [`VERSION is '${version}', not 2.0`] : []),
      ...(scale !== undefined && scale.toUpperCase() !== "GREGORIAN"
        ? [`CALSCALE '${scale}' is not GREGORIAN (unsupported, read as Gregorian)`]
        : []),
    ];
  });
};

// ---------- events ----------

/** One VEVENT: its lines from BEGIN:VEVENT to END:VEVENT. */
export type Event = readonly string[];

/** Line ranges of the VEVENTs that are properly closed, in file order; an unclosed one is not a range. */
const eventRanges = (lines: readonly string[]): { start: number; end: number }[] =>
  scan(lines)
    .spans.filter((s) => s.name === "VEVENT")
    .sort((a, b) => a.start - b.start)
    .filter((s, i, all) => i === 0 || s.start > (all[i - 1] as Span).end);

export const events = (lines: readonly string[]): Event[] =>
  eventRanges(lines).map(({ start, end }) => lines.slice(start, end + 1));

const replaceEvents = (
  lines: readonly string[],
  f: (event: Event, isMaster: boolean) => Event | undefined,
): string[] => {
  const { out, from } = eventRanges(lines).reduce<{ out: string[]; from: number }>(
    (acc, { start, end }) => {
      const event = lines.slice(start, end + 1);
      const changed = f(event, isMaster(event));
      return { out: [...acc.out, ...lines.slice(acc.from, start), ...(changed ?? [])], from: end + 1 };
    },
    { out: [], from: 0 },
  );
  return [...out, ...lines.slice(from)];
};

/**
 * Applies `f` to every VEVENT of the file (`undefined` drops it); everything else is kept as is.
 * Lines of a VEVENT without END are never touched or copied; use `mapEventsChecked` to reject such a file.
 */
export const mapEvents = replaceEvents;

/** `mapEvents`, but a file with unbalanced BEGIN/END is refused with a clear error. */
export const mapEventsChecked = (
  lines: readonly string[],
  f: (event: Event, isMaster: boolean) => Event | undefined,
): Result.Result<string[], InvalidInput> => Result.map(checkedLines(lines), (ok) => replaceEvents(ok, f));

/** Indices of the event's own property lines: not BEGIN/END, and not inside a nested VALARM. */
const ownIndexes = (event: Event): number[] => {
  const d = depths(event);
  return event.flatMap((l, i) => (d[i] === 1 && depthChange(l) === 0 ? [i] : []));
};

export const props = (event: Event, name: string): Prop[] =>
  ownIndexes(event)
    .map((i) => parseProp(event[i] ?? ""))
    .filter((p) => p.name === name);

/** The first of several properties of that name (the first of a duplicated singleton wins). */
export const prop = (event: Event, name: string): Prop | undefined => props(event, name)[0];

/** Sets a property (all other lines of that name are removed); `undefined` removes it. */
export const setProp = (event: Event, name: string, line: string | undefined): Event => {
  const own = ownIndexes(event);
  const hits = own.filter((i) => parseProp(event[i] ?? "").name === name);
  const [first] = hits;
  if (first === undefined) {
    if (line === undefined) return event;
    // RFC 5545 eventc: properties come before nested components (VALARM)
    const nested = event.findIndex((l, i) => i > 0 && /^BEGIN:/i.test(l));
    const at = nested < 0 ? event.length - 1 : nested;
    return [...event.slice(0, at), line, ...event.slice(at)];
  }
  return event.flatMap((l, i) =>
    i === first ? (line === undefined ? [] : [line]) : hits.includes(i) ? [] : [l],
  );
};

/**
 * Sets DESCRIPTION. A vendor X-ALT-DESC (an HTML copy of the description) goes only when the
 * description really changes, since it would be stale then; an unchanged description leaves the
 * event untouched.
 */
export const setDescription = (event: Event, line: string | undefined): Event => {
  const current = prop(event, "DESCRIPTION");
  const next = line === undefined ? undefined : parseProp(line);
  return current?.value === next?.value
    ? event
    : setProp(setProp(event, "DESCRIPTION", line), "X-ALT-DESC", undefined);
};

/** Replaces every own property line of that name with `f(prop, line)`. */
export const mapProps = (event: Event, name: string, f: (p: Prop, line: string) => string): Event => {
  const own = new Set(ownIndexes(event));
  return event.map((l, i) => {
    const p = own.has(i) ? parseProp(l) : undefined;
    return p?.name === name ? f(p, l) : l;
  });
};

export const isMaster = (event: Event): boolean => prop(event, "RECURRENCE-ID") === undefined;

export const uidOf = (lines: readonly string[]): string | undefined => {
  const [first] = events(lines);
  return first === undefined ? undefined : prop(first, "UID")?.value;
};

/** UIDs of the VEVENTs of a file, trimmed, without duplicates; `undefined` stands for an event without UID. */
export const fileUids = (lines: readonly string[]): readonly (string | undefined)[] => [
  ...new Set(events(lines).map((e) => prop(e, "UID")?.value.trim() || undefined)),
];

/** How the tools see a file: one event (series) with a UID, or unusable for a stated reason. */
export type FileClass =
  | { readonly kind: "event"; readonly uid: string }
  | { readonly kind: "unusable"; readonly reason: string; readonly uids: readonly string[] };

/**
 * A vdir file is one calendar object resource (RFC 4791 4.1, vdir): balanced BEGIN/END, VEVENTs of
 * one UID only, no mixing of VEVENT with VTODO/VJOURNAL/VFREEBUSY (VTIMEZONE and unknown components
 * are fine). Anything else is unusable, never guessed.
 */
export const classifyFile = (lines: readonly string[]): FileClass => {
  const { spans, problems } = scan(lines);
  const uids = fileUids(lines);
  const known = uids.filter((u): u is string => u !== undefined);
  const unusable = (reason: string): FileClass => ({ kind: "unusable", reason, uids: known });
  if (problems.length > 0) {
    // an unclosed VEVENT is no event, so its UID is found by looking at every UID line
    const raw = [
      ...new Set(
        allProps(lines)
          .filter((p) => p.name === "UID")
          .map((p) => p.value.trim()),
      ),
    ];
    return {
      kind: "unusable",
      reason: `malformed (${problems.join("; ")}), skipped`,
      uids: raw.filter((u) => u !== ""),
    };
  }
  const zoneProblems = tzidProblems(lines);
  if (zoneProblems.length > 0) return unusable(`${[...new Set(zoneProblems)].join("; ")}, skipped`);
  const types = [
    ...new Set(
      spans
        .filter(
          (s) => (s.parent === "VCALENDAR" || s.parent === undefined) && COMPONENT_TYPES.includes(s.name),
        )
        .map((s) => s.name),
    ),
  ].sort();
  if (types.length > 1) return unusable(`several component types in one file (${types.join(", ")}), skipped`);
  if (types.length === 1 && types[0] !== "VEVENT")
    return unusable(`holds no VEVENT (only ${types[0]}), skipped`);
  if (events(lines).some((e) => props(e, "UID").length > 1))
    return unusable("a VEVENT has several UID properties, skipped");
  if (uids.length > 1)
    return unusable(`several UIDs in one file (${uids.map((u) => u ?? "<none>").join(", ")}), skipped`);
  const [uid] = uids;
  return uid === undefined ? unusable("no event with a UID") : { kind: "event", uid };
};

// ---------- stamps ----------

/** DTSTAMP-style UTC stamp, e.g. 20261102T100000Z */
export const stamp = (now: Date): string =>
  now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");

const UTC_STAMP = /^\d{8}T\d{6}Z$/;

/** The newer of the clock and the stored UTC stamp, so a stamp never goes back (clock skew). */
const notBefore = (stored: string | undefined, now: string): string => {
  const s = stored?.trim();
  return s !== undefined && UTC_STAMP.test(s) && s > now ? s : now;
};

const stampLines = (event: Event, now: Date): [string, string][] =>
  ["LAST-MODIFIED", "DTSTAMP"].map((name): [string, string] => [
    name,
    `${name}:${notBefore(prop(event, name)?.value, stamp(now))}`,
  ]);

/** LAST-MODIFIED and DTSTAMP now (UTC, never earlier than before), SEQUENCE untouched (an attendee's reply keeps the organizer's). */
export const restamp = (event: Event, now: Date): Event =>
  stampLines(event, now).reduce<Event>((e, [name, line]) => setProp(e, name, line), event);

/** Largest value of an RFC 5545 integer. */
const MAX_SEQUENCE = 2147483647;

/** The SEQUENCE of an event as a non-negative integer; a missing or invalid value counts as 0. */
export const sequenceOf = (event: Event): number => {
  const v = prop(event, "SEQUENCE")?.value.trim() ?? "";
  return /^\+?\d{1,10}$/.test(v) ? Math.min(Number(v), MAX_SEQUENCE) : 0;
};

/** Marks an event as modified by its organizer: SEQUENCE + 1 (always a valid integer), LAST-MODIFIED and DTSTAMP now. */
export const touch = (event: Event, now: Date): Event =>
  restamp(setProp(event, "SEQUENCE", `SEQUENCE:${Math.min(sequenceOf(event) + 1, MAX_SEQUENCE)}`), now);
