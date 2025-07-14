{ config, lib, pkgs, ... }:

{
  # Enable ModemManager for 3G/4G modem support
  networking.modemmanager.enable = true;

  # USB mode switching for modems
  services.udev.packages = [ pkgs.usb-modeswitch ];

  # Kernel modules for USB modems
  boot.kernelModules = [ 
    "option"     # USB serial driver for GSM modems
    "usb_wwan"   # USB wireless WAN driver
    "cdc_ether"  # CDC Ethernet driver
    "cdc_ncm"    # CDC NCM driver
    "cdc_acm"    # CDC ACM driver for modem control
  ];

  # Enable automatic USB modeswitch for common modems
  services.udev.extraRules = ''
    # Huawei E3372 and similar modems (switch from CD-ROM mode to modem mode)
    ACTION=="add", SUBSYSTEM=="usb", ATTRS{idVendor}=="12d1", ATTRS{idProduct}=="1f01", RUN+="${pkgs.usb-modeswitch}/bin/usb_modeswitch -v 12d1 -p 1f01 -M '55534243123456780000000000000011062000000100000000000000000000'"
    
    # Quectel EC25 LTE modem
    ACTION=="add", SUBSYSTEM=="usb", ATTRS{idVendor}=="2c7c", ATTRS{idProduct}=="0125", RUN+="${pkgs.usb-modeswitch}/bin/usb_modeswitch -v 2c7c -p 0125"
    
    # Generic Qualcomm modems
    ACTION=="add", SUBSYSTEM=="usb", ATTRS{idVendor}=="05c6", ATTRS{idProduct}=="9000|9001|9002|9003|9004|9005", RUN+="${pkgs.usb-modeswitch}/bin/usb_modeswitch -v 05c6 -p %s{idProduct}"
    
    # Set permissions for modem devices
    SUBSYSTEM=="tty", ATTRS{idVendor}=="12d1|2c7c|05c6", GROUP="dialout", MODE="0664"
    SUBSYSTEM=="usb", ATTRS{idVendor}=="12d1|2c7c|05c6", GROUP="dialout", MODE="0664"
  '';

  # FCC unlock scripts are handled automatically by ModemManager

  # Install useful packages for modem management
  environment.systemPackages = with pkgs; [
    modemmanager     # Provides mmcli
    networkmanager   # Network management
    usb-modeswitch   # USB mode switching
    usbutils         # lsusb and other USB utilities
  ];

  # Enable NetworkManager for network connectivity
  networking.networkmanager.enable = true;
}