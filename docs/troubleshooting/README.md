# Troubleshooting Guide (v3.6.0)

## Quick Reference

This troubleshooting guide is organized by component and symptom for rapid problem resolution. For production issues, start with the [Emergency Procedures](#emergency-procedures) section.

## Emergency Procedures

### System Down - Complete Outage

**Symptoms**: API returns 500 errors, Orange Pi daemon offline, no new messages

**Immediate Actions**:
```bash
# 1. Check Cloudflare Workers status
curl -I https://sexy.qzz.io/api/health
# Expected: HTTP/1.1 200 OK

# 2. Check Orange Pi daemon
ssh root@10.171.150.102 'systemctl status sms-dashboard-daemon'
# Expected: active (running)

# 3. If daemon is down, restart immediately
ssh root@10.171.150.102 'systemctl restart sms-dashboard-daemon'

# 4. Monitor restart
ssh root@10.171.150.102 'journalctl -u sms-dashboard-daemon -f'
```

**Recovery Priority**:
1. Restore API service (Cloudflare Workers)
2. Restart Orange Pi daemon
3. Verify modem detection
4. Validate data flow

### Partial Service Degradation

**Symptoms**: Some modems offline, intermittent API errors, delayed message processing

**Diagnostic Commands**:
```bash
# Check which modems are problematic
npx wrangler d1 execute sms-dashboard --remote --command="
SELECT equipment_id, status, datetime(updated_at) as last_update 
FROM modems 
WHERE status != 'connected' OR datetime(updated_at) < datetime('now', '-5 minutes')
ORDER BY updated_at"

# Check daemon performance
ssh root@10.171.150.102 'journalctl -u sms-dashboard-daemon | grep -E "(ERROR|WARN)" | tail -20'
```

## Component-Specific Troubleshooting

### Cloudflare Workers Issues

#### API Authentication Errors

**Symptom**: `Authentication error [code: 10000]`

**Solution**:
```bash
# Re-authenticate with Cloudflare
npx wrangler login

# Verify authentication
npx wrangler whoami

# If still failing, check API token permissions
# Cloudflare Dashboard > API Tokens > Permissions should include:
# - Zone:Zone:Read
# - Zone:Zone Settings:Edit  
# - Worker:Script:Edit
```

#### Database Connection Failures

**Symptom**: `Database error: no such table`

**Diagnosis**:
```bash
# Check D1 database exists
npx wrangler d1 list

# Verify database binding in wrangler.toml
cat wrangler.toml | grep -A5 "\[\[d1_databases\]\]"

# Expected output:
# [[d1_databases]]
# binding = "DB"
# database_name = "sms-dashboard"  
# database_id = "your-database-id"
```

**Solution**:
```bash
# If database missing, recreate
npx wrangler d1 create sms-dashboard

# Update wrangler.toml with new database_id

# Run migrations
npx wrangler d1 execute sms-dashboard --remote --file=migrations/schema.sql
```

#### Slow API Response Times

**Symptom**: API calls taking >2 seconds

**Diagnosis**:
```bash
# Monitor Workers logs
npx wrangler tail sms-dashboard --format pretty

# Check database query performance
npx wrangler d1 execute sms-dashboard --remote --command="
SELECT COUNT(*) as total_phones, 
       MAX(datetime(updated_at)) as latest_update
FROM device_view"
```

**Solutions**:
```bash
# 1. Clear statement cache (restart Workers)
npx wrangler dev --remote  # Stop with Ctrl+C
npx wrangler deploy

# 2. Check for missing indexes
npx wrangler d1 execute sms-dashboard --remote --file=migrations/add_performance_indexes.sql

# 3. Analyze slow queries
# Add to API handler temporarily:
# console.time('query');
# const result = await db.query();
# console.timeEnd('query');
```

### Orange Pi Daemon Issues

#### Daemon Won't Start

**Symptom**: `systemctl status sms-dashboard-daemon` shows failed

**Diagnosis**:
```bash
# Check detailed error logs
ssh root@10.171.150.102 'journalctl -u sms-dashboard-daemon --no-pager -l'

# Common error patterns:
# - "Permission denied": Check file permissions
# - "Connection refused": API connectivity issue  
# - "ModemManager not available": ModemManager service down
```

**Solutions by Error Type**:

**Permission Error**:
```bash
# Fix daemon binary permissions
ssh root@10.171.150.102 'chmod +x /run/current-system/sw/bin/sms-dashboard-daemon'

# Check secrets permissions
ssh root@10.171.150.102 'ls -la /run/secrets/sms-dashboard-*'
# Expected: readable by sms-dashboard user
```

**API Connection Error**:
```bash
# Test API connectivity
ssh root@10.171.150.102 'curl -H "X-API-Key: test" https://sexy.qzz.io/api/health'

# Check DNS resolution
ssh root@10.171.150.102 'nslookup sexy.qzz.io'

# Check secrets content
ssh root@10.171.150.102 'cat /run/secrets/sms-dashboard-api-url'
ssh root@10.171.150.102 'cat /run/secrets/sms-dashboard-api-key | wc -c'
# Expected: ~64 characters for API key
```

**ModemManager Error**:
```bash
# Restart ModemManager
ssh root@10.171.150.102 'systemctl restart ModemManager'

# Wait for modems to enumerate
sleep 10

# Check modem detection
ssh root@10.171.150.102 'mmcli -L'
```

#### High Memory Usage

**Symptom**: Daemon using >200MB RAM (normal: ~50MB for 54 modems)

**Diagnosis**:
```bash
# Check memory usage trend
ssh root@10.171.150.102 'ps -o pid,ppid,cmd,etime,rss,vsz $(pgrep sms-dashboard-daemon)'

# Check for memory leaks in logs
ssh root@10.171.150.102 'journalctl -u sms-dashboard-daemon | grep -i "memory\|alloc\|leak"'
```

**Solutions**:
```bash
# 1. Restart daemon (immediate fix)
ssh root@10.171.150.102 'systemctl restart sms-dashboard-daemon'

# 2. Check for arena allocator issues
ssh root@10.171.150.102 'journalctl -u sms-dashboard-daemon | grep -c "arena.deinit"'
# Should see regular cleanup messages

# 3. If persistent, check for version mismatch
ssh root@10.171.150.102 'sms-dashboard-daemon --version'
# Expected: v3.6.0
```

#### Worker Thread Deadlocks (Legacy Issue)

**Symptom**: Daemon stops processing, no new messages, CPU usage drops to 0%

**Note**: This issue was eliminated in v3.6.0 through lock-free architecture, but may occur in older versions.

**For v3.6.0**:
```bash
# Check for impossible deadlocks (should never occur)
ssh root@10.171.150.102 'journalctl -u sms-dashboard-daemon | grep -i deadlock'
# Expected: no results

# Check worker thread activity
ssh root@10.171.150.102 'journalctl -u sms-dashboard-daemon | grep "Worker.*started" | tail -5'
# Expected: 8 worker threads started
```

**For older versions**:
```bash
# Emergency restart
ssh root@10.171.150.102 'systemctl restart sms-dashboard-daemon'

# Upgrade to v3.6.0
cd nixos-config
nixos-rebuild switch --flake .#orange-pi \
    --target-host root@10.171.150.102 \
    --build-host root@10.171.150.102 \
    --impure
```

### ModemManager Issues

#### Modems Not Detected

**Symptom**: `mmcli -L` shows fewer than expected modems

**Diagnosis**:
```bash
# Check USB device enumeration
ssh root@10.171.150.102 'lsusb | grep -c "2c7c:0121"'  # Quectel EC20
# Expected: Your modem count

# Check ModemManager logs
ssh root@10.171.150.102 'journalctl -u ModemManager | tail -20'
```

**Solutions**:
```bash
# 1. Check USB hub power
ssh root@10.171.150.102 'dmesg | grep -i "usb.*power"'
# Look for power-related warnings

# 2. Reset problematic USB ports
ssh root@10.171.150.102 'echo "1-1" > /sys/bus/usb/drivers/usb/unbind'
sleep 2
ssh root@10.171.150.102 'echo "1-1" > /sys/bus/usb/drivers/usb/bind'

# 3. Restart ModemManager if needed
ssh root@10.171.150.102 'systemctl restart ModemManager'
```

#### SIM Card Detection Failures

**Symptom**: Modems detected but no ICCID/phone numbers

**Diagnosis**:
```bash
# Check specific modem SIM status
ssh root@10.171.150.102 'mmcli -m 0'  # Replace 0 with modem number
# Look for SIM path: /org/freedesktop/ModemManager1/SIM/X

# If SIM path exists, check SIM details
ssh root@10.171.150.102 'mmcli -i 0'  # Replace 0 with SIM number
```

**Solutions**:
```bash
# 1. SIM not inserted or loose - physical check required
# 2. SIM PIN locked - check if PIN required:
ssh root@10.171.150.102 'mmcli -i 0 | grep -i pin'

# If PIN required, unlock (if known):
# mmcli -i 0 --pin=1234

# 3. Reset specific modem
ssh root@10.171.150.102 'mmcli -m 0 --disable'
sleep 3
ssh root@10.171.150.102 'mmcli -m 0 --enable'
```

### Database Issues

#### Device Count Discrepancies

**Symptom**: Frontend shows different counts than daemon reports

**Diagnosis**:
```bash
# Check all count sources
npx wrangler d1 execute sms-dashboard --remote --command="
SELECT 
    (SELECT COUNT(*) FROM modems WHERE status = 'connected') as db_modems,
    (SELECT COUNT(*) FROM sims WHERE status = 'active') as db_sims,
    (SELECT COUNT(*) FROM device_view) as view_count"

# Check daemon health table
npx wrangler d1 execute sms-dashboard --remote --command="
SELECT modem_count, datetime(last_heartbeat) as heartbeat 
FROM daemon_health WHERE daemon_id = 'orange-pi-main'"
```

**Solution**:
```bash
# Force daemon to resync device counts
ssh root@10.171.150.102 'systemctl restart sms-dashboard-daemon'

# Wait for first heartbeat
sleep 30

# Verify counts match
npx wrangler d1 execute sms-dashboard --remote --command="
SELECT * FROM daemon_health WHERE daemon_id = 'orange-pi-main'"
```

#### Phantom/Stale Modems

**Symptom**: Database shows modems as connected but daemon can't find them

**Diagnosis**:
```bash
# Find stale entries (no update in 2+ minutes)
npx wrangler d1 execute sms-dashboard --remote --command="
SELECT equipment_id, status, datetime(updated_at) as last_update 
FROM modems 
WHERE status = 'connected' 
AND datetime(updated_at) < datetime('now', '-2 minutes')"
```

**Solution**:
```bash
# Clean up stale modems automatically
npx wrangler d1 execute sms-dashboard --remote --command="
UPDATE modems 
SET status = 'disconnected' 
WHERE status = 'connected' 
AND datetime(updated_at) < datetime('now', '-2 minutes')"

# Verify cleanup
npx wrangler d1 execute sms-dashboard --remote --command="
SELECT COUNT(*) as phantom_count FROM modems 
WHERE status = 'connected' 
AND datetime(updated_at) < datetime('now', '-2 minutes')"
# Expected: 0
```

#### Migration Issues

**Symptom**: Error during v1 to v2 database migration

**Diagnosis**:
```bash
# Check current schema version
npx wrangler d1 execute sms-dashboard --remote --command="
SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"

# Check for v1 tables still present
npx wrangler d1 execute sms-dashboard --remote --command="
SELECT name FROM sqlite_master WHERE name = 'phones'"
```

**Recovery Options**:
```bash
# Option 1: Complete rollback to v1
npx wrangler d1 execute sms-dashboard --remote --file=migrations/rollback-to-phones.sql

# Option 2: Re-run migration from clean state
npx wrangler d1 execute sms-dashboard --remote --file=migrations/step1_backup_and_drop.sql
npx wrangler d1 execute sms-dashboard --remote --file=migrations/step2_recreate_tables.sql
npx wrangler d1 execute sms-dashboard --remote --file=migrations/step3_restore_data.sql

# Option 3: Validate and continue
node scripts/validate-migration.js
```

### Performance Issues

#### Slow Message Processing

**Symptom**: Messages appear in API calls minutes after being received

**Diagnosis**:
```bash
# Check daemon processing times
ssh root@10.171.150.102 'journalctl -u sms-dashboard-daemon | grep "📤 Uploaded" | tail -10'

# Look for batch processing delays
ssh root@10.171.150.102 'journalctl -u sms-dashboard-daemon | grep "batch" | tail -10'

# Check queue depths
ssh root@10.171.150.102 'journalctl -u sms-dashboard-daemon | grep "queue.*size" | tail -10'
```

**Solutions**:
```bash
# 1. Reduce batch intervals (edit daemon config if needed)
# See performance-optimizations.md for specific changes

# 2. Check for HTTP timeout issues
ssh root@10.171.150.102 'journalctl -u sms-dashboard-daemon | grep -i timeout'

# 3. Monitor API response times
ssh root@10.171.150.102 'curl -w "%{time_total}\n" -H "X-API-Key: $API_KEY" https://sexy.qzz.io/api/health'
# Expected: < 0.5 seconds
```

#### High API Response Times

**Symptom**: API calls taking >2 seconds consistently

**Diagnosis**:
```bash
# Monitor Workers execution time
npx wrangler tail sms-dashboard --format pretty

# Check for expensive queries
npx wrangler d1 execute sms-dashboard --remote --command="
EXPLAIN QUERY PLAN SELECT * FROM device_view WHERE status = 'connected'"

# Verify indexes exist
npx wrangler d1 execute sms-dashboard --remote --command="
SELECT name FROM sqlite_master WHERE type='index'"
```

**Solutions**:
```bash
# 1. Recreate missing indexes
npx wrangler d1 execute sms-dashboard --remote --file=migrations/add_missing_indexes.sql

# 2. Clear any query bottlenecks
# Check for full table scans in EXPLAIN output
# Add indexes for frequent WHERE clauses

# 3. Consider database optimization
npx wrangler d1 execute sms-dashboard --remote --command="VACUUM"
npx wrangler d1 execute sms-dashboard --remote --command="ANALYZE"
```

## Network and Connectivity Issues

### API Connectivity from Orange Pi

**Symptom**: Daemon can't reach Cloudflare Workers API

**Diagnosis**:
```bash
# Test basic connectivity
ssh root@10.171.150.102 'ping -c 3 1.1.1.1'

# Test DNS resolution
ssh root@10.171.150.102 'nslookup sexy.qzz.io'

# Test HTTPS connectivity
ssh root@10.171.150.102 'curl -I https://sexy.qzz.io'

# Test API endpoint
ssh root@10.171.150.102 'curl -H "X-API-Key: test" https://sexy.qzz.io/api/health'
```

**Solutions**:
```bash
# 1. DNS issues
ssh root@10.171.150.102 'echo "nameserver 1.1.1.1" >> /etc/resolv.conf'

# 2. Firewall blocking HTTPS
ssh root@10.171.150.102 'iptables -L OUTPUT | grep -i drop'
# Check for HTTPS (port 443) blocks

# 3. SSL certificate issues
ssh root@10.171.150.102 'curl -k https://sexy.qzz.io/api/health'
# If this works but normal curl fails, SSL certificate problem
```

### Frontend Loading Issues

**Symptom**: Web dashboard won't load or shows authentication errors

**Diagnosis**:
```bash
# Check Workers serving frontend
curl -I https://sexy.qzz.io/

# Check Auth0 configuration
curl https://sexy.qzz.io/.well-known/jwks.json

# Test API endpoints
curl https://sexy.qzz.io/api/health
```

**Solutions**:
```bash
# 1. Clear browser cache and try again
# 2. Check Auth0 callback URLs include your domain
# 3. Verify secrets are set correctly
npx wrangler secret list
```

## Monitoring and Alerting

### Setting Up Basic Monitoring

**Health Check Script** (`scripts/health-check.sh`):
```bash
#!/bin/bash

API_HEALTH=$(curl -s -o /dev/null -w "%{http_code}" https://sexy.qzz.io/api/health)
DAEMON_STATUS=$(ssh root@10.171.150.102 'systemctl is-active sms-dashboard-daemon' 2>/dev/null || echo "failed")

echo "API Health: $API_HEALTH (expected: 200)"
echo "Daemon Status: $DAEMON_STATUS (expected: active)"

if [ "$API_HEALTH" != "200" ] || [ "$DAEMON_STATUS" != "active" ]; then
    echo "❌ System unhealthy!"
    exit 1
else
    echo "✅ System healthy"
    exit 0
fi
```

**Automated Monitoring** (crontab):
```bash
# Run every 5 minutes
*/5 * * * * /path/to/health-check.sh || echo "SMS Dashboard unhealthy at $(date)" | mail -s "Alert" admin@example.com
```

### Log Analysis

**Find Common Errors**:
```bash
# Cloudflare Workers errors
npx wrangler tail sms-dashboard --format pretty | grep -i error

# Orange Pi daemon errors  
ssh root@10.171.150.102 'journalctl -u sms-dashboard-daemon --since="1 hour ago" | grep -E "ERROR|FATAL"'

# ModemManager errors
ssh root@10.171.150.102 'journalctl -u ModemManager --since="1 hour ago" | grep -i error'
```

**Performance Analysis**:
```bash
# API response time trends
npx wrangler tail sms-dashboard | grep "time_total" | tail -20

# Daemon cycle time analysis
ssh root@10.171.150.102 'journalctl -u sms-dashboard-daemon | grep "cycle.*ms" | tail -20'
```

This troubleshooting guide covers the most common issues encountered in production SMS Dashboard deployments. For issues not covered here, check the component-specific documentation or examine logs for specific error messages.