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
    { self, nixpkgs, flake-parts, sops-nix, ... }@inputs:
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
        "x86_64-darwin"
      ];
      
      flake = {
        # NixOS module for the daemon
        nixosModules = {
          default = ./orange-pi-daemon/nixos-module.nix;
          sms-dashboard-daemon = ./orange-pi-daemon/nixos-module.nix;
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
          # Orange Pi daemon package
          sms-dashboard-daemon = pkgs.stdenv.mkDerivation rec {
            pname = "sms-dashboard-daemon";
            version = "0.1.0";
            
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
              cp zig-out/bin/sms-dashboard-daemon $out/bin/
            '';
          };
        in
        {
          packages = {
            inherit sms-dashboard-daemon;
            default = sms-dashboard-daemon;
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
              program = "${sms-dashboard-daemon}/bin/sms-dashboard-daemon";
            };
          };
        };
    };
}
