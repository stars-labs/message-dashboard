# USB Optimization Module for 100 EC25 Modems
# Based on proven configurations from dotfiles and field testing
{ config, lib, pkgs, ... }:

{
  # USB kernel module options
  boot.extraModprobeConfig = ''
    # USB core options for high device count
    options usbcore use_both_schemes=y
    options usbcore initial_descriptor_timeout=10000
    options usbcore autosuspend=-1

    # xHCI options for USB 3.0 controllers
    options xhci_hcd quirks=270336

    # EHCI options for USB 2.0 controllers
    options ehci_hcd log2_irq_thresh=0
    options ehci_hcd park=3

    # USB storage options (for modems that present as storage first)
    options usb-storage quirks=2c7c:0125:u
  '';

  # udev rules for USB optimization
  services.udev.extraRules = ''
    # Increase USB device timeout for EC25 modems
    SUBSYSTEM=="usb", ATTR{idVendor}=="2c7c", ATTR{idProduct}=="0125", ATTR{bConfigurationValue}="1"

    # Disable USB autosuspend for all Quectel devices
    ACTION=="add", SUBSYSTEM=="usb", ATTR{idVendor}=="2c7c", TEST=="power/control", ATTR{power/control}="on"

    # Increase buffer size for USB serial devices
    ACTION=="add", SUBSYSTEM=="tty", KERNEL=="ttyUSB*", RUN+="/bin/sh -c 'echo 256 > /sys/class/tty/%k/device/../../power/autosuspend_delay_ms'"

    # Priority for modem USB devices
    ACTION=="add", SUBSYSTEM=="usb", ATTR{idVendor}=="2c7c", RUN+="/bin/sh -c 'echo -1 > /sys/%p/power/autosuspend'"
  '';

  # Systemd service to optimize USB at boot
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
            # Check if we can write to these files
            [ -w "$xhci/parameters/quirks" ] && echo 270336 > "$xhci/parameters/quirks" || true
          fi
        done

        # Optimize USB hubs
        for hub in /sys/bus/usb/devices/*/; do
          if [ -f "$hub/bDeviceClass" ] && [ "$(cat $hub/bDeviceClass)" = "09" ]; then
            # This is a hub
            [ -w "$hub/power/autosuspend" ] && echo -1 > "$hub/power/autosuspend" || true
            [ -w "$hub/power/control" ] && echo on > "$hub/power/control" || true
          fi
        done

        # Set USB device priorities
        for modem in /sys/bus/usb/devices/*/; do
          if [ -f "$modem/idVendor" ] && [ "$(cat $modem/idVendor 2>/dev/null)" = "2c7c" ]; then
            # Quectel modem found
            [ -w "$modem/power/autosuspend" ] && echo -1 > "$modem/power/autosuspend" || true
            [ -w "$modem/power/control" ] && echo on > "$modem/power/control" || true
            [ -w "$modem/power/persist" ] && echo 1 > "$modem/power/persist" || true
          fi
        done

        echo "USB optimization complete"
      '';
    };
  };

  # ModemManager optimization
  systemd.services.ModemManager = {
    serviceConfig = {
      # Increase limits for ModemManager
      LimitNOFILE = 65536;
      LimitNPROC = 32768;

      # Nice level for better scheduling
      Nice = -5;

      # CPU affinity (adjust based on your CPU cores)
      # CPUAffinity = "2-7";  # Reserve cores 2-7 for ModemManager
    };

    # Custom ModemManager arguments
    environment = {
      MM_FILTER_RULE_TTY_BLACKLIST = "tty[0-9]*";  # Ignore console TTYs
      MM_FILTER_RULE_TTY_WHITELIST = "ttyUSB*";    # Only process USB TTYs
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

  # Additional sysctl optimizations for USB and ModemManager
  boot.kernel.sysctl = {
    # USB message queue size
    "kernel.msgmnb" = 65536;
    "kernel.msgmax" = 65536;

    # Shared memory for IPC (ModemManager uses D-Bus)
    "kernel.shmmax" = 68719476736;
    "kernel.shmall" = 4294967296;

    # Semaphores for IPC
    "kernel.sem" = "250 32000 100 128";
  };
}