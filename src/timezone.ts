import { Result } from "effect";
import ICAL from "ical.js";
import { IANAZone } from "luxon";
import { InvalidInput } from "./errors.js";

// Pure time zone handling. A zone is a function from an instant to its UTC offset; wall-clock
// values are converted to instants with it. Nothing here reads the host: the caller passes the zone
// of the host in as a name.

type V<A> = Result.Result<A, InvalidInput>;

const fail = (message: string): V<never> => Result.fail(new InvalidInput({ message }));

export interface Zone {
  readonly id: string;
  /** UTC offset in minutes (east positive) at the instant `utcMs`. */
  readonly offsetMinutes: (utcMs: number) => number;
}

/** Calendar date and time of day as written, without any zone. */
export interface Wall {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

export const utcZone: Zone = { id: "UTC", offsetMinutes: () => 0 };

/** The wall-clock fields read as if they were UTC. */
export const wallToUtcMs = (w: Wall): number =>
  Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);

/** Inverse of `wallToUtcMs`. */
export const wallFromUtcMs = (ms: number): Wall => {
  const d = new Date(ms);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
  };
};

/**
 * Instant (epoch ms) of a wall-clock time in a zone. A time skipped by a DST gap moves forward (it
 * is read with the offset valid before the gap); an ambiguous time (DST fold) takes the first
 * occurrence.
 */
export const wallToInstant = (zone: Zone, w: Wall): number => {
  const asUtc = wallToUtcMs(w);
  const before = zone.offsetMinutes(asUtc - DAY_MS);
  const after = zone.offsetMinutes(asUtc + DAY_MS);
  const valid = [before, after]
    .map((o) => asUtc - o * MINUTE_MS)
    .filter((instant) => zone.offsetMinutes(instant) * MINUTE_MS === asUtc - instant);
  return valid.length === 0 ? asUtc - before * MINUTE_MS : Math.min(...valid);
};

/** Wall-clock time in a zone at an instant. */
export const instantToWall = (zone: Zone, instantMs: number): Wall =>
  wallFromUtcMs(instantMs + zone.offsetMinutes(instantMs) * MINUTE_MS);

/** An IANA zone by name. */
export const ianaZone = (name: string): V<Zone> => {
  if (!IANAZone.isValidZone(name)) return fail(`unknown time zone "${name}"`);
  const zone = IANAZone.create(name);
  return Result.succeed({ id: name, offsetMinutes: (ms: number) => zone.offset(ms) });
};

/**
 * Windows (Outlook) time zone names and the IANA zone they stand for: a snapshot of the primary
 * territory ("001") entries of the CLDR `windowsZones.xml` mapping. Windows adds zones now and
 * then; a name missing here is reported as unknown (never read as floating).
 */
