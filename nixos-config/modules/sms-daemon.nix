{ config, lib, pkgs, ... }:

with lib;

let
  cfg = config.services.sms-daemon;
in {
  options.services.sms-daemon = {
    enable = mkEnableOption "SMS Dashboard Daemon";

    apiUrl = mkOption {
      type = types.str;
      default = "https://sexy.qzz.io";
      description = "API URL for the SMS dashboard server";
    };

    apiKey = mkOption {
      type = types.nullOr types.str;
      default = null;
      description = "API key for authentication (not recommended, use apiKeyFile)";
    };

    apiKeyFile = mkOption {
      type = types.nullOr types.path;
      default = null;
      description = "Path to file containing API key";
    };

    uploadInterval = mkOption {
      type = types.int;
      default = 60;
      description = "Upload interval in seconds";
    };

    user = mkOption {
      type = types.str;
      default = "sms-daemon";
      description = "User to run the daemon as";
    };

    group = mkOption {
      type = types.str;
      default = "dialout";
      description = "Group to run the daemon as";
    };

    package = mkOption {
      type = types.package;
      description = "SMS daemon package";
    };
  };

  config = mkIf cfg.enable {
    # Create user and group
    users.users.${cfg.user} = {
      isSystemUser = true;
      group = cfg.group;
      extraGroups = [ "dialout" ];
    };

    users.groups.${cfg.group} = {};

    # Create working directory
    systemd.tmpfiles.rules = [
      "d /var/lib/sms-dashboard 0750 ${cfg.user} ${cfg.group} -"
    ];

    # Systemd service
    systemd.services.sms-daemon = {
      description = "SMS Dashboard Daemon";
      after = [ "network-online.target" "ModemManager.service" ];
      wants = [ "network-online.target" ];
      requires = [ "ModemManager.service" ];
      wantedBy = [ "multi-user.target" ];

      environment = {
        SMS_API_URL = cfg.apiUrl;
        SMS_UPLOAD_INTERVAL = toString cfg.uploadInterval;
      };

      script = ''
        ${optionalString (cfg.apiKeyFile != null) ''
          export SMS_API_KEY="$(cat ${cfg.apiKeyFile})"
        ''}
        ${optionalString (cfg.apiKey != null) ''
          export SMS_API_KEY="${cfg.apiKey}"
        ''}
        exec ${cfg.package}/bin/sms-daemon
      '';

      serviceConfig = {
        Type = "simple";
        User = cfg.user;
        Group = cfg.group;
        Restart = "always";
        RestartSec = "10";
        WorkingDirectory = "/var/lib/sms-dashboard";
        
        # Security settings
        NoNewPrivileges = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        PrivateTmp = true;
        ReadWritePaths = [ "/var/lib/sms-dashboard" ];
      };

      # Include necessary tools in PATH
      path = with pkgs; [
        modemmanager  # Provides mmcli
        coreutils
        findutils
        gnugrep
        gnused
      ];
    };

    # Enable ModemManager
    networking.modemmanager.enable = true;
  };
}