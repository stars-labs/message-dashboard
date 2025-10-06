# Quick Deployment Guide

## Deploy Rust Daemon with Timestamp Fix

### Prerequisites
- SSH access to Orange Pi: `root@203.116.95.146`
- Nix flake environment configured
- Git repository synced

### Deployment Command

```bash
# From repository root
nixos-rebuild switch --flake .#orange-pi \
    --use-substitutes \
    --target-host root@203.116.95.146 \
    --build-host root@203.116.95.146 \
    --impure
```

### Verify Deployment

```bash
# 1. Check service status
ssh root@203.116.95.146 'systemctl status sms-daemon'

# 2. Monitor logs for correct timestamps
ssh root@203.116.95.146 'journalctl -efu sms-daemon.service' | grep timestamp

# 3. Check database timestamps (should be ISO 8601)
npx wrangler d1 execute sms-dashboard --remote \
    --command "SELECT timestamp FROM messages ORDER BY created_at DESC LIMIT 5"
```

### Expected Results

**Service Status:**
```
● sms-daemon.service - SMS Dashboard Daemon
     Loaded: loaded
     Active: active (running)
```

**Log Output:**
```
timestamp: 2025-10-05T14:23:45+08:00   ← CORRECT FORMAT
```

**Database:**
```
┌──────────────────────────────┐
│ timestamp                    │
├──────────────────────────────┤
│ 2025-10-05T14:23:45.000Z    │  ← CORRECT
│ 2025-10-05T14:24:12.000Z    │  ← CORRECT
└──────────────────────────────┘
```

### Rollback (if needed)

```bash
# Revert to previous generation
ssh root@203.116.95.146 'nixos-rebuild switch --rollback'
```

## Deploy Web Dashboard

```bash
cd sms-dashboard
npm run deploy
```

This will:
1. Build frontend with Vite
2. Combine with Workers backend
3. Deploy to Cloudflare

### Verify Dashboard

```bash
# Tail production logs
npx wrangler tail sms-dashboard --format pretty

# Check health endpoint
curl https://sexy.qzz.io/api/health
```

## Troubleshooting

### Daemon Not Starting
```bash
# Check for errors
ssh root@203.116.95.146 'journalctl -xeu sms-daemon.service'

# Verify modem detection
ssh root@203.116.95.146 'mmcli -L'
```

### API Errors
```bash
# Check wrangler logs for specific errors
npx wrangler tail sms-dashboard --format json | jq .

# Test API key
curl -H "X-API-Key: $API_KEY" https://sexy.qzz.io/api/control/pending-sms
```

### Database Issues
```bash
# Check recent messages
npx wrangler d1 execute sms-dashboard --remote \
    --command "SELECT COUNT(*) as total, MAX(created_at) as latest FROM messages"

# Check device stats
npx wrangler d1 execute sms-dashboard --remote \
    --command "SELECT * FROM device_stats"
```

## Documentation

- **Main Docs**: `./docs/` directory
- **Architecture**: `./docs/architecture/`
- **API Reference**: `./docs/api/`
- **Troubleshooting**: `./docs/troubleshooting/`
- **Project Management**: `./docs/project-management/`

For comprehensive guidance, see `CLAUDE.md`.
