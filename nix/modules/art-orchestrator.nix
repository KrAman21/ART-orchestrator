{ inputs, ... }:
{
  perSystem = { self', pkgs, system, lib, ... }: {
    packages.runtime-tree = pkgs.runCommand "art-orchestrator-runtime-tree" {} ''
      mkdir -p "$out"
      cp -r --no-preserve=mode,ownership ${inputs.self}/. "$out/"
      ln -s ${self'.packages.nodejs-deps}/lib/node_modules/art-orchestrator/node_modules "$out/node_modules"
    '';

    packages.default = pkgs.writeShellApplication {
      name = "art-orchestrator";
      runtimeInputs = [ pkgs.nodejs ];
      text = ''
        cd "${self'.packages.runtime-tree}"
        exec node src/index.js
      '';
    };

    packages.nodejs-deps = inputs.dream2nix.lib.evalModules {
      packageSets.nixpkgs = inputs.dream2nix.inputs.nixpkgs.legacyPackages.${system};
      specialArgs = { inherit inputs; };
      modules = [
        ({ config, dream2nix, lib, ... }: {
          imports = [
            dream2nix.modules.dream2nix.nodejs-package-lock-v3
            dream2nix.modules.dream2nix.nodejs-granular-v3
          ];

          name = "art-orchestrator";

          version = "1.0.0";

          nodejs-package-lock-v3.packageLockFile = "${config.mkDerivation.src}/package-lock.json";

          mkDerivation = {
            src = with lib.fileset; toSource {
              root = ../../.;
              fileset = unions [
                ../../package.json
                ../../package-lock.json
              ];
            };
            /*
            This prevents nixpkgs' setup.sh to run make during build and install
              phases.
            Dependencies from npmjs.org are delivered pre-built and cleaned,
              therefore running `make` usually leads to errors.
            The problem with this hack is it can prevent setup-hooks from setting
              buildPhase and installPhase because those are already defined here.
            */
            buildPhase = "runHook preBuild && runHook postBuild";
            installPhase = "runHook preInstall && runHook postInstall";
          };
        })
        {
          paths.projectRoot = ../../.;
          paths.projectRootFile = "flake.nix";
          paths.package = ../../.;
        }
      ];
    };
  };
}
