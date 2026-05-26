{
  perSystem = { self', pkgs, ... }: {
    devShells.default = pkgs.mkShell {
      NODE_PATH = "${self'.packages.nodejs-deps}/lib/node_modules/art-orchestrator/node_modules";
      packages = [
        pkgs.nodejs_latest
      ];
    };
  };
}
