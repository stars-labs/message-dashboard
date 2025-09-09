# NixOS Configuration Security Audit Report

## Executive Summary
This security audit identifies critical vulnerabilities and security misconfigurations in the NixOS configuration for the Orange Pi SMS management system. Several high-severity issues require immediate attention.

## Severity Levels
- **CRITICAL**: Immediate exploitation risk, fix immediately
- **HIGH**: Significant security risk, fix within 24 hours
- **MEDIUM**: Moderate risk, fix within 1 week
- **LOW**: Minor risk, fix in next maintenance window

---

## 1. SSH Configuration Security

### Issues Found

#### 🔴 HIGH: Root Login with SSH Keys Enabled
**Location**: `configuration.nix:70`
```nix
PermitRootLogin = "prohibit-password";
```
**Risk**: While password authentication is disabled, root can still login with SSH keys. This violates the principle of least privilege.

**Recommendation**:
```nix
services.openssh = {
  enable = true;
  settings = {
    PasswordAuthentication = false;
    KbdInteractiveAuthentication = false;
    PermitRootLogin = "no";  # Completely disable root login
    AllowUsers = [ "htx" ];  # Whitelist specific users
    MaxAuthTries = 3;
    ClientAliveInterval = 300;
    ClientAliveCountMax = 2;
    X11Forwarding = false;
    PermitTunnel = "no";
    AllowAgentForwarding = false;
    AllowStreamLocalForwarding = false;
    AuthenticationMethods = "publickey";
  };
  # Consider changing default port
  ports = [ 2222 ];
};
```

#### 🟡 MEDIUM: No SSH Rate Limiting
**Risk**: No protection against brute force attacks.

**Recommendation**: Add fail2ban or implement rate limiting:
```nix
services.fail2ban = {
  enable = true;
  maxretry = 3;
  bantime = "1h";
  jails.sshd = {
    settings = {
      enabled = true;
      port = "ssh";
      filter = "sshd[mode=aggressive]";
    };
  };
};
```

---

## 2. Network Security

### Issues Found

#### 🔴 CRITICAL: Firewall Enabled But No Rules Configured
**Location**: `configuration.nix:44-45`
```nix
networking.firewall.enable = true;
networking.nftables.enable = true;
```
**Risk**: Firewall is enabled but no explicit rules are defined. Default policy may allow all traffic.

**Recommendation**:
```nix
networking.firewall = {
  enable = true;
  allowPing = false;  # Disable ICMP
  
  # Only allow specific ports
  allowedTCPPorts = [ 
    22  # SSH (or custom port if changed)
  ];
  allowedUDPPorts = [ ];
  
  # Drop all other traffic
  extraCommands = ''
    # Rate limit SSH connections
    iptables -A INPUT -p tcp --dport 22 -m state --state NEW -m recent --set
    iptables -A INPUT -p tcp --dport 22 -m state --state NEW -m recent --update --seconds 60 --hitcount 4 -j DROP
    
    # Log dropped packets
    iptables -A INPUT -j LOG --log-prefix "IPT-DROP: " --log-level 4
  '';
  
  # Restrict outbound traffic (egress filtering)
  extraStopCommands = ''
    # Allow only specific outbound connections
    iptables -P OUTPUT DROP
    iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
    iptables -A OUTPUT -p tcp --dport 443 -j ACCEPT  # HTTPS for API
    iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT   # DNS
    iptables -A OUTPUT -p udp --dport 53 -j ACCEPT   # DNS
  '';
};
```

#### 🟡 MEDIUM: DHCP Enabled by Default
**Location**: `hardware-configuration.nix:33`
**Risk**: DHCP can expose the system to rogue DHCP servers and network attacks.

**Recommendation**: Use static IP configuration for production:
```nix
networking.interfaces.enP3p49s0 = {
  useDHCP = false;
  ipv4.addresses = [{
    address = "10.171.150.102";
    prefixLength = 24;
  }];
};
```

---

## 3. User Permissions & Privilege Escalation

### Issues Found

#### 🔴 HIGH: User in wheel Group Without sudo Configuration
**Location**: `configuration.nix:86`
**Risk**: User `htx` is in wheel group but no sudo restrictions are configured.

**Recommendation**:
```nix
security.sudo = {
  enable = true;
  wheelNeedsPassword = true;  # Require password for sudo
  extraConfig = ''
    # Limit sudo commands
    htx ALL=(ALL) /run/current-system/sw/bin/systemctl restart sms-daemon
    htx ALL=(ALL) /run/current-system/sw/bin/systemctl status sms-daemon
    htx ALL=(ALL) NOPASSWD: /run/current-system/sw/bin/journalctl
    
    # Session timeout
    Defaults timestamp_timeout=5
    
    # Log all sudo commands
    Defaults logfile="/var/log/sudo.log"
    Defaults log_input
    Defaults log_output
  '';
};
```

---

