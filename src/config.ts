import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Effect, Result } from "effect";
import { InvalidInput, ioError, type KhalError } from "./errors.js";
import {
  collect,
  collectAll,
  orInvalidInput,
  type Problems,
  problem,
  type Validated,
  valid,
} from "./validation.js";

export type Env = Readonly<Record<string, string | undefined>>;

/** `15m`, `2h`, `1d`, or `none` for no reminder at all */
export type AlarmSetting = string;

export const NO_ALARM = "none";

/** Everything that can be configured for one calendar; only `path` is required. */
export interface CalendarConfig {
  /** the user's own address on this calendar: the organizer of invites, and who answers invitations */
  readonly email?: string;
  /** reminder for new events on this calendar; none when unset */
  readonly alarm?: AlarmSetting;
  /** Absolute path of the calendar's vdir: the directory of its .ics files. */
  readonly path: string;
}

/** calendar name -> its settings */
export type Calendars = Readonly<Record<string, CalendarConfig>>;

export interface Config {
  /**
   * The calendar `new_event` uses when the call names none, so that calendar's `email` and `alarm`
   * apply. Required when there are several calendars, never guessed; with exactly one calendar
   * that one is meant.
   */
  readonly defaultCalendar?: string;
  readonly calendars: Calendars;
}

export const defaultConfig: Config = {
  calendars: {},
};

// ---------- pure ----------
// Every value read from the environment or the config file is trimmed before it is checked, and
// independent checks accumulate their problems (see validation.ts) instead of stopping at the first.

export const isEmail = (s: string): boolean => /^[^\s@,;:<>]+@[^\s@,;:<>]+\.[^\s@,;:<>]+$/.test(s);

/** `<n>m`, `<n>h` or `<n>d` (n = 0..9999 minutes, hours or days before the start), or `none`. */
export const isAlarmSetting = (s: string): boolean => s === NO_ALARM || /^\d{1,4}[mhd]$/.test(s);

const ALARM_HINT = "a reminder like 30m, 2h or 1d (minutes, hours, days before the start), or 'none'";

const CONTROL = /[\u0000-\u001f\u007f]/;

/** An environment variable counts as unset when it is empty or only whitespace. */
const envValue = (env: Env, name: string): string | undefined => {
  const v = env[name]?.trim();
  return v === undefined || v === "" ? undefined : v;
};

// ---------- environment overrides ----------
// Every property of the config file can be set (or overridden) by an environment variable. The
// schema is one rule: the prefix `MCP_KHAL_`, then the key path in SCREAMING_SNAKE_CASE, every
// part joined by a single `_`:
//   defaultCalendar             -> MCP_KHAL_DEFAULT_CALENDAR
//   calendars.<name>.path       -> MCP_KHAL_CALENDARS_<NAME>_PATH
//   calendars.<name>.email      -> MCP_KHAL_CALENDARS_<NAME>_EMAIL
//   calendars.<name>.alarm      -> MCP_KHAL_CALENDARS_<NAME>_ALARM
// <NAME> is the calendar name in capitals with every run of characters other than A-Z and 0-9
// turned into a single `_` (work-1 -> WORK_1). Because the shape of the config is fixed (the
// settings of a calendar are the closed set path, email, alarm), the setting is always the last
// part and the calendar everything between, so a `_` inside a name is not ambiguous. The location
// of the config file itself is MCP_KHAL_CONFIG. An empty variable counts as unset; a variable
// beats the file.

export const ENV_PREFIX = "MCP_KHAL_";
export const ENV_DEFAULT_CALENDAR = `${ENV_PREFIX}DEFAULT_CALENDAR`;
const ENV_CALENDARS = `${ENV_PREFIX}CALENDARS_`;
const CALENDAR_FIELDS = ["path", "email", "alarm"] as const;

/** The part of a variable name that stands for a calendar name. */
export const envSegment = (name: string): string =>
  name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_|_$/g, "");

/** The variable that sets `field` of the calendar called `name`. */
export const calendarEnvName = (name: string, field: (typeof CALENDAR_FIELDS)[number]): string =>
  `${ENV_CALENDARS}${envSegment(name)}_${field.toUpperCase()}`;

/** Names the variable that supplied a value, so a message can point at it instead of at the file. */
type Source = (path: string) => string;

/**
 * Lays the environment over the raw config: returns the new raw object and, for every path a
 * variable set, the name of that variable. Variables that look like settings but are none (a typo)
 * and calendar names that cannot be told apart by their variable name are problems.
 */
