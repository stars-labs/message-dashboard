#!/usr/bin/env bash

# Security Audit Script for Orange Pi NixOS Configuration
# This script performs various security checks on the deployed system

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
REMOTE_HOST="${1:-10.171.150.102}"
REMOTE_USER="${2:-htx}"
SSH_PORT="${3:-2222}"

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}Security Audit for Orange Pi SMS System${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""
echo "Target: ${REMOTE_USER}@${REMOTE_HOST}:${SSH_PORT}"
echo ""

# Function to run remote commands
remote_exec() {
    ssh -p "${SSH_PORT}" "${REMOTE_USER}@${REMOTE_HOST}" "$@" 2>/dev/null || true
}

# Function to check test results
check_result() {
    local test_name="$1"
    local result="$2"
    local expected="$3"
    
    if [[ "$result" == "$expected" ]]; then
        echo -e "${GREEN}✓${NC} ${test_name}"
        return 0
    else
        echo -e "${RED}✗${NC} ${test_name}"
        echo "  Expected: ${expected}"
        echo "  Got: ${result}"
        return 1
    fi
}

# Track overall results
TOTAL_TESTS=0
PASSED_TESTS=0

# =============================================================================
# 1. SSH CONFIGURATION CHECKS
# =============================================================================

echo -e "${YELLOW}1. SSH Configuration${NC}"

# Check if root login is disabled
TOTAL_TESTS=$((TOTAL_TESTS + 1))
result=$(remote_exec "sudo grep '^PermitRootLogin' /etc/ssh/sshd_config | awk '{print \$2}'")
if check_result "Root login disabled" "$result" "no"; then
    PASSED_TESTS=$((PASSED_TESTS + 1))
fi

# Check if password authentication is disabled
TOTAL_TESTS=$((TOTAL_TESTS + 1))
result=$(remote_exec "sudo grep '^PasswordAuthentication' /etc/ssh/sshd_config | awk '{print \$2}'")
if check_result "Password authentication disabled" "$result" "no"; then
    PASSED_TESTS=$((PASSED_TESTS + 1))
fi

# Check SSH port
TOTAL_TESTS=$((TOTAL_TESTS + 1))
result=$(remote_exec "sudo grep '^Port' /etc/ssh/sshd_config | awk '{print \$2}'")
if [[ "$result" != "22" ]] && [[ -n "$result" ]]; then
    echo -e "${GREEN}✓${NC} Non-standard SSH port (${result})"
    PASSED_TESTS=$((PASSED_TESTS + 1))
else
    echo -e "${RED}✗${NC} Using standard SSH port 22"
fi

# Check for fail2ban
TOTAL_TESTS=$((TOTAL_TESTS + 1))
result=$(remote_exec "systemctl is-active fail2ban")
if check_result "Fail2ban active" "$result" "active"; then
    PASSED_TESTS=$((PASSED_TESTS + 1))
fi

echo ""

# =============================================================================
# 2. FIREWALL CHECKS
# =============================================================================

echo -e "${YELLOW}2. Firewall Configuration${NC}"

# Check if firewall is enabled
TOTAL_TESTS=$((TOTAL_TESTS + 1))
result=$(remote_exec "sudo iptables -L -n | grep -c 'Chain' || echo 0")
if [[ "$result" -gt 0 ]]; then
    echo -e "${GREEN}✓${NC} Firewall is active"
    PASSED_TESTS=$((PASSED_TESTS + 1))
else
    echo -e "${RED}✗${NC} Firewall appears inactive"
fi

# Check for rate limiting rules
TOTAL_TESTS=$((TOTAL_TESTS + 1))
result=$(remote_exec "sudo iptables -L -n | grep -c 'recent:' || echo 0")
if [[ "$result" -gt 0 ]]; then
    echo -e "${GREEN}✓${NC} Rate limiting rules found"
    PASSED_TESTS=$((PASSED_TESTS + 1))
else
    echo -e "${YELLOW}⚠${NC} No rate limiting rules detected"
fi

# Check open ports
echo -e "${BLUE}Open ports:${NC}"
remote_exec "sudo ss -tlnp | grep LISTEN | awk '{print \$4}' | sed 's/.*://' | sort -u | head -10"

echo ""

# =============================================================================
# 3. SYSTEM HARDENING
# =============================================================================

echo -e "${YELLOW}3. System Hardening${NC}"

# Check kernel parameters
declare -A kernel_params=(
    ["kernel.dmesg_restrict"]="1"
    ["kernel.kptr_restrict"]="2"
    ["kernel.yama.ptrace_scope"]="2"
    ["net.ipv4.conf.all.rp_filter"]="1"
    ["net.ipv4.tcp_syncookies"]="1"
    ["fs.protected_hardlinks"]="1"
    ["fs.protected_symlinks"]="1"
)

for param in "${!kernel_params[@]}"; do
    TOTAL_TESTS=$((TOTAL_TESTS + 1))
    result=$(remote_exec "sysctl -n $param 2>/dev/null || echo 'not set'")
    expected="${kernel_params[$param]}"
    if [[ "$result" == "$expected" ]]; then
        echo -e "${GREEN}✓${NC} $param = $result"
        PASSED_TESTS=$((PASSED_TESTS + 1))
    else
        echo -e "${RED}✗${NC} $param = $result (expected: $expected)"
    fi
done

echo ""

# =============================================================================
# 4. SERVICE SECURITY
# =============================================================================

echo -e "${YELLOW}4. Service Security${NC}"

# Check SMS daemon status
TOTAL_TESTS=$((TOTAL_TESTS + 1))
result=$(remote_exec "systemctl is-active sms-daemon")
if [[ "$result" == "active" ]]; then
    echo -e "${GREEN}✓${NC} SMS daemon is running"
    PASSED_TESTS=$((PASSED_TESTS + 1))
    
    # Check daemon user
    TOTAL_TESTS=$((TOTAL_TESTS + 1))
    result=$(remote_exec "ps aux | grep sms-daemon | grep -v grep | awk '{print \$1}' | head -1")
    if [[ "$result" != "root" ]] && [[ -n "$result" ]]; then
        echo -e "${GREEN}✓${NC} Daemon running as non-root user ($result)"
        PASSED_TESTS=$((PASSED_TESTS + 1))
    else
        echo -e "${RED}✗${NC} Daemon running as root"
    fi
else
    echo -e "${YELLOW}⚠${NC} SMS daemon is not running"
fi

# Check for systemd hardening
TOTAL_TESTS=$((TOTAL_TESTS + 1))
result=$(remote_exec "systemctl show sms-daemon -p NoNewPrivileges --value")
if check_result "NoNewPrivileges enabled" "$result" "yes"; then
    PASSED_TESTS=$((PASSED_TESTS + 1))
fi

TOTAL_TESTS=$((TOTAL_TESTS + 1))
result=$(remote_exec "systemctl show sms-daemon -p PrivateTmp --value")
if check_result "PrivateTmp enabled" "$result" "yes"; then
    PASSED_TESTS=$((PASSED_TESTS + 1))
fi

echo ""

# =============================================================================
# 5. USB SECURITY
# =============================================================================

echo -e "${YELLOW}5. USB Security${NC}"

# Check for USBGuard
TOTAL_TESTS=$((TOTAL_TESTS + 1))
result=$(remote_exec "systemctl is-active usbguard 2>/dev/null || echo 'inactive'")
if [[ "$result" == "active" ]]; then
    echo -e "${GREEN}✓${NC} USBGuard is active"
    PASSED_TESTS=$((PASSED_TESTS + 1))
else
    echo -e "${YELLOW}⚠${NC} USBGuard is not active"
fi

# List connected USB devices
echo -e "${BLUE}Connected USB devices:${NC}"
remote_exec "lsusb | head -5" || echo "  Unable to list USB devices"

echo ""

# =============================================================================
# 6. AUDIT AND LOGGING
# =============================================================================

echo -e "${YELLOW}6. Audit and Logging${NC}"

# Check auditd
TOTAL_TESTS=$((TOTAL_TESTS + 1))
result=$(remote_exec "systemctl is-active auditd 2>/dev/null || echo 'inactive'")
if [[ "$result" == "active" ]]; then
    echo -e "${GREEN}✓${NC} Audit daemon is active"
    PASSED_TESTS=$((PASSED_TESTS + 1))
else
    echo -e "${YELLOW}⚠${NC} Audit daemon is not active"
fi

# Check for AppArmor
TOTAL_TESTS=$((TOTAL_TESTS + 1))
result=$(remote_exec "systemctl is-active apparmor 2>/dev/null || echo 'inactive'")
if [[ "$result" == "active" ]]; then
    echo -e "${GREEN}✓${NC} AppArmor is active"
    PASSED_TESTS=$((PASSED_TESTS + 1))
else
    echo -e "${YELLOW}⚠${NC} AppArmor is not active"
fi

echo ""

# =============================================================================
# 7. USER AND PERMISSION CHECKS
# =============================================================================

echo -e "${YELLOW}7. User and Permissions${NC}"

# Check sudo configuration
TOTAL_TESTS=$((TOTAL_TESTS + 1))
result=$(remote_exec "sudo grep -c 'timestamp_timeout' /etc/sudoers 2>/dev/null || echo 0")
if [[ "$result" -gt 0 ]]; then
    echo -e "${GREEN}✓${NC} Sudo timeout configured"
    PASSED_TESTS=$((PASSED_TESTS + 1))
else
    echo -e "${YELLOW}⚠${NC} No sudo timeout configured"
fi

# Check for unnecessary SUID binaries
echo -e "${BLUE}SUID binaries found:${NC}"
suid_count=$(remote_exec "find /usr/bin /usr/sbin -perm -4000 2>/dev/null | wc -l || echo 0")
echo "  Found ${suid_count} SUID binaries"

echo ""

# =============================================================================
# 8. BOOT SECURITY
# =============================================================================

echo -e "${YELLOW}8. Boot Security${NC}"

# Check for secure boot
TOTAL_TESTS=$((TOTAL_TESTS + 1))
result=$(remote_exec "test -d /sys/firmware/efi && echo 'uefi' || echo 'bios'")
if [[ "$result" == "uefi" ]]; then
    echo -e "${BLUE}ℹ${NC} System uses UEFI boot"
    
    # Check if secure boot is enabled
    result=$(remote_exec "mokutil --sb-state 2>/dev/null | grep -o 'enabled\\|disabled' || echo 'unknown'")
    if [[ "$result" == "enabled" ]]; then
        echo -e "${GREEN}✓${NC} Secure boot is enabled"
        PASSED_TESTS=$((PASSED_TESTS + 1))
    else
        echo -e "${YELLOW}⚠${NC} Secure boot is not enabled"
    fi
else
    echo -e "${BLUE}ℹ${NC} System uses BIOS boot"
fi

echo ""

# =============================================================================
# VULNERABILITY SCAN
# =============================================================================

echo -e "${YELLOW}9. Quick Vulnerability Scan${NC}"

# Check for outdated packages
echo -e "${BLUE}Checking for system updates...${NC}"
update_count=$(remote_exec "nix-channel --update 2>/dev/null && nix-env -u --dry-run 2>/dev/null | grep -c 'upgrading' || echo 0")
if [[ "$update_count" -eq 0 ]]; then
    echo -e "${GREEN}✓${NC} System appears up to date"
else
    echo -e "${YELLOW}⚠${NC} ${update_count} packages can be updated"
fi

# Check for common vulnerabilities
echo -e "${BLUE}Checking for common misconfigurations...${NC}"

# World-writable files
TOTAL_TESTS=$((TOTAL_TESTS + 1))
writable_count=$(remote_exec "find /etc -type f -perm -002 2>/dev/null | wc -l || echo 0")
if [[ "$writable_count" -eq 0 ]]; then
    echo -e "${GREEN}✓${NC} No world-writable files in /etc"
    PASSED_TESTS=$((PASSED_TESTS + 1))
else
    echo -e "${RED}✗${NC} Found ${writable_count} world-writable files in /etc"
fi

# Unowned files
TOTAL_TESTS=$((TOTAL_TESTS + 1))
unowned_count=$(remote_exec "find / -nouser -o -nogroup 2>/dev/null | wc -l || echo 0")
if [[ "$unowned_count" -eq 0 ]]; then
    echo -e "${GREEN}✓${NC} No unowned files found"
    PASSED_TESTS=$((PASSED_TESTS + 1))
else
    echo -e "${YELLOW}⚠${NC} Found ${unowned_count} unowned files"
fi

echo ""

# =============================================================================
# SUMMARY
# =============================================================================

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}Security Audit Summary${NC}"
echo -e "${BLUE}========================================${NC}"

