#!/usr/bin/env bash
# Remote deployment script for Orange Pi NixOS configuration
# Run this from your remote machine at 203.116.95.146

set -e

# Configuration
ORANGE_PI_IP="10.171.150.102"
ORANGE_PI_USER="root"
REPO_URL="https://github.com/stars-labs/message-dashboard.git"
WORK_DIR="/tmp/message-dashboard-deploy"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}Orange Pi SMS Daemon - Remote Deployment Script${NC}"
echo -e "${GREEN}================================================${NC}"
echo ""

# Check if we can reach the Orange Pi
echo -e "${YELLOW}Checking connectivity to Orange Pi at ${ORANGE_PI_IP}...${NC}"
if ping -c 1 -W 2 ${ORANGE_PI_IP} > /dev/null 2>&1; then
    echo -e "${GREEN}✓ Orange Pi is reachable${NC}"
else
    echo -e "${RED}✗ Cannot reach Orange Pi at ${ORANGE_PI_IP}${NC}"
    echo "Please ensure:"
    echo "  1. Orange Pi is powered on"
    echo "  2. You are on the same network (or have VPN access)"
    echo "  3. The IP address ${ORANGE_PI_IP} is correct"
    exit 1
fi

# Clone or update the repository
echo -e "${YELLOW}Preparing deployment directory...${NC}"
if [ -d "$WORK_DIR" ]; then
    echo "Updating existing repository..."
    cd "$WORK_DIR"
    git pull origin main
else
    echo "Cloning repository..."
    git clone "$REPO_URL" "$WORK_DIR"
    cd "$WORK_DIR"
fi

echo -e "${GREEN}✓ Repository ready${NC}"

# Show current USB statistics on Orange Pi
echo ""
echo -e "${YELLOW}Current Orange Pi Status:${NC}"
ssh ${ORANGE_PI_USER}@${ORANGE_PI_IP} << 'ENDSSH'
echo "Hostname: $(hostname)"
echo "Kernel: $(uname -r)"
echo ""
echo "USB Modems detected:"
lsusb | grep -E "12d1|2c7c|05c6|1a86" | wc -l
echo ""
echo "ModemManager status:"
systemctl is-active ModemManager || echo "ModemManager not running"
mmcli -L 2>/dev/null | grep -c "Modem/" || echo "0 modems in ModemManager"
echo ""
echo "Current file descriptor limit:"
ulimit -n
echo ""
echo "SMS Daemon status:"
systemctl is-active sms-daemon || echo "sms-daemon not running"
echo ""
echo "Memory usage:"
free -h | grep Mem
echo ""
echo "USB buffer size:"
cat /sys/module/usbcore/parameters/usbfs_memory_mb 2>/dev/null || echo "Default (16MB)"
ENDSSH

# Confirm deployment
echo ""
echo -e "${YELLOW}Ready to deploy the following changes:${NC}"
echo "  • Increased memory limits (2GB for daemon)"
echo "  • USB buffer increased to 256MB"
echo "  • File descriptor limit set to 65536"
echo "  • USB autosuspend disabled for stability"
echo "  • Kernel optimizations for 100 modems"
echo ""
read -p "Deploy these changes to Orange Pi? (y/n) " -n 1 -r
echo ""

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo -e "${RED}Deployment cancelled${NC}"
    exit 1
fi

# Deploy NixOS configuration
echo ""
echo -e "${YELLOW}Deploying NixOS configuration...${NC}"
echo "This may take 5-10 minutes..."

cd "$WORK_DIR"
nixos-rebuild switch \
    --flake .#orange-pi \
    --use-substitutes \
    --target-host ${ORANGE_PI_USER}@${ORANGE_PI_IP} \
    --build-host ${ORANGE_PI_USER}@${ORANGE_PI_IP} \
    --impure

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ NixOS configuration deployed successfully${NC}"
else
    echo -e "${RED}✗ Deployment failed${NC}"
    exit 1
fi

# Verify new limits
echo ""
echo -e "${YELLOW}Verifying new configuration...${NC}"
ssh ${ORANGE_PI_USER}@${ORANGE_PI_IP} << 'ENDSSH'
echo "New limits applied:"
echo ""
echo "File descriptor limit:"
systemctl show sms-daemon | grep -E "LimitNOFILE"
echo ""
echo "Memory limits:"
systemctl show sms-daemon | grep -E "MemoryMax|MemorySwapMax"
echo ""
echo "Address space limits:"
systemctl show sms-daemon | grep -E "LimitAS|LimitDATA|LimitSTACK"
echo ""
echo "USB buffer size:"
cat /sys/module/usbcore/parameters/usbfs_memory_mb
echo ""
echo "USB autosuspend:"
cat /sys/module/usbcore/parameters/autosuspend
echo ""
echo "Restarting SMS daemon..."
systemctl restart sms-daemon
sleep 3
echo ""
echo "SMS Daemon status:"
systemctl status sms-daemon --no-pager | head -20
ENDSSH

# Final check
echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}Deployment Complete!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo "Next steps:"
echo "  1. Monitor the daemon: ssh ${ORANGE_PI_USER}@${ORANGE_PI_IP} 'journalctl -u sms-daemon -f'"
echo "  2. Check modem count: ssh ${ORANGE_PI_USER}@${ORANGE_PI_IP} 'mmcli -L | wc -l'"
echo "  3. Watch for OOM kills: ssh ${ORANGE_PI_USER}@${ORANGE_PI_IP} 'dmesg -w | grep -i killed'"
echo ""
echo "To monitor USB devices performance:"
echo "  ssh ${ORANGE_PI_USER}@${ORANGE_PI_IP} 'watch -n1 \"lsusb | grep -E '12d1|2c7c|05c6|1a86' | wc -l\"'"
echo ""
echo "If issues persist, check the deployment instructions in DEPLOY_INSTRUCTIONS.md"