# Auth0 Google Authentication Troubleshooting Guide

## Common Issues and Solutions

### 1. Check Auth0 Application Settings

Log in to Auth0 Dashboard and verify:

1. **Allowed Callback URLs** - Must include exactly:
   ```
   https://sexy.qzz.io/api/auth/callback
   ```

2. **Allowed Web Origins** - Must include:
   ```
   https://sexy.qzz.io
   ```

3. **Allowed Logout URLs** - Must include:
   ```
   https://sexy.qzz.io
   ```

### 2. Enable Google Social Connection

1. Go to Auth0 Dashboard > Authentication > Social
2. Find Google / Gmail
3. Make sure it's enabled (toggle should be ON)
4. Click on Google to configure
5. Ensure your Google OAuth credentials are properly configured

### 3. Check Application Type

1. Go to Applications > Your App > Settings
2. Application Type should be "Single Page Application" or "Regular Web Application"
3. Token Endpoint Authentication Method should be "Post" for Regular Web Apps

### 4. Verify Secrets in Cloudflare

Run these commands to ensure secrets are set:
```bash
cd workers-api
wrangler secret list -c wrangler.unified-custom.toml
```

If any are missing, set them:
```bash
wrangler secret put AUTH0_DOMAIN -c wrangler.unified-custom.toml
# Enter: tron.jp.auth0.com

wrangler secret put AUTH0_CLIENT_ID -c wrangler.unified-custom.toml
# Enter: ZhBLVZumzA8E71ttXABQzVDdoycyDp9i

wrangler secret put AUTH0_CLIENT_SECRET -c wrangler.unified-custom.toml
# Enter: wJ6nmNpjJBcDV9cAIccLqadpsAUac2dndB5Q3M6Nrp07lPP-lSqzAPXU_jrOlXyl
```

### 5. Check Worker Logs

To see the detailed error logs:
```bash
wrangler tail sms-dashboard -c wrangler.unified-custom.toml
```

Then try to login again and watch for error messages.

### 6. Common Error Messages

**"redirect_uri_mismatch"**
- The callback URL in Auth0 doesn't match exactly
- Check for https vs http, trailing slashes, or typos

**"unauthorized_client"**
- Google connection not properly configured
- Client ID/Secret mismatch

**"access_denied"**
- User cancelled the login
- Or Google account restrictions

### 7. Test Direct Auth0 Login

Try logging in with username/password instead of Google:
1. Create a test user in Auth0 Dashboard > User Management > Users
2. Try logging in with that user

### 8. Debug Information

The updated code now logs:
- Whether an error was returned from Auth0
- The redirect URI being used
- Token exchange parameters
- Any error responses

Check the logs using:
```bash
wrangler tail sms-dashboard -c wrangler.unified-custom.toml --format pretty
```

### 9. Google-Specific Setup

If Google login specifically is failing:
1. Go to https://console.cloud.google.com/
2. Check your OAuth 2.0 Client IDs
3. Ensure Authorized redirect URIs include:
   ```
   https://tron.jp.auth0.com/login/callback
   ```
4. Check if your Google project is in production or testing mode

### 10. Clear Browser Data

Sometimes authentication issues are caused by:
- Cached redirects
- Old cookies
- Stale localStorage

Try:
1. Opening in an incognito/private window
2. Clearing site data for sexy.qzz.io
3. Clearing site data for tron.jp.auth0.com