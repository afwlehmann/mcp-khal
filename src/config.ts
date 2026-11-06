import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Effect, Result } from "effect";
import { InvalidInput, ioError, type KhalError } from "./errors.js";

/** calendar name -> the user's own address on that calendar */
export type Mapping = Readonly<Record<string, string>>;

export type Env = Readonly<Record<string, string | undefined>>;

/** `15m`, `2h`, `1d`, or `none` for no reminder at all */
export type AlarmSetting = string;

export const NO_ALARM = "none";

export interface Config {
  /** the khal executable: a name looked up on PATH or an absolute path */
  readonly khal: string;
  readonly calendarEmails: Mapping;
  /** reminder for events without an explicit `alarm`, unless the calendar has its own */
  readonly defaultAlarm: AlarmSetting;
  /** calendar name -> reminder for new events on that calendar (overrides `defaultAlarm`) */
  readonly calendarAlarms: Mapping;
}

export const DEFAULT_KHAL = "khal";
export const defaultConfig: Config = {
  khal: DEFAULT_KHAL,
  calendarEmails: {},
  defaultAlarm: NO_ALARM,
  calendarAlarms: {},
};

const invalid = (message: string): InvalidInput => new InvalidInput({ message });

// ---------- pure ----------

export const isEmail = (s: string): boolean => /^[^\s@,;:<>]+@[^\s@,;:<>]+\.[^\s@,;:<>]+$/.test(s);

export const configPath = (env: Env, home: string): string =>
  env.MCP_KHAL_CONFIG ?? join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "mcp-khal.json");

/** The environment variable wins over the config file's `khal`. */
export const resolveKhalBinary = (
  env: Env,
  config: Config,
): { readonly binary: string; readonly source: "MCP_KHAL_BIN" | "config" } =>
  env.MCP_KHAL_BIN !== undefined && env.MCP_KHAL_BIN !== ""
    ? { binary: env.MCP_KHAL_BIN, source: "MCP_KHAL_BIN" }
    : { binary: config.khal, source: "config" };

export const parseCalendarNames = (stdout: string): string[] =>
  stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const parseEmails = (raw: unknown, where: string): Result.Result<Mapping, InvalidInput> => {
  if (!isRecord(raw)) return Result.fail(invalid(`${where} must be a JSON object of calendar name -> email`));
  const bad = Object.entries(raw).find(([, v]) => typeof v !== "string" || !isEmail(v));
  return bad
    ? Result.fail(invalid(`${where} entry '${bad[0]}' is not a valid email address`))
    : Result.succeed(raw as Mapping);
};

/** `<n>m`, `<n>h` or `<n>d` (n = 0..9999 minutes, hours or days before the start), or `none`. */
export const isAlarmSetting = (s: string): boolean => s === NO_ALARM || /^\d{1,4}[mhd]$/.test(s);

const ALARM_HINT = "a reminder like 30m, 2h or 1d (minutes, hours, days before the start), or 'none'";

const parseAlarm = (raw: unknown, where: string): Result.Result<AlarmSetting, InvalidInput> =>
  typeof raw === "string" && isAlarmSetting(raw)
    ? Result.succeed(raw)
    : Result.fail(invalid(`${where} must be ${ALARM_HINT}, got ${JSON.stringify(raw)}`));

const parseCalendarAlarms = (raw: unknown): Result.Result<Mapping, InvalidInput> => {
  if (!isRecord(raw))
    return Result.fail(invalid("calendarAlarms must be a JSON object of calendar name -> reminder"));
  const bad = Object.entries(raw).find(([, v]) => typeof v !== "string" || !isAlarmSetting(v));
  return bad
    ? Result.fail(
        invalid(`calendarAlarms entry '${bad[0]}' must be ${ALARM_HINT}, got ${JSON.stringify(bad[1])}`),
      )
    : Result.succeed(raw as Mapping);
};

const parseBinary = (raw: unknown): Result.Result<string, InvalidInput> =>
  typeof raw !== "string" || raw.trim() === "" || /[\u0000-\u001f\u007f]/.test(raw)
    ? Result.fail(invalid("config 'khal' must be a non-empty path or command name"))
    : Result.succeed(raw.trim());

/**
 * `{ "khal": "khal", "calendarEmails": { "work": "me@example.com" } }`; both keys are optional.
 * A flat `{ "work": "me@example.com" }` (the format of v1.0.0) is still understood.
 */
