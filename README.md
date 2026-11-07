# mcp-khal

An MCP server that lets an assistant read and create events in your [khal](https://github.com/pimutils/khal) calendars.

## Tools

| Tool | Purpose | Parameters |
|---|---|---|
| `list_calendars` | List the configured calendars | — |
| `list_events` | List events in a date range (default: today + 7 days) | `range?`, `calendar?` |
| `events_in_range` | List all events intersecting a time range | `start`, `end`, `calendar?` |
| `search_events` | Search events by text | `query`, `calendar?` |
| `new_event` | Create an event or a recurring series | `start`, `end?`, `summary`, `calendar?`, `location?`, `description?`, `alarm?`, `recurrence?`, `attendees?`, `organizer?` |

`new_event` is the only tool that writes. Its description tells the calling agent to ask the user for confirmation first, and never to invite attendees without explicit approval. The other tools are read-only and also work on read-only calendars.

### Default calendar
When a `new_event` call names no `calendar`, the event goes to `defaultCalendar` from the config. It is required when khal has several calendars and optional when it has exactly one (that one is then used). The server checks at startup that khal has the calendar, and it always passes the calendar to khal explicitly: khal's own `default_calendar` is never relied on (without one, `khal new` fails at once with exit code 2; it does not prompt). The order in which khal lists calendars is irrelevant; calendar names are shown sorted.

### Recurring events
`recurrence` is `{ pattern, ending? }`. For a series, `start` must be `YYYY-MM-DD HH:MM` (the first occurrence, which must match the pattern), `end` is a required `HH:MM`, and times are local.

`pattern` is one of:
- `{ "kind": "daily", "interval"?: n }`
- `{ "kind": "weekly", "interval"?: n, "weekdays": [...] }`
- `{ "kind": "monthly_day", "interval"?: n, "day": 1-31 }`
- `{ "kind": "monthly_weekday", "interval"?: n, "nth": 1-4 | -1, "weekday": "..." }`
- `{ "kind": "yearly", "interval"?: n }`

`ending` is `{ "kind": "never" }`, `{ "kind": "count", "count": n }` or `{ "kind": "until", "date": "YYYY-MM-DD" }`.

Example, every 2nd Wednesday of the month: `{ "pattern": { "kind": "monthly_weekday", "nth": 2, "weekday": "wednesday" } }`.

### Invites
With `attendees` (email addresses), `new_event` imports an ICS with `ORGANIZER` and one `ATTENDEE` per address. Like a series, `start` must be `YYYY-MM-DD HH:MM` and `end` an `HH:MM`. The organizer is `organizer` if given, else the calendar's `email` from the config (`calendars.<name>.email`), else the calendar name if it is an email address; otherwise the call fails. khal does not send the invites; that is left to your sync/mail tooling.

### Reminders
`new_event` can set one reminder per event, given as `<n>m`, `<n>h` or `<n>d` (minutes, hours or days before the start, n from 0 to 9999), for example `15m`, `2h` or `1d`. `0m` means "at the start". `none` means no reminder.

If `alarm` is not given, the reminder comes from the configuration (see [Configuration](#configuration)). In order of precedence:
1. the `alarm` of the call (`none` switches a configured reminder off for this event),
2. the calendar's own `alarm` (`calendars.<name>.alarm`),
3. no reminder.

There is no global default reminder: a reminder belongs to a calendar. A call that names no `calendar` goes to the [default calendar](#default-calendar) and gets that calendar's reminder.

Why this exists: a reminder is part of the event itself (a `VALARM`), and khal and vdirsyncer sync it unchanged. A server's own "default notifications" are not reliably applied to events that arrive without one, so setting a default here makes the reminder independent of the server. Plain events are created with `khal new -m`; series and invites are imported as ICS with a `VALARM`. khal stores a reminder of `0m` as `P0D`.

## Usage
```
npm install && npm run build
```
MCP client config:
```json
{ "mcpServers": { "khal": { "command": "node", "args": ["/path/to/mcp-khal/dist/cli.js"] } } }
```

### Setup (not a tool)
```
npm run setup        # or: node dist/cli.js setup
```
Lists your khal calendars and asks for your email address on each; the answer is saved as that calendar's `email` in the config file (see below). Existing addresses are prefilled (editable) on each line; otherwise a calendar whose name is an email address is prefilled with that name. Submit blank on an empty line to skip. When khal has several calendars it then asks for the calendar new events go to (`defaultCalendar`, prefilled with the configured one; it must be one of them). Rerun any time: everything else in the file (`khal`, the reminders of the calendars, calendars khal no longer has) is preserved.

### Configuration
The server reads its environment and one JSON config file once, at startup. Nothing is re-read while it runs, so restart it after changing either.

The config file is `$MCP_KHAL_CONFIG`, else `$XDG_CONFIG_HOME/mcp-khal.json`, else `~/.config/mcp-khal.json`. A missing file means the defaults. All keys are optional:

```json
{
  "khal": "khal",
  "defaultCalendar": "work",
  "calendars": {
    "work": { "email": "me@example.com", "alarm": "1d" },
    "private": { "email": "me@example.org", "alarm": "none" },
    "school": { "alarm": "90m" }
  }
}
```

A ready-to-copy version is installed with the package at `share/doc/mcp-khal/examples/mcp-khal.json` (in the Nix package, in the npm tarball as `examples/mcp-khal.json`, and in the repository as [`examples/mcp-khal.json`](examples/mcp-khal.json)). A test parses it, so it always matches what the server accepts.

| Key | Default | Meaning |
|---|---|---|
| `khal` | `"khal"` | The khal executable: a command name looked up on `PATH`, or an absolute path such as `/nix/store/…/bin/khal`. |
| `defaultCalendar` | unset | The calendar `new_event` uses when a call names none, by the name khal reports. Required when khal has several calendars, optional with one. Checked against khal at startup. See [Default calendar](#default-calendar). |
| `calendars` | `{ }` | One object per calendar, by the name khal reports (`khal printcalendars`). |

Each entry of `calendars` has two optional fields and nothing else (a typo such as `emial` is an error):

| Field | Meaning |
|---|---|
| `email` | Your address on this calendar: the organizer of invites created there. Written by `mcp-khal setup`. |
| `alarm` | Reminder for new events on this calendar; `none` or unset means no reminder. |

Migrating from v1.2.0 (breaking): `calendarEmails` and `calendarAlarms` moved into the per-calendar objects (`"calendarEmails": { "work": "a@b.c" }` is now `"calendars": { "work": { "email": "a@b.c" } }`, likewise `alarm`), and `defaultAlarm` is gone: put an `alarm` on each calendar and name the calendar for events without one in `defaultCalendar`. A config that still uses a retired key is refused at startup with a message that says so.

Reminders are `<n>m`, `<n>h` or `<n>d` (n from 0 to 9999; lowercase unit, no spaces inside) or `none`. They are validated when the config is read (see [Validation at startup](#validation-at-startup)), and an invalid value stops the server at startup naming the key and the value. These are rejected: `15` (no unit), `-5m` (negative), `1w`, `1.5d`, `5 m`, `5M`, `None`, `1d2h`, an empty string and anything that is not a string.

| Environment variable | Meaning |
|---|---|
| `MCP_KHAL_BIN` | Overrides `khal` from the config file, for example `MCP_KHAL_BIN=/opt/khal/bin/khal`. Same rule as `khal`: an absolute path or a bare command name, never a relative path. An empty value is ignored. |
| `MCP_KHAL_CONFIG` | Path of the config file. |
| `XDG_CONFIG_HOME` | Base directory of the config file when `MCP_KHAL_CONFIG` is unset. |

At startup the server logs its effective configuration as one line on stderr (stdout carries the MCP protocol): the config file path, the khal executable and whether it came from `MCP_KHAL_BIN` or the config, the timeout, the reminders and the calendar names. Addresses are masked (`m***@work.com`), values of secret-looking keys (`token`, `password`, `secret`, `api key`, …) and credentials inside URLs are redacted, and the process environment is never logged.

A config in the flat `{ "work": "me@example.com" }` format of v1.0.0 is still read.

#### Validation at startup
The server checks its configuration when it starts and refuses to start (exit code 1, message on stderr) if anything is wrong, instead of failing later on every call. Nothing is guessed. It reports every problem at once; for example:

```
mcp-khal cannot start: InvalidInput: 3 problems:
- MCP_KHAL_BIN must not start with '~', which is not expanded; use an absolute path (got ~/khal)
- defaultCalendar must be a calendar name (a string), got 42
- calendars.work.email is not a valid email address, got "nope"
```

All strings from the environment and the config file are trimmed before they are checked, so `" 15m "` is `15m`. Whitespace inside a value is not removed (`5 m` is invalid), and an environment variable that is empty or only whitespace counts as unset.

First, the values themselves:
- **JSON and keys:** the file must be valid JSON with only the keys above, and every calendar object only `email` and `alarm`; a typo such as `emial` is an error, not silently ignored.
- **`khal` in the config and `MCP_KHAL_BIN`:** a bare command name (looked up on `PATH`) or an absolute path, never a relative path. Relative paths (`./khal`, `bin/khal`, `../khal`), `~` (never expanded), names with spaces or a leading `-`, and control characters are rejected.
- **`MCP_KHAL_CONFIG` and `XDG_CONFIG_HOME`:** absolute paths.
- **Calendar names** (the keys of `calendars` and `defaultCalendar`): not empty, no control characters, and unique after trimming.
- **Addresses** must look like email addresses, **reminders** like the section above.

Then the values against the machine:
- the khal executable runs (`khal --version`) and can list its calendars,
- every calendar named in `calendars` exists in khal (the message lists the calendars khal has, sorted, which catches typos),
- `defaultCalendar` exists in khal, and is set when khal has several calendars (with exactly one it is filled in),
- the temporary directory exists and is writable,
- a config file named explicitly by `MCP_KHAL_CONFIG` exists (the default location may be missing: that means the defaults).

`mcp-khal setup` applies the first group but not the machine checks, so it can still be used to repair a configuration that names calendars khal no longer has.

## Nix / Home Manager
The flake exposes:

| Output | Purpose |
|---|---|
| `packages.<system>.default` | The server. The version is taken from `package.json`. khal is not bundled: it must be on `PATH`, or be named in the config / `MCP_KHAL_BIN`. |
| `overlays.default` | Adds `pkgs.mcp-khal`. |
| `homeModules.default` | The Home Manager module `programs.mcp-khal`. |

Supported systems: `aarch64-darwin`, `x86_64-linux` and `aarch64-linux`. `x86_64-darwin` (Intel Macs) is not supported because the pinned nixpkgs dropped it; it would need a nixpkgs 26.05 based input.

### Home Manager module
Add the flake as an input, import the module and enable it:

```nix
# flake.nix of your Home Manager configuration
inputs.mcp-khal.url = "github:<you>/mcp-khal";

# home configuration
{ config, inputs, ... }:
{
  imports = [ inputs.mcp-khal.homeModules.default ];

  programs.mcp-khal = {
    enable = true;
    # where new events go when a call names no calendar (required with several calendars)
    defaultCalendar = "work";
    # one object per calendar, by the name khal reports; every field is optional
    calendars = {
      work = {
        email = "me@example.com";
        alarm = "1d";
      };
      private = {
        email = "me@example.org";
        alarm = "none";
      };
      school.alarm = "90m";
    };
  };
}
```

Options:

| Option | Type | Default | Description |
|---|---|---|---|
| `programs.mcp-khal.enable` | bool | `false` | Install `mcp-khal` into `home.packages`. |
| `programs.mcp-khal.package` | package | the flake's `default` package for your system | Override to use your own build or an overlay. |
| `programs.mcp-khal.khalPackage` | package | `pkgs.khal` | The khal that mcp-khal runs. Its path is written to the `khal` key of the config file, so the server does not depend on `PATH`. |
| `programs.mcp-khal.defaultCalendar` | null or non-empty string | `null` | The calendar new events go to when a call names none, by the name khal reports. Required when khal has several calendars; written to the config only when set. See [Default calendar](#default-calendar). |
| `programs.mcp-khal.calendars.<name>` | submodule | `{ }` | Settings of one calendar, by the name khal reports. A typed object with the two options below; an unknown option (a typo such as `emial`) is an evaluation error. |
| `programs.mcp-khal.calendars.<name>.email` | null or email address | `null` | Your address on the calendar: the organizer of invites (see [Invites](#invites)). Validated with the same rule as the server, so a typo fails at `home-manager switch` instead of breaking invites later. |
| `programs.mcp-khal.calendars.<name>.alarm` | null or reminder | `null` | Reminder for new events on the calendar, `none` or unset means no reminder. See [Reminders](#reminders). |

What the module does:
- It writes `~/.config/mcp-khal.json` through `xdg.configFile` with `khal` (the path of `khalPackage`), `defaultCalendar` and `calendars` (options that are not set stay out of the file); see [Configuration](#configuration). The package also ships an example config under `share/doc/mcp-khal/examples/`. This replaces the interactive `mcp-khal setup`. The file lives in the Nix store as a read-only symlink, so change the options instead of rerunning `setup`. `MCP_KHAL_BIN` in the environment of the MCP client still overrides the khal path.
- Calendar names must match the names khal reports (`khal printcalendars`), not necessarily the names of Home Manager accounts.

### Wiring it into an MCP client
The server speaks MCP over stdio, so the client needs the binary path. For example, with Home Manager's Claude Code module:

```nix
programs.claude-code.mcpServers.khal = {
  command = "${config.programs.mcp-khal.package}/bin/mcp-khal";
};
```
Any other client takes the same `command` with no arguments.

### khal and vdirsyncer
- mcp-khal only ever runs `khal`; it never calls vdirsyncer. The configured `khal` reads khal's usual config file, so use the khal configuration you already have (for example the one Home Manager generates from `programs.khal` / `accounts.calendar`).
- Events are written into khal's local storage. Getting them to the server is vdirsyncer's job, so keep syncing with your existing setup (for example `services.vdirsyncer` or a timer running `vdirsyncer sync`). A new event or invite reaches the remote calendar after the next sync.
- khal does not send invitation mails; that is left to your sync or mail tooling.

After changing npm dependencies, update `npmDepsHash` in `nix/package.nix` (set it to `lib.fakeHash`, build, copy the reported hash).

### Development
`nix develop` installs git hooks: `nixfmt`, `biome` (lint + format for TypeScript), `ripsecrets`, the unit tests (`npm test`: typecheck + [vitest](https://vitest.dev) with enforced coverage thresholds), and `convco` (Conventional Commits, e.g. `feat: add x`, `fix: y`). A commit fails if any of them fail. `nix build` also runs the tests.

### Integration tests
`nix develop --command npm run test:integration` runs the tools against the real khal from the dev shell: it creates events, a weekly series and an invite, and reads them back through khal, checks the ICS files khal stored, and runs `mcp-khal setup`. Everything happens inside one temporary directory (HOME, the XDG directories, `TMPDIR`, khal's config and calendars, the mcp-khal config); khal gets an environment built from scratch with only `PATH` taken over, so your real calendars and configuration are never read or written. The directory is removed afterwards, and the run fails if it is not.

### CI and releases
`.github/workflows/ci.yml` runs on pushes to `main`, tags and pull requests:

| Job | What it does |
|---|---|
| `nix` (Linux and macOS) | `nix flake check` (nixfmt, biome, ripsecrets, unit tests with coverage, Home Manager module check), `nix build`, and a smoke test of the binary. |
| `integration` (Linux and macOS) | The [integration tests](#integration-tests) against the real khal, run in `nix develop` (`npm ci`, then `npm run test:integration`). A job of its own, so its result is visible separately from the build and the unit tests. |
| `npm` | `npm ci`, `npm run build`, `npm test` (typecheck, vitest, coverage thresholds) without Nix. |
| `conventional commits` | Pull requests only: `convco check` over the commits of the PR. |
| `release` | On a tag `vX.Y.Z`: checks the tag equals the `package.json` version, runs `npm pack` and creates a GitHub release with generated notes and the tarball attached. Tags with a suffix such as `v1.2.0-rc.1` become pre-releases. |

Caching: the Nix jobs restore and save the Nix store with [`nix-community/cache-nix-action`](https://github.com/nix-community/cache-nix-action) (one cache per job and OS, keyed on `flake.lock`, `flake.nix`, `nix/` and, for the build, `package-lock.json`, with a prefix fallback and garbage collection above 2 GB), the `npm` and `release` jobs cache the npm downloads through `actions/setup-node`, and the `integration` job caches `~/.npm` with `actions/cache`.

To release: bump `version` (`npm version <major|minor|patch> --no-git-tag-version`, plus the version string in `src/server.ts`), update `npmDepsHash` in `nix/package.nix` (it also changes with the lockfile's version), commit, then `git tag vX.Y.Z && git push origin vX.Y.Z`. The release job only runs after the `nix`, `integration` and `npm` jobs succeed.
