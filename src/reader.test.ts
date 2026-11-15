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
  });
});
