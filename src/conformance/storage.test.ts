import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serialize, stripMethod } from "../ics.js";
import { readCalendar } from "../reader.js";
import { itReq, outcome, runFail, runOk, type Sandbox, sandbox } from "../testlib.js";
import {
  createEvent,
  findEvent,
  isEventFile,
  newFileIn,
  readIcsFile,
  tempNameIn,
  vdirOf,
  writeEvent,
} from "../vdir.js";

// vdir storage rules (vdirsyncer's vdir spec), RFC 4791 section 4.1 and 5.3.2 for stored objects,
// and the METHOD policy. Every test works in a temporary sandbox.

const event = (uid: string, ...extra: string[]): string[] => [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//test//EN",
  "BEGIN:VEVENT",
  `UID:${uid}`,
  "DTSTAMP:20300101T000000Z",
  "DTSTART:20300116T090000Z",
  "SUMMARY:s",
  ...extra,
  "END:VEVENT",
  "END:VCALENDAR",
];

const bytesOf = (lines: readonly string[]): string => serialize(lines);

let sb: Sandbox;
let dir: string;
beforeEach(async () => {
  sb = await sandbox();
  dir = await sb.vdir("work");
});
afterEach(() => sb.cleanup());

const put = (name: string, lines: readonly string[] | string): Promise<void> =>
  writeFile(join(dir, name), typeof lines === "string" ? lines : bytesOf(lines));

const names = (): Promise<string[]> => readdir(dir).then((n) => n.sort());

const find = (uid: string) =>
  Effect.flatMap(
    Effect.promise(() => sb.settings(["work"])),
    (settings) => findEvent(settings, "work", uid),
  );

describe("which files are items", () => {
  itReq(
    ["VDIR:ics-extension", "VDIR:ignore-tmp-and-no-extension", "VDIR:metadata-files-no-extension"],
    "only *.ics files are events; *.tmp files and files without extension (color, displayname) are not",
    async () => {
      await put("x.ics", event("x"));
      await put("y.ics.tmp", event("y"));
      await put("color", "#FF8800");
      await put("displayname", "Work");
      await put(".hidden.ics", event("h"));
      const stale = bytesOf(event("y"));
      const r = await Effect.runPromise(readCalendar(dir));
      expect(r.events.map((e) => e.uid)).toEqual(["x"]);
      expect(r.problems).toEqual([]);
      expect(await readFile(join(dir, "y.ics.tmp"), "utf8")).toBe(stale); // neither read nor deleted
      expect(["x.ics", "X.ICS"].every(isEventFile)).toBe(true);
      expect(["y.ics.tmp", "color", ".a.ics"].some(isEventFile)).toBe(false);
    },
  );

  itReq(
    "VDIR:collection-contains-only-items",
    "sub-directories of the calendar directory are not scanned",
    async () => {
      await mkdir(join(dir, "sub"));
      await writeFile(join(dir, "sub", "z.ics"), bytesOf(event("z")));
      await mkdir(join(dir, "folder.ics"));
      await put("x.ics", event("x"));
      expect((await Effect.runPromise(readCalendar(dir))).events.map((e) => e.uid)).toEqual(["x"]);
      expect((await runFail(find("z"))).message).toMatch(/no event with uid 'z'/);
    },
  );
});

