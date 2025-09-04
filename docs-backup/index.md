# Message Dashboard Documentation

Welcome to the comprehensive documentation for the Message Dashboard project.

## 📚 Documentation Structure

### Core Documentation
- [API Documentation](API_DOCUMENTATION.md) - Complete API reference
- [Architecture Overview](CLOUDFLARE_ARCHITECTURE.md) - System architecture and design
- [Configuration Guide](CONFIGURATION.md) - Configuration options and settings

### Setup & Deployment
- [Auth0 Setup Guide](AUTH0_SETUP.md) - Authentication configuration
- [Deployment Guide](DEPLOYMENT_GUIDE.md) - Production deployment instructions
- [Deployment Success](DEPLOYMENT_SUCCESS.md) - Post-deployment verification
- [Configuration Migration](CONFIGURATION_MIGRATION.md) - Migrating configurations

### Component-Specific Documentation

#### SMS Dashboard
- [README](sms-dashboard/README.md) - Dashboard overview
- [Auth0 Roles Setup](sms-dashboard/auth0-roles-setup.md) - Role-based access control
- [Enable Auth0 Roles Quickstart](sms-dashboard/enable-auth0-roles-quickstart.md) - Quick RBAC setup
- [Production Auth0 Checklist](sms-dashboard/production-auth0-checklist.md) - Auth0 production readiness
- [ICCID Debugging Guide](sms-dashboard/ICCID_DEBUGGING_GUIDE.md) - Troubleshooting ICCID issues

#### Orange Pi Daemon
- [README](orange-pi-daemon/README.md) - Daemon overview
- [Quickstart Guide](ORANGE_PI_QUICKSTART.md) - Quick setup for Orange Pi
- [API Reference](ORANGE_PI_API_REFERENCE.md) - Orange Pi API documentation
- [NixOS Setup](ORANGE_PI_NIXOS_SETUP.md) - NixOS configuration guide
- [Threading Architecture](orange-pi-daemon/threading-architecture.md) - Concurrency design
- [MMCLI Crash Protection](orange-pi-daemon/MMCLI_CRASH_PROTECTION.md) - Crash handling
- [MMCLI Root Cause Analysis](orange-pi-daemon/MMCLI_CRASH_ROOT_CAUSE.md) - Issue analysis
- [SOPS Setup](orange-pi-daemon/SOPS_SETUP.md) - Secrets management
- [Testing Guide](orange-pi-daemon/TESTING.md) - Test procedures
- [Changelog](orange-pi-daemon/CHANGELOG.md) - Version history
- [Source Code README](orange-pi-daemon/src-README.md) - Code structure

#### NixOS Configuration
- [README](nixos-config/README.md) - NixOS configuration overview
- [Migration Guide](nixos-config/migrate.md) - System migration procedures
- [SMS Daemon Config](nixos-config/SMS_DAEMON_CONFIG.md) - Daemon configuration
- [Secrets Management](nixos-config/secrets-README.md) - SOPS secrets setup

### Security & Troubleshooting
- [Security Documentation](security/SECURITY.md) - Security policies and procedures
- [API Key Troubleshooting](API_KEY_TROUBLESHOOTING.md) - API authentication issues
- [Auth0 Troubleshooting](AUTH0_TROUBLESHOOTING.md) - Auth0 integration issues
- [Authorization Guide](AUTHORIZATION_GUIDE.md) - Permission system guide

### Protocol Documentation
- [WebSocket Protocol](WEBSOCKET_PROTOCOL.md) - Real-time communication protocol
- [API Documentation](API_DOCS.md) - API endpoints reference

## 🚀 Quick Links

- [Getting Started](ORANGE_PI_QUICKSTART.md)
- [API Reference](API_DOCUMENTATION.md)
- [Deployment Guide](DEPLOYMENT_GUIDE.md)
- [Troubleshooting](API_KEY_TROUBLESHOOTING.md)

## 📝 Contributing

When adding new documentation:
1. Place it in the appropriate subdirectory
2. Update this index file
3. Use clear, descriptive filenames
4. Follow the existing documentation style