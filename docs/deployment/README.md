# Deployment Guide (v3.6.0)

## Overview

The SMS Dashboard deployment consists of two main components: the Cloudflare Workers backend/frontend and the Orange Pi daemon. This guide covers both complete deployments and provides troubleshooting for common issues.

## Prerequisites

### Development Environment
- **Node.js**: v18+ with npm
- **Wrangler CLI**: Latest version (`npm install -g wrangler`)
- **Git**: For cloning and version control
- **Auth0 Account**: For user authentication setup

### Orange Pi Requirements
- **Orange Pi 5 Plus**: 8GB+ RAM, 8-core ARM64
- **NixOS**: Installed and configured
- **USB Infrastructure**: Powered USB 3.0 hubs (12V 10A+)
- **Modems**: 54+ Quectel EC20 or compatible LTE modems
- **Network**: Stable internet connection for daemon uploads

## Part 1: Cloudflare Workers Deployment

### Step 1: Environment Setup

Clone and prepare the repository:

```bash
git clone https://github.com/your-org/sms-dashboard.git
cd sms-dashboard/sms-dashboard
npm install
```

### Step 2: Cloudflare Authentication

```bash
# Login to Cloudflare (opens browser)
npx wrangler login

# Verify authentication
npx wrangler whoami
```

**Troubleshooting**: If you see `Authentication error [code: 10000]`, the login has expired. Always run `npx wrangler login` first when encountering auth errors.

### Step 3: Configure Secrets

Set up required environment secrets:

```bash
# Auth0 configuration
npx wrangler secret put AUTH0_DOMAIN          # e.g., your-tenant.auth0.com
npx wrangler secret put AUTH0_CLIENT_ID       # Auth0 application client ID  
npx wrangler secret put AUTH0_CLIENT_SECRET   # Auth0 application client secret
npx wrangler secret put AUTH0_AUDIENCE        # API audience (optional)

# Orange Pi daemon authentication
npx wrangler secret put API_KEY               # Generate secure random key

# Optional: Additional configuration
npx wrangler secret put SENTRY_DSN           # Error tracking (optional)
```

**Generate secure API key**:
```bash
# Linux/macOS
openssl rand -hex 32

# Or use online generator
# https://passwordsgenerator.net/ (64 characters, hex)
```

### Step 4: Database Setup

Initialize and migrate the D1 database:

```bash
# Create D1 database (first time only)
npx wrangler d1 create sms-dashboard

# Update wrangler.toml with database ID (shown in previous command output)
# Add to [[d1_databases]] section:
# database_id = "your-database-id"

# Run database migrations
npx wrangler d1 execute sms-dashboard --remote --file=migrations/schema.sql
npx wrangler d1 execute sms-dashboard --remote --file=migrations/002_refactor_phones_to_modems_sims.sql
npx wrangler d1 execute sms-dashboard --remote --file=migrations/003_migrate_phones_data.sql
npx wrangler d1 execute sms-dashboard --remote --file=migrations/004_cleanup_synthetic_entries.sql
npx wrangler d1 execute sms-dashboard --remote --file=migrations/005_create_device_view.sql

# Validate migration
node scripts/validate-migration.js
```

### Step 5: Auth0 Configuration

Configure Auth0 application settings:

#### Application Settings
```
Application Type: Single Page Application
Allowed Callback URLs: 
  - http://localhost:5173
  - https://your-domain.workers.dev
  - https://sexy.qzz.io
Allowed Logout URLs:
  - http://localhost:5173
  - https://your-domain.workers.dev
  - https://sexy.qzz.io
Allowed Web Origins:
  - http://localhost:5173
  - https://your-domain.workers.dev
  - https://sexy.qzz.io
```

#### API Configuration
```
Name: SMS Dashboard API
Identifier: https://sms-dashboard-api
Signing Algorithm: RS256
```

#### Roles and Permissions
Create roles with these permissions:
- **Admin**: `phones.read`, `messages.read`, `messages.send`, `keywords.read`, `keywords.write`
- **Viewer**: `phones.read`, `messages.read`
- **Operator**: `phones.read`, `messages.read`, `messages.send`

