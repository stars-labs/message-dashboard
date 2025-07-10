# Auth0 Production Configuration for sexy.qzz.io

## Auth0 Application Settings

Go to your Auth0 dashboard: https://manage.auth0.com/dashboard/jp/tron/applications

### Application URIs Configuration

Update your Auth0 application with these exact URLs:

**Allowed Callback URLs**:
```
https://sms-dashboard-api.xiongchenyu6.workers.dev/api/auth/callback
https://sexy.qzz.io
```

**Allowed Logout URLs**:
```
https://sexy.qzz.io
```

**Allowed Web Origins**:
```
https://sexy.qzz.io
https://sms-dashboard-api.xiongchenyu6.workers.dev
```

**Allowed Origins (CORS)**:
```
https://sexy.qzz.io
```

### Save Changes
Click "Save Changes" at the bottom of the page.

## Frontend Deployment to sexy.qzz.io

### Option 1: Cloudflare Pages

1. **Build the frontend**:
```bash
cd /home/freeman.xiong/Documents/github/hecoinfo/message-dashboard
npm run build
```

2. **Deploy to Cloudflare Pages**:
```bash
npx wrangler pages deploy dist --project-name sexy-qzz-io
```

3. **Configure custom domain**:
   - Go to Cloudflare Pages dashboard
   - Add custom domain: sexy.qzz.io
   - Update DNS records

### Option 2: Traditional Hosting

1. **Build**:
```bash
npm run build
```

2. **Upload `dist` folder** to your hosting provider

3. **Configure nginx** (if applicable):
```nginx
server {
    listen 443 ssl http2;
    server_name sexy.qzz.io;
    
    ssl_certificate /path/to/ssl/cert.pem;
    ssl_certificate_key /path/to/ssl/key.pem;
    
    root /var/www/sexy.qzz.io;
    index index.html;
    
    location / {
        try_files $uri $uri/ /index.html;
    }
    
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
}
```

## API Configuration Summary

- **API URL**: https://sms-dashboard-api.xiongchenyu6.workers.dev
- **Frontend URL**: https://sexy.qzz.io
- **Auth0 Domain**: tron.jp.auth0.com
- **API Key**: `af1f81f4398114f93860a83c0643974143971c8e4740e0301c74393124e3d2ae`

## Orange Pi Configuration

Configure your Orange Pi devices with:

```bash
# Environment variables or config file
API_ENDPOINT=https://sms-dashboard-api.xiongchenyu6.workers.dev/api/control
API_KEY=af1f81f4398114f93860a83c0643974143971c8e4740e0301c74393124e3d2ae
```

## Testing Production Setup

1. **Test API health**:
```bash
curl https://sms-dashboard-api.xiongchenyu6.workers.dev/api/health
# Expected: OK
```

2. **Test Auth0 login**:
   - Visit https://sexy.qzz.io
   - Click login
   - Should redirect to Auth0 and back

3. **Test Orange Pi integration**:
```bash
curl -X POST https://sms-dashboard-api.xiongchenyu6.workers.dev/api/control/messages \
  -H "X-API-Key: af1f81f4398114f93860a83c0643974143971c8e4740e0301c74393124e3d2ae" \
  -H "Content-Type: application/json" \
  -d '{"messages": []}'
```

## Make Yourself Admin

After your first login:

```bash
# Find your user ID
wrangler d1 execute sms-dashboard --remote --command="SELECT id, email, is_admin FROM users"

# Make yourself admin
wrangler d1 execute sms-dashboard --remote --command="UPDATE users SET is_admin = 1 WHERE email = 'your-email@example.com'"

# Add to admin group
wrangler d1 execute sms-dashboard --remote --command="DELETE FROM user_groups WHERE user_id = (SELECT id FROM users WHERE email = 'your-email@example.com')"
wrangler d1 execute sms-dashboard --remote --command="INSERT INTO user_groups (user_id, group_id, assigned_by) SELECT id, 'admin', 'system' FROM users WHERE email = 'your-email@example.com'"
```

## Security Checklist

✅ Auth0 URLs configured for production domain only
✅ API key stored securely (use SOPS for team sharing)
✅ HTTPS enforced on all endpoints
✅ CORS configured for sexy.qzz.io only
✅ Default user group set to 'viewer' (read-only)

## Monitoring

```bash
# View real-time logs
wrangler tail

# Check user activity
wrangler d1 execute sms-dashboard --remote --command="SELECT * FROM audit_logs ORDER BY timestamp DESC LIMIT 20"

# Monitor WebSocket connections
wrangler d1 execute sms-dashboard --remote --command="SELECT COUNT(*) as active_sessions FROM sessions WHERE expires_at > datetime('now')"
```