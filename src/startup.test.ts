import { describe, expect, it } from "vitest";
import { maskEmail, REDACTED, sanitize, startupLine, startupReport } from "./startup.js";
import { testSettings } from "./testlib.js";

describe("sanitize", () => {
  it("redacts values of secret-looking keys at any depth", () => {
    const input = {
      path: "/cal/work",
      password: "hunter2",
      nested: {
        apiKey: "abc",
        api_key: "abc",
        Token: "t",
        clientSecret: "s",
        list: [{ authorization: "Bearer x" }],
      },
      passwords: ["a", "b"],
    };
    expect(sanitize(input)).toEqual({
      path: "/cal/work",
      password: REDACTED,
      nested: {
        apiKey: REDACTED,
        api_key: REDACTED,
        Token: REDACTED,
        clientSecret: REDACTED,
        list: [{ authorization: REDACTED }],
      },
      // a whole value under a secret-looking key is redacted at once, arrays included
      passwords: REDACTED,
    });
  });

  it("keeps empty or missing secrets as they are and leaves ordinary values alone", () => {
    expect(sanitize({ password: "", token: null, other: undefined, n: 1, ok: true })).toEqual({
      password: "",
      token: null,
      other: undefined,
      n: 1,
      ok: true,
    });
  });

  it("strips credentials embedded in URLs", () => {
    expect(sanitize({ remote: "https://alice:s3cret@example.org/dav" })).toEqual({
      remote: `https://${REDACTED}@example.org/dav`,
    });
    expect(sanitize("see https://example.org/plain and ssh://git@host/x")).toBe(
      `see https://example.org/plain and ssh://${REDACTED}@host/x`,
    );
  });
});

describe("maskEmail", () => {
  it("keeps the first letter and the domain only", () => {
    expect(maskEmail("me@work.com")).toBe("m***@work.com");
    expect(maskEmail("first.last+tag@sub.example.org")).toBe("f***@sub.example.org");
  });

  it("redacts anything that is not an address", () => {
    expect(maskEmail("nope")).toBe(REDACTED);
    expect(maskEmail("@x.com")).toBe(REDACTED);
  });
});

describe("startupReport", () => {
  const settings = testSettings({
    configPath: "/c.json",
    defaultCalendar: "work",
    calendars: {
      work: { path: "/cal/work", email: "me@work.com", alarm: "1d" },
      home: { path: "/cal/home", alarm: "none" },
    },
  });

  it("reports the config path, the time zone, the folders and masked addresses", () => {
    expect(startupReport(settings)).toEqual({
      configPath: "/c.json",
      timezone: "Europe/Berlin",
      defaultCalendar: "work",
      calendars: {
        work: { path: "/cal/work", email: "m***@work.com", alarm: "1d" },
        home: { path: "/cal/home", alarm: "none" },
      },
    });
  });

  it("leaves out the default calendar when there is none", () => {
    const report = startupReport(testSettings({ calendars: { work: { path: "/cal/work" } } }));
    expect("defaultCalendar" in report).toBe(false);
    expect(report.calendars).toEqual({ work: { path: "/cal/work" } });
  });

  it("is a whitelist: only the config path, the zone, the default calendar and the calendars", () => {
    expect(Object.keys(startupReport(settings)).sort()).toEqual([
      "calendars",
      "configPath",
      "defaultCalendar",
      "timezone",
    ]);
  });
});

describe("startupLine", () => {
  it("never contains a full email address", () => {
    const line = startupLine(
      testSettings({ calendars: { work: { path: "/cal/work", email: "me@work.com" } } }),
    );
    expect(line).toMatch(/^mcp-khal starting with configuration \{/);
    expect(line).toContain("m***@work.com");
    expect(line).toContain("/cal/work");
    expect(line).not.toContain("me@work.com");
  });

  it("redacts credentials in a URL even if one ever ends up in the report", () => {
    const line = startupLine(testSettings({ configPath: "https://user:pw@host/x" }));
    expect(line).not.toContain("user:pw");
    expect(line).toContain(`https://${REDACTED}@host/x`);
  });
});
