# Auth0 Configuration for Unified Deployment

When deploying the unified SMS Dashboard (frontend + backend in single Worker), you need to update your Auth0 application settings.

## Steps to Update Auth0

1. **Log in to Auth0 Dashboard**
   - Go to https://manage.auth0.com/
   - Navigate to Applications > Your Application > Settings

2. **Update Application URLs**
   
   Replace all instances of separate frontend/backend URLs with your unified Worker URL:

   **Allowed Callback URLs:**
   ```
   https://sms-dashboard.xiongchenyu6.workers.dev/api/auth/callback
   ```

   **Allowed Logout URLs:**
   ```
   https://sms-dashboard.xiongchenyu6.workers.dev
   ```

   **Allowed Web Origins:**
   ```
   https://sms-dashboard.xiongchenyu6.workers.dev
   ```

   **Allowed Origins (CORS):**
   ```
   https://sms-dashboard.xiongchenyu6.workers.dev
   ```

3. **Save Changes**
   - Click "Save Changes" at the bottom of the settings page

## Custom Domain Configuration

If you're using a custom domain (e.g., sexy.qzz.io), update all URLs accordingly:

**Example with custom domain:**
- Allowed Callback URLs: `https://sexy.qzz.io/api/auth/callback`
- Allowed Logout URLs: `https://sexy.qzz.io`
- Allowed Web Origins: `https://sexy.qzz.io`
- Allowed Origins (CORS): `https://sexy.qzz.io`

## Deployment Commands

1. **Deploy to Workers (default domain):**
   ```bash
   ./deploy-unified.sh
   ```

2. **Deploy with custom domain:**
   - First update `wrangler.unified.toml` with your custom domain in FRONTEND_URL
   - Then run the deployment script

## Verify Configuration

After deployment, test the authentication flow:
1. Go to your app URL
2. Click login
3. You should be redirected to Auth0
4. After successful login, you should be redirected back to your app
5. Check that the session is maintained

## Troubleshooting

If authentication fails:
1. Check browser console for errors
2. Verify all URLs in Auth0 match exactly (including https://)
3. Ensure secrets are properly set in Workers:
   ```bash
   wrangler secret put AUTH0_DOMAIN -c wrangler.unified.toml
   wrangler secret put AUTH0_CLIENT_ID -c wrangler.unified.toml
   wrangler secret put AUTH0_CLIENT_SECRET -c wrangler.unified.toml
   ```