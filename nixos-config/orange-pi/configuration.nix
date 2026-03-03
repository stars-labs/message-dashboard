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

    # Include USB optimization module for 100 modems
    #../modules/usb-optimization.nix
  ];

  # System identification
  networking.hostName = "orange-pi-sms";

  # Allow unfree packages (for claude-code)
  nixpkgs.config.allowUnfree = true;

  # =============================================================================
  # USB OPTIMIZATION FOR 100 MODEMS
  # =============================================================================

  # Kernel parameters for USB performance with 100 modems
  # NOTE: These are merged with security hardening parameters in boot section below

  # NOTE: All sysctl settings are consolidated in boot.kernel.sysctl section within boot {}

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
  networking.firewall.enable = true; # Disable legacy iptables firewall
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
    ports = [ 22 ]; # Standard SSH port (security through obscurity is ineffective)
    settings = {
      PasswordAuthentication = false;
      KbdInteractiveAuthentication = false;
      PermitRootLogin = "prohibit-password"; # Allow root login with keys only (needed for nixos-rebuild)
      AllowUsers = [
        "htx"
        "root"
      ]; # Allow htx and root users
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
      rndtime = "8m";
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
    wheelNeedsPassword = true; # Always require password for sudo
    execWheelOnly = true; # Only wheel group can use sudo

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
      Defaults !insults
      Defaults mail_badpass
      Defaults mail_no_user

      # Environment restrictions
      Defaults env_reset
      Defaults env_keep="COLORS DISPLAY HOSTNAME HISTSIZE LS_COLORS"
      Defaults secure_path="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
    '';
  };

  # =============================================================================
  # WATCHDOG CONFIGURATION
  # =============================================================================

  services.logrotate.enable = false;
  # Hardware watchdog configuration
  # Using watchdogd service for system monitoring and automatic recovery
  services.watchdogd = {
    enable = true;
    settings = {
      "device /dev/watchdog" = {
        timeout = 30; # Hardware watchdog timeout in seconds
        interval = 10; # Ping interval in seconds
        safe-exit = true; # Disable watchdog on clean exit
      };
      loadavg = {
        enabled = true;
        interval = 60;
        warning = 8.0; # Warning at load average 8
        critical = 12.0; # Critical at load average 12 (will trigger reboot)
      };
      meminfo = {
        enabled = true;
        interval = 60;
        warning = 0.85; # Warning at 85% memory usage
        critical = 0.95; # Critical at 95% memory usage (will trigger reboot)
      };
      filenr = {
        enabled = true;
        logmark = true; # Log file descriptor usage
      };
    };
  };

  # =============================================================================
  # BOOT SECURITY
  # =============================================================================

  boot = {
    # Use hardened kernel packages for enhanced security
    kernelPackages = lib.mkForce pkgs.linuxPackages_hardened;

    # Load watchdog kernel module (Orange Pi usually uses sunxi_wdt)
    kernelModules = [ "sunxi_wdt" ]; # Allwinner watchdog for Orange Pi

    # Boot loader configuration
    loader = {
      systemd-boot.enable = true; # Disabled for Lanzaboote
      efi = {
        canTouchEfiVariables = true;
        efiSysMountPoint = "/boot";
      };
      timeout = 1; # Minimal timeout to prevent boot delay attacks
    };

    # Kernel parameters for security hardening AND USB optimization
    kernelParams = [
      # USB optimization for 100 modems
      "usbcore.usbfs_memory_mb=1024" # Increase USB buffer (default 16MB, 1GB for 100 modems)
      "usbcore.autosuspend=-1" # Disable USB autosuspend
      "xhci_hcd.quirks=270336" # USB controller quirk for stability (from dotfiles)
      "log_buf_len=4M" # Increase kernel message buffer
      "elevator=noop" # Optimize for throughput
      "fs.file-max=2097152" # Increase file handles
      "fs.nr_open=1048576" # Increase open file limit

      # Watchdog parameters
      "sunxi_wdt.nowayout=1" # Prevent watchdog from being disabled

      # Security hardening
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

    # Kernel sysctl settings - ALL sysctl configuration
    kernel.sysctl = {
      # ===== USB and system performance (for 100 modems) =====
      # USB and device optimizations
      "vm.dirty_ratio" = 5;
      "vm.dirty_background_ratio" = 2;
      "vm.swappiness" = 10;

      # Network buffer optimizations (for API uploads and 100 modems)
      "net.core.rmem_max" = 134217728;
      "net.core.wmem_max" = 134217728;
      "net.core.rmem_default" = 134217728;
      "net.core.wmem_default" = 134217728;
      "net.core.netdev_max_backlog" = 50000;
      "net.ipv4.tcp_rmem" = "4096 87380 134217728";
      "net.ipv4.tcp_wmem" = "4096 65536 134217728";

      # File handle limits
      "fs.file-max" = 2097152;
      "fs.nr_open" = 1048576;

      # Inotify limits for monitoring many devices
      "fs.inotify.max_user_instances" = 8192;
      "fs.inotify.max_user_watches" = 524288;

      # Process limits
      "kernel.pid_max" = 4194304;
      "kernel.threads-max" = 2097152;

      # ===== Security hardening =====
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
      "net.ipv6.conf.all.use_tempaddr" = lib.mkForce 2;
      "net.ipv6.conf.default.use_tempaddr" = lib.mkForce 2;

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
      "kernel.modules_disabled" = 0; # Set to 1 after boot if no modules needed
      "kernel.perf_event_paranoid" = 3;

      # Process hardening
      # kernel.pid_max already set above to 4194304 for 100 modems
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
      "uvcvideo" # Webcam - remove if needed
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
      enable = false;
      killUnconfinedConfinables = true;
    };

    # Audit framework - DISABLED due to buffer overflow with 100 USB modems
    # auditd generates too many events with 100 modems causing "No buffer space available"
    auditd.enable = false;
    audit = {
      enable = false;
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
        login.failDelay.delay = 4000000; # 4 seconds
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
  # DNS RESOLUTION AND NETWORK MANAGEMENT
  # =============================================================================

  # Enable NetworkManager for better network management
  networking.networkmanager = {
    enable = true;
    dns = "systemd-resolved"; # Use systemd-resolved for DNS
  };

  # Enable systemd-resolved for better DNS handling
  services.resolved = {
    enable = true;
    dnssec = "false"; # Disable DNSSEC completely as it's causing validation failures
    dnsovertls = "opportunistic"; # Use DNS over TLS when available
    llmnr = "false"; # Disable LLMNR for security (multicast name resolution)
  };

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
    sbctl # Secure boot control
    usbutils # Provides lsusb command
    ldns
    claude-code
    # Security tools (configure manually if needed)
    # aide  # File integrity monitoring - not available as service
    # rkhunter  # Rootkit hunter - not available as service
    # lynis  # Security auditing - not available as service
  ];

  # Regular security updates
  #system.autoUpgrade = {
  #  enable = true;
  #  allowReboot = false;  # Manual reboot for production
  #  dates = "04:00";
  #  randomizedDelaySec = "30min";
  #};

  # ModemManager managed directly by Rust daemon for better control of 87+ modems

  # This value determines the NixOS release compatibility
  system.stateVersion = "25.11";
}
