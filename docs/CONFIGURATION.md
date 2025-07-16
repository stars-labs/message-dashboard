# Configuration Guide

This document describes the configuration system for the SMS Dashboard project.

## Overview

The SMS Dashboard uses a hierarchical configuration system that supports:
- JSON configuration files for default and environment-specific settings
- Environment variables for sensitive data and deployment-specific values
- Runtime configuration for request-specific settings
- SOPS for secret management in NixOS deployments

## Configuration Structure

### Configuration Files

The system uses JSON configuration files stored in `sms-dashboard/config/`:

- `default.json` - Base configuration for all environments
- `production.json` - Production-specific overrides
- `.env.example` - Example environment variables

### Configuration Hierarchy

Configuration is loaded and merged in the following order (later values override earlier ones):

1. Default configuration (`default.json`)
2. Environment-specific configuration (e.g., `production.json`)
3. Environment variables
4. Runtime values (e.g., request context)

## Server Configuration

### Environment Variables

```bash
# Auth0 Configuration
AUTH0_DOMAIN=your-tenant.auth0.com
AUTH0_CLIENT_ID=your-client-id
AUTH0_CLIENT_SECRET=your-client-secret
AUTH0_AUDIENCE=your-api-audience

# API Configuration  
API_KEY=your-secure-api-key
WORKER_URL=https://your-domain.com

# Environment
ENVIRONMENT=production
```

### Using Configuration in Server Code

```javascript
import { createConfig } from './config/index.js';

// In Cloudflare Workers
export default {
  async fetch(request, env) {
    const config = createConfig(env, request);
    
    // Get configuration values
    const apiKey = env.API_KEY;
    const baseUrl = config.get('server.api.baseUrl');
    const heartbeatInterval = config.get('server.websocket.heartbeatInterval', 30000);
    
    // Get API endpoint
    const phonesUrl = config.getApiEndpoint('phones');
  }
}
```

## Client Configuration

### Environment Variables (Vite)

```bash
# Development
VITE_API_BASE_URL=http://localhost:8787
VITE_AUTH0_DOMAIN=your-tenant.auth0.com
VITE_AUTH0_CLIENT_ID=your-client-id
VITE_AUTH0_AUDIENCE=your-api-audience
```

### Using Configuration in Client Code

```javascript
import config, { getConfig } from './lib/config.js';

// Get configuration values
const apiBaseUrl = getConfig('server.api.baseUrl');
const reconnectDelay = getConfig('client.websocket.reconnectDelay', 3000);

// Configuration is also available globally
const heartbeatInterval = window.APP_CONFIG?.server?.websocket?.heartbeatInterval;
```

## Orange Pi Daemon Configuration

### Environment Variables

```bash
SMS_API_URL=https://your-domain.com
SMS_API_KEY=your-api-key
SMS_DEVICE_ID=orange-pi-001
SMS_UPLOAD_INTERVAL=60
LOG_LEVEL=info
```

### NixOS Module Configuration

```nix
services.sms-daemon = {
  enable = true;
  apiUrl = "https://your-domain.com";
  apiKeyFile = config.sops.secrets."sms-dashboard/api-key".path;
  deviceId = "orange-pi-001";
  uploadInterval = 60;
  logLevel = "info";
};
```

## SOPS Secret Management

### Setting Up SOPS

1. Create age key for encryption:
```bash
age-keygen -o ~/.config/sops/age/keys.txt
```

2. Create `.sops.yaml` in project root:
```yaml
keys:
  - &admin age1your-public-key-here
creation_rules:
  - path_regex: secrets/.*\.yaml$
    key_groups:
    - age:
      - *admin
```

3. Create encrypted secrets:
```bash
sops secrets/orange-pi.yaml
```

### Using SOPS with NixOS

```nix
{
  sops.defaultSopsFile = ./secrets/orange-pi.yaml;
  sops.age.keyFile = "/var/lib/sops-nix/key.txt";
  
  sops.secrets."sms-dashboard/api-key" = {
    owner = "sms-daemon";
  };
  
  services.sms-daemon = {
    apiKeyFile = config.sops.secrets."sms-dashboard/api-key".path;
  };
}
```

## Configuration Reference

### Server Configuration

```json
{
  "server": {
    "api": {
      "baseUrl": "https://your-domain.com",
      "endpoints": {
        "phones": "/api/phones",
        "messages": "/api/messages",
        "control": "/api/control",
        "ws": "/api/ws",
        "daemonWs": "/api/daemon-ws",
        "sse": "/api/sse"
      }
    },
    "websocket": {
      "heartbeatInterval": 30000,      // Daemon heartbeat check interval (ms)
      "heartbeatTimeout": 60000,       // Timeout for daemon heartbeat (ms)
      "reconnectDelay": 3000,          // WebSocket reconnection delay (ms)
      "maxReconnectAttempts": 5,       // Maximum reconnection attempts
      "requestTimeout": 10000          // API request timeout (ms)
    },
    "daemon": {
      "deviceId": "orange-pi-001",     // Unique device identifier
      "version": "1.0.0",              // Daemon version
      "pollInterval": 10000,           // Message check interval (ms)
      "uploadInterval": 60000          // Phone status upload interval (ms)
    }
  }
}
```

### Client Configuration

```json
{
  "client": {
    "websocket": {
      "reconnectDelay": 3000,          // Reconnection delay (ms)
      "maxReconnectAttempts": 5,       // Maximum reconnection attempts
      "connectionTimeout": 5000,       // Connection timeout (ms)
      "requestTimeout": 10000          // Request timeout (ms)
    },
    "ui": {
      "refreshInterval": 30000,        // UI refresh interval (ms)
      "messageLoadLimit": 100,         // Messages per page
      "phoneLoadLimit": 50             // Phones per page
    }
  }
}
```

## Migration from Hardcoded Values

The following hardcoded values have been moved to configuration:

| Old Hardcoded Value | Configuration Path | Environment Variable |
|-------------------|-------------------|---------------------|
| `https://sexy.qzz.io` | `server.api.baseUrl` | `API_BASE_URL` |
| `4025b019988238...` | N/A | `API_KEY` |
| `orange-pi-001` | `server.daemon.deviceId` | `SMS_DEVICE_ID` |
| `30000` (heartbeat) | `server.websocket.heartbeatInterval` | N/A |
| `60000` (timeout) | `server.websocket.heartbeatTimeout` | N/A |
| `5000` (connection) | `client.websocket.connectionTimeout` | N/A |
| `10000` (request) | `client.websocket.requestTimeout` | N/A |

## Best Practices

1. **Never commit sensitive values** - Use environment variables or SOPS
2. **Use meaningful defaults** - Provide sensible defaults in `default.json`
3. **Document all configuration** - Keep this guide up to date
4. **Validate configuration** - Check required values at startup
5. **Use typed access** - Prefer configuration objects over string lookups

## Development Workflow

1. Copy `.env.example` to `.env` and fill in your values
2. Start the development server with environment variables
3. Use configuration objects in code instead of hardcoded values
4. Test with different configurations

## Production Deployment

1. Set all required environment variables in Cloudflare Workers
2. Use SOPS for NixOS deployments
3. Verify configuration with health checks
4. Monitor for configuration errors in logs