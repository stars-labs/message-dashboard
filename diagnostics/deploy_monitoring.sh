#!/bin/bash

# Deployment script for USB modem monitoring system
# Run with sudo to install system-wide monitoring

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="/var/log/modem-monitoring"

echo "=== Deploying USB Modem Monitoring System ==="

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    echo "Please run as root (sudo)"
    exit 1
fi

# 1. Create log directory
echo "Creating log directory..."
mkdir -p "$LOG_DIR"
chmod 755 "$LOG_DIR"

# 2. Make all scripts executable
echo "Setting script permissions..."
chmod +x "$SCRIPT_DIR"/*.sh

# 3. Install systemd service and timer
echo "Installing systemd service and timer..."
cp "$SCRIPT_DIR/modem-monitoring.service" /etc/systemd/system/
cp "$SCRIPT_DIR/modem-monitoring.timer" /etc/systemd/system/

# Update service file to use correct script path
sed -i "s|ExecStart=.*|ExecStart=$SCRIPT_DIR/comprehensive_modem_monitor.sh|" /etc/systemd/system/modem-monitoring.service

# 4. Install kernel parameter optimizations
echo "Installing kernel parameter optimizations..."
if [ ! -f /etc/sysctl.d/99-usb-modem-optimization.conf ]; then
    cp "$SCRIPT_DIR/recommended_kernel_params.conf" /etc/sysctl.d/99-usb-modem-optimization.conf
    echo "Kernel parameters installed. Reboot required for full effect."
else
    echo "Kernel parameters already exist. Skipping..."
fi

# 5. Install ModemManager optimizations
echo "Installing ModemManager optimizations..."
mkdir -p /etc/ModemManager
if [ ! -f /etc/ModemManager/ModemManager.conf ]; then
    cp "$SCRIPT_DIR/modemmanager_optimized.conf" /etc/ModemManager/ModemManager.conf
    echo "ModemManager configuration installed."
    echo "Restart ModemManager to apply: systemctl restart ModemManager"
else
    echo "ModemManager config exists. Review and merge manually if needed."
fi

# 6. Enable and start monitoring
echo "Enabling monitoring service..."
systemctl daemon-reload
systemctl enable modem-monitoring.timer
systemctl start modem-monitoring.timer

# 7. Create alert configuration template
echo "Creating alert configuration template..."
mkdir -p /etc/modem-monitoring
if [ ! -f /etc/modem-monitoring/alert-config.sh ]; then
    cat > /etc/modem-monitoring/alert-config.sh << 'EOF'
#!/bin/bash
# Alert configuration for modem monitoring
# Customize this file to enable automated alerting

# Email alerts (requires mailutils)
ALERT_EMAIL="admin@yourdomain.com"
ENABLE_EMAIL_ALERTS=false

# Slack webhook (optional)
SLACK_WEBHOOK_URL=""
ENABLE_SLACK_ALERTS=false

# SMS alerts (optional - requires curl and SMS service)
SMS_SERVICE_URL=""
SMS_API_KEY=""
ALERT_PHONE_NUMBER=""
ENABLE_SMS_ALERTS=false

# Function to send alerts (customize as needed)
send_alert() {
    local alert_type="$1"
    local alert_message="$2"
    
    if [ "$ENABLE_EMAIL_ALERTS" = "true" ] && command -v mail >/dev/null 2>&1; then
        echo "$alert_message" | mail -s "Modem Alert: $alert_type" "$ALERT_EMAIL"
    fi
    
    if [ "$ENABLE_SLACK_ALERTS" = "true" ] && [ -n "$SLACK_WEBHOOK_URL" ]; then
        curl -X POST -H 'Content-type: application/json' \
            --data "{\"text\":\"🚨 Modem Alert: $alert_type\\n$alert_message\"}" \
            "$SLACK_WEBHOOK_URL"
    fi
    
    # Add more alerting mechanisms as needed
}

# Process alerts from monitoring script
if [ -f "$alert_file" ]; then
    while IFS=':' read -r alert_type alert_value; do
        case "$alert_type" in
            "CRITICAL_MODEM_LOSS")
                send_alert "Critical Modem Loss" "Only $alert_value modems active out of 100"
                ;;
            "HIGH_TEMPERATURE")
                send_alert "High Temperature" "CPU temperature: ${alert_value}°C"
                ;;
            "HIGH_USB_ERRORS")
                send_alert "USB Errors" "High USB error count: $alert_value"
                ;;
        esac
    done < "$alert_file"
fi
EOF
    chmod +x /etc/modem-monitoring/alert-config.sh
    echo "Alert configuration template created at /etc/modem-monitoring/alert-config.sh"
    echo "Customize it to enable automated alerting."
fi

# 8. Run initial monitoring check
echo "Running initial monitoring check..."
systemctl start modem-monitoring.service

# 9. Show status
echo
echo "=== Deployment Complete ==="
echo "Monitoring timer status:"
systemctl status modem-monitoring.timer --no-pager -l

echo
echo "Recent monitoring logs:"
journalctl -u modem-monitoring.service --no-pager -n 10

echo
echo "Log files location: $LOG_DIR"
echo "Configuration: /etc/modem-monitoring/"
echo "Services: modem-monitoring.service and modem-monitoring.timer"

echo
echo "Next steps:"
echo "1. Review logs: ls -la $LOG_DIR"
echo "2. Check service status: systemctl status modem-monitoring.timer"
echo "3. Configure alerts: edit /etc/modem-monitoring/alert-config.sh"
echo "4. Consider rebooting to apply kernel parameters"
echo "5. Restart ModemManager if config was updated: systemctl restart ModemManager"

echo
echo "Manual monitoring run: $SCRIPT_DIR/comprehensive_modem_monitor.sh"