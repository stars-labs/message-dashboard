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

    deviceId = mkOption {
      type = types.str;
      default = "orange-pi-001";
      description = "Device ID for this daemon instance";
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

    logLevel = mkOption {
      type = types.enum [ "debug" "info" "warn" "err" ];
      default = "info";
      description = "Log level for the daemon (debug, info, warn, err)";
    };

    debugBuild = mkOption {
      type = types.bool;
      default = false;
      description = "Build the daemon in debug mode for verbose logging";
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
      defaultText = literalExpression "pkgs.sms-daemon";
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
        SMS_DEVICE_ID = cfg.deviceId;
        LOG_LEVEL = cfg.logLevel;
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
        curl          # For HTTP requests
        coreutils
        findutils
        gnugrep
        gnused
      ];
    };

    # Enable ModemManager and modem support
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

    # PolicyKit rules to allow sms-daemon user to manage ModemManager
    security.polkit.extraConfig = ''
      polkit.addRule(function(action, subject) {
        if (action.id.match("org.freedesktop.ModemManager1.") &&
            subject.user == "${cfg.user}") {
          return polkit.Result.YES;
        }
      });
    '';
  };
}