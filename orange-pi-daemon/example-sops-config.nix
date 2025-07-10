# Example NixOS configuration using sops-nix for secure API key management

{ config, pkgs, ... }:

{
  imports = [
    # Your hardware configuration
    ./hardware-configuration.nix
    
    # sops-nix module
    <sops-nix/modules/sops>
    
    # SMS Dashboard Daemon module
    ./sms-dashboard-daemon/nixos-module.nix
  ];

  # Configure sops
  sops = {
    # Path to your sops secret file
    defaultSopsFile = ./secrets.yaml;
    
    # Age key file location
    age.keyFile = "/var/lib/sops-nix/key.txt";
    
    # Define secrets
    secrets = {
      "sms-dashboard/api-key" = {
        owner = config.services.sms-dashboard-daemon.user;
        group = config.services.sms-dashboard-daemon.group;
        mode = "0440";
      };
    };
  };

  # Configure SMS Dashboard Daemon with sops secret
  services.sms-dashboard-daemon = {
    enable = true;
    apiUrl = "https://sexy.qzz.io";
    apiKeyFile = config.sops.secrets."sms-dashboard/api-key".path;
    uploadInterval = 60; # Upload every minute
  };

  # ModemManager is automatically enabled by the module
  # but you can add extra configuration here
  services.modemmanager = {
    enable = true;
  };

  # NetworkManager for connectivity
  networking.networkmanager = {
    enable = true;
    # Ensure ModemManager can manage mobile broadband
    unmanaged = [];
  };

  # USB modem kernel modules
  boot.kernelModules = [ 
    "option" 
    "usb_wwan" 
    "cdc_ether" 
    "cdc_ncm" 
    "qmi_wwan"
  ];

  # USB mode switching for various modems
  services.udev.packages = [ pkgs.usb-modeswitch ];
  
  services.udev.extraRules = ''
    # Huawei E3372
    ACTION=="add", SUBSYSTEM=="usb", ATTRS{idVendor}=="12d1", ATTRS{idProduct}=="1f01", RUN+="${pkgs.usb-modeswitch}/bin/usb_modeswitch -v 12d1 -p 1f01 -M '55534243123456780000000000000011062000000100000000000000000000'"
    
    # ZTE MF823
    ACTION=="add", SUBSYSTEM=="usb", ATTRS{idVendor}=="19d2", ATTRS{idProduct}=="0257", RUN+="${pkgs.usb-modeswitch}/bin/usb_modeswitch -v 19d2 -p 0257 -W"
    
    # Quectel EC25
    ACTION=="add", SUBSYSTEM=="usb", ATTRS{idVendor}=="2c7c", ATTRS{idProduct}=="0125", RUN+="${pkgs.usb-modeswitch}/bin/usb_modeswitch -v 2c7c -p 0125 -W"
  '';

  # Useful packages for debugging
  environment.systemPackages = with pkgs; [
    modemmanager
    networkmanager
    mmcli
    nmcli
    usb-modeswitch
    usbutils
  ];

  # Enable SSH for remote management (optional)
  services.openssh = {
    enable = true;
    settings.PasswordAuthentication = false;
  };

  # Firewall
  networking.firewall = {
    enable = true;
    # Allow SSH if enabled
    allowedTCPPorts = [ 22 ];
  };

  # System auto-upgrade (optional)
  system.autoUpgrade = {
    enable = true;
    allowReboot = true;
    dates = "03:00";
  };
}