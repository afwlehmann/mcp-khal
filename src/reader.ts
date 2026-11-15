import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Result } from "effect";
import { calendarWarnings, classifyFile, decodeIcs } from "./ics.js";
import { isEventFile, MAX_FILE_BYTES, readIcsFile } from "./vdir.js";

// Reads every .ics file of a calendar's vdir. Nothing is dropped silently: a file that cannot be
// used is reported as a problem next to the events that could be read, a file that is read but
// deviates from RFC 5545 (e.g. no PRODID) as a warning. Never fails.
//
// Tolerated deviations when reading (see `decodeIcs`): UTF-8 BOM, LF or lone CR line endings, tab
// folds. A METHOD property is ignored (stored files never carry one, but an invitation saved from
// an e-mail may). Everything else non-standard is reported, never guessed.

export interface RawEvent {
  /** absolute path of the .ics file */
  readonly file: string;
  readonly lines: readonly string[];
  readonly uid: string;
}

export interface CalendarRead {
  /** sorted by file path */
  readonly events: readonly RawEvent[];
  /** sorted; one message per unusable file (or directory) */
  readonly problems: readonly string[];
  /** sorted; one message per deviation from RFC 5545 in a file that was read anyway */
  readonly warnings: readonly string[];
}

type FileRead =
  | { readonly kind: "ok"; readonly file: string; readonly lines: readonly string[] }
  | { readonly kind: "problem"; readonly message: string }
  | { readonly kind: "ignored" };

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const reason = (u: unknown): string => (u instanceof Error ? u.message : String(u));

const readFileOf = (file: string): Effect.Effect<FileRead> =>
  Effect.tryPromise({
    try: () => readIcsFile(file),
    catch: (u) => u,
  }).pipe(
    Effect.match({
      onFailure: (u): FileRead => ({ kind: "problem", message: `${file}: unreadable (${reason(u)})` }),
      onSuccess: (r): FileRead => {
        if (r.kind === "ignored") return r;
        if (r.kind === "toobig")
          return { kind: "problem", message: `${file}: skipped, larger than ${MAX_FILE_BYTES} bytes` };
        return Result.match(decodeIcs(r.bytes), {
          onFailure: (e): FileRead => ({ kind: "problem", message: `${file}: ${e.message}, skipped` }),
          onSuccess: (lines): FileRead => ({ kind: "ok", file, lines }),
        });
      },
    }),
  );

type Classified =
  | { readonly event: RawEvent; readonly warnings: readonly string[]; readonly message?: undefined }
  | { readonly event?: undefined; readonly warnings: readonly string[]; readonly message: string };

/** A file is one event (series), or unusable with the reason (RFC 4791 4.1, vdir: one UID, one component type). */
const classify = (file: string, lines: readonly string[]): Classified => {
  const cls = classifyFile(lines);
  return cls.kind === "unusable"
    ? { message: `${file}: ${cls.reason}`, warnings: [] }
    : {
        event: { file, lines, uid: cls.uid },
        warnings: calendarWarnings(lines).map((w) => `${file}: ${w}`),
      };
};

/**
 * Reads all `*.ics` files directly in `dir`. Files are visited in path order; when several files
 * hold the same UID, the first one is used and each further one is reported (khal skips such files
 * without a word).
 */
export const readCalendar = (dir: string): Effect.Effect<CalendarRead> =>
  Effect.tryPromise({ try: () => readdir(dir), catch: (u) => u }).pipe(
    Effect.match({
      onFailure: (u) => ({
        names: [] as string[],
        listing: [`${dir}: cannot list directory (${reason(u)})`],
      }),
      onSuccess: (names) => ({ names, listing: [] as string[] }),
    }),
    Effect.flatMap(({ names, listing }) =>
      Effect.forEach(
        names
          .filter(isEventFile) // not `*.tmp`, not hidden, not vdir metadata files without extension
          .map((n) => join(dir, n))
          .sort(compare),
        readFileOf,
        { concurrency: 8 },
      ).pipe(Effect.map((reads) => ({ reads, listing }))),
    ),
    Effect.map(({ reads, listing }): CalendarRead => {
      const classified = reads.flatMap((r): Classified[] =>
        r.kind === "ok"
          ? [classify(r.file, r.lines)]
          : r.kind === "problem"
            ? [{ message: r.message, warnings: [] }]
            : [],
      );
      const seen = new Map<string, string>();
      const kept = classified.flatMap((c): Classified[] => {
        if (c.event === undefined) return [c];
        const first = seen.get(c.event.uid);
        if (first !== undefined)
          return [
            {
              message: `${c.event.file}: duplicate UID '${c.event.uid}' (also in ${first}), skipped`,
              warnings: [],
            },
          ];
        seen.set(c.event.uid, c.event.file);
        return [c];
      });
      return {
        events: kept.flatMap((c) => (c.event === undefined ? [] : [c.event])),
        problems: [...listing, ...kept.flatMap((c) => (c.message === undefined ? [] : [c.message]))].sort(
          compare,
        ),
        warnings: kept.flatMap((c) => c.warnings).sort(compare),
      };
    }),
  );
