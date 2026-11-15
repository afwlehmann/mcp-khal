import { Result } from "effect";
import ICAL from "ical.js";
import { InvalidInput } from "./errors.js";
import { type Event, events, type Prop, param, parseProp, prop, props, setProp, stamp } from "./ics.js";
import {
  ianaZone,
  instantToWall,
  resolveZone,
  utcZone,
  wallFromUtcMs,
  wallToInstant,
  wallToUtcMs,
  type Zone,
  type Wall as ZoneWall,
} from "./timezone.js";

// Pure date and rule arithmetic for recurring events. Dates and times are handled as "wall clock":
// a Date.UTC number that stands for the digits of an ICS value, whatever its time zone. Anything that
// needs a real instant goes through `src/timezone.ts` (the VTIMEZONE of the file first, RFC 5545
// 3.2.19, then IANA and Windows zone names); this module has no zone code of its own.

type V<A> = Result.Result<A, InvalidInput>;

const invalid = (message: string): InvalidInput => new InvalidInput({ message });
const fail = (message: string): V<never> => Result.fail(invalid(message));

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

/** Results of a list of steps, or the first failure. */
export const sequenceAll = <A, B>(xs: readonly A[], f: (a: A) => V<B>): V<B[]> => {
  const out: B[] = [];
  for (const x of xs) {
    const r = f(x);
    if (Result.isFailure(r)) return fail(r.failure.message);
    out.push(r.success);
  }
  return Result.succeed(out);
};

// ---------- time zones (all through src/timezone.ts) ----------

export interface Zones {
  /** the zone of the host: the one the tools show and take dates and times in */
  readonly host: Zone;
  /**
   * The zone the digits of a date-time value live in: UTC for a value ending in Z, the zone named by
   * TZID (the VTIMEZONE of the file first), and the host zone for floating times and dates.
   */
  readonly of: (p: Prop, value: string) => V<Zone>;
}

/** The zones of one file; its VTIMEZONE components are read once. */
export const zonesOf = (lines: readonly string[], hostZone: string): V<Zones> =>
  Result.gen(function* () {
    const host = yield* ianaZone(hostZone);
    const calendar = yield* Result.try({
      try: () => new ICAL.Component(ICAL.parse(lines.join("\r\n"))),
      catch: () => invalid("the file is not valid iCalendar data"),
    });
    const vtimezones = calendar.getAllSubcomponents("vtimezone");
    const cache = new Map<string, V<Zone>>();
    const named = (tzid: string): V<Zone> => {
      const hit = cache.get(tzid);
      if (hit !== undefined) return hit;
      const made = resolveZone(tzid, vtimezones);
      cache.set(tzid, made);
      return made;
    };
    const of = (p: Prop, value: string): V<Zone> => {
      const v = value.trim();
      const tzid = param(p, "TZID");
      if (/z$/i.test(v)) return Result.succeed(utcZone);
      return tzid === undefined || /^\d{8}$/.test(v) ? Result.succeed(host) : named(tzid);
    };
    return { host, of };
  });

/**
 * The instant (epoch ms) of a stored value. `floating` is the zone a floating time takes (default:
 * the host zone), used for a RECURRENCE-ID without zone next to a zoned DTSTART.
 */
export const instantOf = (zones: Zones, p: Prop, raw: string, floating?: Zone): V<number> => {
  const w = parseWall(raw);
  if (w === undefined) return fail(`cannot read ${p.name} ${raw}`);
  const zone =
    floating !== undefined && w.hasTime && !w.utc && param(p, "TZID") === undefined
      ? Result.succeed(floating)
      : zones.of(p, raw);
  return Result.map(zone, (z) => wallToInstant(z, wallFromUtcMs(w.ms)));
};

/** The stored form of an instant seen in `zone`; `form` says date, floating or UTC. */
export const valueAt = (zone: Zone, form: Pick<Wall, "hasTime" | "utc">, ms: number): string =>
  formatWall({ ms: wallToUtcMs(instantToWall(zone, ms)), hasTime: form.hasTime, utc: form.utc });

/**
 * The UNTIL value that ends a rule with the occurrence at `ms` as its last one (inclusive), of the
 * type RFC 5545 3.3.10 asks for: a DATE for an all-day start, UTC for a UTC start or a start with a
 * TZID, a floating time for a floating start.
 */
export const untilValue = (host: Zone, dtstart: Prop, form: Wall, ms: number): string => {
  if (!form.hasTime) return valueAt(host, form, ms);
  if (form.utc || param(dtstart, "TZID") !== undefined)
    return valueAt(utcZone, { hasTime: true, utc: true }, ms);
  return valueAt(host, form, ms);
};

