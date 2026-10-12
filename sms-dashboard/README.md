# SMS Dashboard

A real-time SMS management system built with **ElysiaJS**, **Drizzle ORM**, and **Svelte**. Supports both Cloudflare Workers and VPS deployment.

## Features

- 📱 Real-time SMS monitoring for 50+ devices
- 🚀 Built with ElysiaJS for high performance
- 💾 Supports both Cloudflare D1 and SQLite databases
- 🔐 Auth0 integration with RBAC
- 📊 Real-time statistics and analytics
- 🤖 AI-powered message analysis
- 🔍 Keyword highlighting and search
- 📡 Orange Pi hardware integration

## Tech Stack

### Backend
- **ElysiaJS** - Fast, type-safe web framework
- **Drizzle ORM** - Type-safe database ORM
- **Cloudflare Workers** - Edge computing platform (optional)
- **SQLite/D1** - Database storage

### Frontend
- **Svelte 5** - Reactive UI framework
- **TailwindCSS** - Utility-first CSS
- **Vite** - Build tool

## Quick Start

### Prerequisites
- [Bun](https://bun.sh) runtime
- Node.js 18+ (optional)
- Cloudflare account (for Workers deployment)

### Installation

```bash
# Install dependencies
bun install

# Initialize database
bun run db:init

# Start development server
bun run dev:api
```

### Environment Variables

Create a `.env` file:

```env
PORT=3000
DATABASE_URL=./data/sqlite.db
API_KEY=your-api-key
AUTH0_DOMAIN=your-tenant.auth0.com
AUTH0_CLIENT_ID=your-client-id
AUTH0_CLIENT_SECRET=your-client-secret
```

## Development

### Run locally
```bash
# Start API server
bun run dev:api

# Start frontend dev server
bun run dev

# Start both with Cloudflare Workers emulation
bun run dev:cf
```

### Database Management
```bash
# Initialize database
bun run db:init

# Generate migrations
bun run db:generate

# Open Drizzle Studio
bun run db:studio
```

## Deployment

### Deploy to Cloudflare Workers
```bash
bun run deploy:cf
```

### Deploy to VPS
```bash
# Build for production
bun run build:api

# Run with PM2
pm2 start "bun run src/index.ts" --name sms-dashboard

# Or with Docker
docker build -t sms-dashboard .
docker run -p 3000:3000 sms-dashboard
```

## API Endpoints

### Public
- `GET /api/health` - Health check

### Protected (Auth Required)
- `GET /api/phones` - List all phones
- `GET /api/messages` - List messages
- `POST /api/messages` - Send message
- `GET /api/stats` - Get statistics

### Control (API Key Required)
- `POST /api/control/phones` - Update phone data
- `POST /api/control/messages` - Upload messages
- `POST /api/control/daemon/health` - Daemon health update

## Project Structure

```
sms-dashboard/
├── src/
│   ├── index.ts              # Main entry point
│   ├── db/
│   │   └── schema/           # Drizzle schemas
│   ├── routes/               # API routes
│   ├── middleware/           # Auth, CORS
│   └── services/             # Database, AI, Sessions
├── client/                   # Svelte frontend
├── scripts/                  # Utility scripts
├── migrations/               # Database migrations
└── drizzle.config.ts        # Drizzle configuration
```

## Orange Pi Integration

The system integrates with Orange Pi hardware running a Zig daemon that:
- Manages 50+ USB modems simultaneously
- Extracts SMS messages in real-time
- Reports device status and metrics
- Uses lock-free architecture for high performance

Configure the daemon with:
```bash
export SMS_API_URL="https://your-domain.com"
export SMS_API_KEY="your-api-key"
```

## License

MIT

## Support

For issues or questions, please open an issue on GitHub.