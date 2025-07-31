# SMS Dashboard

Unified SMS Dashboard application with Svelte frontend and Cloudflare Workers backend.

## Project Structure

```
sms-dashboard/
├── client/           # Frontend source code (Svelte)
│   ├── lib/          # Svelte components
│   └── main.js       # Entry point
├── database/         # Database files
│   └── migrations/   # SQL migration files
├── dist/             # Built frontend assets (auto-generated)
├── public/           # Static assets
├── scripts/          # Build and deployment scripts
├── server/           # Backend source code (Workers)
│   ├── durable-objects/   # WebSocket rooms
│   ├── handlers/          # API request handlers
│   ├── middleware/        # Auth and CORS middleware
│   ├── pages/            # Static pages
│   └── utils/            # Utility functions
├── package.json      # Dependencies
└── wrangler.toml     # Cloudflare Workers configuration
```

## Development

```bash
# Install dependencies
npm install

# Frontend development (Vite on port 8080)
npm run dev

# Backend development (Wrangler)
npm run dev:api

# Build frontend
npm run build

# Deploy to Cloudflare
npm run deploy
```

## Database

```bash
# Initialize local database
npm run db:init

# Run migrations on production
npm run db:migrate
```

## Configuration

Set these secrets in Cloudflare:
```bash
wrangler secret put AUTH0_DOMAIN
wrangler secret put AUTH0_CLIENT_ID
wrangler secret put AUTH0_CLIENT_SECRET
wrangler secret put API_KEY
```

## Deployment

The application is deployed as a single Cloudflare Worker that serves both the frontend and API:

```bash
npm run deploy
```

This will:
1. Build the frontend with Vite
2. Bundle frontend assets into the Worker
3. Deploy to Cloudflare Workers