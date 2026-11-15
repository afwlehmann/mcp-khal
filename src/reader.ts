import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { events, prop, unfoldLines } from "./ics.js";
import { MAX_FILE_BYTES } from "./vdir.js";

// Reads every .ics file of a calendar's vdir. Nothing is dropped silently: a file that cannot be
// used is reported as a problem next to the events that could be read. Never fails.

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
}

type FileRead =
  | { readonly kind: "ok"; readonly file: string; readonly lines: readonly string[] }
  | { readonly kind: "problem"; readonly message: string }
  | { readonly kind: "ignored" };

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const reason = (u: unknown): string => (u instanceof Error ? u.message : String(u));

const readFileOf = (file: string): Effect.Effect<FileRead> =>
  Effect.tryPromise({
    try: async (): Promise<FileRead> => {
      const info = await stat(file);
      if (!info.isFile()) return { kind: "ignored" };
      if (info.size > MAX_FILE_BYTES)
        return { kind: "problem", message: `${file}: skipped, larger than ${MAX_FILE_BYTES} bytes` };
      return { kind: "ok", file, lines: unfoldLines(await readFile(file, "utf8")) };
    },
    catch: (u) => u,
  }).pipe(
    Effect.match({
      onFailure: (u): FileRead => ({ kind: "problem", message: `${file}: unreadable (${reason(u)})` }),
      onSuccess: (r) => r,
    }),
  );

/** UIDs of the VEVENTs of one file, without duplicates; `undefined` for an event without UID. */
const uidsOf = (lines: readonly string[]): readonly (string | undefined)[] => [
  ...new Set(events(lines).map((e) => prop(e, "UID")?.value.trim() || undefined)),
];

type Classified =
  | { readonly event: RawEvent; readonly message?: undefined }
  | { readonly event?: undefined; readonly message: string };

const classify = (file: string, lines: readonly string[]): Classified => {
  const uids = uidsOf(lines);
  if (uids.length > 1)
    return {
      message: `${file}: several UIDs in one file (${uids.map((u) => u ?? "<none>").join(", ")}), skipped`,
    };
  const [uid] = uids;
  return uid === undefined ? { message: `${file}: no event with a UID` } : { event: { file, lines, uid } };
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
          .filter((n) => n.toLowerCase().endsWith(".ics") && !n.startsWith("."))
          .map((n) => join(dir, n))
          .sort(compare),
        readFileOf,
        { concurrency: 8 },
      ).pipe(Effect.map((reads) => ({ reads, listing }))),
    ),
    Effect.map(({ reads, listing }): CalendarRead => {
      const classified = reads.flatMap((r): Classified[] =>
        r.kind === "ok" ? [classify(r.file, r.lines)] : r.kind === "problem" ? [{ message: r.message }] : [],
      );
      const seen = new Map<string, string>();
      const kept = classified.flatMap((c): Classified[] => {
        if (c.event === undefined) return [c];
        const first = seen.get(c.event.uid);
        if (first !== undefined)
          return [{ message: `${c.event.file}: duplicate UID '${c.event.uid}' (also in ${first}), skipped` }];
        seen.set(c.event.uid, c.event.file);
        return [c];
      });
      return {
        events: kept.flatMap((c) => (c.event === undefined ? [] : [c.event])),
        problems: [...listing, ...kept.flatMap((c) => (c.message === undefined ? [] : [c.message]))].sort(
          compare,
        ),
      };
    }),
  );