export const WINDOWS_ZONES: Readonly<Record<string, string>> = {
  "AUS Central Standard Time": "Australia/Darwin",
  "AUS Eastern Standard Time": "Australia/Sydney",
  "Afghanistan Standard Time": "Asia/Kabul",
  "Alaskan Standard Time": "America/Anchorage",
  "Aleutian Standard Time": "America/Adak",
  "Altai Standard Time": "Asia/Barnaul",
  "Arab Standard Time": "Asia/Riyadh",
  "Arabian Standard Time": "Asia/Dubai",
  "Arabic Standard Time": "Asia/Baghdad",
  "Argentina Standard Time": "America/Argentina/Buenos_Aires",
  "Astrakhan Standard Time": "Europe/Astrakhan",
  "Atlantic Standard Time": "America/Halifax",
  "Aus Central W. Standard Time": "Australia/Eucla",
  "Azerbaijan Standard Time": "Asia/Baku",
  "Azores Standard Time": "Atlantic/Azores",
  "Bahia Standard Time": "America/Bahia",
  "Bangladesh Standard Time": "Asia/Dhaka",
  "Belarus Standard Time": "Europe/Minsk",
  "Bougainville Standard Time": "Pacific/Bougainville",
  "Canada Central Standard Time": "America/Regina",
  "Cape Verde Standard Time": "Atlantic/Cape_Verde",
  "Caucasus Standard Time": "Asia/Yerevan",
  "Cen. Australia Standard Time": "Australia/Adelaide",
  "Central America Standard Time": "America/Guatemala",
  "Central Asia Standard Time": "Asia/Almaty",
  "Central Brazilian Standard Time": "America/Cuiaba",
  "Central Europe Standard Time": "Europe/Budapest",
  "Central European Standard Time": "Europe/Warsaw",
  "Central Pacific Standard Time": "Pacific/Guadalcanal",
  "Central Standard Time": "America/Chicago",
  "Central Standard Time (Mexico)": "America/Mexico_City",
  "Chatham Islands Standard Time": "Pacific/Chatham",
  "China Standard Time": "Asia/Shanghai",
  "Cuba Standard Time": "America/Havana",
  "Dateline Standard Time": "Etc/GMT+12",
  "E. Africa Standard Time": "Africa/Nairobi",
  "E. Australia Standard Time": "Australia/Brisbane",
  "E. Europe Standard Time": "Europe/Chisinau",
  "E. South America Standard Time": "America/Sao_Paulo",
  "Easter Island Standard Time": "Pacific/Easter",
  "Eastern Standard Time": "America/New_York",
  "Eastern Standard Time (Mexico)": "America/Cancun",
  "Egypt Standard Time": "Africa/Cairo",
  "Ekaterinburg Standard Time": "Asia/Yekaterinburg",
  "FLE Standard Time": "Europe/Kiev",
  "Fiji Standard Time": "Pacific/Fiji",
  "GMT Standard Time": "Europe/London",
  "GTB Standard Time": "Europe/Bucharest",
  "Georgian Standard Time": "Asia/Tbilisi",
  "Greenland Standard Time": "America/Godthab",
  "Greenwich Standard Time": "Atlantic/Reykjavik",
  "Haiti Standard Time": "America/Port-au-Prince",
  "Hawaiian Standard Time": "Pacific/Honolulu",
  "India Standard Time": "Asia/Calcutta",
  "Iran Standard Time": "Asia/Tehran",
  "Israel Standard Time": "Asia/Jerusalem",
  "Jordan Standard Time": "Asia/Amman",
  "Kaliningrad Standard Time": "Europe/Kaliningrad",
  "Korea Standard Time": "Asia/Seoul",
  "Libya Standard Time": "Africa/Tripoli",
  "Line Islands Standard Time": "Pacific/Kiritimati",
  "Lord Howe Standard Time": "Australia/Lord_Howe",
  "Magadan Standard Time": "Asia/Magadan",
  "Magallanes Standard Time": "America/Punta_Arenas",
  "Marquesas Standard Time": "Pacific/Marquesas",
  "Mauritius Standard Time": "Indian/Mauritius",
  "Mid-Atlantic Standard Time": "Etc/GMT+2",
  "Middle East Standard Time": "Asia/Beirut",
  "Montevideo Standard Time": "America/Montevideo",
  "Morocco Standard Time": "Africa/Casablanca",
  "Mountain Standard Time": "America/Denver",
  "Mountain Standard Time (Mexico)": "America/Mazatlan",
  "Myanmar Standard Time": "Asia/Rangoon",
  "N. Central Asia Standard Time": "Asia/Novosibirsk",
  "Namibia Standard Time": "Africa/Windhoek",
  "Nepal Standard Time": "Asia/Katmandu",
  "New Zealand Standard Time": "Pacific/Auckland",
  "Newfoundland Standard Time": "America/St_Johns",
  "Norfolk Standard Time": "Pacific/Norfolk",
  "North Asia East Standard Time": "Asia/Irkutsk",
  "North Asia Standard Time": "Asia/Krasnoyarsk",
  "North Korea Standard Time": "Asia/Pyongyang",
  "Omsk Standard Time": "Asia/Omsk",
  "Pacific SA Standard Time": "America/Santiago",
  "Pacific Standard Time": "America/Los_Angeles",
  "Pacific Standard Time (Mexico)": "America/Tijuana",
  "Pakistan Standard Time": "Asia/Karachi",
  "Paraguay Standard Time": "America/Asuncion",
  "Qyzylorda Standard Time": "Asia/Qyzylorda",
  "Romance Standard Time": "Europe/Paris",
  "Russia Time Zone 10": "Asia/Srednekolymsk",
  "Russia Time Zone 11": "Asia/Kamchatka",
  "Russia Time Zone 3": "Europe/Samara",
  "Russian Standard Time": "Europe/Moscow",
  "SA Eastern Standard Time": "America/Cayenne",
  "SA Pacific Standard Time": "America/Bogota",
  "SA Western Standard Time": "America/La_Paz",
  "SE Asia Standard Time": "Asia/Bangkok",
  "Saint Pierre Standard Time": "America/Miquelon",
  "Sakhalin Standard Time": "Asia/Sakhalin",
  "Samoa Standard Time": "Pacific/Apia",
  "Sao Tome Standard Time": "Africa/Sao_Tome",
  "Saratov Standard Time": "Europe/Saratov",
  "Singapore Standard Time": "Asia/Singapore",
  "South Africa Standard Time": "Africa/Johannesburg",
  "South Sudan Standard Time": "Africa/Juba",
  "Sri Lanka Standard Time": "Asia/Colombo",
  "Sudan Standard Time": "Africa/Khartoum",
  "Syria Standard Time": "Asia/Damascus",
  "Taipei Standard Time": "Asia/Taipei",
  "Tasmania Standard Time": "Australia/Hobart",
  "Tocantins Standard Time": "America/Araguaina",
  "Tokyo Standard Time": "Asia/Tokyo",
  "Tomsk Standard Time": "Asia/Tomsk",
  "Tonga Standard Time": "Pacific/Tongatapu",
  "Transbaikal Standard Time": "Asia/Chita",
  "Turkey Standard Time": "Europe/Istanbul",
  "Turks And Caicos Standard Time": "America/Grand_Turk",
  "US Eastern Standard Time": "America/Indianapolis",
  "US Mountain Standard Time": "America/Phoenix",
  UTC: "Etc/UTC",
  "UTC+12": "Etc/GMT-12",
  "UTC+13": "Etc/GMT-13",
  "UTC-02": "Etc/GMT+2",
  "UTC-08": "Etc/GMT+8",
  "UTC-09": "Etc/GMT+9",
  "UTC-11": "Etc/GMT+11",
  "Ulaanbaatar Standard Time": "Asia/Ulaanbaatar",
  "Venezuela Standard Time": "America/Caracas",
  "Vladivostok Standard Time": "Asia/Vladivostok",
  "Volgograd Standard Time": "Europe/Volgograd",
  "W. Australia Standard Time": "Australia/Perth",
  "W. Central Africa Standard Time": "Africa/Lagos",
  "W. Europe Standard Time": "Europe/Berlin",
  "W. Mongolia Standard Time": "Asia/Hovd",
  "West Asia Standard Time": "Asia/Tashkent",
  "West Bank Standard Time": "Asia/Hebron",
  "West Pacific Standard Time": "Pacific/Port_Moresby",
  "Yakutsk Standard Time": "Asia/Yakutsk",
  "Yukon Standard Time": "America/Whitehorse",
};

