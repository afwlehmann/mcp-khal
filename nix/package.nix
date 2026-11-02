{
  lib,
  buildNpmPackage,
  makeWrapper,
  khal,
}:

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
    ];
  };

  npmDepsHash = "sha256-ntarwI/goCRgZdTv0PuBjsoE0jBTDFOkWY82pmWqNXU=";

  nativeBuildInputs = [ makeWrapper ];

  # khal is a runtime dependency; keep the package self-contained
  postInstall = ''
    wrapProgram $out/bin/mcp-khal --prefix PATH : ${lib.makeBinPath [ khal ]}
  '';

  doCheck = true;
  checkPhase = ''
    runHook preCheck
    npm test
    runHook postCheck
  '';

  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    rc=0
    $out/bin/mcp-khal --bogus 2>/dev/null || rc=$?
    test "$rc" -eq 2
    runHook postInstallCheck
  '';

  meta = {
    description = "MCP server for reading and creating events in khal calendars";
    license = lib.licenses.mit;
    mainProgram = "mcp-khal";
    platforms = lib.platforms.unix;
  };
}
