# ModemManager optimization for handling 100+ USB modems
# This module fixes issues with ModemManager timing out when detecting many modems
{ config, lib, pkgs, ... }:

{
  # ModemManager configuration for high modem count
  networking.modemmanager = {
    enable = true;
    fccUnlockScripts = [
      {
        # Quectel EC20F LTE modem (different from EC25)
        id = "2c7c:0125";
        path = "${pkgs.modemmanager}/share/ModemManager/fcc-unlock.available.d/2c7c";
      }
      {
        # Quectel EC20 series
        id = "05c6:9215";
        path = "${pkgs.modemmanager}/share/ModemManager/fcc-unlock.available.d/05c6";
      }
    ];
  };

  # Override ModemManager service for better handling of many modems
  systemd.services.ModemManager = {
    serviceConfig = {
      # Increase timeouts for probe operations
      TimeoutStartSec = "5min";
      TimeoutStopSec = "2min";

      # Restart on failure with delay to prevent rapid restarts
      Restart = "on-failure";
      RestartSec = "30s";
      RestartPreventExitStatus = "1";

      # Increase resource limits
      LimitNOFILE = 65536;
      LimitNPROC = lib.mkForce 32768;  # Use higher value from usb-optimization

      # Nice level for better performance
      Nice = -5;

      # CPU and IO scheduling
      CPUSchedulingPolicy = "fifo";
      CPUSchedulingPriority = 20;
      IOSchedulingClass = "realtime";
      IOSchedulingPriority = 2;
    };

    # ModemManager environment variables
    environment = {
      MM_FILTER = "DEFAULT";  # Filter policy for device detection
      MM_MAX_MODEMS = "100";  # Maximum modems to handle
    };

    # Override the ExecStart to add custom parameters
    # Only use valid options for ModemManager 1.24.0
    # STRICT filter policy allows more devices through the filter
    serviceConfig.ExecStart = lib.mkForce [
      "" # Clear the original ExecStart
      "${pkgs.modemmanager}/sbin/ModemManager --filter-policy=STRICT --test-quick-suspend-resume --log-level=INFO"
    ];

    # Add a pre-start script to wait for USB devices to settle
    preStart = ''
      echo "Waiting for USB devices to settle..."
      sleep 10

      # Count USB modem devices
      MODEM_COUNT=$(ls /dev/ttyUSB* 2>/dev/null | wc -l)
      echo "Found $MODEM_COUNT USB serial devices"

      # If we have many modems, give them more time to initialize
      if [ "$MODEM_COUNT" -gt 50 ]; then
        echo "Large number of modems detected, waiting additional time..."
        sleep 20
      fi
    '';

    # Post-start check
    postStart = ''
      echo "ModemManager started, waiting for modem detection..."
      sleep 5

      # Check detected modems
      for i in {1..30}; do
        DETECTED=$(mmcli -L 2>/dev/null | wc -l)
        echo "Attempt $i: Detected $DETECTED modems"

        if [ "$DETECTED" -gt 0 ]; then
          echo "ModemManager successfully detected modems"
          break
        fi

        sleep 2
      done
    '';
  };

  # Add udev rules for Quectel modems to speed up detection
  services.udev.extraRules = ''
    # Quectel EC20/EC25 series modems
    ATTRS{idVendor}=="2c7c", ATTRS{idProduct}=="0125", ENV{ID_MM_DEVICE_PROCESS}="1"
    ATTRS{idVendor}=="05c6", ATTRS{idProduct}=="9215", ENV{ID_MM_DEVICE_PROCESS}="1"

    # Set higher priority for modem ports
    SUBSYSTEM=="tty", ATTRS{idVendor}=="2c7c", ENV{ID_MM_PORT_TYPE_AT_PRIMARY}="1"
    SUBSYSTEM=="tty", ATTRS{idVendor}=="05c6", ENV{ID_MM_PORT_TYPE_AT_PRIMARY}="1"

    # Tag Quectel modems for faster detection
    SUBSYSTEM=="tty", ATTRS{idVendor}=="2c7c", TAG+="systemd", ENV{SYSTEMD_WANTS}="ModemManager.service"
    SUBSYSTEM=="tty", ATTRS{idVendor}=="05c6", TAG+="systemd", ENV{SYSTEMD_WANTS}="ModemManager.service"

    # Increase USB buffer for modem devices
    ACTION=="add", SUBSYSTEM=="usb", ATTRS{idVendor}=="2c7c", RUN+="/bin/sh -c 'echo 256 > /sys/module/usbcore/parameters/usbfs_memory_mb'"
    ACTION=="add", SUBSYSTEM=="usb", ATTRS{idVendor}=="05c6", RUN+="/bin/sh -c 'echo 256 > /sys/module/usbcore/parameters/usbfs_memory_mb'"
  '';

  # Kernel modules for Quectel modems
  boot.kernelModules = [
    "option"           # GSM/UMTS modem driver
    "usb_wwan"        # USB WWAN driver
    "qmi_wwan"        # Qualcomm MSM Interface driver
    "cdc_wdm"         # CDC WDM driver for QMI
    "cdc_ether"       # CDC Ethernet driver
    "cdc_ncm"         # CDC NCM driver
  ];

  # Blacklist conflicting drivers
  boot.blacklistedKernelModules = [
    "qcserial"        # Can conflict with option driver
    "cdc_acm"         # Can interfere with modem detection
  ];
}