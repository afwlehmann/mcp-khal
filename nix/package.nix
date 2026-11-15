{
  lib,
  buildNpmPackage,
}:

# The server itself. It reads and writes the .ics files (vdir) directly; there is no runtime
# dependency besides Node. vdirsyncer, if used, stays an external tool.
# TODO(maintainer): npmDepsHash must be recomputed whenever package-lock.json changes (this
# change set did); set it to lib.fakeHash, build, and copy the reported hash.
let
  packageJson = lib.importJSON ../package.json;
in
buildNpmPackage {
  pname = packageJson.name;
  inherit (packageJson) version;

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../package.json
      ../package-lock.json
      ../tsconfig.json
      ../tsconfig.typecheck.json
      ../vitest.config.ts
      ../vitest.global-setup.ts
      ../src
      ../examples
      ../README.md
    ];
  };

  npmDepsHash = "sha256-Tj7WXRlQmkt9BpjQlSLLkeMEfgBoL/N+bWFiK2KSl9Y=";

  doCheck = true;
  checkPhase = ''
    runHook preCheck
    npm test
    runHook postCheck
  '';

  # documentation and the example config go to share/doc/<name>, the Nix counterpart of
  # /usr/share/doc/<name>; the config itself is per user (~/.config), so nothing goes to etc
  postInstall = ''
    install -Dm644 examples/mcp-khal.json $out/share/doc/mcp-khal/examples/mcp-khal.json
    install -Dm644 README.md $out/share/doc/mcp-khal/README.md
  '';

  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    rc=0
    $out/bin/mcp-khal --bogus 2>/dev/null || rc=$?
    test "$rc" -eq 2
    test -f $out/share/doc/mcp-khal/examples/mcp-khal.json
    test -f $out/share/doc/mcp-khal/README.md
    runHook postInstallCheck
  '';

  meta = {
    description = "MCP server for reading and changing events in local .ics calendars (vdir)";
    license = lib.licenses.mit;
    mainProgram = "mcp-khal";
    platforms = lib.platforms.unix;
  };
}
