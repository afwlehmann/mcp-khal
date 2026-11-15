import { Result } from "effect";
import ICAL from "ical.js";
import { describe, expect, it } from "vitest";
import {
  ianaZone,
  instantToWall,
  resolveZone,
  utcZone,
  type Wall,
  WINDOWS_ZONES,
  wallFromUtcMs,
  wallToInstant,
  wallToUtcMs,
  type Zone,
  zoneFromVtimezone,
} from "./timezone.js";

const wall = (year: number, month: number, day: number, hour = 0, minute = 0, second = 0): Wall => ({
  year,
  month,
  day,
  hour,
  minute,
  second,
});

const ok = <A>(r: Result.Result<A, { message: string }>): A => {
  if (Result.isFailure(r)) throw new Error(`unexpected failure: ${r.failure.message}`);
  return r.success;
};

const iso = (ms: number): string => new Date(ms).toISOString();

const at = (zone: string, w: Wall): string => iso(wallToInstant(ok(ianaZone(zone)), w));

const vtimezone = (...lines: string[]): ICAL.Component => {
  const cal = new ICAL.Component(
    ICAL.parse(
      ["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VTIMEZONE", ...lines, "END:VTIMEZONE", "END:VCALENDAR"].join(
        "\r\n",
      ),
    ),
  );
  const v = cal.getFirstSubcomponent("vtimezone");
  if (v === null) throw new Error("no vtimezone");
  return v;
};

const berlinRules = [
  "BEGIN:STANDARD",
  "DTSTART:19701025T030000",
  "TZOFFSETFROM:+0200",
  "TZOFFSETTO:+0100",
  "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
  "END:STANDARD",
  "BEGIN:DAYLIGHT",
  "DTSTART:19700329T020000",
  "TZOFFSETFROM:+0100",
  "TZOFFSETTO:+0200",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
  "END:DAYLIGHT",
];

describe("wallToUtcMs / wallFromUtcMs", () => {
  it("round-trip", () => {
    const w = wall(2026, 3, 29, 1, 2, 3);
    expect(wallFromUtcMs(wallToUtcMs(w))).toEqual(w);
    expect(iso(wallToUtcMs(w))).toBe("2026-03-29T01:02:03.000Z");
  });
});

describe("wallToInstant / instantToWall", () => {
  it("converts a plain time in Europe/Berlin, America/New_York and Asia/Kolkata", () => {
    expect(at("Europe/Berlin", wall(2026, 1, 15, 12))).toBe("2026-01-15T11:00:00.000Z");
    expect(at("Europe/Berlin", wall(2026, 7, 1, 12))).toBe("2026-07-01T10:00:00.000Z");
    expect(at("America/New_York", wall(2026, 7, 1, 12))).toBe("2026-07-01T16:00:00.000Z");
    expect(at("America/New_York", wall(2026, 1, 1, 12))).toBe("2026-01-01T17:00:00.000Z");
    expect(at("Asia/Kolkata", wall(2026, 7, 1, 9))).toBe("2026-07-01T03:30:00.000Z");
  });

  it("moves a time in the spring-forward gap forward", () => {
    expect(at("Europe/Berlin", wall(2026, 3, 29, 2, 30))).toBe("2026-03-29T01:30:00.000Z");
    expect(at("America/New_York", wall(2026, 3, 8, 2, 30))).toBe("2026-03-08T07:30:00.000Z");
  });

  it("takes the first occurrence of an ambiguous time in the autumn fold", () => {
    expect(at("Europe/Berlin", wall(2026, 10, 25, 2, 30))).toBe("2026-10-25T00:30:00.000Z");
    expect(at("America/New_York", wall(2026, 11, 1, 1, 30))).toBe("2026-11-01T05:30:00.000Z");
  });

  it("turns an instant back into the wall clock of the zone", () => {
    const berlin = ok(ianaZone("Europe/Berlin"));
    expect(instantToWall(berlin, Date.parse("2026-10-25T01:30:00Z"))).toEqual(wall(2026, 10, 25, 2, 30));
    expect(instantToWall(berlin, Date.parse("2026-10-25T00:30:00Z"))).toEqual(wall(2026, 10, 25, 2, 30));
    expect(instantToWall(ok(ianaZone("Asia/Kolkata")), Date.parse("2026-07-01T03:30:00Z"))).toEqual(
      wall(2026, 7, 1, 9),
    );
    expect(instantToWall(utcZone, 0)).toEqual(wall(1970, 1, 1));
  });
});

