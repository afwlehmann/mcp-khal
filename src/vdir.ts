import { createHash, randomBytes } from "node:crypto";
import { link, open, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Effect, Result } from "effect";
import { calendarOf } from "./config.js";
import { type AppError, InvalidInput, ioError } from "./errors.js";
import {
  classifyFile,
  decodeIcs,
  type FileClass,
  fileUids,
  serialize,
  stripMethod,
  structureProblems,
} from "./ics.js";
import type { Settings } from "./settings.js";

// Effects on a calendar's vdir (the directory of .ics files).

export interface StoredEvent {
  /** absolute path of the .ics file */
  readonly file: string;
  readonly lines: readonly string[];
  /**
   * Identifies the content this was read from (modification time in ns, size, SHA-256 of the bytes).
   * Pass it to `writeEvent`, which then replaces the file only while it is unchanged.
   */
  readonly etag: string;
}

/** control characters and line/paragraph separators */
const CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]/u;

const invalid = (message: string): InvalidInput => new InvalidInput({ message });

/** Longest calendar name or uid accepted. */
export const MAX_NAME = 255;

/** Files bigger than this are not events: they are skipped instead of being read into memory. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Is this directory entry an event file? `*.ics` (any case), not hidden. Temporary files (`.tmp`,
 * hidden), files without extension (vdir metadata such as `color`) and everything else are not items.
 */
export const isEventFile = (name: string): boolean =>
  name.toLowerCase().endsWith(".ics") && !name.startsWith(".");

/**
 * The path of a new file in a vdir. The name is a single plain file name (letters, digits and
 * `._@-`, not starting with a dot), so it can never leave the directory or hide.
 */
export const newFileIn = (dir: string, name: string): string | InvalidInput =>
  /^[A-Za-z0-9_@-][A-Za-z0-9._@-]{0,200}$/.test(name)
    ? join(dir, name)
    : invalid(`'${name}' is not a safe file name`);

/** The vdir of a calendar, or why there is none. */
export const vdirOf = (settings: Settings, calendar: string): string | InvalidInput => {
  const name = calendar.trim();
  if (name === "" || name.length > MAX_NAME || CONTROL.test(name))
    return invalid(
      `calendar must be a calendar name (at most ${MAX_NAME} characters, no control characters)`,
    );
  return (
    calendarOf(settings.calendars, name)?.path ??
    invalid(
      `calendar '${name}' is not configured (configured: ${Object.keys(settings.calendars).sort().join(", ") || "none"}); add it as calendars.${name} with a path in the config`,
    )
  );
};

// ---------- reading ----------

type Attempt<A> = { readonly ok: true; readonly value: A } | { readonly ok: false; readonly error: unknown };

/** A promise as a value, so failures are handled without try/catch. */
const attempt = <A>(p: Promise<A>): Promise<Attempt<A>> =>
  p.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );

const codeOf = (u: unknown): string | undefined =>
  typeof u === "object" && u !== null && "code" in u && typeof u.code === "string" ? u.code : undefined;

const reasonOf = (u: unknown): string => (u instanceof Error ? u.message : String(u));

/** The identity of a file's content: modification time (ns), size and a hash of the bytes. */
export const etagOf = (mtimeNs: bigint, bytes: Uint8Array): string =>
  `${mtimeNs}:${bytes.length}:${createHash("sha256").update(bytes).digest("hex")}`;

export type FileRead =
  | { readonly kind: "ok"; readonly bytes: Buffer; readonly etag: string }
  /** not a regular file (a directory, a socket...) */
  | { readonly kind: "ignored" }
  | { readonly kind: "toobig"; readonly size: number };

/** Reads one file: its bytes and etag from one open handle, never more than MAX_FILE_BYTES. Rejects on I/O errors. */
export const readIcsFile = async (file: string): Promise<FileRead> => {
  const info = await stat(file); // before open: a FIFO or device is never opened
  if (!info.isFile()) return { kind: "ignored" };
  if (info.size > MAX_FILE_BYTES) return { kind: "toobig", size: info.size };
  const handle = await open(file, "r");
  try {
    const own = await handle.stat({ bigint: true });
    const bytes = await handle.readFile();
    return bytes.length > MAX_FILE_BYTES
      ? { kind: "toobig", size: bytes.length }
      : { kind: "ok", bytes, etag: etagOf(own.mtimeNs, bytes) };
  } finally {
    await handle.close();
  }
};

type Entry =
  | {
      readonly kind: "file";
      readonly file: string;
      readonly lines: readonly string[];
      readonly etag: string;
      readonly cls: FileClass;
    }
  | { readonly kind: "skipped"; readonly file: string; readonly reason: string }
  | { readonly kind: "ignored" };

