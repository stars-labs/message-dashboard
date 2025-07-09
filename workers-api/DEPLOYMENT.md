# Deployment Guide for SMS Dashboard API

## Prerequisites
- Cloudflare account
- Wrangler CLI installed (`npm install -g wrangler`)
- Logged in to Wrangler (`wrangler login`)

## Step 1: Create D1 Database

```bash
# Create the database
wrangler d1 create sms-dashboard

# Note the database_id from the output
# It will look like: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

## Step 2: Create KV Namespace

```bash
# Create KV namespace for sessions
wrangler kv:namespace create "SESSIONS"

# Note the id from the output
```

## Step 3: Update wrangler.toml

Update the following in `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "sms-dashboard"
database_id = "YOUR_DATABASE_ID_HERE"  # Replace with actual ID

[[kv_namespaces]]
binding = "SESSIONS"
id = "YOUR_KV_NAMESPACE_ID_HERE"  # Replace with actual ID

[vars]
ENVIRONMENT = "production"
FRONTEND_URL = "https://your-frontend-domain.com"  # Update with your frontend URL
```

## Step 4: Apply Database Schema

```bash
# Run the migration
wrangler d1 execute sms-dashboard --file=schema.sql
```

## Step 5: Set Secrets

```bash
# API Key for Orange Pi integration
wrangler secret put API_KEY

# Cloudflare Zero Trust OAuth credentials
wrangler secret put CF_ACCESS_CLIENT_ID
wrangler secret put CF_ACCESS_CLIENT_SECRET
```

## Step 6: Deploy

```bash
# Deploy to Cloudflare Workers
wrangler deploy
```

The deployment will output your Worker URL, which will look like:
`https://sms-dashboard-api.<your-subdomain>.workers.dev`

## Step 7: Configure Cloudflare Zero Trust (Optional)

1. Go to [Cloudflare Zero Trust Dashboard](https://one.dash.cloudflare.com/)
2. Create an OAuth application
3. Add allowed redirect URLs:
   - `https://your-worker-url/api/auth/callback`
   - `http://localhost:5173/api/auth/callback` (for local development)
4. Copy the Client ID and Client Secret
5. Update the secrets using `wrangler secret put`

## Step 8: Update Frontend Configuration

Update your frontend `.env` file:

```env
VITE_API_BASE_URL=https://sms-dashboard-api.<your-subdomain>.workers.dev
```

## Deployment Commands Summary

```bash
# Quick deployment (after initial setup)
cd workers-api
wrangler deploy

# View logs
wrangler tail

# Execute SQL queries
wrangler d1 execute sms-dashboard --command="SELECT * FROM messages LIMIT 10"

# Update secrets
wrangler secret put SECRET_NAME
```

## Troubleshooting

### Database Issues
- Make sure the database ID in wrangler.toml matches the created database
- Check if schema.sql was applied successfully

### Authentication Issues
- Verify OAuth credentials are set correctly
- Check redirect URLs in Cloudflare Zero Trust

### WebSocket Issues
- Durable Objects require a paid Cloudflare Workers plan
- Check browser console for WebSocket connection errors

### CORS Issues
- Update FRONTEND_URL in wrangler.toml
- Check Access-Control headers in middleware/cors.js