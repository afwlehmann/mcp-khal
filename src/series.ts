import { Result } from "effect";
import { InvalidInput } from "./errors.js";
import { type Event, type Prop, param, props } from "./ics.js";

// Pure date and rule arithmetic for recurring events. Dates and times are handled as "wall clock":
// a Date.UTC number that stands for the digits of an ICS value, whatever its time zone.

const invalid = (message: string): InvalidInput => new InvalidInput({ message });

const DAY = 86_400_000;

export interface Wall {
  /** the digits as a Date.UTC number */
  readonly ms: number;
  readonly hasTime: boolean;
  /** the value ends in Z */
  readonly utc: boolean;
}

/** `20301016`, `20301016T090000` or `20301016T090000Z`. */
export const parseWall = (value: string): Wall | undefined => {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/i.exec(value.trim());
  if (!m) return undefined;
  const n = (i: number): number => Number(m[i] ?? 0);
  return {
    ms: Date.UTC(n(1), n(2) - 1, n(3), n(4), n(5), n(6)),
    hasTime: m[4] !== undefined,
    utc: (m[7] ?? "") !== "",
  };
};

const two = (n: number): string => String(n).padStart(2, "0");

export const formatWall = ({ ms, hasTime, utc }: Wall): string => {
  const d = new Date(ms);
  const date = `${d.getUTCFullYear()}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}`;
  return hasTime
    ? `${date}T${two(d.getUTCHours())}${two(d.getUTCMinutes())}${two(d.getUTCSeconds())}${utc ? "Z" : ""}`
    : date;
};

/** `2030-03-04` -> `20300304`; undefined when it is not a real date. */
export const compactDate = (iso: string): string | undefined => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!m) return undefined;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const back = formatWall({ ms, hasTime: false, utc: false });
  return back === `${m[1]}${m[2]}${m[3]}` ? back : undefined;
};

/** Midnight of a compact date as wall-clock milliseconds. */
export const dateMs = (compact: string): number => parseWall(compact)?.ms ?? Number.NaN;

export const dayOf = (w: Wall): number => Math.floor(w.ms / DAY) * DAY;

// ---------- time zones ----------

const zoneOffset = (zone: string, instant: number): number => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instant));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  return (
    Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) -
    Math.floor(instant / 1000) * 1000
  );
};

/** The instant at which a zone's clock shows `wall` (the later one in a daylight-saving overlap). */
const wallToUtc = (zone: string, wall: number): number => {
  const guess = wall - zoneOffset(zone, wall);
  return wall - zoneOffset(zone, guess);
};

/**
 * The `UNTIL` that ends a series just before the occurrence on `compact` (a date): one second
 * before that occurrence. RFC 5545 wants UNTIL in UTC when DTSTART has a zone or is UTC, a date
 * for all-day events and a floating time otherwise.
 */
export const untilBefore = (dtstart: Prop, compact: string): Result.Result<string, InvalidInput> => {
  const start = parseWall(dtstart.value);
  if (start === undefined) return Result.fail(invalid(`cannot read DTSTART ${dtstart.value}`));
  if (!start.hasTime)
    return Result.succeed(formatWall({ ms: dateMs(compact) - DAY, hasTime: false, utc: false }));
  const occurrence = dateMs(compact) + (start.ms - dayOf(start)) - 1000;
  const zone = param(dtstart, "TZID");
  if (start.utc) return Result.succeed(formatWall({ ms: occurrence, hasTime: true, utc: true }));
  if (zone === undefined) return Result.succeed(formatWall({ ms: occurrence, hasTime: true, utc: false }));
  return Result.try({
    try: () => formatWall({ ms: wallToUtc(zone, occurrence), hasTime: true, utc: true }),
    catch: () => invalid(`unknown time zone '${zone}' in DTSTART`),
  });
};

// ---------- rules ----------

const ruleParts = (rule: string): [string, string][] =>
  rule
    .split(";")
    .filter((p) => p.includes("="))
    .map((p) => [p.slice(0, p.indexOf("=")).toUpperCase(), p.slice(p.indexOf("=") + 1)]);

const rule = (parts: readonly (readonly [string, string])[]): string =>
  parts.map(([k, v]) => `${k}=${v}`).join(";");

export const ruleCount = (r: string): number | undefined => {
  const count = ruleParts(r).find(([k]) => k === "COUNT")?.[1];
  return count === undefined ? undefined : Number(count);
};

/** The rule with its end replaced: `UNTIL` instead of `COUNT`/`UNTIL`. */
export const withUntil = (r: string, until: string): string =>
  rule([...ruleParts(r).filter(([k]) => k !== "COUNT" && k !== "UNTIL"), ["UNTIL", until]]);

export const withCount = (r: string, count: number): string =>
  rule([...ruleParts(r).filter(([k]) => k !== "COUNT" && k !== "UNTIL"), ["COUNT", String(count)]]);

// ---------- exceptions ----------

/** Compact dates of every EXDATE and RDATE value of the event. */
export const listedDates = (event: Event): string[] =>
  [...props(event, "EXDATE"), ...props(event, "RDATE")]
    .flatMap((p) => p.value.split(","))
    .map((v) => v.trim().slice(0, 8));

/** The RECURRENCE-ID line for the occurrence on `compact`, shaped like DTSTART. */
export const recurrenceId = (dtstart: Prop, compact: string): string | undefined => {
  const start = parseWall(dtstart.value);
  if (start === undefined) return undefined;
  const at = { ...start, ms: dateMs(compact) + (start.hasTime ? start.ms - dayOf(start) : 0) };
  return `RECURRENCE-ID${dtstart.params}:${formatWall(at)}`;
};