/** One directory entry; never fails (a bad entry is remembered, a vanished one is ignored). */
const scanEntry = (file: string): Effect.Effect<Entry> =>
  Effect.tryPromise({ try: () => readIcsFile(file), catch: (u) => u }).pipe(
    Effect.match({
      onFailure: (u): Entry =>
        codeOf(u) === "ENOENT"
          ? { kind: "ignored" } // removed between readdir and stat
          : { kind: "skipped", file, reason: `unreadable (${reasonOf(u)})` },
      onSuccess: (r): Entry => {
        if (r.kind === "ignored") return r;
        if (r.kind === "toobig")
          return { kind: "skipped", file, reason: `larger than ${MAX_FILE_BYTES} bytes` };
        return Result.match(decodeIcs(r.bytes), {
          onFailure: (e): Entry => ({ kind: "skipped", file, reason: e.message }),
          onSuccess: (lines): Entry => ({
            kind: "file",
            file,
            lines,
            etag: r.etag,
            cls: classifyFile(lines),
          }),
        });
      },
    }),
  );

const MAX_NOTED = 5;

/** The files that could not be used and may hold the event, for the "not found" message. */
const skippedNote = (entries: readonly Entry[]): string => {
  const notes = entries
    .flatMap((e) =>
      e.kind === "skipped"
        ? [`${basename(e.file)}: ${e.reason}`]
        : e.kind === "file" && e.cls.kind === "unusable" && e.cls.reason !== "no event with a UID"
          ? [`${basename(e.file)}: ${e.cls.reason.replace(/, skipped$/, "")}`]
          : [],
    )
    .sort(compare);
  return notes.length === 0
    ? ""
    : ` (${notes.length} file${notes.length === 1 ? "" : "s"} could not be used and may hold it: ${notes.slice(0, MAX_NOTED).join("; ")}${notes.length > MAX_NOTED ? "; ..." : ""})`;
};

/**
 * Finds the .ics file holding the event with this UID. A file that cannot be read is skipped (and
 * named in the error when the event is not found); the same UID in two files, or in a file the tools
 * must not edit (several UIDs, several component types, malformed), is an error instead of a guess.
 */
export const findEvent = (
  settings: Settings,
  calendar: string,
  uid: string,
): Effect.Effect<StoredEvent, AppError> =>
  Effect.gen(function* () {
    const wanted = uid.trim();
    if (wanted === "" || wanted.length > MAX_NAME || CONTROL.test(wanted))
      return yield* Effect.fail(
        invalid(`uid must not be empty, longer than ${MAX_NAME} characters or contain control characters`),
      );
    const dir = vdirOf(settings, calendar);
    if (typeof dir !== "string") return yield* Effect.fail(dir);
    const names = yield* Effect.tryPromise({ try: () => readdir(dir), catch: ioError });
    const entries = yield* Effect.forEach(
      names
        .filter(isEventFile)
        .sort(compare)
        .map((n) => join(dir, n)),
      scanEntry,
      { concurrency: 8 },
    );
    const holders = entries.flatMap((e) =>
      e.kind === "file" && (e.cls.kind === "event" ? e.cls.uid === wanted : e.cls.uids.includes(wanted))
        ? [e]
        : [],
    );
    const [hit] = holders;
    if (hit === undefined)
      return yield* Effect.fail(
        invalid(`no event with uid '${wanted}' in calendar '${calendar.trim()}'${skippedNote(entries)}`),
      );
    if (holders.length > 1)
      return yield* Effect.fail(
        invalid(
          `uid '${wanted}' is in several files of calendar '${calendar.trim()}' (${holders.map((h) => basename(h.file)).join(", ")}); a UID must be unique in a calendar (RFC 4791 4.1), so nothing was changed: remove or fix one of them first`,
        ),
      );
    if (hit.cls.kind === "unusable")
      return yield* Effect.fail(
        invalid(
          `event '${wanted}' is in ${basename(hit.file)}, which cannot be edited: ${hit.cls.reason.replace(/, skipped$/, "")}`,
        ),
      );
    return { file: hit.file, lines: hit.lines, etag: hit.etag };
  });

// ---------- writing ----------

/** Mode of a new file (before the umask), like an ordinary text file. */
const DEFAULT_MODE = 0o644;

/** A temporary name next to the target: hidden, unique per write, ending in `.tmp` (never an item). */
export const tempNameIn = (file: string, token: string): string =>
  join(dirname(file), `.${basename(file)}.${token}.mcp-khal.tmp`);

/** The random part is read inside the effect, once per write. */
const tempName = (file: string): string => tempNameIn(file, randomBytes(8).toString("hex"));

/** Creates `path` exclusively (it must not exist, a planted symlink is not followed), writes and fsyncs. */
const writeTemp = async (path: string, content: string, mode: number): Promise<void> => {
  const handle = await open(path, "wx", mode);
  try {
    await handle.chmod(mode); // the umask must not change a mode we keep
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
};

/** Flushes the directory entry; best effort, not every platform can open a directory. */
const syncDir = async (dir: string): Promise<void> => {
  const handle = await attempt(open(dir, "r"));
  if (!handle.ok) return;
  await attempt(handle.value.sync());
  await handle.value.close();
};

/** What a write found when it re-checked the target right before replacing it. */
type Verdict =
  | { readonly kind: "ok" }
  | { readonly kind: "changed" }
  | { readonly kind: "uid"; readonly was: string; readonly now: string };

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x) => b.includes(x));

