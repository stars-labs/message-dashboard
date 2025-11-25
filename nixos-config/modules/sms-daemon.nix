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
    enable = mkEnableOption "SMS Dashboard Daemon for collecting and uploading SMS messages from USB modems";

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
      home = "/var/lib/sms-dashboard";
      createHome = false; # Managed by systemd
      shell = "${pkgs.shadow}/bin/nologin"; # No shell access
      description = "SMS Dashboard Daemon User";
    };

    users.groups.${cfg.group} = {
      gid = null; # Let system assign
    };

    # Create working directory with strict permissions
    systemd.tmpfiles.rules = [
      "d /var/lib/sms-dashboard 0750 ${cfg.user} ${cfg.group} -"
      "d /var/lib/sms-dashboard/tmp 0700 ${cfg.user} ${cfg.group} -"
      "d /var/log/sms-dashboard 0750 ${cfg.user} ${cfg.group} -"
    ];

    # Hardened systemd service
    systemd.services.sms-daemon = {
      description = "SMS Dashboard Daemon";
      after = [
        "network-online.target"
        "ModemManager.service"
      ];
      wants = [ "network-online.target" ];
      requires = [ "ModemManager.service" ];
      wantedBy = [ "multi-user.target" ];

      environment = {
        SMS_API_URL = cfg.apiUrl;
        CHECK_INTERVAL_SECS = toString cfg.phoneUpdateIntervalSeconds;
        SMS_CHECK_INTERVAL = toString cfg.phoneUpdateIntervalSeconds;
        SMS_MESSAGE_CHECK_INTERVAL = toString cfg.messageCheckIntervalMs;
        SMS_SIGNAL_CHECK_INTERVAL = toString cfg.signalCheckIntervalSeconds;
        SMS_DEVICE_ID = cfg.deviceId;

        # Rust logging (info level by default, set to debug for verbose logs)
        RUST_LOG = if cfg.debugBuild then "orange_pi_daemon_rust=debug" else "orange_pi_daemon_rust=info";

        # Security: Don't expose sensitive paths
        HOME = "/var/lib/sms-dashboard";
        TMPDIR = "/var/lib/sms-dashboard/tmp";
      };

      # Use systemd credentials for API key (more secure than environment variables)
      serviceConfig = mkMerge [
        {
          Type = "simple";
          User = cfg.user;
          Group = cfg.group;

          # Restart configuration
          Restart = "on-failure";
          RestartSec = "10s";
          # RestartPreventExitStatus = "1";  # Only prevent restart on config errors
          StartLimitIntervalSec = "300";
          StartLimitBurst = "5";

          # Working directory
          WorkingDirectory = "/var/lib/sms-dashboard";

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
            "/var/lib/sms-dashboard"
            "/var/log/sms-dashboard"
          ];

          # Device access restrictions (only allow modem devices)
          # TODO: Test if PrivateDevices=true works with DeviceAllow whitelist
          PrivateDevices = true; # Currently need false for USB modem access
          DeviceAllow = [
            "char-usb_device rw" # USB character devices
            "/dev/ttyUSB* rw" # USB serial ports
            "/dev/cdc-wdm* rw" # CDC WDM devices for modems
            "/dev/bus/usb rw" # USB bus access
          ];
          DevicePolicy = "closed"; # Deny all other devices (only effective with PrivateDevices=true)

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
      preStart = ''
        # Verify ModemManager is running
        if ! systemctl is-active ModemManager.service >/dev/null 2>&1; then
          echo "Error: ModemManager is not running" >&2
          exit 1
        fi

        # Check for modems
        modem_count=$(mmcli -L 2>/dev/null | grep -c "Modem/" || echo "0")
        echo "Found $modem_count modem(s)"

        # Log service start
        logger -t sms-daemon "Starting SMS daemon with $modem_count modem(s)"
      '';

      # Post-stop cleanup
      postStop = ''
        # Log service stop
        logger -t sms-daemon "SMS daemon stopped"

        # Clean up any temporary files
        rm -rf /var/lib/sms-dashboard/tmp/*
      '';
    };

    # Enable ModemManager and modem support
    networking.modemmanager.enable = true;

  };
}