const overlayEnv = (
  raw: Record<string, unknown>,
  env: Env,
): { readonly raw: Record<string, unknown>; readonly at: Source; readonly problems: readonly string[] } => {
  const sources = new Map<string, string>();
  const problems: string[] = [];
  const out: Record<string, unknown> = { ...raw };

  const defaultCalendar = envValue(env, ENV_DEFAULT_CALENDAR);
  if (defaultCalendar !== undefined) {
    out.defaultCalendar = defaultCalendar;
    sources.set("defaultCalendar", ENV_DEFAULT_CALENDAR);
  }

  const vars = Object.keys(env)
    .filter((k) => k.startsWith(ENV_CALENDARS) && envValue(env, k) !== undefined)
    .sort();
  if (vars.length > 0 && (raw.calendars === undefined || isRecord(raw.calendars))) {
    const calendars: Record<string, unknown> = { ...(isRecord(raw.calendars) ? raw.calendars : {}) };
    const bySegment = new Map<string, string[]>();
    for (const name of Object.keys(calendars))
      bySegment.set(envSegment(name), [...(bySegment.get(envSegment(name)) ?? []), name]);

    for (const key of vars) {
      const parsed = /^([A-Z0-9]+(?:_[A-Z0-9]+)*)_([A-Z]+)$/.exec(key.slice(ENV_CALENDARS.length));
      const segment = parsed?.[1];
      const known = CALENDAR_FIELDS.find((f) => f.toUpperCase() === parsed?.[2]);
      if (segment === undefined || known === undefined) {
        problems.push(
          `${key} is not a setting (expected ${ENV_CALENDARS}<NAME>_PATH, ${ENV_CALENDARS}<NAME>_EMAIL or ${ENV_CALENDARS}<NAME>_ALARM, with <NAME> in capitals, digits and single underscores)`,
        );
        continue;
      }
      const existing = bySegment.get(segment) ?? [];
      if (existing.length > 1) {
        problems.push(
          `${key} is ambiguous: the calendars ${existing.sort().join(" and ")} all map to ${segment}; rename one of them`,
        );
        continue;
      }
      const name = existing[0] ?? segment.toLowerCase();
      const current = calendars[name];
      calendars[name] = { ...(isRecord(current) ? current : {}), [known]: envValue(env, key) };
      if (existing.length === 0) bySegment.set(segment, [name]);
      sources.set(`calendars.${name}.${known}`, key);
    }
    out.calendars = calendars;
  }

  return { raw: out, at: (path: string): string => sources.get(path) ?? path, problems };
};

export type ConfigSource = "MCP_KHAL_CONFIG" | "XDG_CONFIG_HOME" | "default";

/**
 * Where the config file is: `$MCP_KHAL_CONFIG`, else `$XDG_CONFIG_HOME/mcp-khal.json`, else
 * `~/.config/mcp-khal.json`. Set variables must be absolute paths, because a relative path would
 * silently depend on the working directory of the MCP client.
 */
