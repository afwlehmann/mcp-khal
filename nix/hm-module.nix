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

    calendarEmails = lib.mkOption {
      type = lib.types.attrsOf emailAddress;
      default = { };
      example = {
        work = "me@example.com";
      };
      description = ''
        Calendar name -> your email address on that calendar. Used as the
        organizer of invites; replaces the interactive `mcp-khal setup`.
      '';
    };

    defaultAlarm = lib.mkOption {
      type = alarmSetting;
      default = "none";
      example = "15m";
      description = ''
        Reminder for new events that do not name one and whose calendar has no entry in
        `calendarAlarms`: `30m`, `2h` or `1d` (minutes, hours or days before the start), or
        `none` for no reminder.
      '';
    };

    calendarAlarms = lib.mkOption {
      type = lib.types.attrsOf alarmSetting;
      default = { };
      example = {
        work = "1d";
        private = "none";
      };
      description = ''
        Calendar name -> reminder for new events on that calendar; overrides `defaultAlarm`.
        Use `none` to have no reminder on a calendar.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = [ cfg.package ];

    xdg.configFile."mcp-khal.json".text =
      builtins.toJSON {
        khal = "${lib.getBin cfg.khalPackage}/bin/khal";
        inherit (cfg) calendarEmails defaultAlarm calendarAlarms;
      }
      + "\n";
  };
}
