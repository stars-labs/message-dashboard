# Manual Deployment Steps

Follow these steps to deploy the SMS Dashboard API to Cloudflare Workers:

## Step 1: Re-authenticate with Wrangler

It seems there's an authentication issue. Please run:

```bash
wrangler logout
wrangler login
```

This will open a browser for you to authenticate.

## Step 2: Choose the correct account

Based on the accounts shown, you'll need to choose which account to use. Update the `account_id` in `wrangler.toml`:

- For Chensiwei0729@gmail.com's Account: `9dcccca5dd36961792570374be029ae4`
- For Xiongchenyu6@gmail.com's Account: `2764ae0fd9a5cb92c9ac67708620e54c`

## Step 3: Create D1 Database

```bash
cd workers-api
wrangler d1 create sms-dashboard
```

Copy the database ID from the output. It will look like:
```
✅ Successfully created DB 'sms-dashboard' in region APAC
Created your new D1 database.

[[d1_databases]]
binding = "DB"
database_name = "sms-dashboard"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

## Step 4: Create KV Namespace

```bash
wrangler kv:namespace create "SESSIONS"
```

Copy the namespace ID from the output. It will look like:
```
🌀 Creating namespace with title "sms-dashboard-api-SESSIONS"
✨ Success!
Add the following to your wrangler.toml:

[[kv_namespaces]]
binding = "SESSIONS"
id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

## Step 5: Update wrangler.toml

Replace the placeholder IDs in `wrangler.toml`:

1. Replace `YOUR_DATABASE_ID` with the actual database ID from Step 3
2. Replace `YOUR_KV_NAMESPACE_ID` with the actual namespace ID from Step 4
3. Update `FRONTEND_URL` with your frontend URL (or use `http://localhost:5173` for development)

## Step 6: Apply Database Schema

```bash
wrangler d1 execute sms-dashboard --file=schema.sql
```

## Step 7: Set Secrets

Set the required secrets:

```bash
# API Key for Orange Pi (generate a secure random string)
wrangler secret put API_KEY

# For OAuth (if using Cloudflare Zero Trust)
wrangler secret put CF_ACCESS_CLIENT_ID
wrangler secret put CF_ACCESS_CLIENT_SECRET
```

## Step 8: Deploy

```bash
wrangler deploy
```

## Step 9: Note the Worker URL

After deployment, you'll see output like:
```
Uploaded sms-dashboard-api (X.XX sec)
Published sms-dashboard-api (X.XX sec)
  https://sms-dashboard-api.your-subdomain.workers.dev
```

Copy this URL - you'll need it for the frontend configuration.

## Step 10: Update Frontend Configuration

Create or update `.env` in the frontend directory:

```bash
cd ..  # Go back to main directory
echo "VITE_API_BASE_URL=https://sms-dashboard-api.your-subdomain.workers.dev" > .env
```

## Troubleshooting

### Authentication Issues
- Make sure you're logged in: `wrangler whoami`
- Check account permissions for D1 and Workers
- Try logging out and back in: `wrangler logout` then `wrangler login`

### D1 Database Issues
- Ensure you have a paid Cloudflare Workers plan (required for Durable Objects)
- Check if the database was created: `wrangler d1 list`

### Deployment Issues
- Check logs: `wrangler tail`
- Verify all secrets are set: Check in Cloudflare dashboard
- Ensure all dependencies are installed: `npm install`

## Quick Deploy Commands (after initial setup)

```bash
# Deploy changes
cd workers-api
wrangler deploy

# View logs
wrangler tail

# Run SQL queries
wrangler d1 execute sms-dashboard --command="SELECT COUNT(*) FROM messages"
```