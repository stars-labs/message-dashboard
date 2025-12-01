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
        flake-parts.follows = "flake-parts";
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
          daemonVersion = "7.4.0"; # v7.4.0: Added busctl fallback for SMS deletion

          # Rust SMS daemon - the only daemon implementation
          sms-daemon = pkgs.rustPlatform.buildRustPackage {
            pname = "sms-daemon";
            version = daemonVersion;
            src = ./orange-pi-daemon;

            cargoLock = {
              lockFile = ./orange-pi-daemon/Cargo.lock;
            };

            nativeBuildInputs = with pkgs; [ pkg-config ];
            buildInputs = with pkgs; [
              openssl
              dbus  # Required for native D-Bus support
            ];

            # Post-install: create symlink from Rust binary name to expected name
            postInstall = ''
              ln -s $out/bin/orange-pi-daemon-rust $out/bin/sms-daemon
            '';

            meta = with lib; {
              description = "High-performance Rust SMS daemon with native D-Bus for zero-overhead modem communication";
              longDescription = ''
                A multi-threaded async Rust daemon that monitors 3G/4G modems using native D-Bus,
                eliminating subprocess overhead entirely. Collects SMS messages and phone status
                information, and forwards them to the SMS Dashboard server API in real-time.
                Features native D-Bus (5ms/op), worker pool architecture for 92+ modems, and
                intelligent fallback to busctl when native D-Bus is unavailable.
              '';
              homepage = "https://github.com/hecoinfo/message-dashboard";
              license = licenses.mit;
              platforms = platforms.linux;
            };
          };

          # Alias for backward compatibility
          orange-pi-daemon-rust = sms-daemon;
        in
        {
          packages = {
            inherit sms-daemon orange-pi-daemon-rust;
            default = sms-daemon;
            # Alias for easier access
            daemon-rust = orange-pi-daemon-rust;
          };

          devShells = {
            default = pkgs.mkShell {
              packages = with pkgs; [
                # Nix tools
                nixfmt-rfc-style
                nixd

                # Frontend development
                nodejs_20
                nodePackages.npm

                # Rust development
                cargo
                rustc
                rust-analyzer
                rustfmt
                clippy

                # Testing tools
                curl
                jq
                modemmanager
                pkg-config
                openssl
              ];

              shellHook = ''
                echo "SMS Dashboard Development Environment"
                echo ""
                echo "Available projects:"
                echo "  • Web Dashboard: cd sms-dashboard"
                echo "  • Orange Pi Daemon (Rust): cd orange-pi-daemon"
                echo ""
              '';
            };

            # Dedicated daemon development shell (Rust)
            daemon = pkgs.mkShell {
              packages = with pkgs; [
                cargo
                rustc
                rust-analyzer
                rustfmt
                clippy
                modemmanager
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
                modemmanager
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
