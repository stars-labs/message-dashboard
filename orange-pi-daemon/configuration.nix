# Example NixOS configuration for Orange Pi with SMS Dashboard Daemon

{ config, pkgs, ... }:

{
  imports = [
    # Include the SMS dashboard daemon module
    ./nixos-module.nix
  ];

  # Enable the SMS dashboard daemon
  services.sms-dashboard-daemon = {
    enable = true;
    apiUrl = "https://sexy.qzz.io";
    # Use apiKeyFile with sops-nix (recommended)
    apiKeyFile = config.sops.secrets."sms-dashboard/api-key".path;
    # Or use apiKey directly (not recommended for production)
    # apiKey = "your-api-key-here";
    uploadInterval = 60; # Upload every minute
  };
  
  # Sops configuration for secure secrets
  sops = {
    defaultSopsFile = ./secrets.yaml;
    age.keyFile = "/var/lib/sops-nix/key.txt";
    secrets."sms-dashboard/api-key" = {
      owner = "sms-daemon";
      group = "dialout";
    };
  };

  # Enable ModemManager for 3G/4G modem support
  services.modemmanager.enable = true;

  # NetworkManager for network connectivity
  networking.networkmanager.enable = true;

  # Add necessary packages
  environment.systemPackages = with pkgs; [
    modemmanager
    networkmanager
    mmcli
    nmcli
  ];

  # Example: Using agenix for secrets management
  # age.secrets.sms-api-key = {
  #   file = ./secrets/sms-api-key.age;
  #   owner = "sms-daemon";
  # };
  # 
  # services.sms-dashboard-daemon.apiKey = config.age.secrets.sms-api-key.path;

  # For Orange Pi specific hardware
  boot.kernelModules = [ "option" "usb_wwan" "cdc_ether" "cdc_ncm" ];
  
  # USB mode switching for modems
  services.udev.packages = [ pkgs.usb-modeswitch ];
  
  # Enable automatic USB modeswitch
  services.udev.extraRules = ''
    # Huawei E3372 and similar modems
    ACTION=="add", SUBSYSTEM=="usb", ATTRS{idVendor}=="12d1", ATTRS{idProduct}=="1f01", RUN+="${pkgs.usb-modeswitch}/bin/usb_modeswitch -v 12d1 -p 1f01 -M '55534243123456780000000000000011062000000100000000000000000000'"
    
    # Add more modem rules as needed
  '';
}