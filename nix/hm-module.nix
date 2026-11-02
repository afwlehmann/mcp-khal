{ self }:
{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.programs.mcp-khal;
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
      type = lib.types.attrsOf lib.types.str;
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
