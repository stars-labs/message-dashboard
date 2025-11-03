# ModemManager batch detection for 87+ USB modems
# This module implements a workaround for ModemManager's inability to handle many modems at once
{ config, lib, pkgs, ... }:

let
  # Script to gradually detect modems in batches
  batchDetectionScript = pkgs.writeScript "modemmanager-batch-detect" ''
    #!${pkgs.bash}/bin/bash

    echo "ModemManager Batch Detection Starting..."

    # Wait for ModemManager to fully start
    sleep 10

    # Get initial count
    INITIAL=$(mmcli -L 2>/dev/null | wc -l || echo "0")
    echo "Initial detection: $INITIAL modems"

    # Perform multiple scan passes
    for i in {1..20}; do
        # Trigger a scan
        mmcli --scan-modems 2>/dev/null || true
        sleep 3

        # Check current count
        COUNT=$(mmcli -L 2>/dev/null | wc -l || echo "0")
        echo "Pass $i: $COUNT modems detected"

        # If we've detected most modems, stop
        if [ "$COUNT" -ge 80 ]; then
            echo "Successfully detected $COUNT modems"
            break
        fi

        # Wait between scans to allow processing
        sleep 5
    done

    FINAL=$(mmcli -L 2>/dev/null | wc -l || echo "0")
    echo "Final detection: $FINAL modems"

    # Log to systemd journal
    echo "ModemManager detected $FINAL modems" | systemd-cat -t modemmanager-batch
  '';
in
{
  # Override ModemManager service configuration
  systemd.services.ModemManager = {
    # Add post-start script for batch detection
    postStart = lib.mkAfter ''
      echo "Starting batch modem detection..."
      ${batchDetectionScript} &
    '';

    # Environment variables to help with detection
    environment = {
      MM_FILTER = "DEFAULT";
      # Reduce parallel probing to prevent overwhelming
      MM_MAX_PARALLEL_PROBES = "5";
    };

    # Increase startup timeout for many modems
    serviceConfig = {
      TimeoutStartSec = lib.mkForce "10min";
      # Restart on failure but with delay
      Restart = lib.mkDefault "on-failure";
      RestartSec = lib.mkForce "60s";  # Use longer delay for batch detection
    };
  };

  # Create a timer to periodically rescan for modems
  systemd.timers.modemmanager-rescan = {
    description = "Periodic ModemManager rescan for new modems";
    wantedBy = [ "timers.target" ];
    timerConfig = {
      OnBootSec = "5min";
      OnUnitActiveSec = "30min";
      Unit = "modemmanager-rescan.service";
    };
  };

  systemd.services.modemmanager-rescan = {
    description = "Rescan for USB modems";
    after = [ "ModemManager.service" ];
    requires = [ "ModemManager.service" ];

    serviceConfig = {
      Type = "oneshot";
      ExecStart = pkgs.writeScript "rescan-modems" ''
        #!${pkgs.bash}/bin/bash

        BEFORE=$(mmcli -L 2>/dev/null | wc -l || echo "0")

        # Perform 3 scan attempts
        for i in {1..3}; do
            mmcli --scan-modems 2>/dev/null || true
            sleep 5
        done

        AFTER=$(mmcli -L 2>/dev/null | wc -l || echo "0")

        if [ "$AFTER" -gt "$BEFORE" ]; then
            echo "Rescan found new modems: $BEFORE -> $AFTER"
        fi
      '';
    };
  };

  # Manual command to force detection
  environment.systemPackages = with pkgs; [
    (writeScriptBin "force-modem-detection" ''
      #!${bash}/bin/bash
      echo "Forcing modem detection..."

      for i in {1..10}; do
          echo "Scan attempt $i..."
          mmcli --scan-modems 2>/dev/null || true
          sleep 2
          COUNT=$(mmcli -L 2>/dev/null | wc -l || echo "0")
          echo "  Found: $COUNT modems"
      done

      echo "Final count: $(mmcli -L 2>/dev/null | wc -l || echo "0") modems"
    '')
  ];
}