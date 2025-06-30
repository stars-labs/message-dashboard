# Message Dashboard

A modern SMS verification code management system for 95 EC20 modems connected to Orange Pi 5 Plus.

## Features

- 📱 Manage 95 SIM cards from China, Hong Kong, and Singapore
- 🔍 Automatic verification code extraction
- 🎨 Modern, colorful UI with gradient designs
- 📊 Real-time statistics and monitoring
- 🌐 Mobile-first responsive design
- 🔖 Message history with source-based grouping

## Tech Stack

- **Frontend**: Svelte + Vite
- **Styling**: Tailwind CSS
- **Runtime**: Bun
- **Hardware**: Orange Pi 5 Plus + 95x EC20 Modems

## Development

```bash
# Install dependencies
bun install

# Start dev server
bun run dev --host 0.0.0.0

# Build for production
bun run build
```

## Access

- Local: http://localhost:8080
- Network: http://[YOUR_IP]:8080

## Architecture

The system manages SMS messages from 95 EC20 modems, extracts verification codes, and provides a structured view organized by source applications (Taobao, WeChat, WhatsApp, etc.).

Each message displays:
- Source application with color-coded labels
- Extracted verification code (highlighted)
- Receiver SIM card ID
- Timestamp