PERCENTAGE=$((PASSED_TESTS * 100 / TOTAL_TESTS))

if [[ $PERCENTAGE -ge 80 ]]; then
    COLOR=$GREEN
    STATUS="GOOD"
elif [[ $PERCENTAGE -ge 60 ]]; then
    COLOR=$YELLOW
    STATUS="FAIR"
else
    COLOR=$RED
    STATUS="POOR"
fi

echo -e "Tests Passed: ${COLOR}${PASSED_TESTS}/${TOTAL_TESTS}${NC} (${PERCENTAGE}%)"
echo -e "Security Status: ${COLOR}${STATUS}${NC}"
echo ""

# Recommendations
if [[ $PERCENTAGE -lt 100 ]]; then
    echo -e "${YELLOW}Recommendations:${NC}"
    echo "1. Review the failed tests above"
    echo "2. Implement the security hardening configuration"
    echo "3. Consider enabling:"
    echo "   - USBGuard for USB device filtering"
    echo "   - AppArmor for mandatory access control"
    echo "   - Auditd for system auditing"
    echo "   - Secure boot if using UEFI"
    echo "4. Run this audit regularly (weekly recommended)"
fi

echo ""
echo "Audit completed at $(date)"

exit $((TOTAL_TESTS - PASSED_TESTS))