{ self }:
{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.programs.mcp-khal;

  # same rule as `isEmail` in src/config.ts: the server rejects a config with any other value
  part = "[^[:space:]@,;:<>]+";
  emailRegex = "${part}@${part}\\.${part}";

  emailAddress = lib.mkOptionType {
    name = "emailAddress";
    description = "email address";
    descriptionClass = "noun";
    check = x: lib.isString x && builtins.match emailRegex x != null;
    merge = lib.mergeEqualOption;
  };

  # same rule as `isAlarmSetting` in src/config.ts: 30m, 2h, 1d, or none
  alarmSetting = lib.mkOptionType {
    name = "reminder";
    description = "reminder like 30m, 2h or 1d (minutes, hours, days before the start), or none";
    descriptionClass = "noun";
    check = x: lib.isString x && builtins.match "none|[0-9]{1,4}[mhd]" x != null;
    merge = lib.mergeEqualOption;
  };

  # one statically typed object per calendar; options that are not set stay out of the JSON
  calendarModule = lib.types.submodule {
    options = {
      email = lib.mkOption {
        type = lib.types.nullOr emailAddress;
        default = null;
        example = "me@example.com";
        description = "Your address on this calendar: the organizer of invites created there.";
      };
      alarm = lib.mkOption {
        type = lib.types.nullOr alarmSetting;
        default = null;
        example = "1d";
        description = ''
          Reminder for new events on this calendar (`30m`, `2h`, `1d` or `none`); overrides
          `defaultAlarm`. Unset means `defaultAlarm` applies.
        '';
      };
    };
  };
in
{
  options.programs.mcp-khal = {
    enable = lib.mkEnableOption "the mcp-khal MCP server";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      defaultText = lib.literalExpression "mcp-khal.packages.\${pkgs.stdenv.hostPlatform.system}.default";
      description = "The mcp-khal package.";
    };

    khalPackage = lib.mkOption {
      type = lib.types.package;
      default = pkgs.khal;
      defaultText = lib.literalExpression "pkgs.khal";
      description = ''
        The khal that mcp-khal runs. Its path is written to the `khal` key of
        `mcp-khal.json`, so the server does not depend on `PATH`.
      '';
    };

    defaultAlarm = lib.mkOption {
      type = alarmSetting;
      default = "none";
      example = "15m";
      description = ''
        Reminder for new events that do not name one and whose calendar has no `alarm` of its
        own (this includes events without a calendar): `30m`, `2h` or `1d` (minutes, hours or
        days before the start), or `none` for no reminder.
      '';
    };

    calendars = lib.mkOption {
      type = lib.types.attrsOf calendarModule;
      default = { };
      example = {
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
      description = ''
        Per-calendar settings, by the name khal reports (`khal printcalendars`): your address on
        the calendar (the organizer of invites; replaces the interactive `mcp-khal setup`) and
        the reminder for new events there. A name that khal does not know stops the server at
        startup.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = [ cfg.package ];

    xdg.configFile."mcp-khal.json".text =
      builtins.toJSON {
        khal = "${lib.getBin cfg.khalPackage}/bin/khal";
        inherit (cfg) defaultAlarm;
        calendars = lib.mapAttrs (_: calendar: lib.filterAttrs (_: v: v != null) calendar) cfg.calendars;
      }
      + "\n";
  };
}
