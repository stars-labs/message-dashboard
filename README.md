# SMS Dashboard

A real-time SMS management dashboard with multi-SIM support, built with Svelte and Cloudflare Workers.

## Documentation

All documentation is in the `docs/` directory:

- [API Documentation](docs/API_DOCUMENTATION.md)
- [Auth0 Setup Guide](docs/AUTH0_SETUP.md)
- [Deployment Guide](docs/DEPLOYMENT_GUIDE.md)
- [Orange Pi Quickstart](docs/ORANGE_PI_QUICKSTART.md)
- [Architecture Overview](docs/CLOUDFLARE_ARCHITECTURE.md)

## Project Structure

```
message-dashboard/
├── docs/                 # Documentation
└── sms-dashboard/        # Main application
    ├── client/           # Frontend source code (Svelte)
    ├── database/         # SQL migrations
    ├── dist/             # Built frontend assets
    ├── public/           # Static assets
    ├── scripts/          # Build and deployment scripts
    ├── server/           # Backend source code (Workers)
    ├── package.json      # Dependencies
    └── wrangler.toml     # Cloudflare Workers config
```

## Quick Start

```bash
cd sms-dashboard
npm install

# Development
npm run dev         # Frontend development (Vite)
npm run dev:api     # Backend development (Wrangler)

# Production
npm run deploy      # Build and deploy to Cloudflare
```

## Orange Pi NixOS Deployment

Deploy the SMS dashboard daemon to your Orange Pi 5 Plus:

```bash
# Deploy to Orange Pi (replace with your actual IP)
sudo nixos-rebuild switch --flake .#orange-pi \
  --use-substitutes \
  --target-host root@10.171.150.102 \
  --impure

# Check daemon status
ssh root@10.171.150.102 'systemctl status sms-dashboard-daemon'
```

Before deployment, create the API key file on the Orange Pi:
```bash
ssh root@10.171.150.102
mkdir -p /etc/sms-dashboard
echo "your-api-key" > /etc/sms-dashboard/api-key
chmod 600 /etc/sms-dashboard/api-key
```

## Database Setup

```bash
# Initialize database
npm run db:init

# Run migrations
npm run db:migrate
```

See documentation for detailed setup and deployment instructions.