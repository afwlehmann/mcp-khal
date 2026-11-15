import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { events, isMaster, prop, props, unfoldLines } from "./ics.js";
import { respondLines, respondToEvent, withParam } from "./respondEvent.js";
import { failure, removeDir, runFail, runOk, tempDir, testSettings, unwrap } from "./testlib.js";

const NOW = new Date("2030-01-01T10:00:00Z");
const ME = "me@example.com";
const HOST = "Europe/Berlin";

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
const respond = (lines: readonly string[], p: object, address = ME) =>
  respondLines(lines, { ...base, response: "accepted", ...p }, address, NOW, HOST);

describe("withParam", () => {
  it("sets a parameter in place, adds it when missing, and does not look inside quotes", () => {
    expect(withParam(";ROLE=CHAIR;PARTSTAT=NEEDS-ACTION;RSVP=TRUE", "PARTSTAT", "ACCEPTED")).toBe(
      ";ROLE=CHAIR;PARTSTAT=ACCEPTED;RSVP=TRUE",
    );
    expect(withParam(";CN=x", "PARTSTAT", "DECLINED")).toBe(";CN=x;PARTSTAT=DECLINED");
    expect(withParam("", "PARTSTAT", "DECLINED")).toBe(";PARTSTAT=DECLINED");
    expect(withParam(';CN="a;PARTSTAT=x";partstat=A;PARTSTAT=B', "PARTSTAT", "T")).toBe(
      ';CN="a;PARTSTAT=x";PARTSTAT=T',
    );
    expect(withParam(";X-NUM-GUESTS=2;ROLE", "PARTSTAT", "T")).toBe(";X-NUM-GUESTS=2;ROLE;PARTSTAT=T");
  });
});

describe("respondLines", () => {
  it("sets the user's status only, keeping every parameter, the order and SEQUENCE", () => {
    const out = unwrap(respond(invite(), {}));
    expect(status(main(out))).toEqual({
      "mailto:Me@Example.com": "ACCEPTED",
      "mailto:other@example.com": "NEEDS-ACTION",
    });
    const mine = props(main(out), "ATTENDEE")[0];
    expect(mine?.params).toBe(';CN="Me: Myself";ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;RSVP=TRUE');
    expect(props(main(out), "ATTENDEE")[1]?.params).toContain("RSVP=TRUE");
    expect(prop(main(out), "SEQUENCE")?.value).toBe("3");
    expect(prop(main(out), "DTSTAMP")?.value).toBe("20300101T100000Z");
    expect(prop(main(out), "LAST-MODIFIED")?.value).toBe("20300101T100000Z");
  });

  it.each([
    ["declined", "DECLINED"],
    ["tentative", "TENTATIVE"],
  ] as const)("writes %s as %s", (response, partstat) => {
    const out = unwrap(respond(invite(), { response }));
    expect(status(main(out))["mailto:Me@Example.com"]).toBe(partstat);
  });

  it("answers for the series only: exceptions keep their own answer", () => {
    const exception = (date: string): string[] => [
      "BEGIN:VEVENT",
      "UID:i1",
      `RECURRENCE-ID:${date}T090000`,
      "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:me@example.com",
      "END:VEVENT",
    ];
    const lines = invite([...exception("20301017")], "FREQ=DAILY");
    const out = unwrap(respond(lines, { response: "declined" }));
    const [first, second] = events(out);
    expect(status(first ?? [])["mailto:Me@Example.com"]).toBe("DECLINED");
    expect(status(second ?? [])).toEqual({ "mailto:me@example.com": "NEEDS-ACTION" });
  });

  it("answers one occurrence by writing an exception, leaving the series alone", () => {
    const lines = invite([], "FREQ=DAILY");
    const out = unwrap(respond(lines, { response: "declined", scope: "instance", date: "2030-10-18" }));
    const [first, exception, ...rest] = events(out);
    expect(rest).toEqual([]);
    expect(first).toEqual(main(lines));
    expect(prop(exception ?? [], "RECURRENCE-ID")?.value).toBe("20301018T090000");
    expect(status(exception ?? [])).toEqual({
      "mailto:Me@Example.com": "DECLINED",
      "mailto:other@example.com": "NEEDS-ACTION",
    });
    expect(prop(exception ?? [], "SEQUENCE")?.value).toBe("3");
    expect(prop(exception ?? [], "DTSTAMP")?.value).toBe("20300101T100000Z");
    // a second answer changes that exception instead of adding one
    const again = unwrap(respond(out, { response: "accepted", scope: "instance", date: "2030-10-18" }));
    expect(events(again)).toHaveLength(2);
    expect(status(events(again)[1] ?? [])["mailto:Me@Example.com"]).toBe("ACCEPTED");
  });

  it("refuses when the user is not invited, the answer or the scope is wrong, or there is no organizer", () => {
    const message = (p: object, address = ME, lines = invite()) =>
      failure(respond(lines, p, address)).message;
    expect(message({}, "nobody@example.com")).toMatch(/nobody@example.com is not invited/);
    expect(message({ response: "maybe" })).toMatch(/must be accepted, declined or tentative/);
    expect(message({ scope: "instance" })).toMatch(/needs the date/);
    expect(message({ scope: "from_date", date: "2030-10-18" })).toMatch(/'all' or 'instance'/);
    expect(message({ scope: "instance", date: "2030-10-18" })).toMatch(/not a recurring event/);
    expect(message({}, ME, ["BEGIN:VCALENDAR", "END:VCALENDAR"])).toMatch(/no main event/);
    expect(message({ scope: "instance", date: "2030-10-18" }, "x@y.zz", invite([], "FREQ=DAILY"))).toMatch(
      /not invited/,
    );
    const noOrganizer = invite().filter((l) => !l.startsWith("ORGANIZER"));
    expect(message({}, ME, noOrganizer)).toMatch(/no ORGANIZER/);
    expect(
      message({}, ME, [...invite().slice(0, -1), "BEGIN:VTODO", "UID:i1", "END:VTODO", "END:VCALENDAR"]),
    ).toMatch(/VTODO/);
  });

  it("strips a METHOD line the file carries from an invitation mail", () => {
    const lines = ["BEGIN:VCALENDAR", "METHOD:REQUEST", ...invite().slice(1)];
    expect(unwrap(respond(lines, {})).some((l) => l.startsWith("METHOD"))).toBe(false);
  });
});

