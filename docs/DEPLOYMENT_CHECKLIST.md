# Deployment Checklist - Fix Fake MODEM_ Entries

## Summary of Changes (v5.2.0)

This deployment fixes critical issues with fake MODEM_ entries being created in the database and systemd watchdog timeouts.

### Issues Fixed
1. ✅ **Fake MODEM_ entries** - Daemon no longer creates fake IDs for modems without valid IMEI
2. ✅ **Systemd watchdog timeout** - Added periodic watchdog keepalive signals
3. ✅ **Server-side validation** - API now rejects fake MODEM_ entries

## Pre-Deployment Steps

### 1. Backup Database
```bash
npx wrangler d1 backup sms-dashboard
```

### 2. Analyze Current Fake Entries
```bash
npx wrangler d1 execute sms-dashboard --remote --command="SELECT COUNT(*) FROM modems WHERE equipment_id LIKE 'MODEM_%'"
```

## Deployment Steps

### Step 1: Deploy Cloudflare Workers (API with validation)
```bash
cd sms-dashboard
bun run deploy
```

Verify:
```bash
npx wrangler tail sms-dashboard --format pretty
# Look for: "[control.js] Rejecting fake modem entry"
```

### Step 2: Clean Database (Remove existing fake entries)
```bash
# Run the cleanup script
npx wrangler d1 execute sms-dashboard --remote --file=../sql/cleanup-fake-modems.sql > cleanup-results.txt

# Verify cleanup
npx wrangler d1 execute sms-dashboard --remote --command="SELECT COUNT(*) FROM modems WHERE equipment_id LIKE 'MODEM_%'"
# Should return 0
```

### Step 3: Deploy Daemon to Orange Pi (v5.2.0)
```bash
# Build and deploy
nixos-rebuild switch --flake .#orange-pi \
    --use-substitutes \
    --target-host root@203.116.95.146 \
    --build-host root@203.116.95.146 \
    --impure
```

### Step 4: Verify Daemon Deployment
```bash
# Check service status
ssh root@203.116.95.146 'systemctl status sms-daemon'

# Check for watchdog signals in logs
ssh root@203.116.95.146 'journalctl -u sms-daemon -n 100 | grep -E "(Watchdog|MODEM_)"'

# Monitor for restarts (should be stable now)
ssh root@203.116.95.146 'journalctl -u sms-daemon -f'
```

## Post-Deployment Verification

### 1. Check for New Fake Entries (after 5 minutes)
```bash
npx wrangler d1 execute sms-dashboard --remote --command="SELECT equipment_id, manufacturer, model FROM modems WHERE equipment_id LIKE 'MODEM_%' ORDER BY updated_at DESC"
```
Should return empty results.

### 2. Monitor Daemon Stability
```bash
# Check restart count (should be 0 or stable)
ssh root@203.116.95.146 'systemctl show sms-daemon -p NRestarts'

# Check daemon version
ssh root@203.116.95.146 'journalctl -u sms-daemon | grep "Starting Rust SMS Daemon"'
# Should show: v5.0.0 or later
```

### 3. Check API Logs for Rejections
```bash
npx wrangler tail sms-dashboard --format pretty | grep "Rejecting"
```

### 4. Verify SIM-Modem Associations
```sql
-- Run this query to check SIM-modem relationships
SELECT
    s.iccid,
    s.phone_number,
    s.current_modem_id,
    m.manufacturer,
    m.model
FROM sims s
LEFT JOIN modems m ON s.current_modem_id = m.equipment_id
WHERE s.current_modem_id IS NOT NULL
ORDER BY s.sim_index;
```

## Rollback Plan

If issues occur:

### 1. Rollback Daemon
```bash
# Stop the daemon
ssh root@203.116.95.146 'systemctl stop sms-daemon'

# Rollback to previous generation
ssh root@203.116.95.146 'nixos-rebuild switch --rollback'

# Restart daemon
ssh root@203.116.95.146 'systemctl start sms-daemon'
```

### 2. Restore Database (if needed)
```bash
# List backups
npx wrangler d1 backup list sms-dashboard

# Restore specific backup
npx wrangler d1 backup restore sms-dashboard <backup-id>
```

## Success Criteria

✅ No new MODEM_ entries in database
✅ Daemon runs without systemd restarts for >10 minutes
✅ All valid modems have proper IMEI (not MODEM_*)
✅ SIMs correctly associated with real modems
✅ API logs show fake entries being rejected

## Change Log

### Daemon (v5.2.0)
- `modem_manager.rs`: Return None for modems without valid IMEI
- `worker_pool.rs`: Skip processing modems without valid IMEI
- `main.rs`: Add systemd watchdog keepalive signals

### API
- `control.js`: Reject modems starting with MODEM_ and null manufacturer/model
- `control.js`: Clear SIM associations pointing to fake modems

## Notes

- The cleanup script creates archive tables for audit trail
- Archive tables: `modems_archive_fake`, `sims_archive_fake_relationships`
- Check these tables if you need to recover any data

## Contact

If issues arise during deployment:
1. Check logs: `journalctl -u sms-daemon -f`
2. Check API logs: `npx wrangler tail sms-dashboard`
3. Review this checklist and rollback if needed