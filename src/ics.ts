import { fold } from "./recurrence.js";

// Pure helpers to read and edit an existing .ics file line by line (RFC 5545). Only what the tools
// that change events need: VEVENT components and their own (not VALARM) properties.

/** Content lines with RFC 5545 folding undone; blank lines dropped. */
export const unfoldLines = (ics: string): string[] =>
  ics
    .replace(/\r?\n[ \t]/g, "")
    .split(/\r?\n/)
    .filter((l) => l !== "");

/** Folded lines, CRLF-terminated. */
export const serialize = (lines: readonly string[]): string => `${lines.map(fold).join("\r\n")}\r\n`;

export interface Prop {
  readonly name: string;
  /** everything between the name and the colon, including the leading ';', e.g. ";TZID=Europe/Berlin" */
  readonly params: string;
  readonly value: string;
}

/** Index of the first colon outside double quotes (a quoted parameter may contain one). */
const valueColon = (line: string): number =>
  line.split("").findIndex((ch, i) => ch === ":" && (line.slice(0, i).match(/"/g)?.length ?? 0) % 2 === 0);

export const parseProp = (line: string): Prop => {
  const colon = valueColon(line);
  const head = colon < 0 ? line : line.slice(0, colon);
  const semi = head.indexOf(";");
  return {
    name: (semi < 0 ? head : head.slice(0, semi)).toUpperCase(),
    params: semi < 0 ? "" : head.slice(semi),
    value: colon < 0 ? "" : line.slice(colon + 1),
  };
};

/** The value of a parameter, e.g. `param(prop, "TZID")`; quotes removed. */
export const param = (p: Prop, name: string): string | undefined => {
  const m = new RegExp(`;${name}=("[^"]*"|[^;:]*)`, "i").exec(p.params);
  return m?.[1]?.replace(/^"|"$/g, "");
};

export const formatProp = (name: string, params: string, value: string): string =>
  `${name}${params}:${value}`;

/** One VEVENT: its lines from BEGIN:VEVENT to END:VEVENT. */
export type Event = readonly string[];

const isLine = (line: string, text: string): boolean => line.toUpperCase() === text;

/** Applies `f` to every VEVENT of the file (`undefined` drops it); everything else is kept as is. */
const eventRanges = (lines: readonly string[]): { start: number; end: number }[] =>
  lines
    .flatMap((l, i) => (isLine(l, "BEGIN:VEVENT") ? [i] : []))
    .map((start) => ({ start, end: lines.findIndex((l, i) => i > start && isLine(l, "END:VEVENT")) }));

export const events = (lines: readonly string[]): Event[] =>
  eventRanges(lines).map(({ start, end }) => lines.slice(start, end + 1));

export const mapEvents = (
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

const depthChange = (line: string): number => {
  const u = line.toUpperCase();
  return u.startsWith("BEGIN:") ? 1 : u.startsWith("END:") ? -1 : 0;
};

/** Indices of the event's own property lines: not BEGIN/END, and not inside a nested VALARM. */
const ownIndexes = (event: Event): number[] =>
  event.flatMap((l, i) => {
    const before = event.slice(0, i).reduce((d, x) => d + depthChange(x), 0);
    return before === 1 && depthChange(l) === 0 ? [i] : [];
  });

export const props = (event: Event, name: string): Prop[] =>
  ownIndexes(event)
    .map((i) => parseProp(event[i] ?? ""))
    .filter((p) => p.name === name);

export const prop = (event: Event, name: string): Prop | undefined => props(event, name)[0];

/** Sets a property (all other lines of that name are removed); `undefined` removes it. */
export const setProp = (event: Event, name: string, line: string | undefined): Event => {
  const own = ownIndexes(event);
  const hits = own.filter((i) => parseProp(event[i] ?? "").name === name);
  const [first] = hits;
  if (first === undefined)
    return line === undefined ? event : [...event.slice(0, -1), line, ...event.slice(-1)];
  return event.flatMap((l, i) =>
    i === first ? (line === undefined ? [] : [line]) : hits.includes(i) ? [] : [l],
  );
};

export const isMaster = (event: Event): boolean => prop(event, "RECURRENCE-ID") === undefined;

export const uidOf = (lines: readonly string[]): string | undefined => {
  const [first] = events(lines);
  return first === undefined ? undefined : prop(first, "UID")?.value;
};

/** DTSTAMP-style UTC stamp, e.g. 20261102T100000Z */
export const stamp = (now: Date): string =>
  now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");

/** Marks an event as modified: SEQUENCE + 1, LAST-MODIFIED and DTSTAMP now. */
export const touch = (event: Event, now: Date): Event => {
  const sequence = Number(prop(event, "SEQUENCE")?.value ?? "0");
  const next = Number.isFinite(sequence) ? sequence + 1 : 1;
  return [
    ["SEQUENCE", String(next)],
    ["LAST-MODIFIED", stamp(now)],
    ["DTSTAMP", stamp(now)],
  ].reduce<Event>((e, [name, value]) => setProp(e, name!, `${name}:${value}`), event);
};
