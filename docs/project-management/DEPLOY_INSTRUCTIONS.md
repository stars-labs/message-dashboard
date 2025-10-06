# Deployment Instructions for Orange Pi Memory Limit Fix

## Issue Fixed
The SMS daemon was being killed by OOM killer when managing 100 USB modems due to insufficient memory limits.

## Changes Made

### 1. NixOS Configuration Updates (`nixos-config/modules/sms-daemon.nix`)
- **MemoryMax**: Increased from 512M to 2G
- **MemorySwapMax**: Added 1G swap allowance
- **CPUQuota**: Increased to 400% (4 cores)
- **TasksMax**: Increased to 512
- **LimitNOFILE**: Increased to 65536 (from default 1024)
- **LimitNPROC**: Increased to 512
- **LimitAS**: Set to 4G (total address space)
- **LimitDATA**: Set to 3G (data segment)
- **LimitSTACK**: Set to 16M per thread

### 2. Database Synchronization
- Added automatic sim_index synchronization between modem_state and sims tables
- Created migration script `010_fix_sim_index_sync.sql`

### 3. Daemon Updates
- Modified to use modem_index as fallback when sim_index extraction fails

## Deployment Steps

### Step 1: Push Changes to Git
```bash
git push origin main
```

### Step 2: Deploy NixOS Configuration
Once you have SSH access to the Orange Pi (10.171.150.102):

```bash
# From your local machine in the nixos-config directory:
cd /home/freeman.xiong/Documents/github/hecoinfo/message-dashboard
nixos-rebuild switch --flake .#orange-pi \
    --use-substitutes \
    --target-host root@10.171.150.102 \
    --build-host root@10.171.150.102 \
    --impure
```

Alternative: If you're directly on the Orange Pi:
```bash
# SSH into the Orange Pi first
ssh root@10.171.150.102

# Pull the latest changes
cd /path/to/message-dashboard
git pull

# Apply the configuration
nixos-rebuild switch --flake .#orange-pi --impure
```

### Step 3: Verify New Limits
After deployment, verify the new limits are applied:

```bash
# Check systemd service limits
systemctl show sms-daemon | grep -E "Limit|Memory|Tasks"

# Expected output should show:
# MemoryMax=2147483648 (2G)
# LimitNOFILE=65536
# LimitAS=4294967296 (4G)
# LimitDATA=3221225472 (3G)
# TasksMax=512

# Check current file descriptor limit for the daemon
cat /proc/$(pgrep sms-daemon)/limits | grep "open files"
# Should show: 65536

# Monitor daemon memory usage
systemctl status sms-daemon
journalctl -u sms-daemon -f

# Check for OOM kills
dmesg | grep -i "killed process"
```

### Step 4: Run Database Migration
```bash
cd sms-dashboard
npx wrangler d1 execute sms-dashboard --remote --file=migrations/010_fix_sim_index_sync.sql
```

### Step 5: Monitor Stability
Monitor the daemon to ensure it can handle all 100 modems:

```bash
# Check how many modems are detected
mmcli -L | wc -l

# Monitor daemon logs
journalctl -u sms-daemon -f

# Check memory usage over time
while true; do
    echo "$(date): $(systemctl show sms-daemon --property=MemoryCurrent | cut -d= -f2 | numfmt --to=iec)"
    sleep 10
done
```

## Troubleshooting

### If OOM Kills Continue
1. Check actual memory usage:
   ```bash
   systemctl status sms-daemon
   cat /proc/$(pgrep sms-daemon)/status | grep -E "Vm|Rss"
   ```

2. Increase limits further if needed:
   - Edit `nixos-config/modules/sms-daemon.nix`
   - Increase `MemoryMax` to 3G or 4G
   - Redeploy configuration

### If File Descriptor Limit Not Applied
1. Check current ulimit:
   ```bash
   su - sms-daemon -s /bin/bash -c "ulimit -n"
   ```

2. Verify systemd applied the limit:
   ```bash
   systemctl show sms-daemon | grep LimitNOFILE
   ```

3. If still 1024, restart the service:
   ```bash
   systemctl restart sms-daemon
   ```

## Expected Results
After deployment:
- Daemon should handle 100 USB modems without OOM kills
- File descriptor limit should be 65536
- Memory usage should stay under 2G
- All 100 modems should remain connected and operational