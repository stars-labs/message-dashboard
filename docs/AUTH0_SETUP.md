# Auth0 Setup Guide for SMS Dashboard

## Prerequisites
- Auth0 account (free tier is sufficient)
- Access to Auth0 Dashboard

## Step 1: Create Auth0 Application

1. Log in to [Auth0 Dashboard](https://manage.auth0.com/)
2. Navigate to **Applications** → **Create Application**
3. Choose:
   - Name: `SMS Dashboard`
   - Application Type: `Single Page Application`
4. Click **Create**

## Step 2: Configure Application Settings

In your Auth0 application settings:

### Basic Information
- Note down:
  - **Domain**: `your-tenant.auth0.com`
  - **Client ID**: `your-client-id`
  - **Client Secret**: `your-client-secret` (under Settings)

### Application URIs
Configure the following URLs:

- **Allowed Callback URLs**:
  ```
  https://your-worker-domain.workers.dev/api/auth/callback
  http://localhost:8787/api/auth/callback
  ```

- **Allowed Logout URLs**:
  ```
  https://your-frontend-domain.com
  http://localhost:5173
  ```

- **Allowed Web Origins**:
  ```
  https://your-frontend-domain.com
  http://localhost:5173
  ```

### Save Changes
Click **Save Changes** at the bottom of the page.

## Step 3: Configure Auth0 API (Optional but Recommended)

1. Navigate to **APIs** → **Create API**
2. Configure:
   - Name: `SMS Dashboard API`
   - Identifier: `https://sms-dashboard.api`
   - Signing Algorithm: `RS256`
3. Click **Create**

## Step 4: Set Up Cloudflare Workers Environment

### Update wrangler.toml
```toml
[vars]
ENVIRONMENT = "production"
FRONTEND_URL = "https://your-frontend-domain.com"
AUTH0_DOMAIN = "your-tenant.auth0.com"  # Add this line
```

### Set Secrets
```bash
# Set Auth0 secrets
wrangler secret put AUTH0_CLIENT_ID
# Enter: your-auth0-client-id

wrangler secret put AUTH0_CLIENT_SECRET
# Enter: your-auth0-client-secret

wrangler secret put AUTH0_AUDIENCE
# Enter: https://sms-dashboard.api (optional)

# Set API key for Orange Pi
wrangler secret put API_KEY
# Enter: your-secure-api-key
```

## Step 5: Update Frontend Configuration

Create `.env` file in the frontend directory:
```env
VITE_API_BASE_URL=https://your-worker-domain.workers.dev
```

## Step 6: Deploy

### Backend (Cloudflare Workers)
```bash
cd workers-api
wrangler deploy
```

### Frontend
```bash
cd ..
npm run build
# Deploy dist folder to your hosting service
```

## Step 7: Test Authentication Flow

1. Open your frontend URL
2. Click "使用 Auth0 登录" (Login with Auth0)
3. You should be redirected to Auth0 login page
4. After successful login, you'll be redirected back to the dashboard

## Auth0 Features You Can Enable

### 1. Social Logins
In Auth0 Dashboard → **Authentication** → **Social**:
- Enable Google, GitHub, Microsoft, etc.
- Configure OAuth apps for each provider

### 2. Multi-factor Authentication
In Auth0 Dashboard → **Security** → **Multi-factor Auth**:
- Enable SMS, Authenticator apps, etc.
- Configure MFA policies

### 3. User Management
In Auth0 Dashboard → **User Management** → **Users**:
- View all registered users
- Manually create users
- Block/unblock users

### 4. Rules & Actions
In Auth0 Dashboard → **Auth Pipeline** → **Rules**:
- Add custom logic to authentication flow
- Example: Email domain restrictions

```javascript
function emailDomainWhitelist(user, context, callback) {
  const whitelist = ['yourcompany.com']; // authorized domains
  const userHasAccess = whitelist.some(
    domain => user.email && user.email.endsWith(`@${domain}`)
  );

  if (!userHasAccess) {
    return callback(new UnauthorizedError('Access denied.'));
  }

  return callback(null, user, context);
}
```

## Troubleshooting

### Common Issues

1. **"Callback URL mismatch" error**
   - Ensure callback URLs in Auth0 match exactly
   - Check for trailing slashes
   - Verify protocol (http vs https)

2. **CORS errors**
   - Add your frontend domain to Allowed Web Origins
   - Check CORS middleware in Workers

3. **"Invalid token" errors**
   - Verify Auth0 domain is correct
   - Check if secrets are set correctly
   - Ensure token hasn't expired

### Debug Mode

Add these to your Worker for debugging:
```javascript
console.log('Auth0 Domain:', env.AUTH0_DOMAIN);
console.log('Callback URL:', `${url.origin}/api/auth/callback`);
```

## Security Best Practices

1. **Never expose Client Secret**
   - Only use it in backend (Workers)
   - Never include in frontend code

2. **Use HTTPS everywhere**
   - Auth0 requires HTTPS for production
   - Use Cloudflare SSL

3. **Implement token refresh**
   - Auth0 tokens expire
   - Implement refresh token flow for better UX

4. **Restrict callback URLs**
   - Only add necessary URLs
   - Remove development URLs in production

## Additional Resources

- [Auth0 Docs](https://auth0.com/docs)
- [Auth0 + SPA Quick Start](https://auth0.com/docs/quickstart/spa)
- [JWT.io](https://jwt.io/) - Debug JWT tokens
- [Auth0 Community](https://community.auth0.com/)