### Step 6: Build and Deploy

```bash
# Build unified bundle (includes frontend assets)
npm run build

# Deploy to Cloudflare Workers
npm run deploy

# Or deploy manually
npx wrangler deploy

# Verify deployment
curl https://your-domain.workers.dev/api/health
```

**Expected health response**:
```json
{
  "success": true,
  "data": {
    "status": "healthy",
    "version": "v2.0.0",
    "database": {
      "status": "connected",
      "response_time_ms": 12
    }
  }
}
```

### Step 7: Custom Domain (Optional)

```bash
# Add custom domain
npx wrangler custom-domains add sexy.qzz.io

# Or update via Cloudflare dashboard:
# Workers & Pages > your-worker > Settings > Domains > Add Custom Domain
```

## Part 2: Orange Pi Deployment

### Step 1: NixOS Setup

Ensure Orange Pi is running NixOS with flakes enabled:

```bash
# On Orange Pi, enable flakes in /etc/nixos/configuration.nix
nix.settings.experimental-features = [ "nix-command" "flakes" ];

# Rebuild system
sudo nixos-rebuild switch
```

### Step 2: Clone Repository

```bash
# On deployment machine (can be different from Orange Pi)
git clone https://github.com/your-org/sms-dashboard.git
cd sms-dashboard
```

### Step 3: Configure Secrets

Set up SOPS secrets for the daemon:

```bash
cd nixos-config

# Create or edit secrets file
sops secrets/orange-pi.yaml

# Add required secrets:
# sms-dashboard:
#   api-key: "your-api-key-from-step-3"
#   api-url: "https://sexy.qzz.io"
```

**SOPS secrets format**:
```yaml
sms-dashboard:
    api-key: ENC[AES256_GCM,data:your-encrypted-api-key,iv:...,tag:...,type:str]
    api-url: ENC[AES256_GCM,data:encrypted-url,iv:...,tag:...,type:str]
```

### Step 4: Deploy to Orange Pi

**Critical deployment command** (most commonly forgotten):

```bash
# From nixos-config directory
nixos-rebuild switch --flake .#orange-pi \
    --use-substitutes \
    --target-host root@10.171.150.102 \
    --build-host root@10.171.150.102 \
    --impure
```

**Command breakdown**:
- `--flake .#orange-pi`: Use the orange-pi configuration from current flake
- `--use-substitutes`: Download pre-built packages when possible
- `--target-host`: Deploy to this Orange Pi IP address
- `--build-host`: Build on the Orange Pi (uses its architecture)
- `--impure`: Allow impure evaluation for secrets

### Step 5: Verify Daemon Deployment

```bash
# Check daemon service status
ssh root@10.171.150.102 'systemctl status sms-dashboard-daemon'

# Expected output:
# ● sms-dashboard-daemon.service - SMS Dashboard Daemon
#    Active: active (running) since Mon 2025-01-15 10:30:00 UTC
#    Main PID: 1234 (orange-pi-daemon)

# Check daemon logs
ssh root@10.171.150.102 'journalctl -u sms-dashboard-daemon -f'

# Expected log entries:
# Jan 15 10:30:00 orange-pi daemon[1234]: 🚀 SMS Daemon v3.6.0 starting...
# Jan 15 10:30:01 orange-pi daemon[1234]: ✅ Found 54 modems via ModemManager
# Jan 15 10:30:02 orange-pi daemon[1234]: 📡 Worker pool initialized with 8 threads
# Jan 15 10:30:03 orange-pi daemon[1234]: 🔄 Lock-free queues ready (8192 slots)
```

### Step 6: Hardware Verification

```bash
# Check ModemManager status
ssh root@10.171.150.102 'systemctl status ModemManager'

# List detected modems
ssh root@10.171.150.102 'mmcli -L'

# Expected output:
# Found 54 modems:
#   /org/freedesktop/ModemManager1/Modem/0 [Quectel] EC20
#   /org/freedesktop/ModemManager1/Modem/1 [Quectel] EC20
#   ... (54 total)

# Check USB devices
ssh root@10.171.150.102 'lsusb | grep -c "2c7c:0121"'
# Expected: 54 (or your modem count)

# Check daemon memory usage
ssh root@10.171.150.102 'ps aux | grep sms-dashboard-daemon'
# Expected: ~50MB RSS for 54 modems
```

