# Cloudflare Deployment Guide

This guide walks you through deploying the SMS Dashboard with Cloudflare Workers backend.

## Prerequisites

1. Cloudflare account (free tier is sufficient)
2. Node.js and npm installed locally
3. Wrangler CLI installed: `npm install -g wrangler`

## Step 1: Set up Cloudflare Services

### 1.1 Create D1 Database

```bash
# Login to Cloudflare
wrangler login

# Create D1 database
wrangler d1 create sms-dashboard

# Note the database_id from the output
```

### 1.2 Create KV Namespace

```bash
# Create KV namespace for sessions
wrangler kv:namespace create "SESSIONS"

# Note the namespace_id from the output
```

### 1.3 Set up Cloudflare Zero Trust

1. Go to [Cloudflare Zero Trust Dashboard](https://one.dash.cloudflare.com/)
2. Navigate to Access > Applications
3. Click "Add an application"
4. Choose "Self-hosted"
5. Configure:
   - Application name: "SMS Dashboard"
   - Session Duration: 24 hours
   - Application domain: `your-api.workers.dev`
6. Add authentication methods:
   - Google OAuth
   - GitHub OAuth
   - Email OTP
7. Note down:
   - Application ID
   - Client ID
   - Client Secret

## Step 2: Deploy Workers API

### 2.1 Configure wrangler.toml

Update `workers-api/wrangler.toml` with your IDs:

```toml
name = "sms-dashboard-api"
main = "src/index.js"
compatibility_date = "2023-12-01"

[[d1_databases]]
binding = "DB"
database_name = "sms-dashboard"
database_id = "YOUR_D1_DATABASE_ID"  # From step 1.1

[[kv_namespaces]]
binding = "SESSIONS"
id = "YOUR_KV_NAMESPACE_ID"  # From step 1.2

[vars]
ENVIRONMENT = "production"
FRONTEND_URL = "https://your-app.pages.dev"
CF_ACCESS_DOMAIN = "your-team.cloudflareaccess.com"
CF_ACCESS_APP_ID = "YOUR_APP_ID"  # From step 1.3
```

### 2.2 Set Secrets

```bash
cd workers-api

# Set API key for Orange Pi
wrangler secret put API_KEY
# Enter a secure random string

# Set Cloudflare Access credentials
wrangler secret put CF_ACCESS_CLIENT_ID
# Enter client ID from step 1.3

wrangler secret put CF_ACCESS_CLIENT_SECRET
# Enter client secret from step 1.3
```

### 2.3 Initialize Database

```bash
# Create tables
wrangler d1 execute sms-dashboard --file=./schema.sql
```

### 2.4 Deploy Workers

```bash
# Install dependencies
npm install

# Deploy to Cloudflare
wrangler deploy

# Note your Workers URL: https://sms-dashboard-api.YOUR-SUBDOMAIN.workers.dev
```

## Step 3: Update Frontend

### 3.1 Create API Configuration

Create `src/lib/api.js`:

```javascript
const API_BASE_URL = import.meta.env.VITE_API_URL || 'https://sms-dashboard-api.YOUR-SUBDOMAIN.workers.dev';

export async function fetchWithAuth(endpoint, options = {}) {
  const token = localStorage.getItem('auth_token');
  
  const response = await fetch(`${API_BASE_URL}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': token ? `Bearer ${token}` : '',
      ...options.headers,
    },
  });
  
  if (response.status === 401) {
    // Redirect to login
    window.location.href = `${API_BASE_URL}/api/auth/login`;
    return;
  }
  
  return response.json();
}

