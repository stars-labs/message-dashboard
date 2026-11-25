{
  config,
  pkgs,
  lib,
  ...
}:

{
  imports = [
    ./hardware-configuration.nix

    ../modules/sms-daemon.nix
    ../modules/netbird-server.nix
    ../modules/pi-deploy.nix
  ];

  # claude-code is unfree.
  nixpkgs.config.allowUnfree = true;

  networking = {
    hostName = "orange-pi-sms";

    # NetworkManager is the only network manager here; dhcpcd on top of it
    # produces duplicate leases, routes, and DNS entries.
    # Do not set networking.useDHCP: the NetworkManager module sets it to false,
    # and a plain true conflicts at eval.
    dhcpcd.enable = false;
    nameservers = [
      "8.8.8.8"
      "8.8.4.4"
    ];

    firewall.enable = false;

    networkmanager = {
      enable = true;
      dns = "systemd-resolved";

      # NetworkManager owns every interface, so addressing lives here rather than
      # in networking.interfaces.
      ensureProfiles.profiles = {
        # Office uplink on enP4p65s0; the fixed address is the deploy and access
        # target in docs/deployment.md.
        lan-static = {
          connection = {
            id = "lan-static";
            type = "ethernet";
            interface-name = "enP4p65s0";
            autoconnect = "true";
            autoconnect-priority = "100";
          };
          ipv4 = {
            method = "manual";
            addresses = "10.171.150.102/24";
            gateway = "10.171.150.1";
            ignore-auto-dns = "true";
            route-metric = "100";
            may-fail = "false";
          };
          ipv6.method = "ignore";
        };

        # Spare port; the higher route metric keeps the static uplink as default
        # route, and DNS stays on networking.nameservers.
        lan-dhcp = {
          connection = {
            id = "lan-dhcp";
            type = "ethernet";
            interface-name = "enP3p49s0";
            autoconnect = "true";
            autoconnect-priority = "50";
          };
          ipv4 = {
            method = "auto";
            ignore-auto-dns = "true";
            route-metric = "200";
          };
          ipv6.method = "ignore";
        };
      };
    };
  };

  services = {
    openssh = {
      enable = true;
      ports = [ 22 ];
      settings = {
        PasswordAuthentication = false;
        KbdInteractiveAuthentication = false;
        PermitRootLogin = "prohibit-password"; # nixos-rebuild connects as root with a key
        AllowUsers = [
          "htx"
          "root"
        ];
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
    };

    fail2ban = {
      enable = false;
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

    logrotate.enable = false;
    watchdogd = {
      enable = true;
      settings = {
        "device /dev/watchdog" = {
          timeout = 30;
          interval = 10;
          safe-exit = true;
        };
        loadavg = {
          enabled = true;
          interval = 60;
          warning = 8.0;
          critical = 12.0; # reboots
        };
        meminfo = {
          enabled = true;
          interval = 60;
          warning = 0.85;
          critical = 0.95; # reboots
        };
        filenr = {
          enabled = true;
          logmark = true;
        };
      };
    };

    resolved = {
      enable = true;
      settings = {
        Resolve = {
          DNSSEC = "false"; # validation failures
          DNSOverTLS = "opportunistic";
          LLMNR = "false";
        };
      };
    };

    journald.settings.Journal = {
      Storage = "persistent";
      SystemMaxUse = "1G";
      SystemKeepFree = "500M";
      RuntimeMaxUse = "200M";
      RuntimeKeepFree = "100M";
      MaxRetentionSec = "30d";

      Compress = "yes";
      SplitMode = "uid";
      RateLimitIntervalSec = "30s";
      RateLimitBurst = "10000";

      ForwardToSyslog = "yes";
      MaxLevelStore = "debug";
      MaxLevelSyslog = "info";
    };
  };

  environment.etc."ssh/banner".text = ''
    ********************************************************************
    *                                                                  *
    * Unauthorized access to this system is strictly prohibited.      *
    * All access attempts are logged and monitored.                   *
    * Violators will be prosecuted to the fullest extent of the law. *
    *                                                                  *
    ********************************************************************
  '';

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
      "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC/XbGv4O4QXwFxs9gvie5LxHygseGa82ue+DpsiZ9zGaHwwKmLHAnkk9QsR4T4ALRCyK0yzGBliI2rRlICqw58CLQzASK9w23+YhQdp61NtXG94C8QTCJk2nGpsv9oKM+MnyH7d2dH97vfAE/S/2vAk7FwMzVhH8ehaH1E/f/d2WX6RjBHWqEwG4I4kLDkpMBBM2QmKnCxLOnxXmjZmhr/p0Pr61hedht2Fs1aRQ1XfMkRLPG0lHdzadcIdut6pG39yO33vKfJOf72BuRz3Qdd6P6x5bmFLjuymzvJrDC2KAFtBKpc5G0u+lozN3y9k8f+mgOj4EYFdNjKvRMgr9Dv cardno:25_422_096"
    ];

    shell = pkgs.bashInteractive;
  };

  users.users.root = {
    hashedPasswordFile = config.sops.secrets."sms-dashboard/user-passwords/root-hash".path;
    openssh.authorizedKeys.keys = [
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFhTqqOg4U3juVuxFgHt9cq2Opy+XVHLQahORdA56z6F openpgp:0x0383A3C3"
      "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC/XbGv4O4QXwFxs9gvie5LxHygseGa82ue+DpsiZ9zGaHwwKmLHAnkk9QsR4T4ALRCyK0yzGBliI2rRlICqw58CLQzASK9w23+YhQdp61NtXG94C8QTCJk2nGpsv9oKM+MnyH7d2dH97vfAE/S/2vAk7FwMzVhH8ehaH1E/f/d2WX6RjBHWqEwG4I4kLDkpMBBM2QmKnCxLOnxXmjZmhr/p0Pr61hedht2Fs1aRQ1XfMkRLPG0lHdzadcIdut6pG39yO33vKfJOf72BuRz3Qdd6P6x5bmFLjuymzvJrDC2KAFtBKpc5G0u+lozN3y9k8f+mgOj4EYFdNjKvRMgr9Dv cardno:25_422_096"
    ];
  };

  security.sudo = {
    enable = true;
    wheelNeedsPassword = true;
    execWheelOnly = true;

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

  # Nothing else reclaims old generations or dead store paths on this box.
  nix.gc = {
    automatic = true;
    dates = "weekly";
    options = "--delete-older-than 14d";
  };

  boot = {
    # linux_hardened is gone upstream; latest mainline instead.
    kernelPackages = lib.mkForce pkgs.linuxPackages_latest;

    kernelModules = [ "sunxi_wdt" ];

    loader = {
      systemd-boot = {
        enable = true;
        configurationLimit = 10; # keeps the ESP from filling up
      };
      efi = {
        canTouchEfiVariables = true;
        efiSysMountPoint = "/boot";
      };
      timeout = 1;
    };

    kernelParams = [
      "usbcore.usbfs_memory_mb=1024" # default is 16MB; 100 modems need more
      "usbcore.autosuspend=-1"
      "usbcore.old_scheme_first=1" # legacy enumeration handshake first; helps marginal modems
      "xhci_hcd.quirks=270336"
      "log_buf_len=4M"
      "elevator=noop"
      "fs.file-max=2097152"
      "fs.nr_open=1048576"
      "sunxi_wdt.nowayout=1"

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

    kernel.sysctl = {
      "vm.dirty_ratio" = 5;
      "vm.dirty_background_ratio" = 2;
      "vm.swappiness" = 10;

      "net.core.rmem_max" = 134217728;
      "net.core.wmem_max" = 134217728;
      "net.core.rmem_default" = 134217728;
      "net.core.wmem_default" = 134217728;
      "net.core.netdev_max_backlog" = 50000;
      "net.ipv4.tcp_rmem" = "4096 87380 134217728";
      "net.ipv4.tcp_wmem" = "4096 65536 134217728";

      "fs.file-max" = 2097152;
      "fs.nr_open" = 1048576;

      "fs.inotify.max_user_instances" = 8192;
      "fs.inotify.max_user_watches" = 524288;

      "kernel.pid_max" = 4194304;
      "kernel.threads-max" = 2097152;

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

      "fs.protected_hardlinks" = 1;
      "fs.protected_symlinks" = 1;
      "fs.protected_regular" = 2;
      "fs.protected_fifos" = 2;
      "fs.suid_dumpable" = 0;

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
      "kernel.modules_disabled" = 0;
      "kernel.perf_event_paranoid" = 3;

      "vm.mmap_min_addr" = 65536;
      "vm.unprivileged_userfaultfd" = 0;
    };

    blacklistedKernelModules = [
      "dccp"
      "sctp"
      "rds"
      "tipc"

      "cramfs"
      "freevxfs"
      "jffs2"
      "hfs"
      "hfsplus"
      "udf"

      "bluetooth"
      "btusb"
      "firewire-core"
      "thunderbolt"

      # SMS and calls use the AT serial ports (option driver); qmi_wwan would
      # only create one idle wwu* interface per modem.
      "qmi_wwan"
      "cdc_wdm"

      # The mainline Orange Pi 5 Plus device tree wires the hym8563 alarm IRQ to
      # the wrong pin, so it storms (~3400 IRQs/s) and keeps i2c-6 busy; the
      # clock comes from NTP.
      "rtc_hym8563"

      "vivid"
      "uvcvideo"
    ];
  };

  security = {
    polkit.enable = true;

    apparmor = {
      enable = false;
      killUnconfinedConfinables = true;
    };

    # auditd overflows its buffer ("No buffer space available") with 100 modems.
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
        login.failDelay.delay = 4000000; # microseconds
        sshd.failDelay.delay = 4000000;
        sudo.failDelay.delay = 4000000;
      };
    };
  };

  systemd.coredump.enable = false;

  time.timeZone = "Asia/Singapore";

  i18n.defaultLocale = "en_SG.UTF-8";

  environment.systemPackages = with pkgs; [
    vim
    htop
    tmux
    git
    sbctl
    usbutils
    ldns
    claude-code
  ];

  system.stateVersion = "25.11";
}