## Part 3: Integration Testing

### Step 1: End-to-End Health Check

```bash
# Test Cloudflare Workers API
curl https://sexy.qzz.io/api/health

# Test daemon connectivity (from Orange Pi)
ssh root@10.171.150.102 'curl -H "X-API-Key: YOUR_API_KEY" https://sexy.qzz.io/api/health'
```

### Step 2: Data Flow Verification

```bash
# Check if phones are being uploaded
curl -H "Authorization: Bearer $JWT_TOKEN" https://sexy.qzz.io/api/phones

# Monitor daemon uploads in real-time
ssh root@10.171.150.102 'journalctl -u sms-dashboard-daemon -f | grep "📤 Uploaded"'

# Check database for recent data
npx wrangler d1 execute sms-dashboard --remote --command="
SELECT COUNT(*) as phone_count, MAX(updated_at) as last_update 
FROM device_view 
WHERE updated_at > datetime('now', '-5 minutes')"
```

### Step 3: Performance Verification

```bash
# Check API response times
curl -w "@curl-format.txt" https://sexy.qzz.io/api/phones

# curl-format.txt contents:
#      time_namelookup:  %{time_namelookup}\n
#         time_connect:  %{time_connect}\n
#      time_appconnect:  %{time_appconnect}\n
#     time_pretransfer:  %{time_pretransfer}\n
#        time_redirect:  %{time_redirect}\n
#   time_starttransfer:  %{time_starttransfer}\n
#                     ----------\n
#           time_total:  %{time_total}\n

# Expected: time_total < 500ms

# Check daemon performance
ssh root@10.171.150.102 'journalctl -u sms-dashboard-daemon | grep "PERF:" | tail -10'
```

## Deployment Automation

### GitHub Actions Deployment

Create `.github/workflows/deploy.yml`:

```yaml
name: Deploy SMS Dashboard

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  deploy-cloudflare:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'
          
      - name: Install dependencies
        run: |
          cd sms-dashboard
          npm ci
          
      - name: Build application
        run: |
          cd sms-dashboard
          npm run build
          
      - name: Deploy to Cloudflare Workers
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          workingDirectory: 'sms-dashboard'
          command: deploy

  deploy-orange-pi:
    runs-on: ubuntu-latest
    needs: deploy-cloudflare
    if: github.ref == 'refs/heads/main'
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Nix
        uses: cachix/install-nix-action@v18
        with:
          extra_nix_config: |
            experimental-features = nix-command flakes
            
      - name: Deploy to Orange Pi
        run: |
          echo "${{ secrets.ORANGE_PI_SSH_KEY }}" > /tmp/ssh-key
          chmod 600 /tmp/ssh-key
          
          cd nixos-config
          nix run nixpkgs#nixos-rebuild -- switch \
            --flake .#orange-pi \
            --target-host root@10.171.150.102 \
            --build-host root@10.171.150.102 \
            --use-substitutes \
            --impure
```

### Deployment Script

Create `scripts/deploy.sh`:

```bash
#!/bin/bash
set -euo pipefail

ORANGE_PI_IP="10.171.150.102"
API_KEY_FILE=".api-key"

echo "🚀 Starting SMS Dashboard deployment..."

# Step 1: Deploy Cloudflare Workers
echo "📡 Deploying Cloudflare Workers..."
cd sms-dashboard
npm run deploy
cd ..

# Step 2: Test API health
echo "🔍 Testing API health..."
if curl -f -s https://sexy.qzz.io/api/health > /dev/null; then
    echo "✅ API is healthy"
else
    echo "❌ API health check failed"
    exit 1
fi

# Step 3: Deploy Orange Pi
echo "🍊 Deploying Orange Pi daemon..."
cd nixos-config
nixos-rebuild switch --flake .#orange-pi \
    --use-substitutes \
    --target-host root@$ORANGE_PI_IP \
    --build-host root@$ORANGE_PI_IP \
    --impure

# Step 4: Verify daemon
echo "🔍 Verifying daemon deployment..."
sleep 10
if ssh root@$ORANGE_PI_IP 'systemctl is-active --quiet sms-dashboard-daemon'; then
    echo "✅ Daemon is running"
else
    echo "❌ Daemon failed to start"
    ssh root@$ORANGE_PI_IP 'journalctl -u sms-dashboard-daemon --no-pager -l'
    exit 1
fi

echo "🎉 Deployment completed successfully!"
```