describe("files and UIDs", () => {
  itReq(
    [
      "VDIR:filename-no-requirement",
      "RFC4791:5.3.2:url-arbitrary",
      "VDIR:filename-metadata-not-preserved",
      "VDIR:keep-original-filename",
    ],
    "an event is found by UID whatever the file is called, renaming does not change it, edits keep the name",
    async () => {
      await put("abc.ics", event("xyz"));
      const first = await runOk(find("xyz"));
      expect(first.file).toBe(join(dir, "abc.ics"));
      await rename(join(dir, "abc.ics"), join(dir, "renamed.ics"));
      const second = await runOk(find("xyz"));
      expect(second.file).toBe(join(dir, "renamed.ics"));
      await runOk(
        writeEvent(
          second.file,
          second.lines.map((l) => (l === "SUMMARY:s" ? "SUMMARY:t" : l)),
          second.etag,
        ),
      );
      expect(await names()).toEqual(["renamed.ics"]); // no .bak, no rename to <uid>.ics
      expect(await readFile(join(dir, "renamed.ics"), "utf8")).toContain("SUMMARY:t\r\n");
    },
  );

  itReq(
    ["RFC4791:3.2:recurrence-single-resource", "VDIR:recurrence-exceptions-in-same-file"],
    "a series with two exceptions is one file with three VEVENTs of one UID",
    async () => {
      const two = [
        ...event("series", "RRULE:FREQ=DAILY").slice(0, -1),
        "BEGIN:VEVENT",
        "UID:series",
        "RECURRENCE-ID:20300117T090000Z",
        "DTSTAMP:20300101T000000Z",
        "DTSTART:20300117T100000Z",
        "END:VEVENT",
        "BEGIN:VEVENT",
        "UID:series",
        "RECURRENCE-ID:20300118T090000Z",
        "DTSTAMP:20300101T000000Z",
        "DTSTART:20300118T100000Z",
        "END:VEVENT",
        "END:VCALENDAR",
      ];
      await put("series.ics", two);
      const r = await Effect.runPromise(readCalendar(dir));
      expect(r.problems).toEqual([]);
      expect(r.events.map((e) => [e.uid, e.lines.filter((l) => l === "BEGIN:VEVENT").length])).toEqual([
        ["series", 3],
      ]);
      expect((await runOk(find("series"))).file).toBe(join(dir, "series.ics"));
    },
  );

  itReq(
    [
      "RFC4791:4.1:different-uid-separate-resource",
      "VDIR:uid-values-equal",
      "POLICY:refuse-multi-uid-or-multi-type-files",
    ],
    "a file with two UIDs is refused for editing, naming the reason",
    async () => {
      const two = [
        ...event("a").slice(0, -1),
        "BEGIN:VEVENT",
        "UID:b",
        "DTSTAMP:20300101T000000Z",
        "END:VEVENT",
        "END:VCALENDAR",
      ];
      await put("two.ics", two);
      for (const uid of ["a", "b"]) {
        const e = await runFail(find(uid));
        expect(e.message).toMatch(/cannot be edited: several UIDs in one file \(a, b\)/);
      }
      const r = await Effect.runPromise(readCalendar(dir));
      expect(r.events).toEqual([]);
      expect(r.problems[0]).toContain("several UIDs in one file (a, b), skipped");
    },
  );

  itReq(
    ["RFC4791:4.1:one-component-type", "POLICY:refuse-multi-uid-or-multi-type-files"],
    "a file with a VEVENT and a VTODO is refused for editing",
    async () => {
      const mixed = [...event("m").slice(0, -1), "BEGIN:VTODO", "UID:m", "END:VTODO", "END:VCALENDAR"];
      await put("mixed.ics", mixed);
      expect((await runFail(find("m"))).message).toMatch(
        /cannot be edited: several component types in one file \(VEVENT, VTODO\)/,
      );
      expect((await Effect.runPromise(readCalendar(dir))).problems[0]).toContain("several component types");
    },
  );

  it("refuses a malformed file instead of copying or guessing", async () => {
    const broken = event("br").filter((l) => l !== "END:VEVENT");
    await put("broken.ics", broken);
    expect((await runFail(find("br"))).message).toMatch(/cannot be edited: malformed \(BEGIN:VEVENT/);
    const r = await Effect.runPromise(readCalendar(dir));
    expect(r.problems[0]).toMatch(/malformed \(BEGIN:VEVENT .* has no matching END:VEVENT/);
  });

  it("reports the same UID in two files instead of picking one", async () => {
    await put("a.ics", event("dup"));
    await put("b.ics", event("dup"));
    const e = await runFail(find("dup"));
    expect(e.message).toMatch(/uid 'dup' is in several files of calendar 'work' \(a\.ics, b\.ics\)/);
    expect(e.message).toMatch(/RFC 4791 4\.1/);
  });

  it("skips an entry it cannot use and names it when the event is not found", async () => {
    await put("good.ics", event("g"));
    await symlink(join(dir, "missing-target"), join(dir, "dangling.ics"));
    await writeFile(join(dir, "binary.ics"), Buffer.from([0x42, 0x3a, 0xff, 0xfe, 0x0a]));
    expect((await runOk(find("g"))).file).toBe(join(dir, "good.ics"));
    const e = await runFail(find("nope"));
    expect(e.message).toMatch(
      /no event with uid 'nope' in calendar 'work' \(1 file could not be used and may hold it: binary\.ics: the file is not valid UTF-8\)/,
    );
  });

  it("lists at most five unusable files in the message", async () => {
    await Promise.all(
      ["a", "b", "c", "d", "e", "f"].map((n) => writeFile(join(dir, `${n}.ics`), Buffer.from([0xff, 0xfe]))),
    );
    const e = await runFail(find("nope"));
    expect(e.message).toMatch(/6 files could not be used.*; \.\.\.\)$/);
  });

  it("does not look at a vanished or non-regular entry", async () => {
    await mkdir(join(dir, "d.ics"));
    await put("ok.ics", event("ok"));
    expect((await runOk(find("ok"))).file).toBe(join(dir, "ok.ics"));
    expect(await readIcsFile(join(dir, "d.ics"))).toEqual({ kind: "ignored" });
  });
});

describe("writing", () => {
  itReq(
    "VDIR:atomic-write",
    "a write replaces the file by rename of a fsynced temporary file and leaves nothing behind",
    async () => {
      await put("a.ics", event("a"));
      const stored = await runOk(find("a"));
      const next = stored.lines.map((l) => (l === "SUMMARY:s" ? "SUMMARY:new" : l));
      await runOk(writeEvent(stored.file, next, stored.etag));
      expect(await names()).toEqual(["a.ics"]);
      expect(await readFile(stored.file, "utf8")).toBe(bytesOf(next));
    },
  );

  itReq(
    "VDIR:atomic-write",
    "a refused write leaves the old content intact and no temporary file",
    async () => {
      await put("a.ics", event("a"));
      const before = await readFile(join(dir, "a.ics"), "utf8");
      const e = await runFail(writeEvent(join(dir, "a.ics"), event("other")));
      expect(e.message).toMatch(/its UID would change from a to other/);
      expect(await readFile(join(dir, "a.ics"), "utf8")).toBe(before);
      expect(await names()).toEqual(["a.ics"]);
    },
  );

  itReq(
    "VDIR:tmp-files-allowed",
    "the temporary file is hidden, unique, next to the target and ends in .tmp",
    () => {
      const t = tempNameIn("/v/abc.ics", "0123");
      expect(t).toBe("/v/.abc.ics.0123.mcp-khal.tmp");
      expect(isEventFile(".abc.ics.0123.mcp-khal.tmp")).toBe(false);
      expect(tempNameIn("/v/abc.ics", "4567")).not.toBe(t);
    },
  );

  itReq(
    "RFC4791:5.3.2.1:no-uid-change-on-overwrite",
    "a write never changes the UID inside the file",
    async () => {
      await put("a.ics", event("a"));
      const same = await runOk(find("a"));
      await runOk(writeEvent(same.file, event("a", "LOCATION:x"), same.etag));
      expect(await readFile(same.file, "utf8")).toContain("LOCATION:x");
      expect((await runFail(writeEvent(same.file, event("b")))).message).toMatch(
        /UID would change from a to b/,
      );
      expect((await runFail(writeEvent(same.file, ["BEGIN:VCALENDAR", "END:VCALENDAR"]))).message).toMatch(
        /from a to none/,
      );
      expect(await readFile(same.file, "utf8")).toContain("UID:a\r\n");
    },
  );

  it("replaces a file only if it still has the content it was read with", async () => {
    await put("a.ics", event("a"));
    const stored = await runOk(find("a"));
    await put("a.ics", event("a", "LOCATION:someone else"));
    const e = await runFail(writeEvent(stored.file, event("a", "LOCATION:me"), stored.etag));
    expect(e._tag).toBe("InvalidInput");
    expect(e.message).toMatch(/a\.ics was changed by someone else after it was read; nothing was written/);
    expect(await readFile(stored.file, "utf8")).toContain("LOCATION:someone else");
    expect(await names()).toEqual(["a.ics"]);
  });

  it("notices a change of the modification time alone", async () => {
    await put("a.ics", event("a"));
    const stored = await runOk(find("a"));
    const later = new Date(Date.now() + 60_000);
    await utimes(stored.file, later, later);
    expect((await runFail(writeEvent(stored.file, stored.lines, stored.etag))).message).toMatch(
      /changed by someone else/,
    );
  });

  it("refuses to write when the file was deleted meanwhile, but a write without etag creates it", async () => {
    await put("a.ics", event("a"));
    const stored = await runOk(find("a"));
    await rm(stored.file);
    expect((await runFail(writeEvent(stored.file, stored.lines, stored.etag))).message).toMatch(
      /changed by someone else/,
    );
    expect(await names()).toEqual([]);
    await runOk(writeEvent(stored.file, stored.lines));
    expect(await names()).toEqual(["a.ics"]);
  });

  it("keeps the mode of the file", async () => {
    await put("a.ics", event("a"));
    await chmod(join(dir, "a.ics"), 0o600);
    const stored = await runOk(find("a"));
    await runOk(writeEvent(stored.file, stored.lines, stored.etag));
    expect((await stat(stored.file)).mode & 0o777).toBe(0o600);
  });

  it("does not follow a planted symlink at the old temporary name", async () => {
    await put("a.ics", event("a"));
    const victim = join(sb.dir, "victim");
    await writeFile(victim, "precious");
    await symlink(victim, join(dir, ".a.ics.mcp-khal.tmp"));
    const stored = await runOk(find("a"));
    await runOk(writeEvent(stored.file, stored.lines, stored.etag));
    expect(await readFile(victim, "utf8")).toBe("precious");
  });

  it("refuses to write a calendar with unbalanced BEGIN/END, in both write functions", async () => {
    const broken = event("a").filter((l) => l !== "END:VEVENT");
    await put("a.ics", event("a"));
    const before = await readFile(join(dir, "a.ics"), "utf8");
    expect((await runFail(writeEvent(join(dir, "a.ics"), broken))).message).toMatch(
      /refusing to write a malformed calendar/,
    );
    expect((await runFail(createEvent(join(dir, "n.ics"), broken))).message).toMatch(
      /refusing to write a malformed calendar/,
    );
    expect(await readFile(join(dir, "a.ics"), "utf8")).toBe(before);
    expect(await names()).toEqual(["a.ics"]);
  });

  it("fails with an I/O error when the directory is missing, leaving nothing behind", async () => {
    expect((await runFail(writeEvent(join(dir, "missing", "x.ics"), event("x"))))._tag).toBe("IoError");
    expect((await runFail(createEvent(join(dir, "missing", "x.ics"), event("x"))))._tag).toBe("IoError");
  });

  it("vdirOf names a configured calendar's directory", async () => {
    expect(vdirOf(await sb.settings(["work"]), "work")).toBe(dir);
  });
});

describe("creating", () => {
  itReq(
    ["RFC4791:5.3.2:create-only-if-absent", "POLICY:new-event-filename-and-uid"],
    "a new file is created exclusively; an existing one is never overwritten, even by two parallel creates",
    async () => {
      await put("taken.ics", event("t"));
      const before = await readFile(join(dir, "taken.ics"), "utf8");
      expect((await runFail(createEvent(join(dir, "taken.ics"), event("other"))))._tag).toBe("IoError");
      expect(await readFile(join(dir, "taken.ics"), "utf8")).toBe(before);
      const results = await Promise.all(
        ["one", "two"].map((uid) => outcome(createEvent(join(dir, "race.ics"), event(uid)))),
      );
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect((await names()).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    },
  );

  itReq(
    ["VDIR:filename-similar-to-uid", "POLICY:new-event-filename-and-uid"],
    "a new file name is a plain name from [A-Za-z0-9._@-] inside the directory",
    () => {
      expect(newFileIn("/v", "3f2a-b1@mcp-khal.ics")).toBe("/v/3f2a-b1@mcp-khal.ics");
      for (const bad of ["../x.ics", "a/b.ics", ".x.ics", "a b.ics", ""])
        expect(typeof newFileIn("/v", bad)).not.toBe("string");
    },
  );

  it("creates the file with hard links unavailable (O_EXCL fallback) and still never overwrites", async () => {
    const noLinks = (code: string) => () =>
      Promise.reject(Object.assign(new Error(`no links (${code})`), { code }));
    await runOk(createEvent(join(dir, "n.ics"), event("n"), noLinks("EPERM")));
    expect(await readFile(join(dir, "n.ics"), "utf8")).toBe(bytesOf(event("n")));
    expect((await runFail(createEvent(join(dir, "n.ics"), event("m"), noLinks("EXDEV"))))._tag).toBe(
      "IoError",
    );
    expect(await readFile(join(dir, "n.ics"), "utf8")).toBe(bytesOf(event("n")));
    expect(await names()).toEqual(["n.ics"]);
  });

  it("reports a hard link failure that is not about missing support", async () => {
    const denied = () => Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" }));
    expect((await runFail(createEvent(join(dir, "n.ics"), event("n"), denied)))._tag).toBe("IoError");
    expect(await names()).toEqual([]);
  });
});

describe("METHOD", () => {
  const invitation = event("inv").flatMap((l) => (l === "VERSION:2.0" ? [l, "METHOD:REQUEST"] : [l]));

  itReq(
    ["POLICY:strip-method-on-write", "RFC4791:4.1:no-method"],
    "stored files carry no METHOD: it is stripped on write and on create",
    async () => {
      expect(stripMethod(invitation)).toEqual(event("inv"));
      await put("inv.ics", invitation);
      const stored = await runOk(find("inv"));
      await runOk(writeEvent(stored.file, stored.lines, stored.etag));
      expect(await readFile(stored.file, "utf8")).not.toContain("METHOD");
      await runOk(
        createEvent(
          join(dir, "new.ics"),
          invitation.map((l) => (l === "UID:inv" ? "UID:new" : l)),
        ),
      );
      const created = await readFile(join(dir, "new.ics"), "utf8");
      expect(created).not.toContain("METHOD");
      expect(created).toContain("BEGIN:VEVENT\r\nUID:new\r\n");
    },
  );

  itReq(
    "POLICY:tolerate-method-on-read",
    "a file with METHOD:PUBLISH is listed and found like any other",
    async () => {
      await put(
        "pub.ics",
        event("pub").flatMap((l) => (l === "VERSION:2.0" ? [l, "METHOD:PUBLISH"] : [l])),
      );
      const r = await Effect.runPromise(readCalendar(dir));
      expect(r.events.map((e) => e.uid)).toEqual(["pub"]);
      expect(r.problems).toEqual([]);
      expect((await runOk(find("pub"))).file).toBe(join(dir, "pub.ics"));
    },
  );

  it("keeps a METHOD-like property that is not the calendar's own", () => {
    const lines = event("k", "X-METHOD:keep", "COMMENT:METHOD:x");
    expect(stripMethod(lines)).toEqual(lines);
  });
});
