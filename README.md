# mcp-khal

An MCP server that lets an assistant read, create and change events in your local iCalendar (`.ics`) calendars, stored as a [vdir](https://vdirsyncer.pimutils.org/en/stable/vdir.html) (one `.ics` file per event in a directory, as [vdirsyncer](https://github.com/pimutils/vdirsyncer) keeps them). The server parses and writes the files itself: it needs no khal and no Python, only Node.

The name is historical: version 2.x ran the `khal` command line tool. See the [changelog](CHANGELOG.md).

## Tools

| Tool | Purpose | Parameters |
|---|---|---|
| `list_calendars` | List the configured calendars | — |
| `list_events` | List events in a range of days (default: today + 7 days) | `range?`, `calendar?` |
| `events_in_range` | List all events intersecting the days from `start` up to `end` | `start`, `end`, `calendar?` |
| `search_events` | Search events by text | `query`, `calendar?`, `range?` |
| `new_event` | Create an event or a recurring series | `start`, `end?`, `duration?`, `timezone?`, `summary`, `calendar?`, `location?`, `description?`, `alarm?`, `recurrence?`, `attendees?`, `organizer?` |
| `update_event` | Change an existing event, all of a series, one occurrence or the occurrences from a date on | `calendar`, `uid`, `scope?`, `date?`, `summary?`, `location?`, `description?`, `start?`, `end?` |
| `end_event_series` | End a recurring event after a given day | `calendar`, `uid`, `last_date` |
| `respond_to_event` | Accept, decline or mark as tentative an invitation (needs the calendar's `email`) | `calendar`, `uid`, `response`, `scope?`, `date?` |

The three read tools return a JSON array of events with the fields `calendar`, `startDate`, `startTime`, `endDate`, `endTime`, `title`, `location`, `organizer`, `attendees`, `uid`, `status`, `cancelled`, `allDay`, `repeatPattern` and `description`. `attendees` lists the invitees by name and address; accept/decline status is not part of the output. Recurring events are expanded: each occurrence in the range is one entry. Files that could not be read or expanded (unparsable, over 2 MiB, duplicate uid, unknown time zone) are listed after the JSON as problems, never silently dropped.

### Ranges
The range of `list_events` and `search_events` is ISO, not free text. The grammar is exactly this, case-insensitive:

| `range` | Days |
|---|---|
| `''` (omitted) | today and the next 7 days |
| `today`, `tomorrow`, `YYYY-MM-DD` | that one day |
| `A B` | from day `A` up to, not including, day `B` (`2026-11-01 2026-11-08`) |
| `A Nd` | `N` days starting at `A` (`today 7d`), N from 1 to 3660 |

`A` and `B` are `today`, `tomorrow` or a date. `events_in_range` takes `start` and `end` as two such day words (the end day is exclusive). Weekday names, `yesterday`, `now`, `eod`, `week` and locale date formats are not understood. Days are calendar days in the server's [time zone](#time-zones), so a range across a DST change is still whole days. An event is in the range when it intersects the half-open interval `[start of the first day, start of the end day)`; an event that merely ends at the start is not in it. `search_events` matches a case-insensitive substring of title, location or description (no patterns) and, without a `range`, looks a year back and a year ahead.

### Writing
`new_event`, `update_event`, `end_event_series` and `respond_to_event` are the tools that write. Their descriptions tell the calling agent to ask the user for confirmation first (and never to invite attendees without explicit approval). The other tools are read-only and also work on read-only calendars. If the title of a new event contains `/`, the event is still created, but the result ends with a warning for the agent: some CalDAV servers have synchronization problems with such titles.

`new_event` takes structured fields and writes a new `.ics` file into the calendar's `path`:
- `start` is `YYYY-MM-DD` for an all-day event (then `end` is the last day, inclusive) or `YYYY-MM-DDTHH:MM` for a timed one.
- Give `end` (same form) or `duration` (`1h`, `30m`, `1h30m`, `2d`), not both. With neither, a timed event lasts one hour and an all-day event one day. A timed event must end after it starts.
- `timezone` is an IANA zone name (`Europe/Berlin`) in which a timed event's `start` and `end` are read; the default is the server's [time zone](#time-zones). It is ignored for all-day events.
- The file name is a plain token derived from the uid, and an existing file is never overwritten.

`update_event` rewrites the event's `.ics` file atomically, and the previous version is not kept: it cannot be undone. Its description says so and tells the agent to ask the user first. The event is identified by `calendar` and `uid` (both are in the output of the read tools). Only the given fields change; an empty `location` or `description` removes it. `start` (`YYYY-MM-DD HH:MM`) and `end` (`HH:MM`, same day) go together and are in the event's own time zone (UTC for an event stored in UTC). All-day events cannot be moved. Attendees are not touched and no invitation update is sent. SEQUENCE, LAST-MODIFIED and DTSTAMP are updated.

For a recurring event `scope` says what changes, so the agent never touches ICS itself, and each is one call:

| `scope` | Needs | What happens |
|---|---|---|
| `all` (default) | – | The whole series changes, and moves if `start`/`end` are given. Refused for a series with exceptions when moving. Exceptions keep their own text. |
| `instance` | `date` | Only the occurrence on `date` changes; it may be moved to another day. An exception (`RECURRENCE-ID`) is written into the same file, or the existing one for that day is changed. The series stays as it is. |
| `from_date` | `date` | The occurrence on `date` and all after it change. The series is split: the old one ends one second before that occurrence (`UNTIL`, in the form RFC 5545 requires for its time zone), and the rest becomes a new series with a new uid in a new `.ics` file; a `COUNT` is carried over (the new series gets the occurrences that were left). Only the time of day can change, not the date. Refused when the series has exceptions or listed dates on or after `date`; change those with `instance`. |

`date` (`YYYY-MM-DD`) must be a day on which the series has an occurrence, so excluded days and days beyond the end of the series are refused before anything is written. For `from_date` the new series is written first, so a failure in between leaves a duplicate rather than losing events.

`end_event_series` makes `last_date` (`YYYY-MM-DD`, an existing occurrence after the first) the last occurrence: the rule gets an `UNTIL` just after it (replacing a `COUNT`) and exceptions after it are dropped. It rewrites the `.ics` file like `update_event`, cannot be undone, and says so in its description. It never removes a whole event, and no cancellation is sent to attendees.

`respond_to_event` sets the `PARTSTAT` of the user's own `ATTENDEE` line (`ACCEPTED`, `DECLINED` or `TENTATIVE`) and drops the `RSVP` request, leaving `SEQUENCE` and every other attendee alone. The user is the calendar's configured `email` (matched case-insensitively against the attendees); the call is refused when that address is not invited. `scope` is `all` (default: the main event and every exception that lists the user) or `instance` with `date` (one occurrence; an exception is written for it). It rewrites the `.ics` file like `update_event` and cannot be undone. The server sends nothing, so the organizer only learns of the answer if the user's sync or mail tooling does that; the tool result says so.

### Input checks
Everything an agent passes in is checked before anything is read or written, and a failed check changes nothing:
- **Shape (schema):** `calendar` and `uid` at most 255 characters; summary and location at most 1,000, description at most 20,000; days exactly `YYYY-MM-DD` (then checked to be a real date); times exactly `YYYY-MM-DDTHH:MM`; `scope` and `response` only the listed values; `timezone` a known IANA zone.
- **Text** (summary, location, description): no control characters or Unicode line/paragraph separators; line breaks, `,`, `;` and `\` are escaped, so text can never add ICS lines or properties.
- **Files:** a calendar is addressed by its configured `path`, never by a path from the call. Events are found by `uid` among the `.ics` files of that directory only (directories, other files and files over 2 MiB are skipped). A new file gets a plain name (letters, digits, `._@-`) and never overwrites an existing one. Writes go to a temporary file in the same directory and are renamed over the old one.

### Default calendar
When a `new_event` call names no `calendar`, the event goes to `defaultCalendar` from the config. It is required when several calendars are configured and optional when there is exactly one (that one is then used). The server checks at startup that it is one of the configured calendars. The order in which calendars are configured is irrelevant; calendar names are shown sorted.

### Recurring events
`recurrence` is `{ pattern, ending? }`. For a series, `start` must be `YYYY-MM-DDTHH:MM` (the first occurrence, which must match the pattern) and the duration comes from `end` or `duration`.

`pattern` is one of:
- `{ "kind": "daily", "interval"?: n }`
- `{ "kind": "weekly", "interval"?: n, "weekdays": [...] }`
- `{ "kind": "monthly_day", "interval"?: n, "day": 1-31 }`
- `{ "kind": "monthly_weekday", "interval"?: n, "nth": 1-4 | -1, "weekday": "..." }`
- `{ "kind": "yearly", "interval"?: n }`

`ending` is `{ "kind": "never" }`, `{ "kind": "count", "count": n }` or `{ "kind": "until", "date": "YYYY-MM-DD" }`.

Example, every 2nd Wednesday of the month: `{ "pattern": { "kind": "monthly_weekday", "nth": 2, "weekday": "wednesday" } }`.

Reading expands any RFC 5545 recurrence found in the files, not only these patterns: `RRULE` (including `BYSETPOS`, `BYDAY` and the like), `RDATE`, `EXDATE`, single overrides (`RECURRENCE-ID`) and `RANGE=THISANDFUTURE`. `RDATE;VALUE=PERIOD` and `RANGE=THISANDPRIOR` are not supported and are reported as problems. A series without an end is expanded only as far as the requested range.

### Time zones
The server's own time zone, the host zone, decides what a time without zone means: the range days of the read tools, the times of `new_event` without `timezone`, and how times are shown. It is read once at startup from the runtime (`Intl.DateTimeFormat().resolvedOptions().timeZone`), which follows the `TZ` environment variable and otherwise the system's zone, and it is logged in the startup line. There is no config key for it. In a container, which usually has no zone configured and then reports `UTC`, set `TZ` (for example `TZ=Europe/Berlin`) in the environment of the server. A value that is not a known IANA zone stops the server at startup.

Events keep their own zone. A recurring event is expanded as wall-clock time in its zone (a daily 09:00 stays 09:00 across a DST change), and its occurrences are shown in the host zone. Floating times (no zone) are read as host-zone time. An unknown `TZID` is reported as a problem for that event and not guessed; the Windows zone names that Outlook writes are mapped to IANA zones. Timed events written by `new_event` carry a `VTIMEZONE` generated from the IANA zone; a `VTIMEZONE` that comes with an event is kept.

### Invites
With `attendees` (email addresses), `new_event` writes an event with `ORGANIZER` and one `ATTENDEE` per address. The organizer is `organizer` if given, else the calendar's `email` from the config (`calendars.<name>.email`), else the calendar name if it is an email address; otherwise the call fails. The server does not send the invites; that is left to your sync/mail tooling.

### Reminders
`new_event` can set one reminder per event, given as `<n>m`, `<n>h` or `<n>d` (minutes, hours or days before the start, n from 0 to 9999), for example `15m`, `2h` or `1d`. `0m` means "at the start". `none` means no reminder. The reminder is written as a display `VALARM`.

If `alarm` is not given, the reminder comes from the configuration (see [Configuration](#configuration)). In order of precedence:
1. the `alarm` of the call (`none` switches a configured reminder off for this event),
2. the calendar's own `alarm` (`calendars.<name>.alarm`),
3. no reminder.

There is no global default reminder: a reminder belongs to a calendar. A call that names no `calendar` goes to the [default calendar](#default-calendar) and gets that calendar's reminder.

Why this exists: a reminder is part of the event itself (a `VALARM`), and vdirsyncer syncs it unchanged. A server's own "default notifications" are not reliably applied to events that arrive without one, so setting a default here makes the reminder independent of the server.

## Usage
```
npm install && npm run build
```
MCP client config:
```json
{ "mcpServers": { "calendar": { "command": "node", "args": ["/path/to/mcp-khal/dist/cli.js"] } } }
```

### Setup (not a tool)
```
npm run setup        # or: node dist/cli.js setup
```
Asks for your email address on each configured calendar (saved as that calendar's `email`) and, when there are several calendars, for the calendar new events go to (`defaultCalendar`). Existing values are prefilled and editable; submit blank to skip. It never invents calendars: each calendar and its `path` must be in the config file (see below). Rerun any time: everything else in the file is preserved.

### Configuration
The server reads its environment and one JSON config file once, at startup. Nothing is re-read while it runs, so restart it after changing either.

The config file is `$MCP_KHAL_CONFIG`, else `$XDG_CONFIG_HOME/mcp-khal.json`, else `~/.config/mcp-khal.json`. A missing file means no calendars. The file needs at least one calendar with a `path`; `defaultCalendar` is required with several:

```json
{
  "defaultCalendar": "work",
  "calendars": {
    "work": { "path": "/home/me/.local/share/calendars/work", "email": "me@example.com", "alarm": "1d" },
    "private": { "path": "/home/me/.local/share/calendars/private", "email": "me@example.org", "alarm": "none" },
    "school": { "path": "/home/me/.local/share/calendars/school", "alarm": "90m" }
  }
}
```

A ready-to-copy version is installed with the package at `share/doc/mcp-khal/examples/mcp-khal.json` (in the Nix package, in the npm tarball as `examples/mcp-khal.json`, and in the repository as [`examples/mcp-khal.json`](examples/mcp-khal.json)). A test parses it, so it always matches what the server accepts.

| Key | Default | Meaning |
|---|---|---|
| `defaultCalendar` | unset | The calendar `new_event` uses when a call names none. Required when several calendars are configured, optional with one. Checked against `calendars` at startup. See [Default calendar](#default-calendar). |
| `calendars` | `{ }` | One object per calendar, by name. The name is what the tools show and take as `calendar`. |

Each entry of `calendars` has one required and two optional fields and nothing else (a typo such as `emial` is an error):

| Field | Meaning |
|---|---|
| `path` | Required. Absolute path of the calendar's vdir: the directory of its `.ics` files (with vdirsyncer, the `path` of its `filesystem` storage). Not recursive: only the files directly in it are read. Different for every calendar. Checked at startup: a readable and writable directory (read-only tools would work on a read-only one, but the server refuses to start so that a typo is noticed). |
| `email` | Your address on this calendar: the organizer of invites created there, and who answers invitations. Written by `mcp-khal setup`. |
| `alarm` | Reminder for new events on this calendar; `none` or unset means no reminder. |

Reminders are `<n>m`, `<n>h` or `<n>d` (n from 0 to 9999; lowercase unit, no spaces inside) or `none`. They are validated when the config is read (see [Validation at startup](#validation-at-startup)), and an invalid value stops the server at startup naming the key and the value. These are rejected: `15` (no unit), `-5m` (negative), `1w`, `1.5d`, `5 m`, `5M`, `None`, `1d2h`, an empty string and anything that is not a string.

#### Environment variables
Every setting of the config file can also be set, or overridden, by an environment variable. The names follow one rule: `MCP_KHAL_`, then the key path in capitals, every part joined by a single `_`.

| Config key | Environment variable |
|---|---|
| `defaultCalendar` | `MCP_KHAL_DEFAULT_CALENDAR` |
| `calendars.<name>.path` | `MCP_KHAL_CALENDARS_<NAME>_PATH` |
| `calendars.<name>.email` | `MCP_KHAL_CALENDARS_<NAME>_EMAIL` |
| `calendars.<name>.alarm` | `MCP_KHAL_CALENDARS_<NAME>_ALARM` |

`<NAME>` is the calendar name in capitals, with every run of characters other than `A–Z` and `0–9` turned into one `_` (`work-1` becomes `WORK_1`). A calendar is found by that form, so `MCP_KHAL_CALENDARS_WORK_1_ALARM=15m` sets the reminder of the calendar `work-1` of the file. The calendar settings are a fixed set (`path`, `email`, `alarm`), so the setting is always the last part and the calendar everything between: an underscore inside a name is not ambiguous. A variable beats the file; an empty or blank variable counts as unset. A calendar that is only in the environment is named by its `<NAME>` in lower case (`MCP_KHAL_CALENDARS_PRIVATE_PATH` creates the calendar `private`), and it needs its `_PATH`, so the whole configuration can come from the environment and the file can be absent.

A variable that starts with `MCP_KHAL_CALENDARS_` but is not one of these settings (`MCP_KHAL_CALENDARS_WORK_COLOR`, a lower-case name, a doubled underscore) stops the server at startup, as does a name two calendars of the file share (`a-b` and `a b`), because it could not be told apart. A wrong value is reported with the name of the variable, not of the file key. Two further variables do not set config values:

| Environment variable | Meaning |
|---|---|
| `MCP_KHAL_CONFIG` | Path of the config file (absolute). |
| `XDG_CONFIG_HOME` | Base directory of the config file when `MCP_KHAL_CONFIG` is unset (absolute). |
| `TZ` | The server's [time zone](#time-zones), an IANA name. Set it in containers. |

At startup the server logs its effective configuration as one line on stderr (stdout carries the MCP protocol): the config file path, the host time zone, the reminders and the calendar names. Addresses are masked (`m***@work.com`), values of secret-looking keys (`token`, `password`, `secret`, `api key`, …) and credentials inside URLs are redacted, and the process environment is never logged.

#### Validation at startup
The server checks its configuration when it starts and refuses to start (exit code 1, message on stderr) if anything is wrong, instead of failing later on every call. Nothing is guessed. It reports every problem at once; for example:

```
mcp-khal cannot start: InvalidInput: 3 problems:
- defaultCalendar must be a calendar name (a string), got 42
- calendars.work.email is not a valid email address, got "nope"
- calendars.school.path must be an absolute path without control characters (no '~', no relative path), got "school"
```

All strings from the environment and the config file are trimmed before they are checked, so `" 15m "` is `15m`. Whitespace inside a value is not removed (`5 m` is invalid), and an environment variable that is empty or only whitespace counts as unset.

First, the values themselves:
- **JSON and keys:** the file must be valid JSON with only the keys above, and every calendar object only `path`, `email` and `alarm`; a typo such as `emial` is an error, not silently ignored.
- **`MCP_KHAL_CONFIG` and `XDG_CONFIG_HOME`:** absolute paths.
- **Calendar names** (the keys of `calendars` and `defaultCalendar`): not empty, no control characters, and unique after trimming.
- **Addresses** must look like email addresses, **reminders** like the section above, and a calendar **`path`** must be present, absolute (no `~`, no relative path, no control characters) and different for every calendar.
- **The host time zone** must be a known IANA zone.

Then the values against the machine:
- `defaultCalendar` is one of the configured calendars, and is set when there are several (with exactly one it is filled in),
- every calendar `path` is a directory that can be read and written,
- a config file named explicitly by `MCP_KHAL_CONFIG` exists (the default location may be missing: that means no calendars).

`mcp-khal setup` applies the first group but not the machine checks, so it can still be used to repair a configuration whose directories are gone.

## Standards conformance

The server reads and writes iCalendar (RFC 5545) files in vdir layout and follows RFC 5545, 5546, 6868, 4791 and 7986 where they apply. Every requirement is listed in `spec/*.json` and attributed to a test; the generated report is [`docs/conformance.md`](docs/conformance.md).

What we write is standard only: no vendor `X-` properties, no `METHOD` in stored files, CRLF line endings folded at 75 octets, a generated `VTIMEZONE` for every zone used. Unknown properties and components in existing files are kept as they are when an event is edited.

What we tolerate when reading, because real clients produce it (reported where it matters, never copied into what we write): a byte order mark, bare LF or lone CR line breaks, tab folds, `METHOD` in stored files, a missing `PRODID`, Windows zone names such as `W. Europe Standard Time` (mapped to IANA), and a `VTIMEZONE` that disagrees with IANA (the file's own definition wins). Files we cannot handle safely are skipped and listed as problems: invalid UTF-8, several UIDs or component types in one file, unbalanced `BEGIN`/`END`. An event whose `TZID` can be resolved neither from its `VTIMEZONE`, nor as an IANA or Windows zone name is reported as a problem, never treated as floating time.

Events with `CLASS:PRIVATE` or `CLASS:CONFIDENTIAL` are shown by the read tools without details (time and a placeholder title only) and cannot be found by searching their text.

## Nix / Home Manager
The flake provides the package, an overlay and a Home Manager module. See [docs/nix.md](docs/nix.md) for the outputs, the module options, wiring it into an MCP client and the vdirsyncer setup.
