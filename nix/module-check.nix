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

  configOf = config: config.xdg.configFile."mcp-khal.json".text;
  expectedWith =
    {
      defaultCalendar ? null,
      calendars ? { },
    }:
    builtins.toJSON (
      lib.optionalAttrs (defaultCalendar != null) { inherit defaultCalendar; }
      // {
        inherit calendars;
      }
    )
    + "\n";

  dir = name: "/home/me/.local/share/calendars/${name}";

  # one object per calendar: `path` is required, the other fields are optional and an unset one
  # stays out of the JSON
  acceptedCalendars = {
    work = {
      path = dir "work";
      email = "me@example.com";
      alarm = "1d";
    };
    private = {
      path = dir "private";
      email = "first.last+tag@sub.example.org";
      alarm = "none";
    };
    school = {
      path = dir "school";
      alarm = "90m";
    };
    early = {
      path = dir "early";
      alarm = "0m";
    };
    long = {
      path = dir "long";
      alarm = "2h";
    };
    emailOnly = {
      path = dir "emailOnly";
      email = "x@y.org";
    };
    declared.path = dir "declared";
  };

  rejectedPaths = [
    ""
    "relative/dir"
    "~/calendars"
    "./work"
    "a\nb"
  ];

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
  "per-calendar settings (path, address and reminder in m, h, d, 0m and none) must be written to mcp-khal.json";
assert lib.assertMsg (
  configOf evaluate == expectedWith { }
) "the file is written even without calendars, and has no khal key";
assert lib.assertMsg (
  !(builtins.hasAttr "khal" (
    builtins.fromJSON (builtins.unsafeDiscardStringContext (configOf evaluate))
  ))
) "mcp-khal.json must not contain a khal key";
assert lib.assertMsg (
  !(evaluate.programs.mcp-khal ? khalPackage)
) "there must be no khalPackage option: khal is not used any more";
assert lib.assertMsg (lib.elem pkgs.hello evaluate.home.packages)
  "the configured package must be installed";
assert lib.assertMsg (lib.all (
  v:
  throws (calendarsOf {
    calendars.work = {
      path = dir "work";
      email = v;
    };
  })
) rejectedEmails) "invalid addresses must be rejected";
assert lib.assertMsg (lib.all (
  v:
  throws (calendarsOf {
    calendars.work = {
      path = dir "work";
      alarm = v;
    };
  })
) rejectedAlarms) "invalid per-calendar reminders must be rejected";
assert lib.assertMsg (lib.all (
  v:
  throws (calendarsOf {
    calendars.work.path = v;
  })
) rejectedPaths) "invalid calendar paths must be rejected";
assert lib.assertMsg (throws (calendarsOf {
  calendars.work.email = "me@example.com";
})) "a calendar without path must be rejected: path is required";
assert lib.assertMsg (lib.all (
  v: throws (evaluateWith { defaultCalendar = v; }).programs.mcp-khal.defaultCalendar
) rejectedCalendarNames) "invalid default calendar names must be rejected";
assert lib.assertMsg (
  !(builtins.hasAttr "defaultCalendar" (
    builtins.fromJSON (builtins.unsafeDiscardStringContext (configOf evaluate))
  ))
) "an unset defaultCalendar must stay out of mcp-khal.json";
assert lib.assertMsg (throws (calendarsOf {
  calendars.work = {
    path = dir "work";
    emial = "me@example.com";
  };
})) "a typo in a calendar option must be an evaluation error, not silently ignored";
assert lib.assertMsg (throws (calendarsOf {
  calendars.work = "me@example.com";
})) "a calendar must be an object, not a plain address";

pkgs.runCommand "mcp-khal-hm-module-check" { } "touch $out"