describe("ianaZone", () => {
  it("knows IANA names and rejects others", () => {
    expect(ok(ianaZone("Europe/Berlin")).id).toBe("Europe/Berlin");
    const bad = ianaZone("Nowhere/Land");
    expect(Result.isFailure(bad) && bad.failure.message).toMatch(/Nowhere\/Land/);
  });
});

describe("zoneFromVtimezone", () => {
  it("evaluates STANDARD and DAYLIGHT rules", () => {
    const zone: Zone = ok(zoneFromVtimezone(vtimezone("TZID:Custom Berlin", ...berlinRules)));
    expect(zone.id).toBe("Custom Berlin");
    expect(zone.offsetMinutes(Date.parse("2026-01-15T12:00:00Z"))).toBe(60);
    expect(zone.offsetMinutes(Date.parse("2026-07-01T12:00:00Z"))).toBe(120);
    expect(zone.offsetMinutes(Date.parse("2026-03-29T00:59:59Z"))).toBe(60);
    expect(zone.offsetMinutes(Date.parse("2026-03-29T01:00:00Z"))).toBe(120);
    expect(zone.offsetMinutes(Date.parse("1960-01-01T00:00:00Z"))).toBe(60);
    expect(iso(wallToInstant(zone, wall(2026, 3, 29, 2, 30)))).toBe("2026-03-29T01:30:00.000Z");
    expect(iso(wallToInstant(zone, wall(2026, 10, 25, 2, 30)))).toBe("2026-10-25T00:30:00.000Z");
  });

  it("supports RDATE transitions, negative and second-precise offsets", () => {
    const zone = ok(
      zoneFromVtimezone(
        vtimezone(
          "TZID:Odd",
          "BEGIN:STANDARD",
          "DTSTART:19700101T000000",
          "TZOFFSETFROM:-0330",
          "TZOFFSETTO:-0330",
          "END:STANDARD",
          "BEGIN:DAYLIGHT",
          "DTSTART:20260301T000000",
          "RDATE:20270301T000000",
          "TZOFFSETFROM:-0330",
          "TZOFFSETTO:-023000",
          "END:DAYLIGHT",
        ),
      ),
    );
    expect(zone.offsetMinutes(Date.parse("2026-02-01T00:00:00Z"))).toBe(-210);
    expect(zone.offsetMinutes(Date.parse("2026-06-01T00:00:00Z"))).toBe(-150);
  });

  it("rejects a VTIMEZONE without TZID", () => {
    const r = zoneFromVtimezone(
      vtimezone(
        "BEGIN:STANDARD",
        "DTSTART:19700101T000000",
        "TZOFFSETFROM:+0000",
        "TZOFFSETTO:+0100",
        "END:STANDARD",
      ),
    );
    expect(Result.isFailure(r) && r.failure.message).toMatch(/no TZID/);
  });

  it("rejects a VTIMEZONE without rules, offsets or DTSTART", () => {
    const msg = (r: Result.Result<Zone, { message: string }>): string =>
      Result.isFailure(r) ? r.failure.message : "";
    expect(msg(zoneFromVtimezone(vtimezone("TZID:Empty")))).toMatch(/no rules/);
    expect(
      msg(
        zoneFromVtimezone(
          vtimezone(
            "TZID:X",
            "BEGIN:STANDARD",
            "DTSTART:19700101T000000",
            "TZOFFSETFROM:+0100",
            "END:STANDARD",
          ),
        ),
      ),
    ).toMatch(/TZOFFSETTO/);
    expect(
      msg(
        zoneFromVtimezone(
          vtimezone("TZID:X", "BEGIN:STANDARD", "TZOFFSETFROM:+0100", "TZOFFSETTO:+0200", "END:STANDARD"),
        ),
      ),
    ).toMatch(/DTSTART/);
  });
});

