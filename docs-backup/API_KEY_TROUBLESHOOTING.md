# API Key Troubleshooting Guide

This guide helps resolve API key authentication issues between the Orange Pi daemon and the SMS Dashboard API.

## Common 401 Unauthorized Issues

### Issue: API_KEY Secret Not Set in Cloudflare Workers

**Symptoms:**
- Daemon shows correct API key but still gets 401 errors
- Logs show: `HTTP status code: 401` with `{"error":"Unauthorized"}`

**Cause:**
The `API_KEY` secret was not set in Cloudflare Workers environment.

**Solution:**
1. Get the API key from the Orange Pi SOPS secrets or generate a new one
2. Set it in Cloudflare Workers:
   ```bash
   cd sms-dashboard
   echo "your-64-character-api-key" | npx wrangler secret put API_KEY
   ```

### Issue: API Key Contains Whitespace

**Symptoms:**
- Intermittent 401 errors
- API key length appears correct but authentication fails

**Cause:**
The API key file contains newlines or trailing spaces.

**Solution:**
In the NixOS module (`sms-daemon.nix`), the API key is trimmed:
```nix
export SMS_API_KEY="$(cat ${cfg.apiKeyFile} | tr -d '\n')"
```

### Issue: Case-Sensitive Headers

**Symptoms:**
- API key is correct but authentication fails
- Works with curl but not from daemon

**Cause:**
HTTP header names should use proper casing. The server expects `X-API-Key`.

**Solution:**
Ensure the daemon sends the header as `X-API-Key` (not `x-api-key`).

## Debugging Steps

1. **Check API Key on Orange Pi:**
   ```bash
   ssh root@10.171.150.102
   cat /run/secrets/sms-dashboard/api-key | od -c
   ```

2. **Test API Key Directly:**
   ```bash
   curl -X POST https://sexy.qzz.io/api/control/heartbeat \
     -H "Content-Type: application/json" \
     -H "X-API-Key: your-api-key" \
     -d '{"device_id":"test","version":"1.0","status":"online"}'
   ```

3. **Check Cloudflare Secrets:**
   ```bash
   cd sms-dashboard
   npx wrangler secret list
   ```

4. **View Daemon Logs:**
   ```bash
   ssh root@10.171.150.102 'journalctl -u sms-daemon -f'
   ```

## API Key Requirements

- Length: 64 characters
- Characters: Alphanumeric only (a-z, A-Z, 0-9)
- No spaces, newlines, or special characters
- Case-sensitive

## Example Working Configuration

1. **Generate API Key:**
   ```bash
   openssl rand -hex 32
   ```

2. **Set in SOPS (Orange Pi):**
   ```yaml
   sms-dashboard:
     api-key: 4025b0194ccc456bbcc9bb26a6b0ecf88ad7c666e23949c7a7b1b967d8feee5a
   ```

3. **Set in Cloudflare:**
   ```bash
   echo "4025b0194ccc456bbcc9bb26a6b0ecf88ad7c666e23949c7a7b1b967d8feee5a" | npx wrangler secret put API_KEY
   ```

4. **Deploy:**
   ```bash
   # Deploy to Cloudflare
   cd sms-dashboard
   npm run deploy

   # Deploy to Orange Pi
   nixos-rebuild switch --flake .#orange-pi \
     --target-host root@10.171.150.102 \
     --build-host root@10.171.150.102 \
     --impure
   ```