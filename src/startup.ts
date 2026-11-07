import type { Settings } from "./settings.js";

export const REDACTED = "[REDACTED]";

/** Keys whose values must never be logged, now or when the configuration grows. */
const SECRET_KEY = /secret|token|pass(word|wd)?|api[-_]?key|credential|auth|private[-_]?key|cookie/i;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** `https://user:pw@host/` -> `https://[REDACTED]@host/` */
const stripUrlCredentials = (s: string): string =>
  s.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, `$1${REDACTED}@`);

/** Redacts the value of every secret-looking key, recursively, and credentials embedded in URLs. */
export const sanitize = (value: unknown, key = ""): unknown => {
  if (SECRET_KEY.test(key) && value !== undefined && value !== null && value !== "") return REDACTED;
  if (Array.isArray(value)) return value.map((v) => sanitize(v, key));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitize(v, k)]));
  return typeof value === "string" ? stripUrlCredentials(value) : value;
};

/** Personal data stays out of logs: `me@work.com` -> `m***@work.com`. */
export const maskEmail = (email: string): string => {
  const at = email.lastIndexOf("@");
  return at <= 0 ? REDACTED : `${email.slice(0, 1)}***${email.slice(at)}`;
};

/**
 * What is worth knowing about the effective configuration. Deliberately a whitelist: the
 * environment handed to khal (`childEnv`) is never part of it.
 */
export const startupReport = (settings: Settings): Record<string, unknown> => ({
  configPath: settings.configPath,
  khal: { binary: settings.khal, source: settings.khalSource },
  timeoutMs: settings.timeoutMs,
  defaultAlarm: settings.defaultAlarm,
  calendars: Object.fromEntries(
    Object.entries(settings.calendars).map(([name, calendar]) => [
      name,
      {
        ...(calendar.email === undefined ? {} : { email: maskEmail(calendar.email) }),
        ...(calendar.alarm === undefined ? {} : { alarm: calendar.alarm }),
      },
    ]),
  ),
});

/** The line the server logs once at startup (to stderr; stdout belongs to the MCP protocol). */
export const startupLine = (settings: Settings): string =>
  `mcp-khal starting with configuration ${JSON.stringify(sanitize(startupReport(settings)))}`;
