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

## Nix / Home Manager
The flake exposes `packages.<system>.default` (version taken from `package.json`, `khal` bundled on its PATH), `overlays.default` and `homeModules.default`.

```nix
# flake inputs: mcp-khal.url = "github:<you>/mcp-khal";
{
  imports = [ inputs.mcp-khal.homeModules.default ];
  programs.mcp-khal = {
    enable = true;
    # replaces `mcp-khal setup`; written to $XDG_CONFIG_HOME/mcp-khal.json
    calendarEmails.work = "me@example.com";
  };
}
```
Then point your MCP client at `${config.programs.mcp-khal.package}/bin/mcp-khal`.

After changing npm dependencies, update `npmDepsHash` in `nix/package.nix` (set it to `lib.fakeHash`, build, copy the reported hash).

### Development
`nix develop` installs git hooks: `nixfmt`, `biome` (lint + format for TypeScript), `ripsecrets`, the unit tests (`npm test`, built on `node:test`), and `convco` (Conventional Commits, e.g. `feat: add x`, `fix: y`). A commit fails if any of them fail. `nix build` also runs the tests.

## Setup (not a tool)
```
npm run setup        # or: node dist/cli.js setup
```
Lists your khal calendars and asks for your email address on each. The mapping (calendar name → address) is saved to `~/.config/mcp-khal.json` (`$XDG_CONFIG_HOME` and `$MCP_KHAL_CONFIG` are honoured). Existing entries are prefilled (editable) on each line; otherwise a calendar whose name is an email address is prefilled with that name. Submit blank on an empty line to skip. Rerun any time.
