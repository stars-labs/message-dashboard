# USB Optimization Module for 100 EC25 Modems
# Based on proven configurations from dotfiles and field testing
# Optimized for direct AT command mode (not ModemManager)
{ config, lib, pkgs, ... }:

{
  # USB kernel module options
  boot.extraModprobeConfig = ''
    # USB core options for high device count
    options usbcore use_both_schemes=y
    options usbcore initial_descriptor_timeout=10000
    options usbcore autosuspend=-1

    # xHCI options for USB 3.0 controllers (critical for stability)
    options xhci_hcd quirks=270336

    # EHCI options for USB 2.0 controllers
    options ehci_hcd log2_irq_thresh=0
    options ehci_hcd park=3

    # USB storage options (for modems that present as storage first)
    options usb-storage quirks=2c7c:0125:u

    # USB serial option driver optimization
    options option nctrl_msg_timeout=10000
  '';

  # udev rules for USB optimization
  services.udev.extraRules = ''
    # Increase USB device timeout for EC25/EC20 modems (Quectel)
    SUBSYSTEM=="usb", ATTR{idVendor}=="2c7c", ATTR{idProduct}=="0125", ATTR{bConfigurationValue}="1"

    # Disable USB autosuspend for all Quectel devices
    ACTION=="add", SUBSYSTEM=="usb", ATTR{idVendor}=="2c7c", TEST=="power/control", ATTR{power/control}="on"

    # Priority and power settings for modem USB devices
    ACTION=="add", SUBSYSTEM=="usb", ATTR{idVendor}=="2c7c", RUN+="${pkgs.bash}/bin/bash -c 'echo -1 > /sys/%p/power/autosuspend 2>/dev/null || true'"
    ACTION=="add", SUBSYSTEM=="usb", ATTR{idVendor}=="2c7c", RUN+="${pkgs.bash}/bin/bash -c 'echo on > /sys/%p/power/control 2>/dev/null || true'"
    ACTION=="add", SUBSYSTEM=="usb", ATTR{idVendor}=="2c7c", RUN+="${pkgs.bash}/bin/bash -c 'echo 1 > /sys/%p/power/persist 2>/dev/null || true'"

    # Disable autosuspend for USB hubs (critical for hub stability)
    ACTION=="add", SUBSYSTEM=="usb", ATTR{bDeviceClass}=="09", RUN+="${pkgs.bash}/bin/bash -c 'echo -1 > /sys/%p/power/autosuspend 2>/dev/null || true'"
    ACTION=="add", SUBSYSTEM=="usb", ATTR{bDeviceClass}=="09", RUN+="${pkgs.bash}/bin/bash -c 'echo on > /sys/%p/power/control 2>/dev/null || true'"

    # Set USB serial port permissions for sms-daemon group
    SUBSYSTEM=="tty", KERNEL=="ttyUSB*", GROUP="dialout", MODE="0660"
  '';

  # Systemd service to optimize USB at boot and periodically reset hung devices
  systemd.services.usb-optimization = {
    description = "USB optimization for 100 modems";
    after = [ "multi-user.target" ];
    wantedBy = [ "multi-user.target" ];

    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      ExecStart = pkgs.writeShellScript "usb-optimize" ''
        #!/bin/sh
        set -e

        echo "Optimizing USB for 100 modems..."

        # Increase xHCI event ring size if available
        for xhci in /sys/bus/pci/drivers/xhci_hcd/*/; do
          if [ -d "$xhci" ]; then
            [ -w "$xhci/parameters/quirks" ] && echo 270336 > "$xhci/parameters/quirks" || true
          fi
        done

        # Also check platform xHCI (RK3588 uses platform USB controllers)
        for xhci in /sys/bus/platform/drivers/xhci-hcd/*/; do
          if [ -d "$xhci" ]; then
            echo "Found platform xHCI: $xhci"
          fi
        done

        # Optimize USB hubs - CRITICAL for hub cascade stability
        for hub in /sys/bus/usb/devices/*/; do
          if [ -f "$hub/bDeviceClass" ] && [ "$(cat $hub/bDeviceClass 2>/dev/null)" = "09" ]; then
            [ -w "$hub/power/autosuspend" ] && echo -1 > "$hub/power/autosuspend" 2>/dev/null || true
            [ -w "$hub/power/control" ] && echo on > "$hub/power/control" 2>/dev/null || true
            [ -w "$hub/power/autosuspend_delay_ms" ] && echo -1 > "$hub/power/autosuspend_delay_ms" 2>/dev/null || true
          fi
        done

        # Set USB device priorities for Quectel modems
        for modem in /sys/bus/usb/devices/*/; do
          if [ -f "$modem/idVendor" ] && [ "$(cat $modem/idVendor 2>/dev/null)" = "2c7c" ]; then
            [ -w "$modem/power/autosuspend" ] && echo -1 > "$modem/power/autosuspend" 2>/dev/null || true
            [ -w "$modem/power/control" ] && echo on > "$modem/power/control" 2>/dev/null || true
            [ -w "$modem/power/persist" ] && echo 1 > "$modem/power/persist" 2>/dev/null || true
          fi
        done

        echo "USB optimization complete"
        echo "USB devices: $(lsusb | grep -c 'Quectel' || echo 0) Quectel modems detected"
        echo "USB serial ports: $(ls /dev/ttyUSB* 2>/dev/null | wc -l || echo 0)"
      '';
    };
  };

  # Kernel module loading optimizations
  boot.kernelModules = [
    "cdc_acm"      # USB ACM for modems
    "cdc_wdm"      # USB WDM for QMI
    "qmi_wwan"     # QMI WWAN for LTE modems
    "option"       # USB serial option driver
    "usb_wwan"     # USB WWAN driver
  ];

  # Additional sysctl optimizations for USB subsystem
  boot.kernel.sysctl = {
    # USB message queue size
    "kernel.msgmnb" = 65536;
    "kernel.msgmax" = 65536;

    # Shared memory for IPC
    "kernel.shmmax" = 68719476736;
    "kernel.shmall" = 4294967296;

    # Semaphores for IPC
    "kernel.sem" = "250 32000 100 128";
  };
}