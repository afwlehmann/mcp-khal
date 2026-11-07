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
    extra:
    (lib.evalModules {
      modules = [
        stub
        (import ./hm-module.nix { inherit self; })
        {
          programs.mcp-khal = {
            enable = true;
            package = pkgs.hello; # stand-in for the server; evaluated, never built
          }
          // extra;
        }
      ];
    }).config;

  evaluate = evaluateWith { };

  # forces only the option under test; the stand-in package must not be evaluated deeply
  throws = value: !(builtins.tryEval (builtins.deepSeq value true)).success;
  calendarsOf = extra: (evaluateWith extra).programs.mcp-khal.calendars;

  khalOf = khal: "${khal}/bin/khal";
  configOf = config: config.xdg.configFile."mcp-khal.json".text;
  expectedWith =
    {
      khal ? khalOf pkgs.khal,
      defaultCalendar ? null,
      calendars ? { },
    }:
    builtins.toJSON (
      {
        inherit khal;
      }
      // lib.optionalAttrs (defaultCalendar != null) { inherit defaultCalendar; }
      // {
        inherit calendars;
      }
    )
    + "\n";

  # one object per calendar; every field is optional and an unset one stays out of the JSON
  acceptedCalendars = {
    work = {
      email = "me@example.com";
      alarm = "1d";
    };
    private = {
      email = "first.last+tag@sub.example.org";
      alarm = "none";
    };
    school.alarm = "90m";
    early.alarm = "0m";
    long.alarm = "2h";
    emailOnly.email = "x@y.org";
    declared = { };
  };

  rejectedEmails = [
    ""
    "nope"
    "me@example"
    "a b@example.com"
    "a@b.com, c@d.com"
    "<me@example.com>"
  ];

  rejectedCalendarNames = [
    ""
    "   "
    "a\nb"
  ];

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
in

assert lib.assertMsg
  (
    configOf (evaluateWith {
      defaultCalendar = "work";
      calendars = acceptedCalendars;
    }) == expectedWith {
      defaultCalendar = "work";
      calendars = acceptedCalendars;
    }
  )
  "per-calendar settings (address and reminder in m, h, d, 0m and none) must be written to mcp-khal.json";
assert lib.assertMsg (
  configOf evaluate == expectedWith { }
) "khalPackage must default to nixpkgs' khal and the file is written even without calendars";
assert lib.assertMsg (
  configOf (evaluateWith {
    khalPackage = pkgs.hello;
  }) == expectedWith { khal = khalOf pkgs.hello; }
) "a custom khalPackage must be the khal written to the config";
assert lib.assertMsg (lib.elem pkgs.hello evaluate.home.packages)
  "the configured package must be installed";
assert lib.assertMsg (lib.all (
  v:
  throws (calendarsOf {
    calendars.work.email = v;
  })
) rejectedEmails) "invalid addresses must be rejected";
assert lib.assertMsg (lib.all (
  v:
  throws (calendarsOf {
    calendars.work.alarm = v;
  })
) rejectedAlarms) "invalid per-calendar reminders must be rejected";
assert lib.assertMsg (lib.all (
  v: throws (evaluateWith { defaultCalendar = v; }).programs.mcp-khal.defaultCalendar
) rejectedCalendarNames) "invalid default calendar names must be rejected";
assert lib.assertMsg (
  !(builtins.hasAttr "defaultCalendar" (
    builtins.fromJSON (builtins.unsafeDiscardStringContext (configOf evaluate))
  ))
) "an unset defaultCalendar must stay out of mcp-khal.json";
assert lib.assertMsg (throws (calendarsOf {
  calendars.work.emial = "me@example.com";
})) "a typo in a calendar option must be an evaluation error, not silently ignored";
assert lib.assertMsg (throws (calendarsOf {
  calendars.work = "me@example.com";
})) "a calendar must be an object, not a plain address";

pkgs.runCommand "mcp-khal-hm-module-check" { } "touch $out"
