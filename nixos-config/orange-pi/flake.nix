{
  description = "Orange Pi SMS Dashboard Configuration";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    sops-nix = {
      url = "github:Mic92/sops-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    lanzaboote = {
      url = "github:nix-community/lanzaboote";
      inputs = {
        nixpkgs.follows = "nixpkgs";
        flake-compat.follows = "flake-compat";
        flake-parts.follows = "flake-parts";
      };
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      sops-nix,
      lanzanoote,
    }:
    {
      nixosConfigurations.orange-pi = nixpkgs.lib.nixosSystem {
        system = "aarch64-linux"; # Orange Pi ARM64
        modules = [
          ./configuration.nix
          sops-nix.nixosModules.sops
          lanzaboote.nixosModules.lanzaboote
        ];
      };

      # For x86_64 development/testing
      nixosConfigurations.orange-pi-x86 = nixpkgs.lib.nixosSystem {
        system = "x86_64-linux";
        modules = [
          ./configuration.nix
          sops-nix.nixosModules.sops
        ];
      };
    };
}
