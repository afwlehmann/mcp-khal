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
in
{
  options.programs.mcp-khal = {
    enable = lib.mkEnableOption "the mcp-khal MCP server";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      defaultText = lib.literalExpression "mcp-khal.packages.\${pkgs.stdenv.hostPlatform.system}.default";
      description = "The mcp-khal package (bundles khal on its PATH).";
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
  };

  config = lib.mkIf cfg.enable {
    home.packages = [ cfg.package ];

    xdg.configFile."mcp-khal.json" = lib.mkIf (cfg.calendarEmails != { }) {
      text = builtins.toJSON cfg.calendarEmails + "\n";
    };
  };
}