## 4. Boot Security

### Issues Found

#### 🔴 HIGH: Secure Boot Disabled
**Location**: `configuration.nix:115-127`
**Risk**: Lanzaboote secure boot is commented out, allowing potential bootloader attacks.

**Recommendation**: Enable secure boot:
```nix
boot = {
  lanzaboote = {
    enable = true;
    pkiBundle = "/var/lib/sbctl";
  };
  
  loader = {
    systemd-boot.enable = false;  # Disabled when using lanzaboote
    efi = {
      canTouchEfiVariables = true;
      efiSysMountPoint = "/boot";
    };
    
    # Protect boot configuration
    timeout = 1;  # Minimal timeout
    editor = false;  # Disable boot entry editing
  };
  
  # Kernel hardening
  kernelParams = [
    "lockdown=confidentiality"
    "init_on_alloc=1"
    "init_on_free=1"
    "page_alloc.shuffle=1"
    "slab_nomerge"
    "vsyscall=none"
  ];
  
  # Blacklist unnecessary kernel modules
  blacklistedKernelModules = [
    "dccp"
    "sctp"
    "rds"
    "tipc"
    "bluetooth"
    "firewire-core"
  ];
};
```

#### 🟡 MEDIUM: Boot Partition World-Readable
**Location**: `hardware-configuration.nix:24`
**Risk**: Boot partition permissions are 077 but should be more restrictive.

**Recommendation**:
```nix
fileSystems."/boot" = {
  device = "/dev/disk/by-uuid/2E9E-9C7B";
  fsType = "vfat";
  options = [ "fmask=0377" "dmask=0377" "noexec" ];
};
```

---

## 5. Service Configuration Vulnerabilities

### Issues Found

#### 🔴 HIGH: SMS Daemon Running with Excessive Privileges
**Location**: `sms-daemon.nix:212-219`
**Risk**: PolicyKit rule allows SMS daemon full ModemManager access.

**Recommendation**: Restrict PolicyKit permissions:
```nix
security.polkit.extraConfig = ''
  polkit.addRule(function(action, subject) {
    // Only allow specific ModemManager actions
    var allowed_actions = [
      "org.freedesktop.ModemManager1.Device.Control",
      "org.freedesktop.ModemManager1.Messaging",
      "org.freedesktop.ModemManager1.Contacts"
    ];
    
    if (allowed_actions.indexOf(action.id) !== -1 &&
        subject.user == "${cfg.user}") {
      return polkit.Result.YES;
    }
    
    // Log denied attempts
    if (action.id.match("org.freedesktop.ModemManager1.") &&
        subject.user == "${cfg.user}") {
      polkit.log("Denied action " + action.id + " for user " + subject.user);
      return polkit.Result.NO;
    }
  });
'';
```

#### 🟡 MEDIUM: API Key Stored in Environment Variable
**Location**: `sms-daemon.nix:139-144`
**Risk**: API keys in environment variables can be exposed through `/proc`.

**Recommendation**: Use systemd credentials:
```nix
serviceConfig = {
  LoadCredential = "api-key:${cfg.apiKeyFile}";
  # Access via $CREDENTIALS_DIRECTORY/api-key in the service
};
```

#### 🟡 MEDIUM: No Resource Limits on Daemon
**Location**: `sms-daemon.nix:148-168`
**Risk**: Daemon can consume unlimited resources.

**Recommendation**: Add resource limits:
```nix
serviceConfig = {
  # Memory limits
  MemoryMax = "512M";
  MemorySwapMax = "0";
  
  # CPU limits
  CPUQuota = "200%";  # Max 2 cores
  
  # File descriptor limits
  LimitNOFILE = 4096;
  
  # Process limits
  TasksMax = 100;
  
  # Prevent fork bombs
  LimitNPROC = 50;
  
  # Network isolation (if not needed)
  PrivateNetwork = false;  # Keep false if API access needed
  RestrictAddressFamilies = "AF_INET AF_INET6 AF_UNIX";
  
  # Additional hardening
  ProtectKernelTunables = true;
  ProtectKernelModules = true;
  ProtectControlGroups = true;
  RestrictRealtime = true;
  RestrictSUIDSGID = true;
  RemoveIPC = true;
  PrivateMounts = true;
  SystemCallFilter = "@system-service";
  SystemCallErrorNumber = "EPERM";
  
  # Prevent core dumps with sensitive data
  LimitCORE = 0;
};
```

---

## 6. USB Security

### Issues Found

#### 🔴 HIGH: No USB Device Filtering
**Location**: `sms-daemon.nix:196-209`
**Risk**: Any USB device can be attached and accessed.