export const configLocation = (
  env: Env,
  home: string,
): Validated<{ readonly path: string; readonly source: ConfigSource }> => {
  const explicit = envValue(env, "MCP_KHAL_CONFIG");
  if (explicit !== undefined)
    return isAbsolute(explicit)
      ? valid({ path: explicit, source: "MCP_KHAL_CONFIG" })
      : problem(`MCP_KHAL_CONFIG must be an absolute path, got ${JSON.stringify(explicit)}`);
  const xdg = envValue(env, "XDG_CONFIG_HOME");
  if (xdg !== undefined)
    return isAbsolute(xdg)
      ? valid({ path: join(xdg, "mcp-khal.json"), source: "XDG_CONFIG_HOME" })
      : problem(`XDG_CONFIG_HOME must be an absolute path, got ${JSON.stringify(xdg)}`);
  return valid({ path: join(home, ".config", "mcp-khal.json"), source: "default" });
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const checkCalendarName = (name: string, where: string): Validated<string> => {
  const n = name.trim();
  if (n === "") return problem(`${where} has an empty calendar name`);
  if (CONTROL.test(n))
    return problem(`${where} has a calendar name with control characters: ${JSON.stringify(n)}`);
  return valid(n);
};

const parseEmail = (raw: unknown, where: string): Validated<string> =>
  typeof raw === "string" && isEmail(raw.trim())
    ? valid(raw.trim())
    : problem(`${where} is not a valid email address, got ${JSON.stringify(raw)}`);

const parseAlarm = (raw: unknown, where: string): Validated<AlarmSetting> =>
  typeof raw === "string" && isAlarmSetting(raw.trim())
    ? valid(raw.trim())
    : problem(`${where} must be ${ALARM_HINT}, got ${JSON.stringify(raw)}`);

const parseVdirPath = (raw: unknown, where: string): Validated<string> => {
  const p = typeof raw === "string" ? raw.trim() : undefined;
  return p !== undefined && isAbsolute(p) && !CONTROL.test(p)
    ? valid(p)
    : problem(
        `${where} must be an absolute path without control characters (no '~', no relative path), got ${JSON.stringify(raw)}`,
      );
};

const CALENDAR_KEYS: readonly string[] = ["email", "alarm", "path"];

/** One calendar's object: `path` is required, `email` and `alarm` are optional; every problem listed. */
const parseCalendar = (raw: unknown, name: string, at: Source = (p) => p): Validated<CalendarConfig> => {
  const where = `calendars.${name}`;
  if (!isRecord(raw))
    return problem(
      `${where} must be an object like { "path": "/home/me/calendars/work", "email": "me@example.com", "alarm": "15m" }, got ${JSON.stringify(raw)}`,
    );
  return Result.map(
    collect({
      unknownKeys: collectAll(
        Object.keys(raw)
          .filter((k) => !CALENDAR_KEYS.includes(k))
          .map((k) =>
            problem(
              `${where} has an unknown key '${k}' (expected ${CALENDAR_KEYS.map((x) => `'${x}'`).join(", ")})`,
            ),
          ),
      ),
      email: raw.email === undefined ? valid(undefined) : parseEmail(raw.email, at(`${where}.email`)),
      alarm: raw.alarm === undefined ? valid(undefined) : parseAlarm(raw.alarm, at(`${where}.alarm`)),
      path:
        raw.path === undefined
          ? problem(
              `${where}.path is required (or ${calendarEnvName(name, "path")}): the absolute path of the directory of the calendar's .ics files`,
            )
          : parseVdirPath(raw.path, at(`${where}.path`)),
    }),
    ({ email, alarm, path }): CalendarConfig => ({
      path,
      ...(email === undefined ? {} : { email }),
      ...(alarm === undefined ? {} : { alarm }),
    }),
  );
};

/** A JSON object of calendar name -> settings: every entry checked, names trimmed and unique. */
const parseCalendars = (
  raw: unknown,
  where: string,
  parseValue: (value: unknown, name: string) => Validated<CalendarConfig>,
): Validated<Calendars> => {
  if (!isRecord(raw)) return problem(`${where} must be a JSON object of calendar name -> settings`);
  const entries = collectAll(
    Object.entries(raw).map(([name, value]) =>
      Result.map(
        collect({ name: checkCalendarName(name, where), value: parseValue(value, name) }),
        ({ name: n, value: v }) => [n, v] as const,
      ),
    ),
  );
  return Result.flatMap(entries, (list) => {
    const names = list.map(([n]) => n);
    const duplicates = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
    return duplicates.length > 0
      ? collectAll(
          duplicates.map((n) =>
            problem(`${where} lists calendar '${n}' more than once (names are compared after trimming)`),
          ),
        ).pipe(Result.map(() => ({}) as Calendars))
      : valid(Object.fromEntries(list) as Calendars);
  });
};

/** Two calendars cannot live in the same directory: a shared `path` is a copy-paste mistake. */
const checkUniquePaths = (calendars: Calendars): Validated<Calendars> => {
  const byPath = new Map<string, string[]>();
  for (const [name, c] of Object.entries(calendars))
    byPath.set(resolve(c.path), [...(byPath.get(resolve(c.path)) ?? []), name]);
  const shared = [...byPath.entries()].filter(([, names]) => names.length > 1);
  return shared.length === 0
    ? valid(calendars)
    : collectAll(
        shared.map(([path, names]) =>
          problem(`calendars ${names.sort().join(" and ")} have the same path ${path}; each needs its own`),
        ),
      ).pipe(Result.map(() => calendars));
};

/** v1.2.0 keys that are gone or moved into `calendars.<name>`; named in the error so users can migrate. */
const RETIRED_KEYS: Readonly<Record<string, string>> = {
  calendarEmails: 'moved into "calendars": { "<name>": { "email": "..." } }',
  calendarAlarms: 'moved into "calendars": { "<name>": { "alarm": "..." } }',
  defaultAlarm:
    'been dropped: set "alarm" on each calendar under "calendars", and name the calendar for events without one in "defaultCalendar"',
};

/** Every key the config file knows, in the order they are written. */
export const CONFIG_KEYS: readonly string[] = ["defaultCalendar", "calendars"];

const parseDefaultCalendar = (raw: unknown, label: string): Validated<string> =>
  typeof raw === "string"
    ? checkCalendarName(raw, label)
    : problem(`${label} must be a calendar name (a string), got ${JSON.stringify(raw)}`);

/** The default calendar must be one of the configured calendars, and is required when there are several. */
const checkDefaultCalendar = (
  calendars: Calendars,
  defaultCalendar: string | undefined,
  label: string,
): Validated<string | undefined> => {
  const names = Object.keys(calendars).sort();
  if (defaultCalendar === undefined)
    return names.length > 1
      ? problem(
          `several calendars are configured (${names.join(", ")}): set "defaultCalendar" (or ${ENV_DEFAULT_CALENDAR}) to the one new events go to when a call names no calendar`,
        )
      : valid(undefined);
  return Object.hasOwn(calendars, defaultCalendar)
    ? valid(defaultCalendar)
    : problem(
        `${label} '${defaultCalendar}' is not one of the configured calendars (${names.join(", ") || "none"})`,
      );
};

/** Validates the raw configuration (file and environment already merged); every problem is listed. */
const parseRaw = (raw: Record<string, unknown>, at: Source): Validated<Config> => {
  const parsed = Result.map(
    collect({
      unknownKeys: collectAll(
        Object.keys(raw)
          .filter((k) => !CONFIG_KEYS.includes(k))
          .map((k) =>
            problem(
              k in RETIRED_KEYS
                ? `config key '${k}' has ${RETIRED_KEYS[k]}`
                : `unknown config key '${k}' (expected ${CONFIG_KEYS.map((x) => `'${x}'`).join(", ")})`,
            ),
          ),
      ),
      defaultCalendar:
        raw.defaultCalendar === undefined
          ? valid(undefined)
          : parseDefaultCalendar(raw.defaultCalendar, at("defaultCalendar")),
      calendars:
        raw.calendars === undefined
          ? valid({} as Calendars)
          : Result.flatMap(
              parseCalendars(raw.calendars, "calendars", (value, name) => parseCalendar(value, name, at)),
              checkUniquePaths,
            ),
    }),
    ({ defaultCalendar, calendars }) => ({ defaultCalendar, calendars }),
  );
  return Result.flatMap(parsed, ({ defaultCalendar, calendars }) =>
    Result.map(
      checkDefaultCalendar(calendars, defaultCalendar, at("defaultCalendar")),
      (checked): Config => ({
        ...(checked === undefined ? {} : { defaultCalendar: checked }),
        calendars,
      }),
    ),
  );
};

/**
 * The configuration from the file's text (`undefined`: there is no file) with the environment laid
 * over it (see "environment overrides"). The file looks like
 * `{ "defaultCalendar": "work",
 *    "calendars": { "work": { "path": "/home/me/calendars/work", "email": "me@example.com", "alarm": "1d" } } }`;
 * both keys are optional. Every problem is reported, not only the first.
 */
export const parseConfigWithEnv = (json: string | undefined, env: Env): Validated<Config> =>
  Result.flatMap(
    json === undefined
      ? valid<unknown>({})
      : Result.try({
          try: (): unknown => JSON.parse(json),
          catch: (e): Problems => [`config is not valid JSON: ${e instanceof Error ? e.message : String(e)}`],
        }),
    (fileRaw): Validated<Config> => {
      if (!isRecord(fileRaw)) return problem("config must be a JSON object");
      const { raw, at, problems } = overlayEnv(fileRaw, env);
      // the problems of the variables and those of the values are reported together
      return Result.map(
        collect({ variables: collectAll(problems.map((p) => problem(p))), config: parseRaw(raw, at) }),
        (v) => v.config,
      );
    },
  );

/** The file alone, without the environment: what `mcp-khal setup` reads and writes back. */
export const parseConfigValidated = (json: string): Validated<Config> => parseConfigWithEnv(json, {});

export const parseConfig = (json: string): Result.Result<Config, InvalidInput> =>
  orInvalidInput(parseConfigValidated(json));

/** `defaultCalendar` is only written when it is set. */
export const serializeConfig = (c: Config): string =>
  `${JSON.stringify(
    {
      ...(c.defaultCalendar === undefined ? {} : { defaultCalendar: c.defaultCalendar }),
      calendars: c.calendars,
    },
    null,
    2,
  )}\n`;

/**
 * The calendar a new event goes to: the one the call names, else the configured default
 * calendar, else the only calendar there is. Never guessed among several (the config check
 * requires a default then), so `undefined` only happens with no calendar at all.
 */
export const resolveCalendar = (
  config: Pick<Config, "defaultCalendar" | "calendars">,
  calendar: string | undefined,
): string | undefined => {
  if (calendar !== undefined) return calendar.trim();
  if (config.defaultCalendar !== undefined) return config.defaultCalendar;
  const names = Object.keys(config.calendars);
  return names.length === 1 ? names[0] : undefined;
};

/** The settings of one calendar, by the (trimmed) name; inherited object properties never match. */
export const calendarOf = (
  calendars: Calendars,
  calendar: string | undefined,
): CalendarConfig | undefined => {
  const name = calendar?.trim();
  return name !== undefined && Object.hasOwn(calendars, name) ? calendars[name] : undefined;
};

/**
 * The reminder for a new event: an explicit `alarm` wins, then the calendar's own `alarm`;
 * with neither there is no reminder. `none` (explicit or configured) also means no reminder,
 * expressed as `undefined`.
 */
export const resolveAlarm = (
  settings: Pick<Config, "calendars">,
  calendar: string | undefined,
  explicit: string | undefined,
): string | undefined => {
  const chosen = explicit?.trim() ?? calendarOf(settings.calendars, calendar)?.alarm;
  return chosen === undefined || chosen === NO_ALARM ? undefined : chosen;
};

/** Answer to a setup prompt: blank keeps the default (or skips), otherwise must be an email. */
export const interpretAnswer = (
  answer: string,
  fallback: string | undefined,
): Result.Result<string | undefined, string> => {
  const a = answer.trim();
  if (a === "") return Result.succeed(fallback);
  return isEmail(a) ? Result.succeed(a) : Result.fail(`'${a}' is not a valid email address`);
};

/**
 * Answer to the setup prompt for a calendar's vdir path: blank keeps the default (or skips),
 * otherwise it must be an absolute path that no other calendar uses.
 */
export const interpretPath = (
  answer: string,
  fallback: string | undefined,
  taken: readonly string[],
): Result.Result<string | undefined, string> => {
  const a = answer.trim();
  if (a === "") return Result.succeed(fallback);
  if (!isAbsolute(a) || CONTROL.test(a))
    return Result.fail(`'${a}' is not an absolute path (no '~', no relative path)`);
  return taken.some((t) => resolve(t) === resolve(a))
    ? Result.fail(`'${a}' is already the path of another calendar`)
    : Result.succeed(a);
};

/** Which address represents the user on this calendar? Explicit > its config > email-like name. */
export const resolveAddress = (
  calendars: Calendars,
  calendar: string | undefined,
  explicit?: string,
): Result.Result<string, InvalidInput> => {
  const invalid = (message: string) => Result.fail(new InvalidInput({ message }));
  const from = explicit?.trim();
  if (from !== undefined)
    return isEmail(from) ? Result.succeed(from) : invalid(`'${from}' is not a valid email address`);
  const name = calendar?.trim();
  if (name === undefined || name === "")
    return invalid("calendar (or organizer) is required to determine your address for invites");
  const configured = calendarOf(calendars, name)?.email;
  if (configured !== undefined) return Result.succeed(configured);
  return isEmail(name)
    ? Result.succeed(name)
    : invalid(`no address known for calendar '${name}'; run \`mcp-khal setup\` or pass one explicitly`);
};

// ---------- effects (the path is always passed in) ----------

/** The text of the file; `undefined` when it does not exist. */
export const readConfigText = (path: string): Effect.Effect<string | undefined, KhalError> =>
  Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: (u) => u as NodeJS.ErrnoException,
  }).pipe(
    Effect.matchEffect({
      onFailure: (e): Effect.Effect<string | undefined, KhalError> =>
        e.code === "ENOENT" ? Effect.succeed(undefined) : Effect.fail(ioError(e)),
      onSuccess: (content) => Effect.succeed(content),
    }),
  );

/** The parsed file alone; `undefined` when it does not exist. Problems of the content accumulate. */
export const readConfig = (path: string): Effect.Effect<Validated<Config> | undefined, KhalError> =>
  Effect.map(readConfigText(path), (text) => (text === undefined ? undefined : parseConfigValidated(text)));

/** A missing file is the default configuration, not an error. */
export const loadConfig = (path: string): Effect.Effect<Config, KhalError> =>
  Effect.flatMap(readConfig(path), (read) =>
    read === undefined ? Effect.succeed(defaultConfig) : Effect.fromResult(orInvalidInput(read)),
  );

export const saveConfig = (path: string, c: Config): Effect.Effect<void, KhalError> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise({ try: () => mkdir(dirname(path), { recursive: true }), catch: ioError });
    yield* Effect.tryPromise({ try: () => writeFile(path, serializeConfig(c), "utf8"), catch: ioError });
  });