export const api = {
  // Auth
  async getUser() {
    return fetchWithAuth('/api/auth/me');
  },
  
  async logout() {
    await fetchWithAuth('/api/auth/logout', { method: 'POST' });
    localStorage.removeItem('auth_token');
    window.location.href = '/';
  },
  
  // Phones
  async getPhones() {
    return fetchWithAuth('/api/phones');
  },
  
  // Messages
  async getMessages(params = {}) {
    const query = new URLSearchParams(params).toString();
    return fetchWithAuth(`/api/messages?${query}`);
  },
  
  async sendMessage(data) {
    return fetchWithAuth('/api/messages/send', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },
  
  // Stats
  async getStats() {
    return fetchWithAuth('/api/stats');
  },
};
```

### 3.2 Update Environment Variables

Create `.env`:

```env
VITE_API_URL=https://sms-dashboard-api.YOUR-SUBDOMAIN.workers.dev
```

### 3.3 Handle Authentication

Update `src/App.svelte` to check for auth token:

```javascript
import { onMount } from 'svelte';
import { api } from './lib/api';

let user = null;
let loading = true;

onMount(async () => {
  // Check for token in URL (from OAuth callback)
  const urlParams = new URLSearchParams(window.location.search);
  const token = urlParams.get('token');
  
  if (token) {
    localStorage.setItem('auth_token', token);
    window.history.replaceState({}, document.title, '/');
  }
  
  // Check if user is authenticated
  try {
    const response = await api.getUser();
    if (response.user) {
      user = response.user;
    }
  } catch (error) {
    // Redirect to login
    window.location.href = `${import.meta.env.VITE_API_URL}/api/auth/login`;
  }
  
  loading = false;
});
```

## Step 4: Deploy Frontend

```bash
# Build frontend
npm run build

# Deploy to Cloudflare Pages
# 1. Go to Cloudflare Dashboard > Pages
# 2. Create a new project
# 3. Connect to GitHub repository
# 4. Set build configuration:
#    - Build command: npm run build
#    - Build output directory: dist
# 5. Add environment variables:
#    - VITE_API_URL: https://sms-dashboard-api.YOUR-SUBDOMAIN.workers.dev
```

## Step 5: Configure Orange Pi Integration

### 5.1 API Endpoints for Orange Pi

The Orange Pi should send data to these endpoints:

```bash
# Upload messages (POST)
https://sms-dashboard-api.YOUR-SUBDOMAIN.workers.dev/api/control/messages

# Headers
X-API-Key: YOUR_API_KEY
Content-Type: application/json

# Body
{
  "messages": [
    {
      "phone_id": "SIM_001",
      "phone_number": "+8613800138000",
      "content": "Your verification code is: 123456",
      "source": "Taobao",
      "timestamp": "2025-01-01T12:00:00Z"
    }
  ]
}
```

```bash
# Update phone status (POST)
https://sms-dashboard-api.YOUR-SUBDOMAIN.workers.dev/api/control/phones

# Headers
X-API-Key: YOUR_API_KEY
Content-Type: application/json

# Body
{
  "phones": [
    {
      "id": "SIM_001",
      "number": "+8613800138000",
      "country": "中国",
      "flag": "🇨🇳",
      "carrier": "中国移动",
      "status": "online",
      "signal": 85
    }
  ]
}
```

### 5.2 Example Python Script for Orange Pi

```python
import requests
import json
from datetime import datetime

API_URL = "https://sms-dashboard-api.YOUR-SUBDOMAIN.workers.dev"
API_KEY = "YOUR_API_KEY"

def upload_messages(messages):
    """Upload messages to dashboard"""
    response = requests.post(
        f"{API_URL}/api/control/messages",
        headers={
            "X-API-Key": API_KEY,
            "Content-Type": "application/json"
        },
        json={"messages": messages}
    )
    return response.json()

def update_phone_status(phones):
    """Update phone statuses"""
    response = requests.post(
        f"{API_URL}/api/control/phones",
        headers={
            "X-API-Key": API_KEY,
            "Content-Type": "application/json"
        },
        json={"phones": phones}
    )
    return response.json()

# Example usage
messages = [{
    "phone_id": "SIM_001",
    "phone_number": "+8613800138000",
    "content": "【淘宝】您的验证码是：123456",
    "source": "淘宝",
    "timestamp": datetime.now().isoformat() + "Z"
}]

result = upload_messages(messages)
print(result)
```

## Step 6: Monitor and Debug

### 6.1 View Logs

```bash
# View real-time logs
wrangler tail

# View D1 data
wrangler d1 execute sms-dashboard --command "SELECT * FROM messages LIMIT 10"
```

### 6.2 Check KV Sessions

```bash
# List sessions
wrangler kv:key list --namespace-id=YOUR_KV_NAMESPACE_ID
```

## Troubleshooting

### Common Issues

1. **CORS Errors**
   - Update `FRONTEND_URL` in wrangler.toml
   - Check CORS headers in workers-api/src/middleware/cors.js

2. **Authentication Failures**
   - Verify Zero Trust configuration
   - Check CF_ACCESS_* environment variables
   - Ensure callback URL is correct

3. **Database Errors**
   - Run schema.sql to create tables
   - Check D1 binding in wrangler.toml

4. **API Key Issues**
   - Regenerate API key with `wrangler secret put API_KEY`
   - Update Orange Pi configuration

## Security Best Practices

1. **API Keys**
   - Use strong, random API keys
   - Rotate keys regularly
   - Never commit keys to git

2. **Authentication**
   - Enable 2FA on Cloudflare account
   - Restrict Zero Trust access policies
   - Set appropriate session durations

3. **Data Protection**
   - Enable HTTPS everywhere
   - Validate all inputs
   - Implement rate limiting

## Cost Monitoring

Monitor usage in Cloudflare Dashboard:
- Workers: Analytics > Workers
- D1: Databases > Your Database > Metrics
- KV: Workers KV > Your Namespace > Metrics

Stay within free tier limits:
- Workers: 100,000 requests/day
- D1: 5M rows read/day
- KV: 100,000 reads/day