# Changelog

## 3.0.0

Version 3.0 is a breaking release: the server no longer runs `khal`. The name `mcp-khal` is historical: version 2.x ran the `khal` command line tool.

- **No khal.** Calendars are read and written as `.ics` files directly. khal, Python and khal's own config file are not needed any more, and nothing is run as a subprocess.
- **`path` is required** on every calendar and is where the events are. Calendars are no longer discovered from khal: list each one under `calendars` with the `path` its vdir has in your khal or vdirsyncer config.
- **The `khal` config key and `MCP_KHAL_BIN` are gone.** A config file that still has `"khal": …` is rejected as an unknown key, so delete it. `MCP_KHAL_BIN` is not read. In the Home Manager module, `khalPackage` is removed.
- **Environment variables for every setting**, named by one schema (see [Environment variables](README.md#environment-variables)).
- **Calendar names** are the keys of `calendars`, not the names khal reported; keep the same names to keep `defaultCalendar` and the per-calendar settings working.
- **New input grammar.** The tools take ISO ranges and structured fields (see [Ranges](README.md#ranges) and `new_event`) instead of khal's locale-dependent text such as `tomorrow 15:00 1h`, weekday names or `eod`.
- **Range boundary.** An event is in a range when it intersects `[start, end)`. khal included an event that ended exactly at the start of its query.
- **No 2037 cap** on endless series: they are expanded as far as the requested range.
- **Time zones** are handled by the server (see [Time zones](README.md#time-zones)): the host zone comes from `TZ` or the system, and written events carry a proper `VTIMEZONE`.
- **vdirsyncer stays external.** The server never talks to a CalDAV server; keep syncing with your existing setup.
- **Output.** The fields of the read tools are unchanged, but the values are now rendered by the server rather than by khal (ISO dates, `HH:MM` times), and search is a plain text match, not an SQL `LIKE`.
- **UIDs are bare UUIDs.** New events and split-off series get a random UUID v4 as UID and file name (`<uuid>.ics`), as RFC 7986 recommends; 2.x-style `<uuid>@mcp-khal` UIDs are no longer generated. File names of new events never contain `@`. Existing events keep theirs.
- **Read-only calendars.** A calendar directory that is not writable no longer stops the server: the reading tools work and the writing tools fail with a message naming the directory. A directory that cannot be read still stops startup, and all such directories are listed.
- **Writes are checked.** `update_event`, `end_event_series` and `respond_to_event` refuse to write if the file changed after it was read; the config file is replaced atomically.
- **Standards.** Every requirement of RFC 5545, 5546, 6868, 4791 and 7986 that applies is attributed to a test (see [Standards conformance](README.md#standards-conformance)). Events with `CLASS:PRIVATE` or `CLASS:CONFIDENTIAL` are shown without details.
