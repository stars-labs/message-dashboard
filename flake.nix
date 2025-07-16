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
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-parts,
      sops-nix,
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
          modem-support = ./nixos-config/modules/modem-support.nix;
        };

        # NixOS configuration for Orange Pi
        nixosConfigurations = {
          orange-pi = nixpkgs.lib.nixosSystem {
            system = "aarch64-linux";
            modules = [
              ./nixos-config/orange-pi/configuration.nix
              sops-nix.nixosModules.sops
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
                    };
                  };

                  # Override the SMS daemon to use SOPS secrets
                  services.sms-daemon = {
                    enable = true;
                    package = self.packages.aarch64-linux.sms-daemon;
                    apiKeyFile = config.sops.secrets."sms-dashboard/api-key".path;
                    apiUrl = "https://sexy.qzz.io/";
                    uploadInterval = 60;
                    logLevel = "debug";
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
          # Orange Pi SMS daemon package
          sms-daemon = pkgs.stdenv.mkDerivation rec {
            pname = "sms-daemon";
            version = "0.1.1";

            src = ./orange-pi-daemon;

            nativeBuildInputs = with pkgs; [
              zig
            ];

            buildPhase = ''
              export HOME=$TMPDIR
              zig build -Doptimize=ReleaseSafe
            '';

            installPhase = ''
              mkdir -p $out/bin
              cp zig-out/bin/orange-pi-daemon $out/bin/sms-daemon
            '';
          };
        in
        {
          packages = {
            inherit sms-daemon;
            default = sms-daemon;
            # Legacy alias
            sms-dashboard-daemon = sms-daemon;
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

                # Testing tools
                curl
                jq
              ];

              shellHook = ''
                echo "SMS Dashboard Development Environment"
                echo ""
                echo "Available projects:"
                echo "  • Web Dashboard: cd sms-dashboard"
                echo "  • Orange Pi Daemon: cd orange-pi-daemon"
                echo ""
              '';
            };

            # Dedicated daemon development shell
            daemon = pkgs.mkShell {
              packages = with pkgs; [
                zig
                zls
                modemmanager
              ];

              shellHook = ''
                echo "SMS Dashboard Daemon Development"
                echo "Run 'zig build' to compile the daemon"
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
          };
        };
    };
}
