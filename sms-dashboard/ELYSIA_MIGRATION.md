# ElysiaJS + Drizzle ORM Migration

## Overview

The SMS Dashboard has been successfully migrated to use **ElysiaJS** and **Drizzle ORM**, providing a unified codebase that can deploy to both:
- **Cloudflare Workers** with D1 database
- **VPS/Local** with SQLite/PostgreSQL

## Key Features

### Unified Codebase
- Single entry point (`src/index.ts`) that auto-detects the runtime environment
- Works with both Cloudflare Workers and Bun/Node.js
- No dual entry points needed - ElysiaJS handles runtime differences automatically

### Technology Stack
- **ElysiaJS**: Fast, type-safe web framework
- **Drizzle ORM**: Type-safe database ORM with D1 and SQLite support
- **Bun**: Fast JavaScript runtime with built-in SQLite support
- **TypeScript**: Full type safety across the application

## Project Structure

```
sms-dashboard/
├── src/
│   ├── index.ts              # Main entry point (works for both CF and VPS)
│   ├── db/
│   │   └── schema/           # Drizzle schema definitions
│   │       ├── modems.ts
│   │       ├── sims.ts
│   │       ├── messages.ts
│   │       ├── users.ts
│   │       ├── iccid-mappings.ts
│   │       ├── keywords.ts
│   │       ├── daemon.ts
│   │       └── index.ts
│   ├── routes/
│   │   ├── control.ts        # Orange Pi API
│   │   ├── phones.ts         # Phone management
│   │   ├── messages.ts       # Message handling
│   │   ├── stats.ts          # Statistics
│   │   └── health.ts         # Health check
│   ├── middleware/
│   │   ├── auth.ts           # Auth0 JWT validation
│   │   └── cors.ts           # CORS configuration
│   └── services/
│       ├── database.ts       # Database connection factory
│       ├── session.ts        # Session management
│       └── ai.ts             # AI service abstraction
├── scripts/
│   ├── init-db.ts            # Database initialization
│   └── add-missing-tables.ts # Table migration helper
├── drizzle.config.ts         # Drizzle configuration
├── wrangler.toml             # Cloudflare Workers config
└── tsconfig.json             # TypeScript config
```

## Running the Application

### Local Development (VPS Mode)

```bash
# Install dependencies
bun install

# Initialize database
bun run scripts/init-db.ts

# Start development server
PORT=3001 API_KEY=your-api-key bun run src/index.ts

# Or with watch mode
PORT=3001 API_KEY=your-api-key bun run --watch src/index.ts
```

### Cloudflare Workers Development

```bash
# Start Wrangler dev server
bunx wrangler dev

# Deploy to Cloudflare
bunx wrangler deploy
```

## Database Management

### Initialize Local Database
```bash
# Create all tables
bun run scripts/init-db.ts

# Add any missing tables
bun run scripts/add-missing-tables.ts
```

### Drizzle Migrations
```bash
# Generate migrations
bunx drizzle-kit generate

# Push schema changes
bunx drizzle-kit push

# Open Drizzle Studio
bunx drizzle-kit studio
```

## API Endpoints

All endpoints remain compatible with the original implementation:

- `GET /api/health` - Health check
- `GET /api/phones` - List phones
- `GET /api/messages` - List messages
- `GET /api/stats` - Get statistics
- `POST /api/control/phones` - Update phones (Orange Pi)
- `POST /api/control/messages` - Upload messages
- `POST /api/control/daemon/health` - Daemon health update

## Environment Variables

### For VPS Deployment
```env
PORT=3000
DATABASE_URL=./data/sqlite.db
API_KEY=your-api-key
AUTH0_DOMAIN=your-tenant.auth0.com
AUTH0_CLIENT_ID=your-client-id
AUTH0_CLIENT_SECRET=your-client-secret
```

### For Cloudflare Workers
Configure in `wrangler.toml` or use `wrangler secret put`:
```bash
wrangler secret put API_KEY
wrangler secret put AUTH0_DOMAIN
wrangler secret put AUTH0_CLIENT_ID
wrangler secret put AUTH0_CLIENT_SECRET
```

## Testing

```bash
# Run API tests
API_KEY=test-api-key bun run test-api.ts

# Test individual endpoints
curl http://localhost:3001/api/health
curl -H "X-API-Key: test-api-key" http://localhost:3001/api/control/phones
```

## Key Benefits

1. **Unified Codebase**: One codebase for both Cloudflare and VPS deployments
2. **Type Safety**: Full TypeScript with Drizzle's type inference
3. **Performance**: ElysiaJS is one of the fastest web frameworks
4. **Flexibility**: Deploy anywhere - Cloudflare, VPS, Docker, or locally
5. **Modern Stack**: Latest technologies with excellent DX
6. **Backward Compatible**: All API endpoints remain unchanged

## Migration Notes

### What Changed
- Backend framework: Custom router → ElysiaJS
- Database ORM: Raw SQL → Drizzle ORM
- Runtime support: Added Bun SQLite support alongside D1
- Type safety: Full TypeScript types for database queries

### What Remained the Same
- API endpoints and contracts
- Database schema
- Authentication flow (Auth0)
- Orange Pi integration
- Frontend (Svelte) - unchanged

## Next Steps

1. **Frontend Integration**: Update frontend to use new API if needed
2. **WebSocket Support**: Add real-time updates
3. **Docker Deployment**: Create Dockerfile for VPS deployment
4. **PostgreSQL Support**: Add PostgreSQL driver for production VPS
5. **Monitoring**: Add logging and metrics

## Deployment Options

### Option 1: Continue with Cloudflare Workers
```bash
bunx wrangler deploy
```

### Option 2: Deploy to VPS with Docker
```dockerfile
FROM oven/bun:latest
WORKDIR /app
COPY package.json bun.lockb ./
RUN bun install
COPY . .
CMD ["bun", "run", "src/index.ts"]
```

### Option 3: Deploy with PM2
```bash
pm2 start "bun run src/index.ts" --name sms-dashboard
```

## Support

The migration maintains full backward compatibility while providing:
- Better performance
- Type safety
- Multiple deployment options
- Modern development experience

All existing features work as before, with the added flexibility of deploying to any environment.