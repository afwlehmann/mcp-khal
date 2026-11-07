import { describe, expect, it } from "vitest";
import { maskEmail, REDACTED, sanitize, startupLine, startupReport } from "./startup.js";
import { testSettings } from "./testlib.js";

describe("sanitize", () => {
  it("redacts values of secret-looking keys at any depth", () => {
    const input = {
      khal: "khal",
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
      khal: "khal",
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
    khal: "/cfg/khal",
    khalSource: "config",
    configPath: "/c.json",
    defaultAlarm: "15m",
    calendars: { work: { email: "me@work.com", alarm: "1d" }, home: { alarm: "none" } },
    timeoutMs: 5000,
  });

  it("reports the config path, the khal binary with its source and masked addresses", () => {
    expect(startupReport(settings)).toEqual({
      configPath: "/c.json",
      khal: { binary: "/cfg/khal", source: "config" },
      timeoutMs: 5000,
      defaultAlarm: "15m",
      calendars: { work: { email: "m***@work.com", alarm: "1d" }, home: { alarm: "none" } },
    });
  });

  it("shows that MCP_KHAL_BIN overrides the config", () => {
    const report = startupReport({ ...settings, khal: "/env/khal", khalSource: "MCP_KHAL_BIN" });
    expect(report.khal).toEqual({ binary: "/env/khal", source: "MCP_KHAL_BIN" });
  });
});

describe("startupLine", () => {
  it("never contains a full email address", () => {
    const line = startupLine(testSettings({ calendars: { work: { email: "me@work.com" } } }));
    expect(line).toMatch(/^mcp-khal starting with configuration \{/);
    expect(line).toContain("m***@work.com");
    expect(line).not.toContain("me@work.com");
  });

  it("never contains the environment handed to khal", () => {
    const line = startupLine(
      testSettings({
        childEnv: { PATH: "/bin", API_TOKEN: "t0ps3cret", HOME: "/home/someone", DB_PASSWORD: "hunter2" },
      }),
    );
    for (const leaked of ["t0ps3cret", "hunter2", "/home/someone", "API_TOKEN", "DB_PASSWORD"])
      expect(line).not.toContain(leaked);
  });

  it("redacts a secret even if one is ever added to the report", () => {
    const line = startupLine(testSettings({ khal: "https://user:pw@host/khal" }));
    expect(line).not.toContain("user:pw");
    expect(line).toContain(`https://${REDACTED}@host/khal`);
  });
});
