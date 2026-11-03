{
  description = "MCP server for reading and creating events in khal calendars";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    git-hooks.url = "github:cachix/git-hooks.nix";
    git-hooks.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs =
    {
      self,
      nixpkgs,
      git-hooks,
    }:
    let
      supportedSystems = [
        "x86_64-darwin"
        "aarch64-darwin"
        "x86_64-linux"
        "aarch64-linux"
      ];
      forEachSystem = nixpkgs.lib.genAttrs supportedSystems;
      pkgsFor = system: nixpkgs.legacyPackages.${system};
      baseHooks = {
        nixfmt.enable = true;
        # lint + format TypeScript
        biome.enable = true;
        ripsecrets.enable = true;
        convco.enable = true;
      };
    in
    {
      packages = forEachSystem (system: {
        mcp-khal = (pkgsFor system).callPackage ./nix/package.nix { };
        default = self.packages.${system}.mcp-khal;
      });

      overlays.default = final: _prev: {
        mcp-khal = final.callPackage ./nix/package.nix { };
      };

      homeModules.default = import ./nix/hm-module.nix { inherit self; };

      checks = forEachSystem (system: {
        # sandbox-safe hooks only; the unit tests run as the package's checkPhase
        pre-commit-check = git-hooks.lib.${system}.run {
          src = ./.;
          hooks = baseHooks;
        };
        unit-tests = self.packages.${system}.default;
        hm-module = import ./nix/module-check.nix {
          pkgs = pkgsFor system;
          inherit self;
        };
      });

      devShells = forEachSystem (
        system:
        let
          pkgs = pkgsFor system;
          localHooks = git-hooks.lib.${system}.run {
            src = ./.;
            hooks = baseHooks // {
              # the local commit must pass the unit tests
              unit-tests = {
                enable = true;
                name = "unit tests";
                entry = pkgs.lib.getExe (
                  pkgs.writeShellApplication {
                    name = "unit-tests";
                    runtimeInputs = [ pkgs.nodejs ];
                    text = ''
                      if [ ! -d node_modules ]; then npm ci --ignore-scripts; fi
                      npm test
                    '';
                  }
                );
                files = "\\.(ts|json)$";
                pass_filenames = false;
              };
            };
          };
          inherit (localHooks) shellHook enabledPackages;
        in
        {
          default = pkgs.mkShell {
            inherit shellHook;
            buildInputs = enabledPackages ++ [
              pkgs.nodejs
              pkgs.khal
            ];
          };
        }
      );

      formatter = forEachSystem (system: (pkgsFor system).nixfmt);
    };
}