const HORIZON_YEAR = 2100;
const MAX_ONSETS = 5_000;

interface Transition {
  readonly atMs: number;
  readonly from: number;
  readonly to: number;
}

const wallOf = (t: ICAL.Time): Wall => ({
  year: t.year,
  month: t.month,
  day: t.day,
  hour: t.hour,
  minute: t.minute,
  second: t.second,
});

const offsetMinutesOf = (c: ICAL.Component, name: string): V<number> => {
  const prop = c.getFirstProperty(name);
  const raw = prop?.jCal[3];
  const m = typeof raw === "string" ? /^([+-])(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(raw) : null;
  if (m === null) return fail(`the VTIMEZONE has no valid ${name.toUpperCase()}`);
  const seconds = Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4] ?? 0);
  // RFC 5545 3.3.14: minutes and seconds are below 60, and "-0000" is not allowed
  if (Number(m[3]) > 59 || Number(m[4] ?? 0) > 59) {
    return fail(`the VTIMEZONE has no valid ${name.toUpperCase()}: minutes and seconds must be below 60`);
  }
  if (m[1] === "-" && seconds === 0) {
    return fail(`the VTIMEZONE has no valid ${name.toUpperCase()}: a zero offset is written +0000`);
  }
  return Result.succeed(((m[1] === "-" ? -1 : 1) * seconds) / 60);
};

/**
 * RFC 5545 3.6.5: the DTSTART of an observance is local time (neither UTC nor with a TZID), and
 * the UNTIL of its rule is UTC.
 */
const checkObservance = (sub: ICAL.Component): V<undefined> => {
  const start = sub.getFirstProperty("dtstart");
  const raw = start?.jCal[3];
  if (
    start !== null &&
    (typeof raw !== "string" || raw.endsWith("Z") || start.getParameter("tzid") !== undefined)
  ) {
    return fail("the DTSTART of a VTIMEZONE observance must be a local date-time (no Z, no TZID)");
  }
  const rule = sub.getFirstProperty("rrule")?.jCal[3];
  const until = typeof rule === "object" && rule !== null ? (rule as { until?: unknown }).until : undefined;
  if (until !== undefined && !(typeof until === "string" && until.endsWith("Z"))) {
    return fail("the UNTIL of a VTIMEZONE observance rule must be a UTC date-time");
  }
  return Result.succeed(undefined);
};