**Recommendation**: Implement USBGuard:
```nix
services.usbguard = {
  enable = true;
  dbus.enable = true;
  
  rules = ''
    # Allow specific modem vendors only
    allow id 2c7c:0125 name "Quectel EC25"
    allow id 12d1:* name "Huawei Modem"
    allow id 05c6:* name "Qualcomm Modem"
    
    # Block everything else
    block
  '';
  
  implicitPolicyTarget = "block";
  presentDevicePolicy = "keep";
  presentControllerPolicy = "keep";
};
```

---

## 7. Secrets Management

### Issues Found

#### 🟡 MEDIUM: SSH Host Key Used for SOPS Decryption
**Location**: `flake.nix:74`
**Risk**: SSH host key dual-purpose usage.

**Recommendation**: Use dedicated age key:
```nix
sops = {
  age.keyFile = "/var/lib/sops-nix/key.txt";  # Dedicated key
  age.sshKeyPaths = [];  # Don't use SSH keys
};
```

---

## 8. Additional Hardening Recommendations

### System-Wide Security Hardening

```nix
# Add to configuration.nix

# Security hardening
security = {
  # Protect against kernel exploits
  protectKernelImage = true;
  forcePageTableIsolation = true;
  virtualisation.flushL1DataCache = "always";
  
  # Audit framework
  auditd.enable = true;
  audit = {
    enable = true;
    rules = [
      "-w /etc/passwd -p wa -k passwd_changes"
      "-w /etc/group -p wa -k group_changes"
      "-w /etc/shadow -p wa -k shadow_changes"
      "-a always,exit -F arch=b64 -S execve -k exec"
    ];
  };
  
  # AppArmor
  apparmor = {
    enable = true;
    killUnconfinedConfinables = true;
  };
};

# Kernel sysctl hardening
boot.kernel.sysctl = {
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
  
  # File system hardening
  "fs.protected_hardlinks" = 1;
  "fs.protected_symlinks" = 1;
  "fs.suid_dumpable" = 0;
  
  # Kernel hardening
  "kernel.randomize_va_space" = 2;
  "kernel.panic_on_oops" = 1;
  "kernel.yama.ptrace_scope" = 2;
  "kernel.unprivileged_bpf_disabled" = 1;
  "kernel.kptr_restrict" = 2;
  "kernel.dmesg_restrict" = 1;
  "kernel.unprivileged_userns_clone" = 0;
};

# Automatic security updates
system.autoUpgrade = {
  enable = true;
  allowReboot = false;  # Manual reboot for production
  dates = "04:00";
  flake = "github:hecoinfo/message-dashboard#orange-pi";
};

# Log rotation and monitoring
services.journald = {
  extraConfig = ''
    SystemMaxUse=1G
    SystemKeepFree=500M
    MaxRetentionSec=30d
    ForwardToSyslog=yes
    Compress=yes
  '';
};
```

### Monitoring and Alerting

```nix
# Add monitoring
services.prometheus = {
  enable = true;
  exporters = {
    node = {
      enable = true;
      enabledCollectors = [ "systemd" "processes" ];
    };
  };
};

# Intrusion detection
services.aide = {
  enable = true;
  extraConfig = ''
    /etc p+u+g+s+m+c+md5+sha256
    /boot p+u+g+s+m+c+md5+sha256
    /root p+u+g+s+m+c+md5+sha256
  '';
};
```

---

## Priority Action Items

### Immediate (Within 24 hours)
1. Configure firewall rules properly
2. Disable root SSH login completely
3. Implement sudo restrictions
4. Add resource limits to SMS daemon

### Short-term (Within 1 week)
1. Enable secure boot with Lanzaboote
2. Implement USBGuard for USB filtering
3. Set up fail2ban for SSH protection
4. Configure audit logging

### Medium-term (Within 1 month)
1. Implement AppArmor profiles
2. Set up monitoring and alerting
3. Configure automatic security updates
4. Implement network segmentation

---

## Testing Recommendations

After implementing security fixes:

1. **Port Scan Test**:
   ```bash
   nmap -sS -sV -p- 10.171.150.102
   ```

2. **SSH Hardening Test**:
   ```bash
   ssh-audit 10.171.150.102
   ```

3. **Kernel Hardening Test**:
   ```bash
   lynis audit system
   ```

4. **USB Security Test**:
   - Attempt to connect unauthorized USB devices
   - Verify only whitelisted modems work

5. **Privilege Escalation Test**:
   - Test sudo restrictions
   - Attempt to access protected resources

---

## Compliance Considerations

This configuration should align with:
- **CIS Benchmarks** for Linux
- **NIST 800-53** security controls
- **PCI DSS** if handling payment card data
- **GDPR** for data protection (if applicable)

---

## Conclusion

The current NixOS configuration has several critical security vulnerabilities that need immediate attention. The most pressing issues are:

1. Improperly configured firewall
2. Excessive SSH access permissions
3. Missing boot security
4. Lack of USB device filtering
5. Insufficient service isolation

Implementing the recommended fixes will significantly improve the security posture of the Orange Pi SMS management system. Regular security audits should be performed quarterly to maintain security standards.