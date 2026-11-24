{
  config,
  lib,
  pkgs,
  ...
}:

with lib;

let
  cfg = config.services.sms-daemon;
  voiceBridgeNeedsBindCap = cfg.voiceBridgeDomain != null && cfg.voiceBridgePort < 1024;
in
{
  options.services.sms-daemon = {
    enable = mkEnableOption "SMS Dashboard Daemon for collecting and uploading SMS messages from USB modems (uses direct AT commands with D-Bus fallback)";

    apiUrl = mkOption {
      type = types.str;
      default = "https://sexy.itoken.world";
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

    voiceBridgeDomain = mkOption {
      type = types.nullOr types.str;
      default = null;
      example = "voice-bridge.itoken.world";
      description = ''
        Public hostname of the voice bridge. When set, the daemon listens on
        TCP 443 for Cloudflare Realtime WebSocket adapters and obtains its own
        Let's Encrypt certificate over TLS-ALPN-01 on that port. The hostname
        must resolve directly (not proxied) to a public IP forwarded to 443.
      '';
    };

    voiceBridgePort = mkOption {
      type = types.port;
      default = 443;
      description = "Port the voice bridge listens on.";
    };

    voiceBridgeBehindProxy = mkOption {
      type = types.bool;
      default = false;
      description = ''
        Bind the voice bridge to localhost and expect a PROXY protocol v1
        header on every connection. Used when an nginx SNI router owns port
        443 and forwards `voiceBridgeDomain` here with `proxy_protocol on`,
        so the Cloudflare allowlist still sees the real source address.
      '';
    };

    user = mkOption {
      type = types.str;
      default = "sms-daemon";
      description = "User to run the daemon as";
    };

    group = mkOption {
      type = types.str;
      default = "sms-daemon";
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

    users.users.${cfg.user} = {
      isSystemUser = true;
      group = cfg.group;
      extraGroups = [ "dialout" ];
      home = "/var/lib/sms-daemon";
      createHome = false;
      shell = "${pkgs.shadow}/bin/nologin";
      description = "SMS Dashboard Daemon User";
    };

    users.groups.${cfg.group} = {
      gid = null;
    };

    systemd.tmpfiles.rules = [
      "d /var/lib/sms-daemon 0750 ${cfg.user} ${cfg.group} -"
      "d /var/lib/sms-daemon/tmp 0700 ${cfg.user} ${cfg.group} -"
      "d /var/log/sms-daemon 0750 ${cfg.user} ${cfg.group} -"
      "d /var/lib/sms-daemon/acme 0700 ${cfg.user} ${cfg.group} -"
    ];

    systemd.services.sms-daemon = {
      description =
        if cfg.useDBus then
          "SMS Dashboard Daemon (D-Bus/ModemManager mode)"
        else
          "SMS Dashboard Daemon (Direct AT commands mode)";
      after = [ "network-online.target" ] ++ (if cfg.useDBus then [ "ModemManager.service" ] else [ ]);
      wants = [ "network-online.target" ] ++ (if cfg.useDBus then [ "ModemManager.service" ] else [ ]);
      requires = if cfg.useDBus then [ "ModemManager.service" ] else [ ];
      wantedBy = [ "multi-user.target" ];

      # systemd reads start limits from [Unit]; NixOS renders these top-level options there.
      startLimitIntervalSec = 300;
      startLimitBurst = 5;

      environment = {
        SMS_API_URL = cfg.apiUrl;
        CHECK_INTERVAL_SECS = toString cfg.phoneUpdateIntervalSeconds;
        SMS_CHECK_INTERVAL = toString cfg.phoneUpdateIntervalSeconds;
        SMS_MESSAGE_CHECK_INTERVAL = toString cfg.messageCheckIntervalMs;
        SMS_SIGNAL_CHECK_INTERVAL = toString cfg.signalCheckIntervalSeconds;
        SMS_DEVICE_ID = cfg.deviceId;

        USE_DBUS = if cfg.useDBus then "1" else "0";

        RUST_LOG = if cfg.debugBuild then "orange_pi_daemon_rust=debug" else "orange_pi_daemon_rust=info";

        HOME = "/var/lib/sms-daemon";
        TMPDIR = "/var/lib/sms-daemon/tmp";
      }
      // optionalAttrs (cfg.voiceBridgeDomain != null) {
        VOICE_BRIDGE_DOMAIN = cfg.voiceBridgeDomain;
        VOICE_BRIDGE_ACME_DIR = "/var/lib/sms-daemon/acme";
        VOICE_BRIDGE_PORT = toString cfg.voiceBridgePort;
        VOICE_BRIDGE_LISTEN = if cfg.voiceBridgeBehindProxy then "127.0.0.1" else "0.0.0.0";
        VOICE_BRIDGE_PROXY_PROTOCOL = if cfg.voiceBridgeBehindProxy then "1" else "0";
      };

      serviceConfig = mkMerge [
        {
          Type = "simple";
          User = cfg.user;
          Group = cfg.group;

          # The daemon sometimes exits cleanly after a SIGHUP and must come back.
          Restart = "always";
          RestartSec = "10s";
          # preStart waits up to 180s for USB enumeration; the start timeout must exceed it.
          TimeoutStartSec = "300s";

          WorkingDirectory = "/var/lib/sms-daemon";

          # tracing-journald writes structured events itself; stderr is for panics only.
          StandardOutput = "null";
          StandardError = "journal";
          SyslogLevel = "err";
          SyslogIdentifier = "sms-daemon";

          ProtectSystem = "strict";
          ProtectHome = true;
          PrivateTmp = true;
          ProtectProc = "invisible";
          ProcSubset = "pid";

          ReadWritePaths = [
            "/var/lib/sms-daemon"
            "/var/log/sms-daemon"
          ];

          # DeviceAllow has no path wildcards, so /dev/ttyUSB* access comes from
          # the dialout group under an open device policy.
          PrivateDevices = false;
          DevicePolicy = "auto";

          PrivateNetwork = false;
          RestrictAddressFamilies = "AF_INET AF_INET6 AF_UNIX";
          IPAccounting = true;
          IPAddressAllow = [
            "10.171.150.0/24"
            "8.8.8.8/32"
            "8.8.4.4/32"
          ];

          MemoryMax = "2G";
          MemorySwapMax = "1G";
          CPUQuota = "400%";
          TasksMax = 512;

          LimitNOFILE = 65536;
          LimitNPROC = 512;
          LimitCORE = 0;

          LimitAS = "4G";
          LimitDATA = "3G";
          LimitSTACK = "16M";

          NoNewPrivileges = true;
          CapabilityBoundingSet = [
            "CAP_NET_RAW"
          ]
          ++ optional voiceBridgeNeedsBindCap "CAP_NET_BIND_SERVICE";
          # Only a privileged port needs the capability; behind the SNI router
          # the bridge sits on 8443 and does without it.
          AmbientCapabilities = optional voiceBridgeNeedsBindCap "CAP_NET_BIND_SERVICE";

          ProtectKernelTunables = true;
          ProtectKernelModules = true;
          ProtectKernelLogs = true;
          ProtectControlGroups = true;
          ProtectClock = true;
          ProtectHostname = true;

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

          PrivateUsers = false;
          PrivateMounts = true;
          MountAPIVFS = true;

          RestrictRealtime = true;
          RestrictSUIDSGID = true;
          RemoveIPC = true;
          LockPersonality = true;
          RestrictNamespaces = true;
          MemoryDenyWriteExecute = true;

          ExecPaths = [
            "/nix/store"
          ];
          NoExecPaths = [
            "/var"
            "/tmp"
            "/home"
          ];

          PrivateIPC = true;
          KeyringMode = "private";
          UMask = "0077";

          NotifyAccess = "main";
        }

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
              Environment = "SMS_API_KEY=${cfg.apiKey}";
              ExecStart = "${cfg.package}/bin/sms-daemon";
            }
        )
      ];

      path = with pkgs; [
        modemmanager
        coreutils
        findutils
        gnugrep
        gnused
        systemd
        util-linux
      ];

      preStart =
        if cfg.useDBus then
          ''
            # D-Bus mode: verify ModemManager is running
            if ! systemctl is-active ModemManager.service >/dev/null 2>&1; then
              echo "Error: ModemManager is not running (required for D-Bus mode)" >&2
              exit 1
            fi
            modem_count=$(mmcli -L 2>/dev/null | grep -c "Modem/" || echo "0")
            echo "ModemManager mode: $modem_count modem(s) detected"
            logger -t sms-daemon "Starting SMS daemon (D-Bus mode: $modem_count modems)"
          ''
        else
          ''
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

      postStop = ''
        # Log service stop
        logger -t sms-daemon "SMS daemon stopped"

        # Clean up any temporary files
        rm -rf /var/lib/sms-daemon/tmp/*
      '';
    };

    networking.modemmanager.enable = cfg.useDBus;

    # Lets the dialout daemon issue USBDEVFS_RESET on Quectel (vendor 2c7c) device
    # nodes to recover wedged modems, without opening other USB devices.
    services.udev.extraRules = mkIf (!cfg.useDBus) ''
      SUBSYSTEM=="usb", ENV{DEVTYPE}=="usb_device", ATTR{idVendor}=="2c7c", GROUP="dialout", MODE="0664"
    '';

  };
}
