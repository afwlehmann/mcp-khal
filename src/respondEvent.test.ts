import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { events, isMaster, prop, props, unfoldLines } from "./ics.js";
import { respondLines, respondToEvent } from "./respondEvent.js";
import { failure, fakeKhal, removeDir, runFail, runOk, tempDir, unwrap } from "./testlib.js";

const NOW = new Date("2030-01-01T10:00:00Z");
const ME = "me@example.com";

const invite = (extra: string[] = [], rule?: string): string[] => [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "UID:i1",
  "SEQUENCE:3",
  "DTSTAMP:20291201T000000Z",
  "SUMMARY:Review",
  "DTSTART:20301016T090000",
  "DTEND:20301016T100000",
  ...(rule === undefined ? [] : [`RRULE:${rule}`]),
  "ORGANIZER:mailto:boss@example.com",
  'ATTENDEE;CN="Me: Myself";ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:Me@Example.com',
  "ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:other@example.com",
  "END:VEVENT",
  ...extra,
  "END:VCALENDAR",
];

const base = { calendar: "work", uid: "i1" };
const main = (lines: readonly string[]) => events(lines).find(isMaster) ?? [];
const status = (event: readonly string[]) =>
  Object.fromEntries(
    props(event, "ATTENDEE").map((p) => [p.value, /PARTSTAT=([A-Z-]+)/.exec(p.params)?.[1]]),
  );

describe("respondLines", () => {
  it("sets the user's status only, keeps the other parameters and SEQUENCE, and drops the RSVP request", () => {
    const out = unwrap(respondLines(invite(), { ...base, response: "accepted" }, ME, NOW));
    expect(status(main(out))).toEqual({
      "mailto:Me@Example.com": "ACCEPTED",
      "mailto:other@example.com": "NEEDS-ACTION",
    });
    const mine = props(main(out), "ATTENDEE")[0];
    expect(mine?.params).toBe(';CN="Me: Myself";ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED');
    expect(props(main(out), "ATTENDEE")[1]?.params).toContain("RSVP=TRUE");
    expect(prop(main(out), "SEQUENCE")?.value).toBe("3");
    expect(prop(main(out), "DTSTAMP")?.value).toBe("20300101T100000Z");
    expect(prop(main(out), "LAST-MODIFIED")?.value).toBe("20300101T100000Z");
  });

  it.each([
    ["declined", "DECLINED"],
    ["tentative", "TENTATIVE"],
  ] as const)("writes %s as %s", (response, partstat) => {
    const out = unwrap(respondLines(invite(), { ...base, response }, ME, NOW));
    expect(status(main(out))["mailto:Me@Example.com"]).toBe(partstat);
  });

  it("answers the exceptions of a series that list the user, and leaves the others", () => {
    const exception = (date: string, withMe: boolean): string[] => [
      "BEGIN:VEVENT",
      "UID:i1",
      `RECURRENCE-ID:${date}T090000`,
      ...(withMe ? ["ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:me@example.com"] : []),
      "END:VEVENT",
    ];
    const lines = invite([...exception("20301017", true), ...exception("20301018", false)], "FREQ=DAILY");
    const out = unwrap(respondLines(lines, { ...base, response: "declined" }, ME, NOW));
    const [, withMe, without] = events(out);
    expect(status(withMe ?? [])).toEqual({ "mailto:me@example.com": "DECLINED" });
    expect(props(without ?? [], "ATTENDEE")).toEqual([]);
  });

  it("answers one occurrence by writing an exception, leaving the series alone", () => {
    const lines = invite([], "FREQ=DAILY");
    const out = unwrap(
      respondLines(lines, { ...base, response: "declined", scope: "instance", date: "2030-10-18" }, ME, NOW),
    );
    const [first, exception, ...rest] = events(out);
    expect(rest).toEqual([]);
    expect(status(first ?? [])).toEqual({
      "mailto:Me@Example.com": "NEEDS-ACTION",
      "mailto:other@example.com": "NEEDS-ACTION",
    });
    expect(prop(exception ?? [], "RECURRENCE-ID")?.value).toBe("20301018T090000");
    expect(status(exception ?? [])["mailto:Me@Example.com"]).toBe("DECLINED");
    expect(prop(exception ?? [], "SEQUENCE")?.value).toBe("3");
    // a second answer changes that exception instead of adding one
    const again = unwrap(
      respondLines(out, { ...base, response: "accepted", scope: "instance", date: "2030-10-18" }, ME, NOW),
    );
    expect(events(again)).toHaveLength(2);
    expect(status(events(again)[1] ?? [])["mailto:Me@Example.com"]).toBe("ACCEPTED");
  });

  it("refuses when the user is not invited, or the scope is wrong", () => {
    const message = (p: object, address = ME, lines = invite()) =>
      failure(respondLines(lines, { ...base, response: "accepted", ...p }, address, NOW)).message;
    expect(message({}, "nobody@example.com")).toMatch(/nobody@example.com is not invited/);
    expect(message({ scope: "instance" })).toMatch(/needs the date/);
    expect(message({ scope: "from_date", date: "2030-10-18" })).toMatch(/'all' or 'instance'/);
    expect(message({ scope: "instance", date: "2030-10-18" })).toMatch(/not a recurring event/);
    expect(message({}, ME, ["BEGIN:VCALENDAR", "END:VCALENDAR"])).toMatch(/no main event/);
    expect(message({ scope: "instance", date: "2030-10-18" }, "x@y.zz", invite([], "FREQ=DAILY"))).toMatch(
      /not invited/,
    );
  });
});

