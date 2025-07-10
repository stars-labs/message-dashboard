#!/bin/bash
# SMS Dashboard Daemon Installation Script for Orange Pi

set -e

echo "SMS Dashboard Daemon Installer"
echo "=============================="

# Check if running as root
if [ "$EUID" -ne 0 ]; then 
    echo "Please run as root (use sudo)"
    exit 1
fi

# Detect architecture
ARCH=$(uname -m)
case $ARCH in
    aarch64)
        echo "✓ ARM64 architecture detected"
        ;;
    armv7l)
        echo "✓ ARM32 architecture detected"
        ;;
    *)
        echo "✗ Unsupported architecture: $ARCH"
        exit 1
        ;;
esac

# Check for required dependencies
echo "Checking dependencies..."

if ! command -v mmcli &> /dev/null; then
    echo "Installing ModemManager..."
    apt-get update
    apt-get install -y modemmanager libmbim-utils libqmi-utils
fi

if ! command -v zig &> /dev/null; then
    echo "Installing Zig compiler..."
    # Install Zig 0.11.0
    ZIG_VERSION="0.11.0"
    if [ "$ARCH" = "aarch64" ]; then
        ZIG_ARCH="aarch64"
    else
        ZIG_ARCH="armv7a"
    fi
    
    wget https://ziglang.org/download/${ZIG_VERSION}/zig-linux-${ZIG_ARCH}-${ZIG_VERSION}.tar.xz
    tar -xf zig-linux-${ZIG_ARCH}-${ZIG_VERSION}.tar.xz
    mv zig-linux-${ZIG_ARCH}-${ZIG_VERSION}/zig /usr/local/bin/
    rm -rf zig-linux-${ZIG_ARCH}-${ZIG_VERSION}*
fi

# Build the daemon
echo "Building SMS Dashboard Daemon..."
zig build -Doptimize=ReleaseSafe

# Create user and group
echo "Creating system user..."
if ! id -u sms-daemon &>/dev/null; then
    useradd -r -s /bin/false -G dialout,plugdev sms-daemon
fi

# Install binary
echo "Installing daemon..."
install -m 755 zig-out/bin/sms-dashboard-daemon /usr/local/bin/

# Create config directory
mkdir -p /etc/sms-dashboard-daemon
chmod 750 /etc/sms-dashboard-daemon
chown root:sms-daemon /etc/sms-dashboard-daemon

# Create state directory
mkdir -p /var/lib/sms-dashboard
chmod 700 /var/lib/sms-dashboard
chown sms-daemon:dialout /var/lib/sms-dashboard

# Install systemd service
echo "Installing systemd service..."
cp sms-dashboard-daemon.service /etc/systemd/system/
systemctl daemon-reload

# Create config file
if [ ! -f /etc/sms-dashboard-daemon/config ]; then
    echo "Creating configuration file..."
    cat > /etc/sms-dashboard-daemon/config << EOF
# SMS Dashboard Daemon Configuration
# Edit this file to set your API key

SMS_API_URL=https://sexy.qzz.io
SMS_API_KEY=YOUR_API_KEY_HERE
SMS_UPLOAD_INTERVAL=60
EOF
    chmod 640 /etc/sms-dashboard-daemon/config
    chown root:sms-daemon /etc/sms-dashboard-daemon/config
    
    echo ""
    echo "⚠️  IMPORTANT: Edit /etc/sms-dashboard-daemon/config and set your API key!"
    echo ""
fi

# Enable ModemManager
systemctl enable --now ModemManager

echo ""
echo "Installation complete!"
echo ""
echo "Next steps:"
echo "1. Edit /etc/sms-dashboard-daemon/config and set your API key"
echo "2. Start the daemon: systemctl start sms-dashboard-daemon"
echo "3. Enable auto-start: systemctl enable sms-dashboard-daemon"
echo "4. Check status: systemctl status sms-dashboard-daemon"
echo "5. View logs: journalctl -u sms-dashboard-daemon -f"
echo ""
echo "To test modems:"
echo "  mmcli -L                    # List modems"
echo "  mmcli -m 0                  # Show modem details"
echo "  mmcli -m 0 --signal-get     # Check signal"