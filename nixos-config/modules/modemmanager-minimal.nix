# Minimal ModemManager configuration
# Since ModemManager has hardcoded internal limits that prevent it from detecting
# all 87 USB modems, this module provides only the minimal configuration needed.
# The Rust daemon will directly manage modems via serial ports using AT commands.
{ config, lib, pkgs, ... }:

{
  # Basic ModemManager service (disabled by default)
  # We keep it installed but disabled since the daemon will manage modems directly
  networking.modemmanager = {
    enable = false;  # Disabled - daemon will use direct serial communication
  };

  # Essential kernel modules for USB serial modems
  boot.kernelModules = [
    "option"           # GSM/UMTS modem driver (needed for USB serial)
    "usb_wwan"        # USB WWAN driver
    "qmi_wwan"        # Qualcomm MSM Interface driver
    "cdc_wdm"         # CDC WDM driver for QMI
    "cdc_ether"       # CDC Ethernet driver
    "cdc_ncm"         # CDC NCM driver
  ];

  # Basic udev rules for Quectel modems to ensure proper serial port creation
  services.udev.extraRules = ''
    # Quectel EC20/EC25 series modems - ensure serial ports are created
    ATTRS{idVendor}=="2c7c", ATTRS{idProduct}=="0125", MODE="0666", GROUP="dialout"
    ATTRS{idVendor}=="05c6", ATTRS{idProduct}=="9215", MODE="0666", GROUP="dialout"

    # Set permissions for all ttyUSB devices (for direct serial access)
    SUBSYSTEM=="tty", KERNEL=="ttyUSB*", MODE="0666", GROUP="dialout"

    # Increase USB buffer for many modems
    ACTION=="add", SUBSYSTEM=="usb", ATTRS{idVendor}=="2c7c", RUN+="/bin/sh -c 'echo 256 > /sys/module/usbcore/parameters/usbfs_memory_mb'"
    ACTION=="add", SUBSYSTEM=="usb", ATTRS{idVendor}=="05c6", RUN+="/bin/sh -c 'echo 256 > /sys/module/usbcore/parameters/usbfs_memory_mb'"
  '';

  # Ensure dialout group exists for serial port access
  users.groups.dialout = {};

  # Add the daemon user to dialout group for serial port access
  users.users.sms-daemon = {
    extraGroups = [ "dialout" ];
  };
}