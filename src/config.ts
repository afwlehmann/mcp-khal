import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
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

/** Everything that can be configured for one calendar; every field is optional. */
export interface CalendarConfig {
  /** the user's own address on this calendar: the organizer of invites */
  readonly email?: string;
  /** reminder for new events on this calendar; overrides `Config.defaultAlarm` */
  readonly alarm?: AlarmSetting;
}

/** calendar name (as khal reports it) -> its settings */
export type Calendars = Readonly<Record<string, CalendarConfig>>;

export interface Config {
  /** the khal executable: a name looked up on PATH or an absolute path */
  readonly khal: string;
  /** reminder for events without an explicit `alarm`, unless the calendar has its own */
  readonly defaultAlarm: AlarmSetting;
  readonly calendars: Calendars;
}

export const DEFAULT_KHAL = "khal";
export const defaultConfig: Config = {
  khal: DEFAULT_KHAL,
  defaultAlarm: NO_ALARM,
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

/**
 * The khal executable is a bare command name (looked up on PATH) or an absolute path. A relative
 * path would depend on the working directory and `~` is not expanded, so both are rejected.
 * `label` names where the value came from, e.g. "config 'khal'" or "MCP_KHAL_BIN".
 */
export const checkBinary = (raw: string, label: string): Validated<string> => {
  const v = raw.trim();
  if (v === "" || CONTROL.test(v))
    return problem(`${label} must be a non-empty command name or absolute path without control characters`);
  if (isAbsolute(v)) return valid(v);
  if (v.startsWith("~"))
    return problem(
      `${label} must not start with '~', which is not expanded; use an absolute path (got ${v})`,
    );
  if (/[\s/\\]/.test(v) || v.startsWith("-"))
    return problem(
      `${label} must be a bare command name (looked up on PATH) or an absolute path, got ${JSON.stringify(v)}`,
    );
  return valid(v);
};

/** The environment variable wins over the config file's `khal`. */
export const resolveKhalBinary = (
  env: Env,
  config: Config,
): { readonly binary: string; readonly source: "MCP_KHAL_BIN" | "config" } => {
  const fromEnv = envValue(env, "MCP_KHAL_BIN");
  return fromEnv !== undefined
    ? { binary: fromEnv, source: "MCP_KHAL_BIN" }
    : { binary: config.khal, source: "config" };
};

/**
 * `MCP_KHAL_BIN`, when set, follows the same rule as the config's `khal`: a bare command name
 * or an absolute path, never a relative path.
 */
export const checkEnvBinary = (env: Env): Validated<string | undefined> => {
  const fromEnv = envValue(env, "MCP_KHAL_BIN");
  return fromEnv === undefined ? valid(undefined) : checkBinary(fromEnv, "MCP_KHAL_BIN");
};

export const parseCalendarNames = (stdout: string): string[] =>
  stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");

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

const CALENDAR_KEYS: readonly string[] = ["email", "alarm"];

/** One calendar's object: only `email` and `alarm` are known, each optional, every problem listed. */
const parseCalendar = (raw: unknown, name: string): Validated<CalendarConfig> => {
  const where = `calendars.${name}`;
  if (!isRecord(raw))
    return problem(
      `${where} must be an object like { "email": "me@example.com", "alarm": "15m" }, got ${JSON.stringify(raw)}`,
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
      email: raw.email === undefined ? valid(undefined) : parseEmail(raw.email, `${where}.email`),
      alarm: raw.alarm === undefined ? valid(undefined) : parseAlarm(raw.alarm, `${where}.alarm`),
    }),
    ({ email, alarm }): CalendarConfig => ({
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

/** v1.0.0 and v1.2.0 keys that moved into `calendars.<name>`; named in the error so users can migrate. */
const RETIRED_KEYS: Readonly<Record<string, string>> = {
  calendarEmails: 'moved into "calendars": { "<name>": { "email": "..." } }',
  calendarAlarms: 'moved into "calendars": { "<name>": { "alarm": "..." } }',
};

const parseBinary = (raw: unknown): Validated<string> =>
  typeof raw === "string"
    ? checkBinary(raw, "config 'khal'")
    : problem(`config 'khal' must be a string, got ${JSON.stringify(raw)}`);

const CONFIG_KEYS: readonly string[] = ["khal", "defaultAlarm", "calendars"];

/**
 * `{ "khal": "khal", "defaultAlarm": "15m",
 *    "calendars": { "work": { "email": "me@example.com", "alarm": "1d" } } }`; all keys are optional.
 * A flat `{ "work": "me@example.com" }` (the format of v1.0.0) is still understood.
 * Every problem of the file is reported, not only the first.
 */
export const parseConfigValidated = (json: string): Validated<Config> =>
  Result.flatMap(
    Result.try({
      try: (): unknown => JSON.parse(json),
      catch: (e): Problems => [`config is not valid JSON: ${e instanceof Error ? e.message : String(e)}`],
    }),
    (raw): Validated<Config> => {
      if (!isRecord(raw)) return problem("config must be a JSON object");

      const legacy = Object.values(raw).every((v) => typeof v === "string" && isEmail(v.trim()));
      if (legacy)
        return Result.map(
          parseCalendars(raw, "config", (value, name) =>
            Result.map(parseEmail(value, `config entry '${name}'`), (email): CalendarConfig => ({ email })),
          ),
          (calendars) => ({ ...defaultConfig, calendars }),
        );

      return Result.map(
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
          khal: raw.khal === undefined ? valid(DEFAULT_KHAL) : parseBinary(raw.khal),
          defaultAlarm:
            raw.defaultAlarm === undefined ? valid(NO_ALARM) : parseAlarm(raw.defaultAlarm, "defaultAlarm"),
          calendars:
            raw.calendars === undefined
              ? valid({} as Calendars)
              : parseCalendars(raw.calendars, "calendars", parseCalendar),
        }),
        ({ khal, defaultAlarm, calendars }): Config => ({ khal, defaultAlarm, calendars }),
      );
    },
  );

export const parseConfig = (json: string): Result.Result<Config, InvalidInput> =>
  orInvalidInput(parseConfigValidated(json));

export const serializeConfig = (c: Config): string =>
  `${JSON.stringify({ khal: c.khal, defaultAlarm: c.defaultAlarm, calendars: c.calendars }, null, 2)}\n`;

/** The settings of one calendar, by the (trimmed) name; inherited object properties never match. */
const calendarOf = (calendars: Calendars, calendar: string | undefined): CalendarConfig | undefined => {
  const name = calendar?.trim();
  return name !== undefined && Object.hasOwn(calendars, name) ? calendars[name] : undefined;
};

/**
 * The reminder for a new event: an explicit `alarm` wins, then the calendar's own setting, then
 * the default. `none` (explicit or configured) means no reminder, expressed as `undefined`.
 */
export const resolveAlarm = (
  settings: Pick<Config, "defaultAlarm" | "calendars">,
  calendar: string | undefined,
  explicit: string | undefined,
): string | undefined => {
  const chosen = explicit?.trim() ?? calendarOf(settings.calendars, calendar)?.alarm ?? settings.defaultAlarm;
  return chosen === NO_ALARM ? undefined : chosen;
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

/** The parsed file; `undefined` when it does not exist. Problems of the content accumulate. */
export const readConfig = (path: string): Effect.Effect<Validated<Config> | undefined, KhalError> =>
  Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: (u) => u as NodeJS.ErrnoException,
  }).pipe(
    Effect.matchEffect({
      onFailure: (e): Effect.Effect<Validated<Config> | undefined, KhalError> =>
        e.code === "ENOENT" ? Effect.succeed(undefined) : Effect.fail(ioError(e)),
      onSuccess: (content) => Effect.succeed(parseConfigValidated(content)),
    }),
  );

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
