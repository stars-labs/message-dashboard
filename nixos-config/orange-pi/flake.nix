{
  description = "Orange Pi SMS Dashboard Configuration";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    sops-nix = {
      url = "github:Mic92/sops-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, sops-nix }: {
    nixosConfigurations.orange-pi = nixpkgs.lib.nixosSystem {
      system = "aarch64-linux";  # Orange Pi ARM64
      modules = [
        ./configuration.nix
        sops-nix.nixosModules.sops
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