describe("respondToEvent", () => {
  let dir: string;
  let vdir: string;
  let cleanups: (() => Promise<void>)[] = [];

  const khalLists = async (days: string[], calendars = { work: { path: "", email: ME } }) => {
    const record = (day: string) =>
      [
        ...["work", day, "09:00", day, "10:00", "Review", "", "", "", "i1"],
        ...["", "False", "False", "", ""],
      ].join("\u001f");
    const fake = await fakeKhal({ stdout: days.map((d) => `${record(d)}\u001e\n`).join("") });
    cleanups = [...cleanups, fake.cleanup];
    return fake.settings({ calendars: { work: { ...calendars.work, path: vdir } } });
  };

  beforeEach(async () => {
    dir = await tempDir();
    vdir = join(dir, "work");
    await mkdir(vdir);
    await writeFile(join(vdir, "i1.ics"), `${invite([], "FREQ=DAILY").join("\r\n")}\r\n`);
  });
  afterEach(async () => {
    await Promise.all(cleanups.map((c) => c()));
    cleanups = [];
    await removeDir(dir);
  });

  const stored = async () => unfoldLines(await readFile(join(vdir, "i1.ics"), "utf8"));

  it("answers for the whole event with the calendar's own address", async () => {
    const out = await runOk(respondToEvent(await khalLists([]), { ...base, response: "accepted" }, NOW));
    expect(out).toBe(
      "Marked me@example.com as accepted for event i1 in calendar work. No reply was sent to the organizer.\n",
    );
    expect(status(main(await stored()))["mailto:Me@Example.com"]).toBe("ACCEPTED");
  });

  it("answers for one occurrence once khal lists that day", async () => {
    const s = await khalLists(["2030-10-18"]);
    const out = await runOk(
      respondToEvent(s, { ...base, response: "declined", scope: "instance", date: "2030-10-18" }, NOW),
    );
    expect(out).toMatch(/for the occurrence on 2030-10-18 of event i1/);
    expect(events(await stored())).toHaveLength(2);
  });

  it("refuses a day that is no occurrence, an unknown address and a bad scope, writing nothing", async () => {
    const before = await readFile(join(vdir, "i1.ics"), "utf8");
    const s = await khalLists(["2030-10-21"]);
    const instance = { ...base, response: "declined", scope: "instance", date: "2030-10-18" } as const;
    expect((await runFail(respondToEvent(s, instance, NOW))).message).toBe(
      "event i1 has no occurrence on 2030-10-18",
    );
    const noAddress = testNoEmail(s);
    expect(
      (await runFail(respondToEvent(noAddress, { ...base, response: "accepted" }, NOW))).message,
    ).toMatch(/no address known for calendar 'work'/);
    expect(
      (await runFail(respondToEvent(s, { ...base, response: "accepted", scope: "instance" }, NOW))).message,
    ).toMatch(/needs the date/);
    expect(await readFile(join(vdir, "i1.ics"), "utf8")).toBe(before);
  });
});

const testNoEmail = <T extends { calendars: Record<string, { path?: string; email?: string }> }>(
  s: T,
): T => ({
  ...s,
  calendars: { work: { path: s.calendars.work?.path ?? "" } },
});
