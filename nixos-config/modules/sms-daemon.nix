{
  config,
  lib,
  pkgs,
  ...
}:

with lib;

let
  cfg = config.services.sms-daemon;
in
{
  options.services.sms-daemon = {
    enable = mkEnableOption "SMS Dashboard Daemon for collecting and uploading SMS messages from USB modems (uses direct AT commands with D-Bus fallback)";

    apiUrl = mkOption {
      type = types.str;
      default = "https://sexy.qzz.io";
      description = "API URL for the SMS dashboard server";
    };

    deviceId = mkOption {
      type = types.str;
      default = "orange-pi-001";
      description = "Device ID for this daemon instance";
    };

    apiKey = mkOption {
      type = types.nullOr types.str;
      default = null;
      description = "API key for authentication (not recommended, use apiKeyFile)";
      # Mark as internal to discourage use
      internal = true;
    };

    apiKeyFile = mkOption {
      type = types.nullOr types.path;
      default = null;
      description = "Path to file containing API key (recommended)";
    };

    phoneUpdateIntervalSeconds = mkOption {
      type = types.int;
      default = 30;
      description = ''
        How often to update phone status (in seconds).
        Default: 30 seconds
      '';
    };

    messageCheckIntervalMs = mkOption {
      type = types.int;
      default = 100;
      description = ''
        How often to check for new messages (in milliseconds).
        Default: 100ms (10 Hz)
      '';
    };

    signalCheckIntervalSeconds = mkOption {
      type = types.int;
      default = 60;
      description = ''
        How often to check signal quality (in seconds).
        Default: 60 seconds (1 minute)
      '';
    };

    debugBuild = mkOption {
      type = types.bool;
      default = false;
      description = "Use debug build with verbose logging (otherwise uses release build with info level logging)";
    };

    useDBus = mkOption {
      type = types.bool;
      default = false;
      description = ''
        Use D-Bus/ModemManager backend instead of direct AT commands.
        When false (default): Uses direct AT commands, ModemManager is disabled.
        When true: Uses D-Bus/ModemManager (legacy mode).
      '';
    };

    user = mkOption {
      type = types.str;
      default = "sms-daemon";
      description = "User to run the daemon as";
    };

    group = mkOption {
      type = types.str;
      default = "sms-daemon"; # Use dedicated group instead of dialout
      description = "Group to run the daemon as";
    };

    package = mkOption {
      type = types.package;
      description = "SMS daemon package";
      defaultText = literalExpression "pkgs.sms-daemon";
    };
  };

  config = mkIf cfg.enable {
    assertions = [
      {
        assertion = cfg.apiKeyFile != null || cfg.apiKey != null;
        message = "Either apiKeyFile or apiKey must be set for sms-daemon";
      }
      {
        assertion = !(cfg.apiKeyFile != null && cfg.apiKey != null);
        message = "Only one of apiKeyFile or apiKey should be set, not both";
      }
    ];

    # Create dedicated user and group with minimal privileges
    users.users.${cfg.user} = {
      isSystemUser = true;
      group = cfg.group;
      # Only add to dialout for modem access, nothing else
      extraGroups = [ "dialout" ];
      home = "/var/lib/sms-daemon";
      createHome = false; # Managed by systemd
      shell = "${pkgs.shadow}/bin/nologin"; # No shell access
      description = "SMS Dashboard Daemon User";
    };

    users.groups.${cfg.group} = {
      gid = null; # Let system assign
    };

    # Create working directory with strict permissions
    systemd.tmpfiles.rules = [
      "d /var/lib/sms-daemon 0750 ${cfg.user} ${cfg.group} -"
      "d /var/lib/sms-daemon/tmp 0700 ${cfg.user} ${cfg.group} -"
      "d /var/log/sms-daemon 0750 ${cfg.user} ${cfg.group} -"
    ];

    # Hardened systemd service
    systemd.services.sms-daemon = {
      description = if cfg.useDBus
        then "SMS Dashboard Daemon (D-Bus/ModemManager mode)"
        else "SMS Dashboard Daemon (Direct AT commands mode)";
      after = [ "network-online.target" ] ++ (if cfg.useDBus then [ "ModemManager.service" ] else []);
      wants = [ "network-online.target" ] ++ (if cfg.useDBus then [ "ModemManager.service" ] else []);
      requires = if cfg.useDBus then [ "ModemManager.service" ] else [];
      wantedBy = [ "multi-user.target" ];

      # Limit repeated starts at the unit level. systemd ignores these keys in
      # [Service], while NixOS renders these top-level options into [Unit].
      startLimitIntervalSec = 300;
      startLimitBurst = 5;

      environment = {
        SMS_API_URL = cfg.apiUrl;
        CHECK_INTERVAL_SECS = toString cfg.phoneUpdateIntervalSeconds;
        SMS_CHECK_INTERVAL = toString cfg.phoneUpdateIntervalSeconds;
        SMS_MESSAGE_CHECK_INTERVAL = toString cfg.messageCheckIntervalMs;
        SMS_SIGNAL_CHECK_INTERVAL = toString cfg.signalCheckIntervalSeconds;
        SMS_DEVICE_ID = cfg.deviceId;

        # Backend selection: AT commands (default) or D-Bus
        # USE_DBUS=1 forces D-Bus/ModemManager as primary backend
        USE_DBUS = if cfg.useDBus then "1" else "0";

        # Rust logging (info level by default, set to debug for verbose logs)
        RUST_LOG = if cfg.debugBuild then "orange_pi_daemon_rust=debug" else "orange_pi_daemon_rust=info";

        # Security: Don't expose sensitive paths
        HOME = "/var/lib/sms-daemon";
        TMPDIR = "/var/lib/sms-daemon/tmp";
      };

      # Use systemd credentials for API key (more secure than environment variables)
      serviceConfig = mkMerge [
        {
          Type = "simple";
          User = cfg.user;
          Group = cfg.group;

          # Restart configuration
          # Always restart: the daemon sometimes exits cleanly after a SIGHUP;
          # we want systemd to bring it back up regardless of exit code.
          Restart = "always";
          RestartSec = "10s";
          # RestartPreventExitStatus = "1";  # Only prevent restart on config errors
          # preStart waits up to max_wait=180s for USB enumeration to settle;
          # raise the start timeout above that so systemd doesn't abort it.
          TimeoutStartSec = "300s";

          # Working directory
          WorkingDirectory = "/var/lib/sms-daemon";

          # Logging
          StandardOutput = "journal";
          StandardError = "journal";
          SyslogLevel = if cfg.debugBuild then "debug" else "info";
          SyslogIdentifier = "sms-daemon";

          # ==========================================================
          # SECURITY HARDENING
          # ==========================================================

          # Filesystem protections
          ProtectSystem = "strict";
          ProtectHome = true;
          PrivateTmp = true;
          ProtectProc = "invisible";
          ProcSubset = "pid";

          # Only allow access to specific paths
          ReadWritePaths = [
            "/var/lib/sms-daemon"
            "/var/log/sms-daemon"
          ];

          # Device access restrictions (only allow modem devices)
          # PrivateDevices=false required for USB modem access
          # DeviceAllow whitelist only works when PrivateDevices=false
          PrivateDevices = false; # Required for /dev/ttyUSB* access
          # DeviceAllow doesn't support path wildcards - use auto policy for USB serial access
          # The dialout group membership provides the actual permission
          DevicePolicy = "auto"; # Required for dynamic USB serial port access

          # Network restrictions
          PrivateNetwork = false; # Need network for API
          RestrictAddressFamilies = "AF_INET AF_INET6 AF_UNIX";
          IPAccounting = true;
          IPAddressAllow = [
            "10.171.150.0/24" # Local network
            "8.8.8.8/32" # DNS
            "8.8.4.4/32" # DNS
            # Add API server IP if known
          ];

          # Resource limits - Increased for 100 modems
          MemoryMax = "2G"; # Increased from 512M to 2G for 100 modems
          MemorySwapMax = "1G"; # Allow some swap for peak usage
          CPUQuota = "400%"; # Max 4 cores for parallel processing
          TasksMax = 512; # Increased to handle 100+ modems + worker threads

          # File descriptor limits - Increased for many USB devices
          LimitNOFILE = 65536; # Increased for 100 modems (each needs multiple FDs)
          LimitNPROC = 512; # Process limit - increased to match TasksMax
          LimitCORE = 0; # No core dumps (may contain sensitive data)

          # Address space limits - Important for memory management
          LimitAS = "4G"; # Total address space limit
          LimitDATA = "3G"; # Data segment limit
          LimitSTACK = "16M"; # Stack size per thread

          # Capability restrictions
          NoNewPrivileges = true;
          CapabilityBoundingSet = [
            "CAP_NET_RAW" # For network operations
          ];
          AmbientCapabilities = [ ];

          # Kernel protections
          ProtectKernelTunables = true;
          ProtectKernelModules = true;
          ProtectKernelLogs = true;
          ProtectControlGroups = true;
          ProtectClock = true;
          ProtectHostname = true;

          # System call filtering
          SystemCallFilter = [
            "@system-service"
            "~@privileged"
            "~@resources"
            "~@mount"
            "~@reboot"
            "~@swap"
            "~@debug"
            "~@obsolete"
            "~@cpu-emulation"
          ];
          SystemCallErrorNumber = "EPERM";
          SystemCallArchitectures = "native";

          # Namespacing
          PrivateUsers = false; # Need access to dialout group
          PrivateMounts = true;
          MountAPIVFS = true;

          # Misc security
          RestrictRealtime = true;
          RestrictSUIDSGID = true;
          RemoveIPC = true;
          LockPersonality = true;
          RestrictNamespaces = true;
          MemoryDenyWriteExecute = true;

          # Execution restrictions
          ExecPaths = [
            "/nix/store" # Only allow Nix store executables
          ];
          NoExecPaths = [
            "/var"
            "/tmp"
            "/home"
          ];

          # Additional sandboxing
          PrivateIPC = true;
          KeyringMode = "private";
          UMask = "0077";

          # Notification (for monitoring)
          NotifyAccess = "main";
          # WATCHDOG DISABLED - it was causing more problems than solving
          # The daemon runs stable and doesn't need watchdog supervision
          # WatchdogSec = "0";  # 0 = disabled
        }

        # Handle API key loading securely
        (
          if cfg.apiKeyFile != null then
            {
              LoadCredential = "api-key:${cfg.apiKeyFile}";
              ExecStart = pkgs.writeShellScript "sms-daemon-start" ''
                # Read API key from systemd credential
                if [ -f "$CREDENTIALS_DIRECTORY/api-key" ]; then
                  export SMS_API_KEY="$(cat "$CREDENTIALS_DIRECTORY/api-key" | tr -d '\n')"
                else
                  echo "Error: API key credential not found" >&2
                  exit 1
                fi

                # Validate API key format (example: must be 32+ chars)
                if [ ''${#SMS_API_KEY} -lt 32 ]; then
                  echo "Error: API key appears to be invalid (too short)" >&2
                  exit 1
                fi

                exec ${cfg.package}/bin/sms-daemon
              '';
            }
          else
            {
              # Fallback to environment variable (less secure)
              Environment = "SMS_API_KEY=${cfg.apiKey}";
              ExecStart = "${cfg.package}/bin/sms-daemon";
            }
        )
      ];

      # Include necessary tools in PATH
      path = with pkgs; [
        modemmanager # Provides mmcli
        coreutils
        findutils
        gnugrep
        gnused
        systemd # For busctl
        util-linux # For logger command in preStart/postStop
      ];

      # Pre-start checks
      preStart = if cfg.useDBus then ''
        # D-Bus mode: verify ModemManager is running
        if ! systemctl is-active ModemManager.service >/dev/null 2>&1; then
          echo "Error: ModemManager is not running (required for D-Bus mode)" >&2
          exit 1
        fi
        modem_count=$(mmcli -L 2>/dev/null | grep -c "Modem/" || echo "0")
        echo "ModemManager mode: $modem_count modem(s) detected"
        logger -t sms-daemon "Starting SMS daemon (D-Bus mode: $modem_count modems)"
      '' else ''
        # AT command mode: wait for USB enumeration to settle before starting.
        #
        # The daemon builds its modem cache ONCE at startup. On boot (or after a
        # USB topology change) the kernel keeps enumerating ttyUSB ports for tens
        # of seconds; starting before that finishes freezes the cache at a low
        # count (observed: 10 instead of 60). We poll until the port count stays
        # unchanged for several consecutive checks, with a hard timeout fallback.
        poll_interval=5      # seconds between polls
        settle_target=4      # consecutive stable polls required (~20s steady)
        max_wait=180         # hard cap so boot never hangs
        last=-1
        stable=0
        elapsed=0
        while [ "$elapsed" -lt "$max_wait" ]; do
          count=$(ls /dev/ttyUSB* 2>/dev/null | wc -l)
          if [ "$count" -gt 0 ] && [ "$count" -eq "$last" ]; then
            stable=$((stable + 1))
          else
            stable=0
          fi
          last=$count
          [ "$stable" -ge "$settle_target" ] && break
          sleep "$poll_interval"
          elapsed=$((elapsed + poll_interval))
        done
        usb_ports=$last
        at_ports=$((usb_ports / 4))  # Each modem exposes ~4 ports
        echo "AT command mode: USB settled at $usb_ports ports ($at_ports modems) after ''${elapsed}s"
        logger -t sms-daemon "Starting SMS daemon (AT mode: $at_ports modems, USB settled in ''${elapsed}s)"
      '';

      # Post-stop cleanup
      postStop = ''
        # Log service stop
        logger -t sms-daemon "SMS daemon stopped"

        # Clean up any temporary files
        rm -rf /var/lib/sms-daemon/tmp/*
      '';
    };

    # ModemManager: only enable in D-Bus mode
    # In AT command mode, ModemManager is disabled for better performance
    networking.modemmanager.enable = cfg.useDBus;

    # Allow the daemon (member of the dialout group) to issue USBDEVFS_RESET on the
    # Quectel modem USB device nodes (/dev/bus/usb/BBB/DDD). This backs the active
    # USB-reset recovery for wedged modems. Scoped to vendor 2c7c (Quectel) so we
    # don't broaden write access to unrelated USB devices.
    services.udev.extraRules = mkIf (!cfg.useDBus) ''
      SUBSYSTEM=="usb", ENV{DEVTYPE}=="usb_device", ATTR{idVendor}=="2c7c", GROUP="dialout", MODE="0664"
    '';

  };
}
