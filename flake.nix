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
                    phoneUpdateIntervalSeconds = 5; # Check interval for Rust daemon
                    messageCheckIntervalMs = 5000; # Not used by Rust (uses seconds)
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
          daemonVersion = "4.0.0"; # Clean Modem/SIM architecture with device path collection

          # Orange Pi SMS daemon package
          # Base derivation for common settings
          sms-daemon-base = {
            pname = "sms-daemon";
            version = daemonVersion;
            src = ./orange-pi-daemon;
            nativeBuildInputs = with pkgs; [ zig pkg-config ];
            buildInputs = with pkgs; [ dbus ];

            installPhase = ''
              mkdir -p $out/bin
              cp zig-out/bin/orange-pi-daemon $out/bin/sms-daemon
            '';

            meta = with lib; {
              description = "SMS Dashboard Daemon for Orange Pi with 3G/4G modems";
              longDescription = ''
                A multi-threaded daemon that monitors 3G/4G modems using ModemManager (mmcli),
                collects SMS messages and phone status information, and forwards
                them to the SMS Dashboard server API in real-time.
              '';
              homepage = "https://github.com/hecoinfo/message-dashboard";
              license = licenses.mit;
              platforms = platforms.linux;
            };
          };

          # Release build with info logging
          sms-daemon = pkgs.stdenv.mkDerivation (
            sms-daemon-base
            // {
              pname = "sms-daemon";

              buildPhase = ''
                export HOME=$TMPDIR
                rm -rf zig-cache zig-out
                zig build -Doptimize=ReleaseFast -Dlog_level=info
              '';
            }
          );

          # Debug build with debug logging
          sms-daemon-debug = pkgs.stdenv.mkDerivation (
            sms-daemon-base
            // {
              pname = "sms-daemon-debug";

              buildPhase = ''
                export HOME=$TMPDIR
                rm -rf zig-cache zig-out
                zig build -Doptimize=Debug -Dlog_level=debug
              '';
            }
          );

          # Rust SMS daemon - memory-safe replacement
          orange-pi-daemon-rust = pkgs.rustPlatform.buildRustPackage {
            pname = "orange-pi-daemon-rust";
            version = "2.0.3";
            src = ./orange-pi-daemon-rust;
            
            cargoLock = {
              lockFile = ./orange-pi-daemon-rust/Cargo.lock;
            };
            
            nativeBuildInputs = with pkgs; [ pkg-config ];
            buildInputs = with pkgs; [ openssl ];
            
            # Post-install: create symlink from default binary name to expected name
            postInstall = ''
              ln -s $out/bin/orange-pi-daemon-rust $out/bin/sms-daemon
            '';
            
            meta = with lib; {
              description = "Memory-safe Rust SMS daemon for Orange Pi";
              longDescription = ''
                A single-threaded async Rust daemon that replaces the Zig version.
                Provides guaranteed memory safety with zero segfaults.
              '';
              homepage = "https://github.com/hecoinfo/message-dashboard";
              license = licenses.mit;
              platforms = platforms.linux;
            };
          };
        in
        {
          packages = {
            inherit sms-daemon sms-daemon-debug orange-pi-daemon-rust;
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

                # Zig development
                zig
                zls

                # Rust development
                cargo
                rustc
                rust-analyzer
                rustfmt
                clippy

                # Testing tools
                curl
                jq
              ];

              shellHook = ''
                echo "SMS Dashboard Development Environment"
                echo ""
                echo "Available projects:"
                echo "  • Web Dashboard: cd sms-dashboard"
                echo "  • Orange Pi Daemon (Zig): cd orange-pi-daemon"
                echo "  • Orange Pi Daemon (Rust): cd orange-pi-daemon-rust"
                echo ""
              '';
            };

            # Dedicated daemon development shell (Zig)
            daemon = pkgs.mkShell {
              packages = with pkgs; [
                zig
                zls
                modemmanager
              ];

              shellHook = ''
                echo "SMS Dashboard Daemon Development (Zig)"
                echo "Run 'zig build' to compile the daemon"
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
