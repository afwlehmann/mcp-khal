import { Result } from "effect";
import { describe, expect, it } from "vitest";
import { listCalendars, selectCalendars } from "./calendars.js";
import type { Calendars } from "./config.js";

const msg = (r: Result.Result<unknown, { message: string }>): string =>
  Result.match(r, { onFailure: (e) => e.message, onSuccess: () => "" });
const ok = <A>(r: Result.Result<A, unknown>): A | undefined =>
  Result.match(r, { onFailure: () => undefined, onSuccess: (a) => a });

/** calendars as a config could hand them over without the required path (defensive branch) */
const loose = (x: unknown): Calendars => x as Calendars;

describe("listCalendars", () => {
  it("sorts by name", () => {
    const r = listCalendars({ work: { path: "/w" }, Home: { path: "/h" }, alpha: { path: "/a" } });
    expect(ok(r)).toEqual([
      { name: "Home", path: "/h" },
      { name: "alpha", path: "/a" },
      { name: "work", path: "/w" },
    ]);
  });

  it("is empty without calendars", () => {
    expect(ok(listCalendars({}))).toEqual([]);
  });

  it("names a calendar without path", () => {
    expect(msg(listCalendars(loose({ a: { path: "/a" }, b: {} })))).toContain("calendar 'b' has no path");
  });

  it("names every calendar without path", () => {
    const m = msg(listCalendars(loose({ b: {}, a: { email: "a@b.de" } })));
    expect(m).toContain("calendar 'a', calendar 'b' have no path");
  });
});

describe("selectCalendars", () => {
  const cals = loose({ work: { path: "/w" }, home: { path: "/h" }, bare: {} });

  it("one calendar by name, trimmed", () => {
    expect(ok(selectCalendars(cals, " work "))).toEqual([{ name: "work", path: "/w" }]);
  });

  it("all calendars without a name", () => {
    expect(msg(selectCalendars(cals, undefined))).toContain("'bare'");
    expect(ok(selectCalendars({ b: { path: "/b" }, a: { path: "/a" } }, " "))?.map((c) => c.name)).toEqual([
      "a",
      "b",
    ]);
  });

  it("rejects an unknown calendar and lists the known ones", () => {
    expect(msg(selectCalendars(cals, "nope"))).toBe("unknown calendar 'nope' (configured: bare, home, work)");
    expect(msg(selectCalendars({}, "x"))).toContain("configured: none");
  });

  it("does not match inherited properties", () => {
    expect(msg(selectCalendars(cals, "constructor"))).toContain("unknown calendar");
  });

  it("rejects a calendar without path", () => {
    expect(msg(selectCalendars(cals, "bare"))).toContain("calendars.bare.path");
  });
});
