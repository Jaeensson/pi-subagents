{
  description = "Development shell for the pi-subagent extension";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      # Systems the devshell supports; the current one is aarch64-darwin.
      systems = [
        "aarch64-darwin"
        "x86_64-darwin"
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      devShells = forAllSystems (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.mkShell {
            name = "pi-subagent-dev";

            # Missing tools for the project's dev workflows:
            #   npm test           -> node --test tests/core.test.mjs (Node >= 22.6)
            #   npm run typecheck  -> tsc --noEmit
            # nodejs_24 matches pi's own runtime (nodejs-24.18.0) and ships npm.
            # typescript provides tsc; @types/node is linked from the pi store
            # in the shellHook below (tsconfig uses "types": ["node"]).
            # pi-coding-agent ships pi itself (same version as the runtime that
            # loads the extension), so typechecking and testing work even on
            # machines without pi pre-installed.
            packages = with pkgs; [
              nodejs_24
              typescript
              pi-coding-agent
            ];

            # Auto-link pi's runtime packages into ./node_modules so
            # `npm run typecheck` resolves @earendil-works/* and @types/node.
            # Mirrors the manual procedure in README "Development"; idempotent
            # (ln -sfn replaces stale links on every shell entry).
            shellHook = ''
              PI_BIN="$(command -v pi || true)"
              if [ -z "$PI_BIN" ]; then
                echo "pi-subagent: warning: 'pi' not on PATH; skipping node_modules links (typecheck will fail)" >&2
              else
                STORE="$(readlink -f "$PI_BIN" 2>/dev/null | sed 's|/bin/pi$||')/lib/node_modules/pi-monorepo"
                if [ ! -d "$STORE" ]; then
                  echo "pi-subagent: warning: pi store not found at $STORE; typecheck may fail" >&2
                else
                  mkdir -p node_modules/@earendil-works node_modules/@types
                  ln -sfn "$STORE" node_modules/@earendil-works/pi-coding-agent
                  ln -sfn "$STORE/node_modules/@earendil-works/pi-ai" node_modules/@earendil-works/pi-ai
                  ln -sfn "$STORE/node_modules/@earendil-works/pi-tui" node_modules/@earendil-works/pi-tui
                  ln -sfn "$STORE/node_modules/@earendil-works/pi-agent-core" node_modules/@earendil-works/pi-agent-core
                  ln -sfn "$STORE/node_modules/typebox" node_modules/typebox
                  ln -sfn "$STORE/node_modules/@types/node" node_modules/@types/node
                  VERSION="$(echo "$STORE" | sed -E 's/.*pi-coding-agent-([0-9][0-9.]*).*/\1/')"
                  echo "pi-subagent: linked node_modules -> pi $VERSION ($STORE)"
                  # Informational: note if the system pi (the runtime that would
                  # load the extension) differs from the linked devshell pi.
                  SYSTEM_PI="/run/current-system/sw/bin/pi"
                  if [ -x "$SYSTEM_PI" ]; then
                    SYS_STORE="$(readlink -f "$SYSTEM_PI" 2>/dev/null | sed 's|/bin/pi$||')/lib/node_modules/pi-monorepo"
                    SYS_VERSION="$(echo "$SYS_STORE" | sed -E 's/.*pi-coding-agent-([0-9][0-9.]*).*/\1/')"
                    if [ -n "$SYS_VERSION" ] && [ "$SYS_VERSION" != "$VERSION" ]; then
                      echo "pi-subagent: note: system pi is $SYS_VERSION; devshell links target pi $VERSION"
                    fi
                  fi
                fi
              fi
            '';
          };
        });
    };
}
