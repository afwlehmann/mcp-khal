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

  evaluateWith =
    extra: emails:
    (lib.evalModules {
      modules = [
        stub
        (import ./hm-module.nix { inherit self; })
        {
          programs.mcp-khal = {
            enable = true;
            package = pkgs.hello; # stand-in for the server; evaluated, never built
            calendarEmails = emails;
          }
          // extra;
        }
      ];
    }).config;

  evaluate = evaluateWith { };

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

  acceptedAlarms = {
    defaultAlarm = "15m";
    calendarAlarms = {
      work = "1d";
      home = "none";
      school = "90m";
      early = "0m";
      long = "2h";
    };
  };

  rejectedAlarms = [
    ""
    "15"
    "1w"
    "-5m"
    "+5m"
    "None"
    "5 m"
    " 5m"
    "5M"
    "1.5d"
    "10000m"
    "PT5M"
    "soon"
  ];

  # forces only the option under test; the stand-in package must not be evaluated deeply
  throws = value: !(builtins.tryEval (builtins.deepSeq value true)).success;
  rejectsDefault = v: throws (evaluateWith { defaultAlarm = v; } { }).programs.mcp-khal.defaultAlarm;
  rejectsCalendar =
    v: throws (evaluateWith { calendarAlarms.work = v; } { }).programs.mcp-khal.calendarAlarms;

  configOf = config: config.xdg.configFile."mcp-khal.json".text;
  expectedWith =
    extra: khal: emails:
    builtins.toJSON (
      {
        inherit khal;
        calendarEmails = emails;
        defaultAlarm = "none";
        calendarAlarms = { };
      }
      // extra
    )
    + "\n";
  expected = expectedWith { };
in

assert lib.assertMsg (
  configOf (evaluate accepted) == expected "${pkgs.khal}/bin/khal" accepted
) "valid addresses must be written to mcp-khal.json together with the khal path";
assert lib.assertMsg (lib.all isRejected rejected) "invalid addresses must be rejected";
assert lib.assertMsg (
  configOf (evaluate { }) == expected "${pkgs.khal}/bin/khal" { }
) "khalPackage must default to nixpkgs' khal and the file is written even without addresses";
assert lib.assertMsg (
  configOf (evaluateWith { khalPackage = pkgs.hello; } accepted)
  == expected "${pkgs.hello}/bin/khal" accepted
) "a custom khalPackage must be the khal written to the config";
assert lib.assertMsg (lib.elem pkgs.hello
  (evaluate { }).home.packages
) "the configured package must be installed";
assert lib.assertMsg (
  configOf (evaluateWith acceptedAlarms { })
  == expectedWith acceptedAlarms "${pkgs.khal}/bin/khal" { }
) "default and per-calendar reminders (m, h, d, 0m and none) must be written to the config";
assert lib.assertMsg (lib.all rejectsDefault rejectedAlarms)
  "invalid default reminders must be rejected";
assert lib.assertMsg (lib.all rejectsCalendar rejectedAlarms)
  "invalid per-calendar reminders must be rejected";

pkgs.runCommand "mcp-khal-hm-module-check" { } "touch $out"