/** Instants of an override: the instance it replaces and its own start (the same when it has no DTSTART). */
export interface OverrideTimes {
  readonly rid: number;
  readonly start: number;
}

export const overrideTimes = (zones: Zones, e: Event, floating: Zone): V<OverrideTimes> =>
  Result.gen(function* () {
    const ridProp = prop(e, "RECURRENCE-ID");
    if (ridProp === undefined) return yield* fail("an exception has no RECURRENCE-ID");
    const rid = yield* instantOf(zones, ridProp, ridProp.value, floating);
    const dtstart = prop(e, "DTSTART");
    const start = dtstart === undefined ? rid : yield* instantOf(zones, dtstart, dtstart.value, floating);
    return { rid, start };
  });

/** Instants of the entries of every EXDATE or RDATE line (the start of a PERIOD). */
export const listedInstants = (
  zones: Zones,
  e: Event,
  name: "EXDATE" | "RDATE",
  floating: Zone,
): V<number[]> =>
  sequenceAll(
    props(e, name).flatMap((p) => p.value.split(",").map((v) => [p, v] as const)),
    ([p, v]) => instantOf(zones, p, v.trim().split("/")[0] ?? "", floating),
  );

// ---------- rules ----------

const ruleParts = (r: string): [string, string][] =>
  r
    .split(";")
    .filter((p) => p.includes("="))
    .map((p) => [p.slice(0, p.indexOf("=")).toUpperCase(), p.slice(p.indexOf("=") + 1)]);

/** FREQ first (RFC 5545 3.3.10), the other parts in their order. */
const rule = (parts: readonly (readonly [string, string])[]): string =>
  [...parts.filter(([k]) => k === "FREQ"), ...parts.filter(([k]) => k !== "FREQ")]
    .map(([k, v]) => `${k}=${v}`)
    .join(";");

export const ruleCount = (r: string): number | undefined => {
  const count = ruleParts(r).find(([k]) => k === "COUNT")?.[1];
  return count === undefined ? undefined : Number(count);
};

/** The rule with its end replaced: `UNTIL` instead of `COUNT`/`UNTIL` (they never occur together). */
export const withUntil = (r: string, until: string): string =>
  rule([...ruleParts(r).filter(([k]) => k !== "COUNT" && k !== "UNTIL"), ["UNTIL", until]]);

export const withCount = (r: string, count: number): string =>
  rule([...ruleParts(r).filter(([k]) => k !== "COUNT" && k !== "UNTIL"), ["COUNT", String(count)]]);

const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;

/**
 * Does the day (a wall-clock date in the zone of the series) satisfy the BYDAY, BYMONTHDAY and
 * BYMONTH parts of the rule? A series that starts on a day its own rule does not name is not
 * synchronized with it (RFC 5545 3.8.5.3: undefined), so a move to such a day is refused.
 */
export const ruleAllows = (r: string, day: Pick<ZoneWall, "year" | "month" | "day">): boolean => {
  const parts = new Map(ruleParts(r));
  const list = (k: string): string[] | undefined =>
    parts
      .get(k)
      ?.split(",")
      .map((s) => s.trim());
  const weekday = WEEKDAYS[new Date(Date.UTC(day.year, day.month - 1, day.day)).getUTCDay()];
  const length = new Date(Date.UTC(day.year, day.month, 0)).getUTCDate();
  const byDay = list("BYDAY");
  const dayOk =
    byDay === undefined ||
    byDay.some((entry) => {
      const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/i.exec(entry);
      if (m === null || m[2]?.toUpperCase() !== weekday) return false;
      if (m[1] === undefined || parts.get("FREQ") !== "MONTHLY") return true;
      const n = Number(m[1]);
      return n > 0 ? Math.ceil(day.day / 7) === n : Math.ceil((length - day.day + 1) / 7) === -n;
    });
  const monthDays = list("BYMONTHDAY");
  const monthDayOk =
    monthDays === undefined ||
    monthDays.some((e) => Number(e) === day.day || Number(e) === day.day - length - 1);
  const months = list("BYMONTH");
  const monthOk = months === undefined || months.some((e) => Number(e) === day.month);
  return dayOk && monthDayOk && monthOk;
};

// ---------- editing helpers ----------

const depthChange = (line: string): number => {
  const u = line.toUpperCase();
  return u.startsWith("BEGIN:") ? 1 : u.startsWith("END:") ? -1 : 0;
};

/**
 * The file without a METHOD line: a stored calendar object resource has none (RFC 4791 4.1); one
 * saved from an invitation mail has. Only the calendar's own lines are looked at.
 */
