# Cloudflare Architecture Documentation

## Overview

This document outlines the architecture for deploying the SMS Dashboard using Cloudflare's free tier services.

## Free Cloudflare Services Used

1. **Cloudflare Workers** (Free tier: 100,000 requests/day)
   - Backend API server
   - Authentication middleware
   - Request routing

2. **Cloudflare D1** (Free tier: 5GB storage, 5 million rows read/day)
   - SQLite database for storing messages and phone data
   - Persistent storage for OAuth sessions

3. **Cloudflare Zero Trust** (Free tier: up to 50 users)
   - OAuth2 authentication with Google, GitHub, etc.
   - Access control and user management

4. **Cloudflare KV** (Free tier: 100,000 reads/day, 1,000 writes/day)
   - Session storage
   - Caching frequently accessed data

5. **Cloudflare Pages** (Free tier: unlimited sites)
   - Frontend hosting
   - Automatic deployments from GitHub

## Architecture Flow

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│                 │     │                  │     │                 │
│  Orange Pi 5+   │────▶│ Cloudflare       │────▶│  Cloudflare D1  │
│  (95 EC20s)     │ API │ Workers API      │     │  (Database)     │
│                 │     │                  │     │                 │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                               │
                               ▼
                        ┌──────────────────┐
                        │ Cloudflare Zero  │
                        │ Trust (OAuth2)   │
                        └──────────────────┘
                               │
                               ▼
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│                 │     │                  │     │                 │
│   Web Users     │────▶│ Cloudflare Pages │────▶│ Cloudflare KV   │
│  (Browser)      │     │ (Frontend)       │     │ (Session Cache) │
│                 │     │                  │     │                 │
└─────────────────┘     └──────────────────┘     └─────────────────┘
```

## Authentication Flow

1. User accesses the dashboard
2. Frontend checks for valid session token
3. If no token, redirect to Cloudflare Zero Trust login
4. User authenticates with OAuth2 provider (Google/GitHub)
5. Zero Trust validates and issues access token
6. Token stored in KV for session management
7. All API requests include bearer token

## API Endpoints

### Public Endpoints (No Auth Required)
- `GET /api/health` - Health check

### Protected Endpoints (Auth Required)

#### Phone Management
- `GET /api/phones` - List all phones
- `POST /api/phones` - Update phone status
- `GET /api/phones/:id` - Get specific phone details

#### Message Management
- `GET /api/messages` - List messages with pagination
- `POST /api/messages` - Create new message (from Orange Pi)
- `POST /api/messages/send` - Send SMS
- `GET /api/messages/:id` - Get specific message

#### Statistics
- `GET /api/stats` - Get dashboard statistics

### Control Server Endpoints (API Key Auth)
- `POST /api/control/messages` - Bulk upload messages from Orange Pi
- `POST /api/control/phones` - Update phone statuses

## Database Schema (D1)

### phones table
```sql
CREATE TABLE phones (
  id TEXT PRIMARY KEY,
  number TEXT NOT NULL,
  country TEXT NOT NULL,
  flag TEXT NOT NULL,
  carrier TEXT NOT NULL,
  status TEXT NOT NULL,
  signal INTEGER NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### messages table
```sql
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  phone_id TEXT NOT NULL,
  phone_number TEXT NOT NULL,
  content TEXT NOT NULL,
  source TEXT,
  timestamp TIMESTAMP NOT NULL,
  type TEXT NOT NULL,
  verification_code TEXT,
  recipient TEXT,
  status TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (phone_id) REFERENCES phones(id)
);
```

### users table
```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  provider TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_login TIMESTAMP
);
```

## Environment Variables

```env
# Cloudflare Zero Trust
CF_ACCESS_CLIENT_ID=your-client-id
CF_ACCESS_CLIENT_SECRET=your-client-secret

# API Authentication
API_KEY=your-secure-api-key-for-orange-pi

# Database
D1_DATABASE_ID=your-d1-database-id

# KV Namespace
KV_SESSION_NAMESPACE_ID=your-kv-namespace-id
```

## Security Considerations

1. **API Key Authentication**: Control server uses a secure API key
2. **OAuth2 for Users**: Web users authenticate via Zero Trust
3. **CORS Configuration**: Restrict to your domain only
4. **Rate Limiting**: Implement rate limits on Workers
5. **Input Validation**: Validate all inputs server-side
6. **HTTPS Only**: All communication over HTTPS

## Deployment Steps

1. Create Cloudflare account and enable Workers
2. Create D1 database instance
3. Set up Zero Trust application
4. Create KV namespace for sessions
5. Deploy Workers API
6. Update frontend to use Workers endpoints
7. Deploy frontend to Pages

## Cost Estimation (Free Tier)

- **Workers**: 100,000 requests/day ✓
- **D1**: 5GB storage, 5M reads/day ✓
- **KV**: 100,000 reads/day ✓
- **Zero Trust**: Up to 50 users ✓
- **Pages**: Unlimited ✓

Total monthly cost: **$0** (within free tier limits)