export const parseConfig = (json: string): Result.Result<Config, InvalidInput> =>
  Result.gen(function* () {
    const raw = yield* Result.try({
      try: (): unknown => JSON.parse(json),
      catch: (e) => invalid(`config is not valid JSON: ${e instanceof Error ? e.message : String(e)}`),
    });
    if (!isRecord(raw)) return yield* Result.fail(invalid("config must be a JSON object"));

    const legacy = Object.values(raw).every((v) => typeof v === "string" && isEmail(v));
    if (legacy) return { ...defaultConfig, calendarEmails: raw as Mapping };

    const unknown = Object.keys(raw).find((k) => !CONFIG_KEYS.includes(k));
    if (unknown !== undefined)
      return yield* Result.fail(
        invalid(`unknown config key '${unknown}' (expected ${CONFIG_KEYS.map((k) => `'${k}'`).join(", ")})`),
      );
    const khal = raw.khal === undefined ? DEFAULT_KHAL : yield* parseBinary(raw.khal);
    const calendarEmails =
      raw.calendarEmails === undefined ? {} : yield* parseEmails(raw.calendarEmails, "calendarEmails");
    const defaultAlarm =
      raw.defaultAlarm === undefined ? NO_ALARM : yield* parseAlarm(raw.defaultAlarm, "defaultAlarm");
    const calendarAlarms =
      raw.calendarAlarms === undefined ? {} : yield* parseCalendarAlarms(raw.calendarAlarms);
    return { khal, calendarEmails, defaultAlarm, calendarAlarms };
  });

const CONFIG_KEYS: readonly string[] = ["khal", "calendarEmails", "defaultAlarm", "calendarAlarms"];

export const serializeConfig = (c: Config): string =>
  `${JSON.stringify(
    {
      khal: c.khal,
      calendarEmails: c.calendarEmails,
      defaultAlarm: c.defaultAlarm,
      calendarAlarms: c.calendarAlarms,
    },
    null,
    2,
  )}\n`;

/**
 * The reminder for a new event: an explicit `alarm` wins, then the calendar's own setting, then
 * the default. `none` (explicit or configured) means no reminder, expressed as `undefined`.
 */
export const resolveAlarm = (
  settings: Pick<Config, "defaultAlarm" | "calendarAlarms">,
  calendar: string | undefined,
  explicit: string | undefined,
): string | undefined => {
  const chosen =
    explicit ??
    (calendar !== undefined && Object.hasOwn(settings.calendarAlarms, calendar)
      ? settings.calendarAlarms[calendar]
      : settings.defaultAlarm);
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

/** Which address represents the user on this calendar? Explicit > mapping > email-like name. */
export const resolveAddress = (
  mapping: Mapping,
  calendar: string | undefined,
  explicit?: string,
): Result.Result<string, InvalidInput> => {
  if (explicit !== undefined)
    return isEmail(explicit)
      ? Result.succeed(explicit)
      : Result.fail(invalid(`'${explicit}' is not a valid email address`));
  if (calendar === undefined)
    return Result.fail(invalid("calendar (or organizer) is required to determine your address for invites"));
  if (Object.hasOwn(mapping, calendar)) return Result.succeed(mapping[calendar]!);
  return isEmail(calendar)
    ? Result.succeed(calendar)
    : Result.fail(
        invalid(`no address known for calendar '${calendar}'; run \`mcp-khal setup\` or pass one explicitly`),
      );
};

// ---------- effects (the path is always passed in) ----------

/** A missing file is the default configuration, not an error. */
export const loadConfig = (path: string): Effect.Effect<Config, KhalError> =>
  Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: (u) => u as NodeJS.ErrnoException,
  }).pipe(
    Effect.matchEffect({
      onFailure: (e): Effect.Effect<Config, KhalError> =>
        e.code === "ENOENT" ? Effect.succeed(defaultConfig) : Effect.fail(ioError(e)),
      onSuccess: (content): Effect.Effect<Config, KhalError> => Effect.fromResult(parseConfig(content)),
    }),
  );

export const saveConfig = (path: string, c: Config): Effect.Effect<void, KhalError> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise({ try: () => mkdir(dirname(path), { recursive: true }), catch: ioError });
    yield* Effect.tryPromise({ try: () => writeFile(path, serializeConfig(c), "utf8"), catch: ioError });
  });