export const withoutMethod = (lines: readonly string[]): string[] => {
  let depth = 0;
  return lines.filter((l) => {
    const here = depth;
    depth += depthChange(l);
    return !(here === 1 && /^METHOD[;:]/i.test(l));
  });
};

/**
 * Rewrites the own lines of an event named `name` (EXDATE, RDATE): `keep` decides for each
 * comma-separated entry; a line left without entries is removed, an untouched line stays as it is.
 */
export const filterEntries = (
  event: Event,
  name: string,
  keep: (p: Prop, entry: string) => boolean,
): Event => {
  let depth = 0;
  return event.flatMap((line) => {
    const here = depth;
    depth += depthChange(line);
    if (here !== 1 || depthChange(line) !== 0) return [line];
    const p = parseProp(line);
    if (p.name !== name) return [line];
    const entries = p.value.split(",");
    const kept = entries.filter((entry) => keep(p, entry.trim()));
    if (kept.length === entries.length) return [line];
    return kept.length === 0 ? [] : [`${name}${p.params}:${kept.join(",")}`];
  });
};

/**
 * A file the event tools may rewrite: all its events have one UID and no other component than
 * VEVENT sits next to the time zones (RFC 4791 4.1). Anything else is refused, never guessed at.
 */
export const checkFile = (lines: readonly string[]): V<undefined> => {
  const uids = [...new Set(events(lines).flatMap((e) => props(e, "UID").map((p) => p.value)))];
  if (uids.length > 1)
    return fail(
      `the file holds events with different UIDs (${uids.join(", ")}): one file holds one event and its exceptions, so the event tools do not change it`,
    );
  let depth = 0;
  const kinds = lines.flatMap((l) => {
    const here = depth;
    depth += depthChange(l);
    return here === 1 && /^BEGIN:/i.test(l) ? [l.slice(6).toUpperCase()] : [];
  });
  const other = kinds.find((k) => ["VTODO", "VJOURNAL", "VFREEBUSY"].includes(k));
  return other === undefined
    ? Result.succeed(undefined)
    : fail(
        `the file holds a ${other} next to the event: one file holds one kind of component, so the event tools do not change it`,
      );
};

// ---------- addresses, SEQUENCE and stamps ----------

/** A calendar address without `mailto:` (in any case), in lower case. */
export const normAddress = (value: string): string =>
  value
    .trim()
    .replace(/^mailto:/i, "")
    .toLowerCase();

export const sameAddress = (value: string, address: string | undefined): boolean =>
  address !== undefined && normAddress(value) === normAddress(address);

const MAX_SEQUENCE = 2_147_483_647;

/**
 * SEQUENCE + 1 as a valid integer (RFC 5545 3.3.8: -2147483648 to 2147483647). A missing or
 * unreadable value counts as 0; the result never goes down and never leaves the range.
 */
export const nextSequence = (raw: string | undefined): string => {
  const text = raw?.trim() ?? "";
  const n = /^[+-]?\d{1,10}$/.test(text) ? Number(text) : 0;
  const valid = n >= -2_147_483_648 && n <= MAX_SEQUENCE ? n : 0;
  return String(Math.min(Math.max(valid, 0) + 1, MAX_SEQUENCE));
};

/** The stamp for an edit: the clock, or a later stored DTSTAMP/LAST-MODIFIED (they never go back). */
export const stampAt = (e: Event, now: Date): string => {
  const utc = (v: string | undefined): string[] =>
    v !== undefined && /^\d{8}T\d{6}Z$/.test(v.trim()) ? [v.trim()] : [];
  return [...utc(prop(e, "DTSTAMP")?.value), ...utc(prop(e, "LAST-MODIFIED")?.value)].reduce(
    (latest, v) => (v > latest ? v : latest),
    stamp(now),
  );
};

/**
 * Marks one VEVENT as changed by us: DTSTAMP and LAST-MODIFIED get the same UTC instant (without a
 * METHOD they mean the same, RFC 5545 3.8.7.2) and SEQUENCE grows by 1 when `bump` (only the
 * organizer's significant revisions do, RFC 5546 2.1.4). Everything else stays as it is.
 */
export const markEvent = (e: Event, now: Date, bump: boolean): Event => {
  const at = stampAt(e, now);
  const stamped = setProp(setProp(e, "LAST-MODIFIED", `LAST-MODIFIED:${at}`), "DTSTAMP", `DTSTAMP:${at}`);
  return bump
    ? setProp(stamped, "SEQUENCE", `SEQUENCE:${nextSequence(prop(e, "SEQUENCE")?.value)}`)
    : stamped;
};
