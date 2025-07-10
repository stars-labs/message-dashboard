{ config, lib, pkgs, ... }:

with lib;

let
  cfg = config.services.sms-dashboard-daemon;
  
  sms-dashboard-daemon = pkgs.stdenv.mkDerivation rec {
    pname = "sms-dashboard-daemon";
    version = "0.1.0";
    
    src = ./.;
    
    nativeBuildInputs = with pkgs; [
      zig_0_11
    ];
    
    buildPhase = ''
      export HOME=$TMPDIR
      zig build -Doptimize=ReleaseSafe
    '';
    
    installPhase = ''
      mkdir -p $out/bin
      cp zig-out/bin/sms-dashboard-daemon $out/bin/
    '';
  };
in
{
  options.services.sms-dashboard-daemon = {
    enable = mkEnableOption "SMS Dashboard Daemon";
    
    apiUrl = mkOption {
      type = types.str;
      default = "https://sexy.qzz.io";
      description = "SMS Dashboard API URL";
    };
    
    apiKey = mkOption {
      type = types.nullOr types.str;
      default = null;
      description = "API key for authentication (not recommended, use apiKeyFile instead)";
    };
    
    apiKeyFile = mkOption {
      type = types.nullOr types.path;
      default = null;
      description = "Path to file containing the API key";
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
      description = "Group to run the daemon as (needs access to modems)";
    };
  };
  
  config = mkIf cfg.enable (mkMerge [
    {
      assertions = [
        {
          assertion = cfg.apiKey != null || cfg.apiKeyFile != null;
          message = "Either apiKey or apiKeyFile must be set for sms-dashboard-daemon";
        }
        {
          assertion = !(cfg.apiKey != null && cfg.apiKeyFile != null);
          message = "Only one of apiKey or apiKeyFile can be set for sms-dashboard-daemon";
        }
      ];
      
      # Create system user
      users.users.${cfg.user} = {
        isSystemUser = true;
        group = cfg.group;
        description = "SMS Dashboard Daemon user";
        extraGroups = [ "dialout" "networkmanager" ];
      };
      
      # Systemd service
      systemd.services.sms-dashboard-daemon = {
        description = "SMS Dashboard Daemon";
        wantedBy = [ "multi-user.target" ];
        after = [ "network-online.target" "ModemManager.service" ];
        wants = [ "network-online.target" ];
        requires = [ "ModemManager.service" ];
        
        environment = {
          SMS_API_URL = cfg.apiUrl;
          SMS_UPLOAD_INTERVAL = toString cfg.uploadInterval;
        } // (if cfg.apiKey != null then {
          SMS_API_KEY = cfg.apiKey;
        } else {});
        
        script = mkIf (cfg.apiKeyFile != null) ''
          export SMS_API_KEY="$(cat ${cfg.apiKeyFile})"
          exec ${sms-dashboard-daemon}/bin/sms-dashboard-daemon
        '';
        
        serviceConfig = {
          Type = "simple";
          ExecStart = mkIf (cfg.apiKey != null) "${sms-dashboard-daemon}/bin/sms-dashboard-daemon";
          Restart = "always";
          RestartSec = 10;
          User = cfg.user;
          Group = cfg.group;
          
          # Security hardening
          NoNewPrivileges = true;
          PrivateTmp = true;
          ProtectSystem = "strict";
          ProtectHome = true;
          ReadWritePaths = [ "/var/lib/sms-dashboard" ];
          
          # Logging
          StandardOutput = "journal";
          StandardError = "journal";
        };
      };
    }
    
      # Ensure ModemManager is enabled
      services.modemmanager.enable = true;
      
      # Create state directory
      systemd.tmpfiles.rules = [
        "d /var/lib/sms-dashboard 0700 ${cfg.user} ${cfg.group} -"
      ];
    }
  ]);
}