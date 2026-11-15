import { Result } from "effect";
import type { Calendars } from "./config.js";
import { InvalidInput } from "./errors.js";

// The calendars of the server: every `calendars.<name>` of the config with its vdir `path`.

export interface CalendarRef {
  readonly name: string;
  /** absolute path of the directory of the calendar's .ics files */
  readonly path: string;
}

/** Code-unit order: the same on every machine and locale (never `localeCompare`). */
const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * All configured calendars, sorted by name. Fails (naming every offender) when a calendar has no
 * `path`: without it there is nothing to read.
 */
export const listCalendars = (calendars: Calendars): Result.Result<readonly CalendarRef[], InvalidInput> => {
  const names = Object.keys(calendars).sort(byName);
  const missing = names.filter((n) => calendars[n]?.path === undefined);
  return missing.length > 0
    ? Result.fail(
        new InvalidInput({
          message: `${missing
            .map((n) => `calendar '${n}'`)
            .join(
              ", ",
            )} ${missing.length === 1 ? "has" : "have"} no path configured: set calendars.<name>.path in the config (the directory of its .ics files)`,
        }),
      )
    : Result.succeed(
        names.flatMap((name) => {
          const path = calendars[name]?.path;
          return path === undefined ? [] : [{ name, path }];
        }),
      );
};

/** The calendars to read: the named one, or all of them when none is named. */
export const selectCalendars = (
  calendars: Calendars,
  name: string | undefined,
): Result.Result<readonly CalendarRef[], InvalidInput> => {
  const wanted = name?.trim();
  if (wanted === undefined || wanted === "") return listCalendars(calendars);
  const entry = Object.hasOwn(calendars, wanted) ? calendars[wanted] : undefined;
  if (entry === undefined)
    return Result.fail(
      new InvalidInput({
        message: `unknown calendar '${wanted}' (configured: ${Object.keys(calendars).sort(byName).join(", ") || "none"})`,
      }),
    );
  return entry.path === undefined
    ? Result.fail(
        new InvalidInput({
          message: `calendar '${wanted}' has no path configured: set calendars.${wanted}.path in the config (the directory of its .ics files)`,
        }),
      )
    : Result.succeed([{ name: wanted, path: entry.path }]);
};