const definedUids = (lines: readonly string[]): string[] =>
  fileUids(lines).filter((u): u is string => u !== undefined);

/** Is the target still what the caller read (when it says so), and does the write keep its UIDs (RFC 4791 5.3.2.1)? */
const verify = async (
  file: string,
  next: readonly string[],
  expected: string | undefined,
): Promise<Verdict> => {
  const current = await attempt(readIcsFile(file));
  // gone, unreadable or not a file: fine for a blind write, but not for one that expects the old content
  if (!current.ok || current.value.kind !== "ok")
    return expected === undefined ? { kind: "ok" } : { kind: "changed" };
  if (expected !== undefined && current.value.etag !== expected) return { kind: "changed" };
  const was = Result.match(decodeIcs(current.value.bytes), {
    onFailure: (): string[] => [], // cannot compare what is not valid UTF-8
    onSuccess: definedUids,
  });
  const now = definedUids(next);
  return was.length > 0 && !sameSet(was, now)
    ? { kind: "uid", was: was.join(", "), now: now.join(", ") || "none" }
    : { kind: "ok" };
};

const malformed = (lines: readonly string[]): InvalidInput | undefined => {
  const problems = structureProblems(lines);
  return problems.length === 0
    ? undefined
    : invalid(`refusing to write a malformed calendar: ${problems.join("; ")}`);
};

/**
 * Creates a new file, failing (and changing nothing) when one with that name exists already. The
 * content is written to a temporary file and hard-linked to its name, which is atomic and never
 * replaces a file. Where hard links are not supported the file is created exclusively (O_EXCL)
 * and written directly. `linkFile` is a parameter for tests only.
 */
export const createEvent = (
  file: string,
  lines: readonly string[],
  linkFile: typeof link = link,
): Effect.Effect<void, AppError> => {
  const out = stripMethod(lines);
  const bad = malformed(out);
  if (bad !== undefined) return Effect.fail(bad);
  const content = serialize(out);
  return Effect.sync(() => tempName(file)).pipe(
    Effect.flatMap((tmp) =>
      Effect.tryPromise({
        try: async (): Promise<void> => {
          await writeTemp(tmp, content, DEFAULT_MODE);
          const linked = await attempt(linkFile(tmp, file));
          if (!linked.ok && !NO_HARD_LINKS.has(codeOf(linked.error) ?? ""))
            return Promise.reject(linked.error);
          if (!linked.ok) {
            const handle = await open(file, "wx", DEFAULT_MODE); // rejects when the name is taken
            const written = await attempt(handle.writeFile(content, "utf8").then(() => handle.sync()));
            await handle.close();
            if (!written.ok) {
              await rm(file, { force: true }); // we created it just now, remove the partial file
              return Promise.reject(written.error);
            }
          }
          await syncDir(dirname(file));
        },
        catch: ioError,
      }).pipe(Effect.ensuring(Effect.promise(() => rm(tmp, { force: true })))),
    ),
  );
};

/** errno codes of a file system without hard links (FAT, some network and FUSE file systems) */
const NO_HARD_LINKS = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV", "EMLINK"]);

/**
 * Replaces the file atomically: the content goes to a uniquely named temporary file next to it
 * (created exclusively, mode of the old file, fsynced), then it is renamed onto the file, so a
 * reader never sees half a file. With the `etag` of `findEvent` the file is replaced only if it
 * still has the content it was read with; otherwise nothing is written and the error says so.
 * The UIDs of the file never change, and a METHOD property is stripped (RFC 4791 4.1).
 */
export const writeEvent = (
  file: string,
  lines: readonly string[],
  etag?: string,
): Effect.Effect<void, AppError> => {
  const out = stripMethod(lines);
  const bad = malformed(out);
  if (bad !== undefined) return Effect.fail(bad);
  const content = serialize(out);
  return Effect.sync(() => tempName(file)).pipe(
    Effect.flatMap((tmp) =>
      Effect.tryPromise({
        try: async (): Promise<Verdict> => {
          const before = await attempt(stat(file));
          await writeTemp(tmp, content, before.ok ? before.value.mode & 0o7777 : DEFAULT_MODE);
          const verdict = await verify(file, out, etag);
          if (verdict.kind !== "ok") return verdict;
          await rename(tmp, file);
          await syncDir(dirname(file));
          return verdict;
        },
        catch: ioError,
      }).pipe(Effect.ensuring(Effect.promise(() => rm(tmp, { force: true })))),
    ),
    Effect.flatMap((verdict) =>
      verdict.kind === "ok"
        ? Effect.succeed(undefined)
        : Effect.fail(
            invalid(
              verdict.kind === "changed"
                ? `${basename(file)} was changed by someone else after it was read; nothing was written, try again`
                : `refusing to write ${basename(file)}: its UID would change from ${verdict.was} to ${verdict.now}`,
            ),
          ),
    ),
  );
};