## Troubleshooting

### Common Cloudflare Issues

#### Wrangler Authentication Errors
```bash
# Problem: Authentication error [code: 10000]
# Solution: Re-authenticate
npx wrangler login
```

#### Secret Configuration Issues
```bash
# Problem: Missing secrets
# Solution: List and set secrets
npx wrangler secret list
npx wrangler secret put API_KEY
```

#### Database Connection Errors
```bash
# Problem: Database not found
# Solution: Check D1 configuration
npx wrangler d1 list
# Update wrangler.toml with correct database_id
```

### Common Orange Pi Issues

#### ModemManager Not Running
```bash
# Problem: ModemManager service failed
ssh root@10.171.150.102 'systemctl start ModemManager'
ssh root@10.171.150.102 'systemctl enable ModemManager'
```

#### USB Modem Detection Issues
```bash
# Check USB enumeration
ssh root@10.171.150.102 'lsusb | grep 2c7c'

# Check USB power
ssh root@10.171.150.102 'dmesg | grep -i usb | tail -20'

# Reset USB bus if needed
ssh root@10.171.150.102 'echo "1-1" > /sys/bus/usb/drivers/usb/unbind'
ssh root@10.171.150.102 'echo "1-1" > /sys/bus/usb/drivers/usb/bind'
```

#### Daemon Memory Issues
```bash
# Check memory usage
ssh root@10.171.150.102 'free -h'
ssh root@10.171.150.102 'ps aux | grep sms-dashboard-daemon'

# If memory leak suspected, restart daemon
ssh root@10.171.150.102 'systemctl restart sms-dashboard-daemon'
```

#### Network Connectivity Issues
```bash
# Test internet connectivity
ssh root@10.171.150.102 'ping -c 3 8.8.8.8'

# Test API connectivity
ssh root@10.171.150.102 'curl -I https://sexy.qzz.io'

# Check DNS resolution
ssh root@10.171.150.102 'nslookup sexy.qzz.io'
```

### Performance Issues

#### Slow API Response Times
```bash
# Monitor Cloudflare Workers logs
npx wrangler tail sms-dashboard --format pretty

# Check database query performance
npx wrangler d1 execute sms-dashboard --remote --command="
EXPLAIN QUERY PLAN SELECT * FROM device_view WHERE status = 'connected'"
```

#### High Daemon CPU Usage
```bash
# Monitor daemon performance
ssh root@10.171.150.102 'top -p $(pgrep sms-dashboard-daemon)'

# Check for worker thread issues
ssh root@10.171.150.102 'journalctl -u sms-dashboard-daemon | grep -E "(WARN|ERROR)"'
```

## Monitoring and Maintenance

### Health Monitoring

Set up monitoring for:
- API response times: `curl -w "%{time_total}" https://sexy.qzz.io/api/health`
- Daemon heartbeat: Check `daemon_health` table
- Database performance: Monitor D1 metrics
- Orange Pi resources: CPU, memory, disk usage

### Regular Maintenance

#### Weekly Tasks
- Check daemon logs for errors
- Verify all modems are detected
- Monitor API response times
- Review database growth

#### Monthly Tasks
- Update dependencies: `npm update`
- Review and rotate API keys if needed
- Check USB hub power consumption
- Backup database: `npm run db:backup`

This deployment guide ensures a reliable, production-ready SMS Dashboard system with proper monitoring and maintenance procedures.