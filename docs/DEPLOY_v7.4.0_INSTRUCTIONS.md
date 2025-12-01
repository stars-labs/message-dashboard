# Manual Deployment Instructions for v7.4.0 (Busctl Fallback)

## What's New in v7.4.0
- **CRITICAL FIX**: Added busctl fallback for SMS deletion when native D-Bus fails
- This should finally resolve the SMS deletion failures that were causing messages to be re-read repeatedly

## Files to Deploy
1. The compiled daemon binary: `orange-pi-daemon/target/release/orange-pi-daemon-rust`
2. The deployment script: `deploy_v7.4.0.sh`

## Deployment Steps

### Step 1: Copy Files to Server
```bash
# From your local machine:
scp orange-pi-daemon/target/release/orange-pi-daemon-rust root@203.116.95.146:/tmp/
scp deploy_v7.4.0.sh root@203.116.95.146:/tmp/
```

### Step 2: SSH to Server and Deploy
```bash
# SSH to the Orange Pi server
ssh root@203.116.95.146

# Go to temp directory
cd /tmp

# Run the deployment script
bash deploy_v7.4.0.sh
```

### Step 3: Verify SMS Deletion is Working
```bash
# Watch the logs for deletion confirmations
journalctl -u sms-daemon -f | grep -E "(busctl|Delete|SMS)"
```

## What to Look For in Logs

### Success Messages:
- `🚀 SMS Dashboard Daemon v7.4.0 starting...` - Confirms new version is running
- `✅ Deleted SMS via native D-Bus: /path/to/sms` - Native deletion working
- `🔧 Attempting busctl fallback deletion for: /path/to/sms` - Fallback being attempted
- `✅ Deleted SMS via busctl fallback: /path/to/sms` - Fallback successful

### Error Messages (should no longer occur):
- `Native D-Bus deletion failed, trying busctl:` - This is OK, means fallback will be used
- `busctl deletion failed` - This would be a problem, but should not happen

## Expected Behavior
1. The daemon will first try native D-Bus deletion (fastest, ~5ms)
2. If that fails, it automatically falls back to busctl command (~50ms)
3. Messages should be deleted immediately after being read
4. No more duplicate messages being re-read in every cycle

## Monitoring Commands
```bash
# Check service status
systemctl status sms-daemon

# View recent logs
journalctl -u sms-daemon -n 100

# Check for successful deletions
journalctl -u sms-daemon | grep "Deleted SMS" | tail -20

# Monitor in real-time
journalctl -u sms-daemon -f
```

## Rollback (if needed)
```bash
# Stop the service
systemctl stop sms-daemon

# Restore the backup (created by deploy script)
cp /tmp/sms-daemon.backup.* /opt/sms-daemon-manual/sms-daemon

# Restart
systemctl start sms-daemon
```

## Code Changes in v7.4.0
The key change is in `modem_manager.rs`:
- Added busctl fallback in the `delete_sms()` method
- Falls back automatically when native D-Bus deletion fails
- Uses the exact busctl command format that was tested successfully:
  ```bash
  busctl call org.freedesktop.ModemManager1 \
    /org/freedesktop/ModemManager1/Modem/{modem_id} \
    org.freedesktop.ModemManager1.Modem.Messaging \
    Delete o {sms_path}
  ```