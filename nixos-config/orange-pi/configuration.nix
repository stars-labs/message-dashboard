# Hardened NixOS configuration for Orange Pi with SMS Dashboard
# This configuration implements security best practices from the security audit
{
  config,
  pkgs,
  lib,
  ...
}:

{
  imports = [
    # Include hardware configuration (generate with nixos-generate-config)
    ./hardware-configuration.nix

    # Include SMS daemon module
    ../modules/sms-daemon.nix
  ];


  # System identification
  networking.hostName = "orange-pi-sms";
  
  # =============================================================================
  # NETWORK SECURITY
  # =============================================================================
  
  # Static IP configuration (more secure than DHCP)
  networking.interfaces = {
    enP3p49s0 = {
      useDHCP = false;
      ipv4.addresses = [
        {
          address = "10.171.150.102";
          prefixLength = 24;
        }
      ];
    };
  };

  networking.defaultGateway = "10.171.150.1";
  networking.nameservers = [
    "8.8.8.8"
    "8.8.4.4"
  ];

  # Modern nftables firewall configuration
  networking.firewall.enable = false;  # Disable legacy iptables firewall
  networking.nftables = {
    enable = true;
    ruleset = ''
      table inet filter {
        chain input {
          type filter hook input priority filter; policy drop;
          
          # Allow loopback traffic
          iif lo accept
          
          # Allow established and related connections
          ct state established,related accept
          
          # Drop invalid packets
          ct state invalid drop
          
          # Rate limit SSH connections (4 per minute per IP)
          tcp dport 22 ct state new limit rate 4/minute accept
          
          # Log dropped packets with rate limiting
          limit rate 5/minute log prefix "NFT-DROP: "
          
          # Drop everything else
          drop
        }
        
        chain forward {
          type filter hook forward priority filter; policy drop;
        }
        
        chain output {
          type filter hook output priority filter; policy accept;
        }
      }
    '';
  };

  # =============================================================================
  # SSH HARDENING
  # =============================================================================
  
  # Hardened SSH configuration
  services.openssh = {
    enable = true;
    ports = [ 22 ];  # Standard SSH port (security through obscurity is ineffective)
    settings = {
      PasswordAuthentication = false;
      KbdInteractiveAuthentication = false;
      PermitRootLogin = "prohibit-password";  # Allow root login with keys only (needed for nixos-rebuild)
      AllowUsers = [ "htx" "root" ];  # Allow htx and root users
      MaxAuthTries = 3;
      MaxSessions = 2;
      ClientAliveInterval = 300;
      ClientAliveCountMax = 2;
      X11Forwarding = false;
      PermitTunnel = "no";
      AllowAgentForwarding = false;
      AllowStreamLocalForwarding = false;
      AllowTcpForwarding = false;
      AuthenticationMethods = "publickey";
      PubkeyAuthentication = true;
      UsePAM = true;
      PrintMotd = false;
      PrintLastLog = true;
      TCPKeepAlive = false;
      Compression = false;
      UseDNS = false;
      StrictModes = true;
      IgnoreRhosts = true;
      HostbasedAuthentication = false;
    };
    
    # SSH host key algorithms (prefer ed25519)
    hostKeys = [
      {
        path = "/etc/ssh/ssh_host_ed25519_key";
        type = "ed25519";
      }
    ];
    
    # Banner warning
    extraConfig = ''
      Banner /etc/ssh/banner
      
      # Only allow specific key types
      HostKeyAlgorithms ssh-ed25519,rsa-sha2-512,rsa-sha2-256
      
      # Strong ciphers only
      Ciphers chacha20-poly1305@openssh.com,aes256-gcm@openssh.com,aes128-gcm@openssh.com
      
      # Strong MACs only
      MACs hmac-sha2-512-etm@openssh.com,hmac-sha2-256-etm@openssh.com
      
      # Strong key exchange algorithms
      KexAlgorithms curve25519-sha256,curve25519-sha256@libssh.org
    '';
  };
  
  # SSH banner warning
  environment.etc."ssh/banner".text = ''
    ********************************************************************
    *                                                                  *
    * Unauthorized access to this system is strictly prohibited.      *
    * All access attempts are logged and monitored.                   *
    * Violators will be prosecuted to the fullest extent of the law. *
    *                                                                  *
    ********************************************************************
  '';

  # Fail2ban for brute force protection
  services.fail2ban = {
    enable = true;
    maxretry = 3;
    bantime = "1h";
    bantime-increment = {
      enable = true;
      factor = "2";
      maxtime = "24h";
    };
    
    jails = {
      sshd = {
        settings = {
          enabled = true;
          port = "22";
          filter = "sshd[mode=aggressive]";
          maxretry = 3;
          findtime = "10m";
          bantime = "1h";
        };
      };
    };
  };

  # =============================================================================
  # USER AND PRIVILEGE MANAGEMENT
  # =============================================================================
  
  # Create user for management with restricted privileges
  users.users.htx = {
    isNormalUser = true;
    description = "HTX User";
    extraGroups = [
      "networkmanager"
      "wheel"
      "dialout"
    ];
    hashedPasswordFile = config.sops.secrets."sms-dashboard/user-passwords/htx-hash".path;
    openssh.authorizedKeys.keys = [
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFhTqqOg4U3juVuxFgHt9cq2Opy+XVHLQahORdA56z6F openpgp:0x0383A3C3"
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIG+YTPvO562Xqi0ATf38QtdtE9qXWyh/9a74cSxj+4z6 cardno:32_087_457"
    ];
    
    # Set shell timeout
    shell = pkgs.bashInteractive;
  };
  
  # Configure root user for nixos-rebuild (with SOPS password hash)
  users.users.root = {
    hashedPasswordFile = config.sops.secrets."sms-dashboard/user-passwords/root-hash".path;
    openssh.authorizedKeys.keys = [
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFhTqqOg4U3juVuxFgHt9cq2Opy+XVHLQahORdA56z6F openpgp:0x0383A3C3"
    ];
  };

  # Sudo configuration with restrictions
  security.sudo = {
    enable = true;
    wheelNeedsPassword = true;  # Always require password for sudo
    execWheelOnly = true;  # Only wheel group can use sudo
    
    extraConfig = ''
      # Limit sudo commands for htx user
      htx ALL=(ALL) /run/current-system/sw/bin/systemctl restart sms-daemon
      htx ALL=(ALL) /run/current-system/sw/bin/systemctl stop sms-daemon
      htx ALL=(ALL) /run/current-system/sw/bin/systemctl start sms-daemon
      htx ALL=(ALL) /run/current-system/sw/bin/systemctl status sms-daemon
      htx ALL=(ALL) NOPASSWD: /run/current-system/sw/bin/journalctl
      
      # Security settings
      Defaults timestamp_timeout=5
      Defaults lecture=always
      Defaults requiretty
      Defaults use_pty
      Defaults logfile="/var/log/sudo.log"
      Defaults log_input
      Defaults log_output
      Defaults passwd_tries=3
      Defaults insults=false
      Defaults mail_badpass
      Defaults mail_no_user
      
      # Environment restrictions
      Defaults env_reset
      Defaults env_keep="COLORS DISPLAY HOSTNAME HISTSIZE LS_COLORS"
      Defaults secure_path="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
    '';
  };

  # =============================================================================
  # BOOT SECURITY
  # =============================================================================
  
  boot = {
    # Use hardened kernel packages for enhanced security
    kernelPackages = lib.mkForce pkgs.linuxPackages_hardened;
    
    # Lanzaboote secure boot configuration (maintain original setup)
    lanzaboote = {
      enable = true;
      pkiBundle = "/var/lib/sbctl";
    };
    
    # Boot loader configuration
    loader = {
      systemd-boot.enable = lib.mkForce false;  # Disabled for Lanzaboote
      efi = {
        canTouchEfiVariables = true;
        efiSysMountPoint = "/boot";
      };
      timeout = 1;  # Minimal timeout to prevent boot delay attacks
    };
    
    # Kernel parameters for security hardening
    kernelParams = [
      "init_on_alloc=1"
      "init_on_free=1"
      "page_alloc.shuffle=1"
      "randomize_kstack_offset=1"
      "slab_nomerge"
      "vsyscall=none"
      "debugfs=off"
      "oops=panic"
      "quiet"
      "loglevel=3"
      "rd.systemd.show_status=false"
      "rd.udev.log_level=3"
      "vt.global_cursor_default=0"
    ];
    
    # Kernel sysctl hardening
    kernel.sysctl = {
      # Network hardening
      "net.ipv4.conf.all.rp_filter" = 1;
      "net.ipv4.conf.default.rp_filter" = 1;
      "net.ipv4.conf.all.accept_source_route" = 0;
      "net.ipv6.conf.all.accept_source_route" = 0;
      "net.ipv4.conf.all.send_redirects" = 0;
      "net.ipv4.conf.all.accept_redirects" = 0;
      "net.ipv6.conf.all.accept_redirects" = 0;
      "net.ipv4.icmp_echo_ignore_broadcasts" = 1;
      "net.ipv4.icmp_ignore_bogus_error_responses" = 1;
      "net.ipv4.tcp_syncookies" = 1;
      "net.ipv4.conf.all.log_martians" = 1;
      "net.ipv4.conf.default.log_martians" = 1;
      "net.ipv4.tcp_timestamps" = 0;
      "net.ipv4.tcp_rfc1337" = 1;
      "net.ipv6.conf.all.use_tempaddr" = 2;
      "net.ipv6.conf.default.use_tempaddr" = 2;
      
      # File system hardening
      "fs.protected_hardlinks" = 1;
      "fs.protected_symlinks" = 1;
      "fs.protected_regular" = 2;
      "fs.protected_fifos" = 2;
      "fs.suid_dumpable" = 0;
      
      # Kernel hardening
      "kernel.randomize_va_space" = 2;
      "kernel.panic_on_oops" = 1;
      "kernel.yama.ptrace_scope" = 2;
      "kernel.unprivileged_bpf_disabled" = 1;
      "kernel.kptr_restrict" = 2;
      "kernel.dmesg_restrict" = 1;
      "kernel.unprivileged_userns_clone" = 0;
      "kernel.sysrq" = 0;
      "kernel.core_uses_pid" = 1;
      "kernel.kexec_load_disabled" = 1;
      "kernel.modules_disabled" = 0;  # Set to 1 after boot if no modules needed
      "kernel.perf_event_paranoid" = 3;
      
      # Process hardening
      "kernel.pid_max" = 65536;
      "vm.mmap_min_addr" = 65536;
      "vm.unprivileged_userfaultfd" = 0;
    };
    
    # Blacklist unnecessary kernel modules
    blacklistedKernelModules = [
      # Network protocols
      "dccp"
      "sctp"
      "rds"
      "tipc"
      
      # Filesystems
      "cramfs"
      "freevxfs"
      "jffs2"
      "hfs"
      "hfsplus"
      "udf"
      
      # Hardware
      "bluetooth"
      "btusb"
      "firewire-core"
      "thunderbolt"
      
      # Others
      "vivid"
      "uvcvideo"  # Webcam - remove if needed
    ];
  };

  # =============================================================================
  # SYSTEM SECURITY
  # =============================================================================
  
  security = {
    # Polkit settings
    polkit.enable = true;
    
    # AppArmor
    apparmor = {
      enable = true;
      killUnconfinedConfinables = true;
    };
    
    # Audit framework
    auditd.enable = true;
    audit = {
      enable = true;
      rules = [
        "-w /etc/passwd -p wa -k passwd_changes"
        "-w /etc/group -p wa -k group_changes"
        "-w /etc/shadow -p wa -k shadow_changes"
        "-w /etc/sudoers -p wa -k sudoers_changes"
        "-w /etc/ssh/sshd_config -p wa -k sshd_config_changes"
        "-a always,exit -F arch=b64 -S execve -F uid=0 -k root_commands"
        "-a always,exit -F arch=b64 -S connect -k network_connections"
      ];
    };
    
    # PAM configuration
    pam = {
      loginLimits = [
        {
          domain = "*";
          type = "hard";
          item = "maxlogins";
          value = "3";
        }
        {
          domain = "*";
          type = "hard";
          item = "core";
          value = "0";
        }
      ];
      
      services = {
        # Delay after failed authentication
        login.failDelay.delay = 4000000;  # 4 seconds
        sshd.failDelay.delay = 4000000;
        sudo.failDelay.delay = 4000000;
      };
    };
  };


  # =============================================================================
  # SERVICE HARDENING
  # =============================================================================
  
  # Hardening for systemd services is defined in sms-daemon.nix
  # Additional global systemd hardening
  systemd.coredump.enable = false;
  
  # =============================================================================
  # LOGGING AND MONITORING
  # =============================================================================
  
  services.journald = {
    extraConfig = ''
      # Storage configuration
      Storage=persistent
      SystemMaxUse=1G
      SystemKeepFree=500M
      RuntimeMaxUse=200M
      RuntimeKeepFree=100M
      MaxRetentionSec=30d
      
      # Compression and forwarding
      Compress=yes
      SplitMode=uid
      RateLimitInterval=30s
      RateLimitBurst=10000
      
      # Forwarding to syslog for remote logging
      ForwardToSyslog=yes
      MaxLevelStore=debug
      MaxLevelSyslog=info
    '';
  };
  
  # =============================================================================
  # MISCELLANEOUS SECURITY
  # =============================================================================

  # Time zone
  time.timeZone = "Asia/Singapore";

  # Locale
  i18n.defaultLocale = "en_SG.UTF-8";

  # Install only essential packages
  environment.systemPackages = with pkgs; [
    vim
    htop
    tmux
    git
    sbctl  # Secure boot control
    usbutils  # Provides lsusb command
    # Security tools (configure manually if needed)
    # aide  # File integrity monitoring - not available as service
    # rkhunter  # Rootkit hunter - not available as service
    # lynis  # Security auditing - not available as service
  ];
  
  # Regular security updates
  system.autoUpgrade = {
    enable = true;
    allowReboot = false;  # Manual reboot for production
    dates = "04:00";
    randomizedDelaySec = "30min";
  };
  

  # ModemManager configuration
  networking.modemmanager = {
    enable = true;
    fccUnlockScripts = [
      {
        # Quectel EC25 LTE modem
        id = "2c7c:0125";
        path = "${pkgs.modemmanager}/share/ModemManager/fcc-unlock.available.d/2c7c";
      }
      {
        # Au780 modem
        id = "1a86:7523";
        path = "${pkgs.modemmanager}/share/ModemManager/fcc-unlock.available.d/1a86";
      }
    ];
  };

  # This value determines the NixOS release compatibility
  system.stateVersion = "25.11";
}