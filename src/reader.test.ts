import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readCalendar } from "./reader.js";
import { MAX_FILE_BYTES } from "./vdir.js";

const ics = (...uids: (string | undefined)[]): string =>
  [
    "BEGIN:VCALENDAR",
    ...uids.flatMap((u) => [
      "BEGIN:VEVENT",
      ...(u === undefined ? [] : [`UID:${u}`]),
      "SUMMARY:x",
      "END:VEVENT",
    ]),
    "END:VCALENDAR",
    "",
  ].join("\r\n");

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mcp-khal-reader-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const read = () => Effect.runPromise(readCalendar(dir));

describe("readCalendar", () => {
  it("reads .ics files sorted by path, ignoring other files, dotfiles and directories", async () => {
    await writeFile(join(dir, "b.ics"), ics("uid-b"));
    await writeFile(join(dir, "a.ICS"), ics("uid-a"));
    await writeFile(join(dir, "notes.txt"), "hi");
    await writeFile(join(dir, ".hidden.ics"), ics("h"));
    await mkdir(join(dir, "sub.ics"));
    const r = await read();
    expect(r.problems).toEqual([]);
    expect(r.events.map((e) => [e.file, e.uid])).toEqual([
      [join(dir, "a.ICS"), "uid-a"],
      [join(dir, "b.ics"), "uid-b"],
    ]);
    expect(r.events[0]?.lines).toContain("UID:uid-a");
  });

  it("accepts several events with one UID (an exception of a series)", async () => {
    await writeFile(join(dir, "s.ics"), ics("same", "same"));
    const r = await read();
    expect(r.problems).toEqual([]);
    expect(r.events.map((e) => e.uid)).toEqual(["same"]);
  });

  it("reports a file without UID or without events", async () => {
    await writeFile(join(dir, "a.ics"), ics(undefined));
    await writeFile(join(dir, "b.ics"), "garbage");
    const r = await read();
    expect(r.events).toEqual([]);
    expect(r.problems).toEqual([
      `${join(dir, "a.ics")}: no event with a UID`,
      `${join(dir, "b.ics")}: no event with a UID`,
    ]);
  });

  it("reports several UIDs in one file", async () => {
    await writeFile(join(dir, "a.ics"), ics("one", "two"));
    await writeFile(join(dir, "b.ics"), ics("one", undefined));
    const r = await read();
    expect(r.events).toEqual([]);
    expect(r.problems[0]).toContain("several UIDs in one file (one, two)");
    expect(r.problems[1]).toContain("one, <none>");
  });

  it("reports a duplicate UID across files and keeps the first file", async () => {
    await writeFile(join(dir, "a.ics"), ics("dup"));
    await writeFile(join(dir, "b.ics"), ics("dup"));
    await writeFile(join(dir, "c.ics"), ics("other"));
    const r = await read();
    expect(r.events.map((e) => e.file)).toEqual([join(dir, "a.ics"), join(dir, "c.ics")]);
    expect(r.problems).toEqual([
      `${join(dir, "b.ics")}: duplicate UID 'dup' (also in ${join(dir, "a.ics")}), skipped`,
    ]);
  });

  it("reports a file that is too big", async () => {
    await writeFile(join(dir, "big.ics"), "x".repeat(MAX_FILE_BYTES + 1));
    const r = await read();
    expect(r.events).toEqual([]);
    expect(r.problems[0]).toContain("larger than");
  });

  it("reports an unreadable file", async () => {
    await symlink(join(dir, "missing"), join(dir, "dangling.ics"));
    const r = await read();
    expect(r.events).toEqual([]);
    expect(r.problems[0]).toContain("unreadable");
  });

  it("reports a file it may not read", async () => {
    const f = join(dir, "locked.ics");
    await writeFile(f, ics("u"));
    await chmod(f, 0o000);
    const r = await read();
    if (process.getuid?.() === 0) expect(r.events).toHaveLength(1);
    else expect(r.problems[0]).toContain("unreadable");
  });

  it("reports a directory that cannot be listed, without failing", async () => {
    const r = await Effect.runPromise(readCalendar(join(dir, "nope")));
    expect(r.events).toEqual([]);
    expect(r.problems[0]).toContain("cannot list directory");
    expect(r.warnings).toEqual([]);
  });

  it("reads files with a BOM, LF or lone CR line endings and tab folds", async () => {
    const lines = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:uid-long",
      "SUMMARY:a long title",
      "END:VEVENT",
      "END:VCALENDAR",
    ];
    await writeFile(
      join(dir, "bom.ics"),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(lines.join("\r\n"))]),
    );
    await writeFile(join(dir, "lf.ics"), lines.join("\n").replace("uid-long", "uid-lf"));
    await writeFile(join(dir, "cr.ics"), lines.join("\r").replace("uid-long", "uid-cr"));
    await writeFile(
      join(dir, "tab.ics"),
      lines.join("\r\n").replace("uid-long", "uid-tab").replace("a long", "a\r\n\t long"),
    );
    const r = await read();
    expect(r.problems).toEqual([]);
    expect(r.events.map((e) => e.uid)).toEqual(["uid-long", "uid-cr", "uid-lf", "uid-tab"]);
    expect(r.events.find((e) => e.uid === "uid-tab")?.lines).toContain("SUMMARY:a long title");
  });

  it("reports a file that is not UTF-8", async () => {
    await writeFile(join(dir, "latin1.ics"), Buffer.from([0x53, 0x3a, 0xe4, 0x0a]));
    const r = await read();
    expect(r.events).toEqual([]);
    expect(r.problems).toEqual([`${join(dir, "latin1.ics")}: the file is not valid UTF-8, skipped`]);
  });

  it("reports a file with a VTODO next to the VEVENT, one with only a VTODO, and a malformed one", async () => {
    const wrap = (...body: string[]): string =>
      ["BEGIN:VCALENDAR", ...body, "END:VCALENDAR", ""].join("\r\n");
    await writeFile(
      join(dir, "mixed.ics"),
      wrap("BEGIN:VEVENT", "UID:m", "END:VEVENT", "BEGIN:VTODO", "UID:m", "END:VTODO"),
    );
    await writeFile(join(dir, "todo.ics"), wrap("BEGIN:VTODO", "UID:t", "END:VTODO"));
    await writeFile(join(dir, "open.ics"), wrap("BEGIN:VEVENT", "UID:o"));
    await writeFile(
      join(dir, "ok.ics"),
      wrap("BEGIN:X-FOO", "END:X-FOO", "BEGIN:VEVENT", "UID:ok", "END:VEVENT"),
    );
    const r = await read();
    expect(r.events.map((e) => e.uid)).toEqual(["ok"]);
    expect(r.problems.map((p) => p.replace(`${dir}/`, ""))).toEqual([
      "mixed.ics: several component types in one file (VEVENT, VTODO), skipped",
      "open.ics: malformed (BEGIN:VEVENT (content line 2) has no matching END:VEVENT), skipped",
      "todo.ics: holds no VEVENT (only VTODO), skipped",
    ]);
  });

  it("warns about a calendar object without PRODID, but still reads the event", async () => {
    await writeFile(
      join(dir, "a.ics"),
      ["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:a", "END:VEVENT", "END:VCALENDAR", ""].join(
        "\r\n",
      ),
    );
    await writeFile(join(dir, "b.ics"), ics("b"));
    const r = await read();
    expect(r.events.map((e) => e.uid)).toEqual(["a", "b"]);
    expect(r.problems).toEqual([]);
    expect(r.warnings).toEqual([
      `${join(dir, "a.ics")}: PRODID is missing (RFC 5545 3.6)`,
      `${join(dir, "b.ics")}: PRODID is missing (RFC 5545 3.6)`,
      `${join(dir, "b.ics")}: VERSION is missing (RFC 5545 3.6)`,
    ]);
  });
});