describe("respondToEvent", () => {
  let dir: string;
  let vdir: string;
  const settings = () => testSettings({ calendars: { work: { path: vdir, email: ME } } });

  beforeEach(async () => {
    dir = await tempDir();
    vdir = join(dir, "work");
    await mkdir(vdir);
    await writeFile(join(vdir, "i1.ics"), `${invite([], "FREQ=DAILY").join("\r\n")}\r\n`);
  });
  afterEach(async () => {
    await removeDir(dir);
  });

  const stored = async () => unfoldLines(await readFile(join(vdir, "i1.ics"), "utf8"));

  it("answers for the whole event with the calendar's own address", async () => {
    const out = await runOk(respondToEvent(settings(), { ...base, response: "accepted" }, NOW));
    expect(out).toBe(
      "Marked me@example.com as accepted for event i1 in calendar work. No reply was sent to the organizer.\n",
    );
    expect(status(main(await stored()))["mailto:Me@Example.com"]).toBe("ACCEPTED");
  });

  it("answers for one occurrence when that day is one", async () => {
    const s = settings();
    const out = await runOk(
      respondToEvent(s, { ...base, response: "declined", scope: "instance", date: "2030-10-18" }, NOW),
    );
    expect(out).toMatch(/for the occurrence on 2030-10-18 of event i1/);
    expect(events(await stored())).toHaveLength(2);
  });

  it("refuses a day that is no occurrence, an unknown address and a bad scope, writing nothing", async () => {
    const before = await readFile(join(vdir, "i1.ics"), "utf8");
    const s = settings();
    // the series starts on 16 Oct: the 15th is no occurrence
    const instance = { ...base, response: "declined", scope: "instance", date: "2030-10-15" } as const;
    expect((await runFail(respondToEvent(s, instance, NOW))).message).toBe(
      "event i1 has no occurrence on 2030-10-15",
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