/** Transitions of one STANDARD or DAYLIGHT sub-component up to `HORIZON_YEAR`. */
const transitionsOf = (sub: ICAL.Component): V<readonly Transition[]> =>
  Result.gen(function* () {
    const from = yield* offsetMinutesOf(sub, "tzoffsetfrom");
    const to = yield* offsetMinutesOf(sub, "tzoffsetto");
    const start = sub.getFirstPropertyValue("dtstart");
    if (!(start instanceof ICAL.Time)) return yield* fail("the VTIMEZONE has no DTSTART");
    yield* checkObservance(sub);
    const at = (w: Wall): Transition => ({ atMs: wallToUtcMs(w) - from * MINUTE_MS, from, to });
    const rdates = sub
      .getAllProperties("rdate")
      .flatMap((p) => p.getValues())
      .flatMap((v) => (v instanceof ICAL.Time ? [at(wallOf(v))] : []));
    const rule = sub.getFirstPropertyValue("rrule");
    if (!(rule instanceof ICAL.Recur)) return [at(wallOf(start)), ...rdates];
    const onsets: Transition[] = [];
    const it = rule.iterator(start);
    for (let t = it.next(); t !== null && onsets.length < MAX_ONSETS; t = it.next()) {
      if (t.year > HORIZON_YEAR) break;
      onsets.push(at(wallOf(t)));
    }
    return [...onsets, ...rdates];
  });

/** A zone from a VTIMEZONE component (its STANDARD and DAYLIGHT rules). */
export const zoneFromVtimezone = (vtimezone: ICAL.Component): V<Zone> =>
  Result.gen(function* () {
    const tzid = vtimezone.getFirstPropertyValue("tzid");
    const subs = [...vtimezone.getAllSubcomponents("standard"), ...vtimezone.getAllSubcomponents("daylight")];
    if (typeof tzid !== "string" || tzid === "") return yield* fail("a VTIMEZONE has no TZID");
    const id = tzid;
    const lists: Transition[] = [];
    for (const sub of subs) lists.push(...(yield* transitionsOf(sub)));
    const sorted = [...lists].sort((a, b) => a.atMs - b.atMs);
    const first = sorted[0];
    if (first === undefined) return yield* fail(`the VTIMEZONE "${id}" has no rules`);
    const offsetMinutes = (ms: number): number =>
      sorted.reduce((offset, t) => (t.atMs <= ms ? t.to : offset), first.from);
    return { id, offsetMinutes };
  });

const tzidOf = (c: ICAL.Component): unknown => c.getFirstPropertyValue("tzid");

/**
 * Zone for a TZID. RFC 5545 3.2.19: a TZID names the VTIMEZONE of the file, so that one comes
 * first, even when it has the name of an IANA or Windows zone (a stale definition wins over the
 * current tz database), and a VTIMEZONE that is present but invalid is reported, never replaced by
 * a guess. Only a file without a VTIMEZONE of that name falls back to an IANA zone of that name
 * (legacy aliases like "US/Eastern" included), then to a Windows zone name (tolerated deviation:
 * Outlook writes CLDR names without a VTIMEZONE). A TZID like "GMT+0100" or "+01:00" is no zone
 * name. Anything else is an error: such a time is never read as floating.
 */
export const resolveZone = (tzid: string, vtimezones: readonly ICAL.Component[]): V<Zone> => {
  const own = vtimezones.find((v) => tzidOf(v) === tzid);
  if (own !== undefined) return zoneFromVtimezone(own);
  // the engine accepts offsets like "+01:00" as zone names; a TZID is a name, not an offset
  const iana = /^[+-]/.test(tzid) ? fail(`unknown time zone "${tzid}"`) : ianaZone(tzid);
  if (Result.isSuccess(iana)) return iana;
  const windows = WINDOWS_ZONES[tzid];
  if (windows !== undefined) return ianaZone(windows);
  return fail(
    `unknown time zone "${tzid}": the file has no usable VTIMEZONE for it and it is neither an IANA nor a known Windows zone name`,
  );
};
