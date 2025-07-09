# Deployment Steps for Account 2764ae0fd9a5cb92c9ac67708620e54c

Follow these steps in order to deploy the SMS Dashboard:

## Step 1: Create D1 Database

```bash
cd workers-api
wrangler d1 create sms-dashboard
```

**Expected output:**
```
✅ Successfully created DB 'sms-dashboard' in region APAC
Created your new D1 database.

[[d1_databases]]
binding = "DB"
database_name = "sms-dashboard"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"  # Copy this ID
```

## Step 2: Create KV Namespace

```bash
wrangler kv:namespace create "SESSIONS"
```

**Expected output:**
```
🌀 Creating namespace with title "sms-dashboard-api-SESSIONS"
✨ Success!
Add the following to your wrangler.toml:

[[kv_namespaces]]
binding = "SESSIONS"
id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"  # Copy this ID
```

## Step 3: Update wrangler.toml

Replace the placeholder IDs with the actual ones from steps 1 and 2:

```toml
[[d1_databases]]
binding = "DB"
database_name = "sms-dashboard"
database_id = "YOUR_ACTUAL_DATABASE_ID_HERE"

[[kv_namespaces]]
binding = "SESSIONS"
id = "YOUR_ACTUAL_KV_NAMESPACE_ID_HERE"
```

Also update the frontend URL:
```toml
FRONTEND_URL = "http://localhost:5173"  # For development
# OR
FRONTEND_URL = "https://your-actual-frontend-url.pages.dev"  # For production
```

## Step 4: Apply Database Schema

First, apply the enhanced schema with Auth0 and RBAC support:

```bash
# Apply the new schema
wrangler d1 execute sms-dashboard --file=schema-v2.sql
```

## Step 5: Set Secrets

### For Auth0 Authentication:
```bash
# Auth0 Domain (e.g., your-tenant.auth0.com)
wrangler secret put AUTH0_DOMAIN

# Auth0 Client ID
wrangler secret put AUTH0_CLIENT_ID

# Auth0 Client Secret
wrangler secret put AUTH0_CLIENT_SECRET

# API Key for Orange Pi (generate a secure random string)
wrangler secret put API_KEY
```

### Generate a secure API key:
```bash
# On Linux/Mac:
openssl rand -hex 32

# Or use any password generator
```

## Step 6: Deploy the Worker

```bash
wrangler deploy
```

**Expected output:**
```
Uploaded sms-dashboard-api (X.XX sec)
Published sms-dashboard-api (X.XX sec)
  https://sms-dashboard-api.xiongchenyu6.workers.dev
Current Deployment ID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

## Step 7: Make Yourself Admin

After deployment, make your Auth0 user an admin:

```bash
# First, login through the web app to create your user record
# Then find your user ID:
wrangler d1 execute sms-dashboard --command="SELECT id, email FROM users WHERE email = 'your-email@example.com'"

# Make yourself admin:
wrangler d1 execute sms-dashboard --command="UPDATE users SET is_admin = TRUE WHERE id = 'auth0|xxxxxxxxxxxxx'"

# Also add yourself to admin group:
wrangler d1 execute sms-dashboard --command="INSERT INTO user_groups (user_id, group_id, assigned_by) VALUES ('auth0|xxxxxxxxxxxxx', 'admin', 'system')"
```

## Step 8: Configure Frontend

Update your frontend `.env` file:

```bash
cd .. # Go back to main directory
echo "VITE_API_BASE_URL=https://sms-dashboard-api.xiongchenyu6.workers.dev" > .env
```

## Step 9: Test the Deployment

1. **Test health endpoint:**
   ```bash
   curl https://sms-dashboard-api.xiongchenyu6.workers.dev/api/health
   # Should return: OK
   ```

2. **Test Auth0 login:**
   - Open your frontend
   - Click login
   - Should redirect to Auth0

## Troubleshooting

### If D1 creation fails:
```bash
# List existing databases
wrangler d1 list

# If it exists, get the ID from the list
```

### If deployment fails:
```bash
# Check logs
wrangler tail

# Check if you're in the right directory
pwd  # Should be in workers-api directory
```

### To view your Worker URL:
```bash
# After deployment, your Worker will be available at:
https://sms-dashboard-api.xiongchenyu6.workers.dev
```

## Quick Redeploy Commands

After initial setup, use these for updates:

```bash
cd workers-api

# Deploy changes
wrangler deploy

# View logs
wrangler tail

# Execute SQL
wrangler d1 execute sms-dashboard --command="SELECT COUNT(*) FROM users"
```

## Next Steps

1. Configure Auth0 application with callback URLs
2. Set up your frontend deployment
3. Configure Orange Pi with the API key
4. Add additional users and configure groups

Remember to save the database ID and KV namespace ID - you'll need them if you redeploy!