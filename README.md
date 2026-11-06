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
With `attendees` (email addresses), `new_event` imports an ICS with `ORGANIZER` and one `ATTENDEE` per address. Like a series, `start` must be `YYYY-MM-DD HH:MM` and `end` an `HH:MM`. The organizer is `organizer` if given, else the calendar's entry from the setup mapping, else the calendar name if it is an email address; otherwise the call fails. khal does not send the invites; that is left to your sync/mail tooling.

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
Lists your khal calendars and asks for your email address on each. The mapping (calendar name → address) is saved to the config file (see below). Existing entries are prefilled (editable) on each line; otherwise a calendar whose name is an email address is prefilled with that name. Submit blank on an empty line to skip. Rerun any time; the `khal` setting of the file is preserved.

### Configuration
The server reads its environment and one JSON config file once, at startup. Nothing is re-read while it runs, so restart it after changing either.

The config file is `$MCP_KHAL_CONFIG`, else `$XDG_CONFIG_HOME/mcp-khal.json`, else `~/.config/mcp-khal.json`. A missing file means the defaults. Both keys are optional:

```json
{
  "khal": "khal",
  "calendarEmails": { "work": "me@example.com" }
}
```

| Key | Default | Meaning |
|---|---|---|
| `khal` | `"khal"` | The khal executable: a command name looked up on `PATH`, or an absolute path such as `/nix/store/…/bin/khal`. |
| `calendarEmails` | `{ }` | Calendar name → your address on it, used as the organizer of invites. Written by `mcp-khal setup`. |

| Environment variable | Meaning |
|---|---|
| `MCP_KHAL_BIN` | Overrides `khal` from the config file, for example `MCP_KHAL_BIN=/opt/khal/bin/khal`. An empty value is ignored. |
| `MCP_KHAL_CONFIG` | Path of the config file. |
| `XDG_CONFIG_HOME` | Base directory of the config file when `MCP_KHAL_CONFIG` is unset. |

At startup the server logs its effective configuration as one line on stderr (stdout carries the MCP protocol): the config file path, the khal executable and whether it came from `MCP_KHAL_BIN` or the config, the timeout and the calendar names. Addresses are masked (`m***@work.com`), values of secret-looking keys (`token`, `password`, `secret`, `api key`, …) and credentials inside URLs are redacted, and the process environment is never logged.

A config in the flat `{ "work": "me@example.com" }` format of v1.0.0 is still read. An unreadable or invalid config stops the server at startup with a message on stderr, instead of failing later on every call.

## Nix / Home Manager
The flake exposes:

| Output | Purpose |
|---|---|
| `packages.<system>.default` | The server. The version is taken from `package.json`. khal is not bundled: it must be on `PATH`, or be named in the config / `MCP_KHAL_BIN`. |
| `overlays.default` | Adds `pkgs.mcp-khal`. |
| `homeModules.default` | The Home Manager module `programs.mcp-khal`. |

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
    # calendar name -> your email address on that calendar
    calendarEmails = {
      work = "me@example.com";
      private = "me@example.org";
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
| `programs.mcp-khal.calendarEmails` | attrs of email address | `{ }` | Calendar name → your address on it. Used as the organizer of invites (see [Invites](#invites)). Values are validated with the same rule as the server, so a typo fails at `home-manager switch` instead of breaking invites later. |

What the module does:
- It writes `~/.config/mcp-khal.json` through `xdg.configFile` with `khal` (the path of `khalPackage`) and `calendarEmails`; see [Configuration](#configuration). This replaces the interactive `mcp-khal setup`. The file lives in the Nix store as a read-only symlink, so change the options instead of rerunning `setup`. `MCP_KHAL_BIN` in the environment of the MCP client still overrides the khal path.
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
| `npm` | `npm ci`, `npm run build`, `npm test` (typecheck, vitest, coverage thresholds) without Nix. |
| `conventional commits` | Pull requests only: `convco check` over the commits of the PR. |
| `release` | On a tag `vX.Y.Z`: checks the tag equals the `package.json` version, runs `npm pack` and creates a GitHub release with generated notes and the tarball attached. Tags with a suffix such as `v1.2.0-rc.1` become pre-releases. |

To release: bump `version` (`npm version <major|minor|patch> --no-git-tag-version`, plus the version string in `src/server.ts`), update `npmDepsHash` in `nix/package.nix` (it also changes with the lockfile's version), commit, then `git tag vX.Y.Z && git push origin vX.Y.Z`. The release job only runs after the `nix` and `npm` jobs succeed.
