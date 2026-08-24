# SPDX-FileCopyrightText: 2021 Serokell <https://serokell.io/>
#
# SPDX-License-Identifier: CC0-1.0
{
  description = "SMS Dashboard - Web dashboard and Orange Pi daemon for SMS management";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-parts.url = "github:hercules-ci/flake-parts";
    sops-nix = {
      url = "github:Mic92/sops-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    lanzaboote = {
      url = "github:nix-community/lanzaboote";
      inputs = {
        nixpkgs.follows = "nixpkgs";
      };
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-parts,
      sops-nix,
      lanzaboote,
      ...
    }@inputs:
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
        "x86_64-darwin"
      ];

      flake = {
        # NixOS modules
        nixosModules = {
          default = ./nixos-config/modules/sms-daemon.nix;
          sms-daemon = ./nixos-config/modules/sms-daemon.nix;
        };

        # NixOS configuration for Orange Pi
        nixosConfigurations = {
          orange-pi = nixpkgs.lib.nixosSystem {
            system = "aarch64-linux";
            modules = [
              ./nixos-config/orange-pi/configuration.nix
              sops-nix.nixosModules.sops
              lanzaboote.nixosModules.lanzaboote

              (
                {
                  config,
                  pkgs,
                  lib,
                  ...
                }:
                {
                  # Enable flakes
                  nix.settings.experimental-features = [
                    "nix-command"
                    "flakes"
                  ];

                  # SOPS configuration for secure secret management
                  sops = {
                    defaultSopsFile = ./nixos-config/secrets/orange-pi.yaml;
                    # Use SSH host key for decryption on the Orange Pi
                    age.sshKeyPaths = [ "/etc/ssh/ssh_host_ed25519_key" ];

                    secrets = {
                      "sms-dashboard/api-key" = {
                        owner = config.services.sms-daemon.user;
                        group = config.services.sms-daemon.group;
                        mode = "0400";
                      };
                      "sms-dashboard/user-passwords/root-hash" = {
                        neededForUsers = true;
                      };
                      "sms-dashboard/user-passwords/htx-hash" = {
                        neededForUsers = true;
                      };
                    };
                  };

                  # Override the SMS daemon to use SOPS secrets
                  services.sms-daemon = {
                    enable = true;
                    # SWITCH TO RUST: Use the memory-safe Rust daemon
                    package = self.packages.aarch64-linux.orange-pi-daemon-rust;
                    apiKeyFile = config.sops.secrets."sms-dashboard/api-key".path;
                    apiUrl = "https://sexy.qzz.io";
                    phoneUpdateIntervalSeconds = 1; # Upload every 1 second!
                    messageCheckIntervalMs = 1000; # Check every 1 second
                    signalCheckIntervalSeconds = 10; # Not used by Rust (syncs with phone status)
                    debugBuild = false; # Rust daemon uses RUST_LOG env var
                  };
                }
              )
            ];
          };
        };
      };

      perSystem =
        {
          config,
          self',
          inputs',
          pkgs,
          system,
          lib,
          ...
        }:
        let
          # SMS daemon version - single source of truth
          daemonVersion = "8.0.0"; # v8.0.0: Direct AT commands (bypasses ModemManager for better 100+ modem performance)

          # Rust SMS daemon - the only daemon implementation
          sms-daemon = pkgs.rustPlatform.buildRustPackage {
            pname = "sms-daemon";
            version = daemonVersion;
            src = ./orange-pi-daemon;

            cargoLock = {
              lockFile = ./orange-pi-daemon/Cargo.lock;
            };

            nativeBuildInputs = with pkgs; [
              pkg-config
              rustfmt
            ];
            buildInputs = with pkgs; [
              openssl
              dbus # Required for native D-Bus support
            ];

            # Formatting is a deployment gate, not an optional developer check.
            # A NixOS daemon build must never proceed to tests or packaging with
            # an unformatted Rust source tree.
            preCheck = ''
              cargo fmt --all --check
            '';

            # Post-install: create symlink from Rust binary name to expected name
            postInstall = ''
              ln -s $out/bin/orange-pi-daemon-rust $out/bin/sms-daemon
            '';

            meta = with lib; {
              description = "High-performance Rust SMS daemon with direct AT commands for 100+ modems";
              longDescription = ''
                A multi-threaded async Rust daemon optimized for 100+ USB modems. Uses direct
                AT commands via serial ports as primary backend, with D-Bus/ModemManager fallback.
                Collects SMS messages and phone status, forwarding to SMS Dashboard API in real-time.
                Features: Direct AT commands (~1-5ms/op), worker pool architecture, signal caching,
                and automatic backend selection based on availability.
              '';
              homepage = "https://github.com/hecoinfo/message-dashboard";
              license = licenses.mit;
              platforms = platforms.linux;
            };
          };

          # Alias for backward compatibility
          orange-pi-daemon-rust = sms-daemon;

          # One local entry point for the same Rust validation required by Nix.
          check-daemon = pkgs.writeShellApplication {
            name = "check-daemon";
            runtimeInputs = with pkgs; [
              cargo
              git
              rustfmt
            ];
            text = ''
              cd "$(git rev-parse --show-toplevel)/orange-pi-daemon"
              cargo fmt --all --check
              cargo test
            '';
          };

          # Dev convenience commands. These land on $PATH inside the devShell (via
          # direnv `use flake`), so they work from anywhere in the repo tree.
          #
          # `bun` deliberately is NOT declared here: it already comes from the
          # nix-darwin/NixOS system config, and declaring a second one would mean two
          # answers to "which bun does this project use".

          # Runs the Cloudflare Worker locally with Auth0 secrets injected.
          #
          # Secrets never touch disk or command-line arguments. `sops exec-env`
          # decrypts into this process's environment only, then Wrangler forwards
          # that environment into the local Worker bindings. A `.dev.vars` file
          # would leave plaintext credentials behind after a crash.
          dev-api = pkgs.writeShellApplication {
            name = "dev-api";
            runtimeInputs = with pkgs; [
              coreutils
              sops
              git
            ];
            text = ''
              repo_root="$(git rev-parse --show-toplevel)"
              secrets="$repo_root/secrets/dev-vars.yaml"

              if [ ! -f "$secrets" ]; then
                echo "dev-api: $secrets is missing." >&2
                echo "Create it with:  sops \"$secrets\"" >&2
                echo "Required keys: AUTH0_DOMAIN, AUTH0_CLIENT_ID, AUTH0_CLIENT_SECRET," >&2
                echo "               AUTH0_M2M_CLIENT_ID, AUTH0_M2M_CLIENT_SECRET, API_KEY" >&2
                exit 1
              fi

              cd "$repo_root/sms-dashboard"

              # Variables inside this string must expand only after SOPS decrypts
              # the environment in its child shell.
              # shellcheck disable=SC2016
              exec sops exec-env "$secrets" '
                missing=""
                for key in AUTH0_DOMAIN AUTH0_CLIENT_ID AUTH0_CLIENT_SECRET AUTH0_M2M_CLIENT_ID AUTH0_M2M_CLIENT_SECRET API_KEY; do
                  if [ -z "$(printenv "$key")" ]; then
                    missing="$missing $key"
                  fi
                done
                if [ -n "$missing" ]; then
                  echo "dev-api: missing secrets:$missing" >&2
                  exit 1
                fi
                CLOUDFLARE_INCLUDE_PROCESS_ENV=true exec bunx wrangler dev --port 8787
              '
            '';
          };

          # Frontend dev server. The vite invocation itself stays in package.json so
          # there is one definition of how the frontend starts; this only saves the cd.
          dev-frontend = pkgs.writeShellApplication {
            name = "dev-frontend";
            runtimeInputs = with pkgs; [ git ];
            text = ''
              cd "$(git rev-parse --show-toplevel)/sms-dashboard"
              exec bun run dev -- --host 127.0.0.1 --port 8080 --strictPort
            '';
          };

          # Authenticated developer interface for both local Balance Agent
          # capabilities. Credentials live in macOS Keychain; this wrapper never
          # reads the SOPS development secret file.
          balance-agent-cli = pkgs.writeShellApplication {
            name = "balance-agent";
            runtimeInputs = with pkgs; [ git ];
            text = ''
              repo_root="$(git rev-parse --show-toplevel)"
              exec bun "$repo_root/sms-dashboard/balance-agent/src/cli.js" "$@"
            '';
          };

          # Versioned release driver for the Balance Agent desktop app. Builds
          # the .app, zips it, and emits a SHA-256 checksum. Run:
          #   nix run .#release-balance-agent -- 0.1.0
          # Artifacts land under sms-dashboard/balance-agent/release/<version>/.
          # Ad-hoc (unsigned, unnotarized) per the internal-team-utility policy
          # in CLAUDE.md; Developer ID signing is deferred.
          release-balance-agent = pkgs.writeShellApplication {
            name = "release-balance-agent";
            runtimeInputs = with pkgs; [
              git
              bun
              coreutils
              zip
            ];
            text = ''
              version="''${1:?usage: release-balance-agent <version>}"
              repo_root="$(git rev-parse --show-toplevel)"
              cd "$repo_root/sms-dashboard/balance-agent"

              echo "==> Building Balance Agent v''${version}"
              PLAYWRIGHT_BROWSERS_PATH=0 bun run browser:install
              bun run build
              bunx electron-builder --mac dir --arm64 \
                --config.directories.output="release/''${version}"

              app="release/''${version}/mac-arm64/Balance Agent.app"
              zip -r "release/''${version}/Balance-Agent-''${version}-macos-arm64.zip" \
                "$app" >/dev/null
              (cd "release/''${version}" && sha256sum \
                "Balance-Agent-''${version}-macos-arm64.zip" > \
                "Balance-Agent-''${version}-macos-arm64.zip.sha256")

              echo "==> Artifacts:"
              ls -1 "release/''${version}"
            '';
          };

          # Owns the local frontend/API pair. Re-running `dev-server restart`
          # replaces both processes instead of letting Vite or Wrangler select a
          # fallback port. State and logs live in /tmp, never in the worktree.
          dev-server = pkgs.writeShellApplication {
            name = "dev-server";
            runtimeInputs = with pkgs; [
              coreutils
              curl
              lsof
            ];
            text = ''
              state_dir="''${XDG_RUNTIME_DIR:-/tmp}/message-dashboard-dev-$(id -u)"
              frontend_pid_file="$state_dir/frontend.pid"
              api_pid_file="$state_dir/api.pid"
              frontend_log="$state_dir/frontend.log"
              api_log="$state_dir/api.log"

              mkdir -p "$state_dir"

              listener_pids() {
                lsof -nP -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null | sort -u || true
              }

              stop_pid_file() {
                pid_file="$1"
                if [ -f "$pid_file" ]; then
                  pid="$(cat "$pid_file")"
                  if kill -0 "$pid" 2>/dev/null; then
                    kill "$pid" 2>/dev/null || true
                  fi
                  rm -f "$pid_file"
                fi
              }

              stop_port() {
                port="$1"
                pids="$(listener_pids "$port")"
                if [ -n "$pids" ]; then
                  # shellcheck disable=SC2086
                  kill $pids 2>/dev/null || true
                fi
              }

              wait_for_ports_to_stop() {
                for _ in $(seq 1 30); do
                  if [ -z "$(listener_pids 8080)" ] && [ -z "$(listener_pids 8787)" ]; then
                    return 0
                  fi
                  sleep 0.1
                done

                for port in 8080 8787; do
                  pids="$(listener_pids "$port")"
                  if [ -n "$pids" ]; then
                    # These are local dev listeners that did not handle SIGTERM.
                    # shellcheck disable=SC2086
                    kill -KILL $pids 2>/dev/null || true
                  fi
                done
              }

              stop_servers() {
                stop_pid_file "$frontend_pid_file"
                stop_pid_file "$api_pid_file"
                stop_port 8080
                stop_port 8787
                wait_for_ports_to_stop
              }

              show_status() {
                for service in frontend api; do
                  case "$service" in
                    frontend) port=8080 ;;
                    api) port=8787 ;;
                  esac
                  pids="$(listener_pids "$port" | tr '\n' ' ' | sed 's/ $//')"
                  if [ -n "$pids" ]; then
                    echo "$service: running on :$port (pid $pids)"
                  else
                    echo "$service: stopped (:''${port})"
                  fi
                done
              }

              wait_for_url() {
                name="$1"
                url="$2"
                log_file="$3"
                pid_file="$4"
                for _ in $(seq 1 60); do
                  if curl --fail --silent --output /dev/null "$url"; then
                    return 0
                  fi
                  pid="$(cat "$pid_file")"
                  if ! kill -0 "$pid" 2>/dev/null; then
                    echo "dev-server: $name exited during startup." >&2
                    tail -n 30 "$log_file" >&2
                    return 1
                  fi
                  sleep 0.25
                done
                echo "dev-server: timed out waiting for $name at $url." >&2
                tail -n 30 "$log_file" >&2
                return 1
              }

              start_servers() {
                : > "$frontend_log"
                : > "$api_log"

                ${dev-api}/bin/dev-api >"$api_log" 2>&1 &
                api_pid="$!"
                echo "$api_pid" > "$api_pid_file"
                wait_for_url "API" "http://127.0.0.1:8787/api/health" "$api_log" "$api_pid_file"

                ${dev-frontend}/bin/dev-frontend >"$frontend_log" 2>&1 &
                frontend_pid="$!"
                echo "$frontend_pid" > "$frontend_pid_file"
                wait_for_url "frontend" "http://127.0.0.1:8080/" "$frontend_log" "$frontend_pid_file"
                wait_for_url "proxied API" "http://127.0.0.1:8080/api/health" "$frontend_log" "$frontend_pid_file"

                for port in 8080 8787; do
                  count="$(listener_pids "$port" | wc -l | tr -d ' ')"
                  if [ "$count" -ne 1 ]; then
                    echo "dev-server: expected one listener PID on :$port, found $count." >&2
                    stop_servers
                    return 1
                  fi
                done

                echo "SMS Dashboard restarted"
                show_status
                echo "URL:  http://localhost:8080"
                echo "Logs: $state_dir"
                echo "Press Ctrl-C to stop both servers."

                trap 'stop_servers; exit 130' INT TERM
                while kill -0 "$frontend_pid" 2>/dev/null && kill -0 "$api_pid" 2>/dev/null; do
                  sleep 1
                done

                # A newer `dev-server restart` replaces the PID files before this
                # supervisor notices its old children exited. In that case, leave
                # the new process pair alone and simply retire this supervisor.
                current_frontend_pid="$(cat "$frontend_pid_file" 2>/dev/null || true)"
                current_api_pid="$(cat "$api_pid_file" 2>/dev/null || true)"
                if [ "$current_frontend_pid" = "$frontend_pid" ] && [ "$current_api_pid" = "$api_pid" ]; then
                  echo "dev-server: a managed process exited; stopping its peer." >&2
                  stop_servers
                  return 1
                fi
              }

              command="''${1:-restart}"
              case "$command" in
                restart)
                  stop_servers
                  start_servers
                  ;;
                stop)
                  stop_servers
                  show_status
                  ;;
                status)
                  show_status
                  ;;
                logs)
                  echo "Frontend: $frontend_log"
                  echo "API:      $api_log"
                  ;;
                *)
                  echo "Usage: dev-server {restart|stop|status|logs}" >&2
                  exit 2
                  ;;
              esac
            '';
          };
        in
        {
          packages = {
            inherit
              sms-daemon
              orange-pi-daemon-rust
              balance-agent-cli
              release-balance-agent
              ;
            default = sms-daemon;
            # Alias for easier access
            daemon-rust = orange-pi-daemon-rust;
          };

          checks.daemon-format =
            pkgs.runCommand "daemon-format-check"
              {
                nativeBuildInputs = with pkgs; [
                  cargo
                  rustfmt
                ];
              }
              ''
                cp -R ${./orange-pi-daemon} source
                chmod -R u+w source
                cd source
                cargo fmt --all --check
                touch "$out"
              '';

          devShells = {
            default = pkgs.mkShell {
              packages = [
                # Dev commands (defined above) — on $PATH anywhere in the repo
                dev-api
                dev-frontend
                dev-server
                balance-agent-cli
                check-daemon
              ]
              ++ (with pkgs; [
                # Nix tools
                nixfmt
                nixd

                # Ops tooling
                ansible
                ansible-lint
                sops
                age

                # Frontend development
                oxlint

                # Rust development
                cargo
                rustc
                rust-analyzer
                rustfmt
                clippy

                # Testing tools
                curl
                jq
                pkg-config
                openssl
              ]);

              shellHook = ''
                echo "SMS Dashboard Development Environment"
                echo ""
                echo "Available projects:"
                echo "  • Web Dashboard: cd sms-dashboard"
                echo "  • Orange Pi Daemon (Rust): cd orange-pi-daemon"
                echo ""
                echo "Dev commands (work from anywhere in the repo):"
                echo "  • dev-frontend  — Vite dev server on :8080"
                echo "  • dev-api       — Wrangler + Auth0 secrets via SOPS on :8787"
                echo "  • dev-server    — restart/stop/status the unique :8080 + :8787 pair"
                echo "  • balance-agent — authenticated CLI for SMS AI and browser balance work"
                echo "  • check-daemon  — required Rust format check + full test suite"
                echo ""

                # Ensure Ansible finds collections installed by ansible-galaxy (SOPS, general)
                export ANSIBLE_COLLECTIONS_PATHS="$HOME/.ansible/collections:/usr/share/ansible/collections:/etc/ansible/collections:''${ANSIBLE_COLLECTIONS_PATHS:-}"
              '';
            };

            # Dedicated daemon development shell (Rust)
            daemon = pkgs.mkShell {
              packages = with pkgs; [
                nixos-rebuild
                cargo
                rustc
                rust-analyzer
                rustfmt
                clippy
                pkg-config
                openssl
              ];

              shellHook = ''
                echo "SMS Dashboard Daemon Development (Rust)"
                echo "Run 'cargo build --release' to compile the daemon"
                echo "Run 'cargo run' for development"
              '';
            };

            # Rust daemon development shell
            rust = pkgs.mkShell {
              packages = with pkgs; [
                cargo
                rustc
                rust-analyzer
                rustfmt
                clippy
                pkg-config
                openssl
              ];

              shellHook = ''
                echo "SMS Dashboard Daemon Development (Rust)"
                echo "Run 'cargo build --release' to compile the daemon"
                echo "Run 'cargo run' for development"
              '';
            };
          };

          apps = {
            balance-agent-cli = {
              type = "app";
              program = "${balance-agent-cli}/bin/balance-agent";
            };
            release-balance-agent = {
              type = "app";
              program = "${release-balance-agent}/bin/release-balance-agent";
            };
            daemon = {
              type = "app";
              program = "${sms-daemon}/bin/sms-daemon";
            };
            sms-daemon = {
              type = "app";
              program = "${sms-daemon}/bin/sms-daemon";
            };
            daemon-rust = {
              type = "app";
              program = "${orange-pi-daemon-rust}/bin/orange-pi-daemon-rust";
            };
            rust = {
              type = "app";
              program = "${orange-pi-daemon-rust}/bin/orange-pi-daemon-rust";
            };
          };
        };
    };
}
