{
  pkgs,
  self,
}:

let
  inherit (pkgs) lib;

  # just enough of Home Manager for the module to evaluate
  stub =
    { lib, ... }:
    {
      options = {
        home.packages = lib.mkOption {
          type = lib.types.listOf lib.types.raw;
          default = [ ];
        };
        xdg.configFile = lib.mkOption {
          type = lib.types.attrsOf lib.types.raw;
          default = { };
        };
      };
      config._module.args.pkgs = pkgs;
    };

  evaluate =
    emails:
    (lib.evalModules {
      modules = [
        stub
        (import ./hm-module.nix { inherit self; })
        {
          programs.mcp-khal = {
            enable = true;
            package = pkgs.hello;
            calendarEmails = emails;
          };
        }
      ];
    }).config;

  accepted = {
    work = "me@example.com";
    private = "first.last+tag@sub.example.org";
  };

  rejected = [
    ""
    "nope"
    "me@example"
    "a b@example.com"
    "a@b.com, c@d.com"
    "<me@example.com>"
  ];

  isRejected =
    value:
    !(builtins.tryEval (
      builtins.deepSeq (evaluate { work = value; }).programs.mcp-khal.calendarEmails true
    )).success;

  written = (evaluate accepted).xdg.configFile."mcp-khal.json".text;
in

assert lib.assertMsg (
  written == builtins.toJSON accepted + "\n"
) "valid addresses must be written to mcp-khal.json unchanged";
assert lib.assertMsg (lib.all isRejected rejected) "invalid addresses must be rejected";
assert lib.assertMsg (
  !(evaluate { }).xdg.configFile ? "mcp-khal.json"
) "no config file may be managed when calendarEmails is empty";

pkgs.runCommand "mcp-khal-hm-module-check" { } "touch $out"