describe("resolveZone", () => {
  it("prefers the VTIMEZONE of the file", () => {
    const custom = vtimezone(
      "TZID:Europe/Berlin",
      "BEGIN:STANDARD",
      "DTSTART:19700101T000000",
      "TZOFFSETFROM:+0300",
      "TZOFFSETTO:+0300",
      "END:STANDARD",
    );
    const zone = ok(resolveZone("Europe/Berlin", [custom]));
    expect(zone.offsetMinutes(Date.parse("2026-01-01T00:00:00Z"))).toBe(180);
  });

  it("uses IANA without a VTIMEZONE, and reports an unusable VTIMEZONE instead of guessing", () => {
    expect(ok(resolveZone("America/New_York", [])).id).toBe("America/New_York");
    const broken = vtimezone("TZID:Europe/Berlin");
    const r = resolveZone("Europe/Berlin", [broken]);
    expect(Result.isFailure(r) && r.failure.message).toMatch(/no rules/);
  });

  it("maps Windows names", () => {
    const zone = ok(resolveZone("W. Europe Standard Time", []));
    expect(zone.offsetMinutes(Date.parse("2026-07-01T00:00:00Z"))).toBe(120);
    expect(Object.values(WINDOWS_ZONES).every((z) => Result.isSuccess(ianaZone(z)))).toBe(true);
  });

  it("knows the Windows zones that used to be missing", () => {
    const wanted: Record<string, string> = {
      "UTC+12": "Etc/GMT-12",
      "UTC+13": "Etc/GMT-13",
      "UTC-02": "Etc/GMT+2",
      "UTC-08": "Etc/GMT+8",
      "UTC-09": "Etc/GMT+9",
      "Ekaterinburg Standard Time": "Asia/Yekaterinburg",
      "North Asia Standard Time": "Asia/Krasnoyarsk",
      "North Asia East Standard Time": "Asia/Irkutsk",
      "Magadan Standard Time": "Asia/Magadan",
      "Jordan Standard Time": "Asia/Amman",
      "Georgian Standard Time": "Asia/Tbilisi",
      "Mauritius Standard Time": "Indian/Mauritius",
      "Morocco Standard Time": "Africa/Casablanca",
      "Belarus Standard Time": "Europe/Minsk",
      "Montevideo Standard Time": "America/Montevideo",
      "Lord Howe Standard Time": "Australia/Lord_Howe",
      "Chatham Islands Standard Time": "Pacific/Chatham",
      "Kaliningrad Standard Time": "Europe/Kaliningrad",
      "Cuba Standard Time": "America/Havana",
      "Russia Time Zone 3": "Europe/Samara",
      "Russia Time Zone 10": "Asia/Srednekolymsk",
      "Russia Time Zone 11": "Asia/Kamchatka",
    };
    for (const [windows, iana] of Object.entries(wanted)) {
      expect(WINDOWS_ZONES[windows]).toBe(iana);
      expect(ok(resolveZone(windows, [])).id).toBe(iana);
    }
    // every mapped zone is a real one, and each name is a plain string key
    expect(Object.keys(WINDOWS_ZONES).length).toBeGreaterThan(130);
    expect(Object.values(WINDOWS_ZONES).every((z) => Result.isSuccess(ianaZone(z)))).toBe(true);
  });

  it("gives the VTIMEZONE of the file precedence over IANA and Windows names", () => {
    const fixed = (tzid: string) =>
      vtimezone(
        `TZID:${tzid}`,
        "BEGIN:STANDARD",
        "DTSTART:19700101T000000",
        "TZOFFSETFROM:+0300",
        "TZOFFSETTO:+0300",
        "END:STANDARD",
      );
    const at2026 = Date.parse("2026-07-01T00:00:00Z");
    expect(
      ok(resolveZone("W. Europe Standard Time", [fixed("W. Europe Standard Time")])).offsetMinutes(at2026),
    ).toBe(180);
    expect(ok(resolveZone("America/New_York", [fixed("America/New_York")])).offsetMinutes(at2026)).toBe(180);
    // a VTIMEZONE of another name does not count
    expect(ok(resolveZone("America/New_York", [fixed("Europe/Berlin")])).offsetMinutes(at2026)).toBe(-240);
  });

  it("rejects an unknown TZID naming it, never reading it as floating", () => {
    const r = resolveZone("Mars/Olympus", []);
    expect(Result.isFailure(r) && r.failure.message).toMatch(/"Mars\/Olympus"/);
  });
});
