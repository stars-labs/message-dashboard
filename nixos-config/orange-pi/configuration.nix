# NixOS configuration for Orange Pi with SMS Dashboard
{
  config,
  pkgs,
  lib,
  ...
}:

{
  imports = [
    # Include hardware configuration (generate with nixos-generate-config)
    ./hardware-configuration.nix

    # Include SMS daemon module
    ../modules/sms-daemon.nix
  ];

  # System identification
  networking.hostName = "orange-pi-sms";
  
  # Configure static network interface for Orange Pi
  networking.interfaces = {
    enP3p49s0 = {
      ipv4.addresses = [
        {
          address = "10.171.150.102";
          prefixLength = 24;
        }
      ];
    };
  };

  # Configure network settings
  networking.defaultGateway = "10.171.150.1";
  networking.nameservers = [
    "8.8.8.8"
    "8.8.4.4"
  ];

  # Tell NetworkManager to ignore the static interface
  networking.networkmanager.unmanaged = [ "enP3p49s0" ];

  # Disable firewall for now (enable and configure as needed)
  networking.firewall.enable = false;

  # Time zone
  time.timeZone = "Asia/Singapore";

  # Locale
  i18n.defaultLocale = "en_SG.UTF-8";
  i18n.extraLocaleSettings = {
    LC_ADDRESS = "en_SG.UTF-8";
    LC_IDENTIFICATION = "en_SG.UTF-8";
    LC_MEASUREMENT = "en_SG.UTF-8";
    LC_MONETARY = "en_SG.UTF-8";
    LC_NAME = "en_SG.UTF-8";
    LC_NUMERIC = "en_SG.UTF-8";
    LC_PAPER = "en_SG.UTF-8";
    LC_TELEPHONE = "en_SG.UTF-8";
    LC_TIME = "en_SG.UTF-8";
  };

  # Enable SSH for remote management
  services.openssh = {
    enable = true;
    settings = {
      PasswordAuthentication = false;
      KbdInteractiveAuthentication = false;
      PermitRootLogin = "prohibit-password";
    };
  };

  # Configure root user SSH keys
  users.users.root.openssh.authorizedKeys.keys = [
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFhTqqOg4U3juVuxFgHt9cq2Opy+XVHLQahORdA56z6F openpgp:0x0383A3C3"
  ];

  # Create user for management
  users.users.htx = {
    isNormalUser = true;
    description = "HTX User";
    extraGroups = [
      "networkmanager"
      "wheel"
      "dialout"
    ];
    openssh.authorizedKeys.keys = [
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFhTqqOg4U3juVuxFgHt9cq2Opy+XVHLQahORdA56z6F openpgp:0x0383A3C3"
    ];
  };

  # SMS daemon configuration is handled in flake.nix

  # Install essential packages
  environment.systemPackages = with pkgs; [
    vim
    wget
    curl
    htop
    tmux
    git
    sbctl
    usbutils  # Provides lsusb command
  ];

  # Boot configuration
  boot = {
    # Use latest kernel packages
    kernelPackages = lib.mkForce pkgs.linuxPackages_latest;
    
    # Lanzaboote secure boot configuration
    lanzaboote = {
      enable = true;
      pkiBundle = "/var/lib/sbctl";
    };
    
    # Disable systemd-boot as lanzaboote replaces it
    loader = {
      systemd-boot.enable = lib.mkForce false;
      efi = {
        canTouchEfiVariables = true;
        efiSysMountPoint = "/boot";
      };
    };
  };

  # This value determines the NixOS release compatibility
  system.stateVersion = "25.11";
  networking = {

    modemmanager = {
      enable = true;
      fccUnlockScripts = [
        {
          # Quectel EC25 LTE modem
          id = "2c7c:0125";
          path = "${pkgs.modemmanager}/share/ModemManager/fcc-unlock.available.d/2c7c";
        }
        {
          # Au780 modem
          id = "1a86:7523";
          path = "${pkgs.modemmanager}/share/ModemManager/fcc-unlock.available.d/1a86";
        }
      ];
    };
  };

}
