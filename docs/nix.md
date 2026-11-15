# Nix / Home Manager

The flake exposes:

| Output | Purpose |
|---|---|
| `packages.<system>.default` | The server. The version is taken from `package.json`. It has no runtime dependency besides Node. |
| `overlays.default` | Adds `pkgs.mcp-khal`. |
| `homeModules.default` | The Home Manager module `programs.mcp-khal`. |

Supported systems: `aarch64-darwin`, `x86_64-linux` and `aarch64-linux`. `x86_64-darwin` (Intel Macs) is not supported because the pinned nixpkgs dropped it; it would need a nixpkgs 26.05 based input.

## Home Manager module
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
    # one object per calendar; `path` is required, the rest is optional
    calendars = {
      work = {
        path = "/home/me/.local/share/calendars/work";
        email = "me@example.com";
        alarm = "1d";
      };
      private = {
        path = "/home/me/.local/share/calendars/private";
        email = "me@example.org";
        alarm = "none";
      };
      school = {
        path = "/home/me/.local/share/calendars/school";
        alarm = "90m";
      };
    };
  };
}
```

Options:

| Option | Type | Default | Description |
|---|---|---|---|
| `programs.mcp-khal.enable` | bool | `false` | Install `mcp-khal` into `home.packages`. |
| `programs.mcp-khal.package` | package | the flake's `default` package for your system | Override to use your own build or an overlay. |
| `programs.mcp-khal.defaultCalendar` | null or non-empty string | `null` | The calendar new events go to when a call names none. Required with several calendars; written to the config only when set. See [Default calendar](../README.md#default-calendar). |
| `programs.mcp-khal.calendars.<name>` | submodule | `{ }` | Settings of one calendar, by name. A typed object with the options below; an unknown option (a typo such as `emial`) is an evaluation error. |
| `programs.mcp-khal.calendars.<name>.path` | absolute path (string) | required | The calendar's vdir, the directory of its `.ics` files. |
| `programs.mcp-khal.calendars.<name>.email` | null or email address | `null` | Your address on the calendar: the organizer of invites (see [Invites](../README.md#invites)). Validated with the same rule as the server, so a typo fails at `home-manager switch` instead of breaking invites later. |
| `programs.mcp-khal.calendars.<name>.alarm` | null or reminder | `null` | Reminder for new events on the calendar, `none` or unset means no reminder. See [Reminders](../README.md#reminders). |

There is no option for the time zone; set `TZ` in the environment of the MCP client's server process if the system zone is not the one you want.

What the module does:
- It writes `~/.config/mcp-khal.json` through `xdg.configFile` with `defaultCalendar` and `calendars` (options that are not set stay out of the file); see [Configuration](../README.md#configuration). The package also ships an example config under `share/doc/mcp-khal/examples/`. This replaces the interactive `mcp-khal setup`. The file lives in the Nix store as a read-only symlink, so change the options instead of rerunning `setup`.
- A calendar without `path` is an evaluation error.

## Wiring it into an MCP client
The server speaks MCP over stdio, so the client needs the binary path. For example, with Home Manager's Claude Code module:

```nix
programs.claude-code.mcpServers.calendar = {
  command = "${config.programs.mcp-khal.package}/bin/mcp-khal";
};
```
Any other client takes the same `command` with no arguments.

## vdirsyncer
- mcp-khal never calls vdirsyncer and never talks to a calendar server. It reads and writes the files in each calendar's `path`, which is the directory vdirsyncer's `filesystem` storage keeps in sync (for example the one Home Manager generates from `accounts.calendar`).
- Getting changes to and from the server is vdirsyncer's job, so keep syncing with your existing setup (for example `services.vdirsyncer` or a timer running `vdirsyncer sync`). A new event or invite reaches the remote calendar after the next sync. The server re-reads the files on every call, so events that a sync brought in show up at once.
- The server does not send invitation mails; that is left to your sync or mail tooling.

## npmDepsHash
After changing npm dependencies (this includes every version bump, because the lockfile carries the root version), update `npmDepsHash` in `nix/package.nix`: set it to `lib.fakeHash`, build, copy the reported hash.
