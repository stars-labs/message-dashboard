# SMS Dashboard Documentation

A comprehensive distributed SMS management system with high-performance daemon and cost-optimized frontend.

## System Overview

The SMS Dashboard v3.6.0 is a production-ready system managing 54+ USB modems simultaneously through a lock-free Zig daemon, normalized database architecture, and cost-optimized manual-refresh frontend deployed on Cloudflare Workers.

### Key Features

- **Lock-Free Daemon**: Zero-deadlock Zig daemon with parallel processing
- **Normalized Database**: v2.0 schema separating modems, SIMs, and state tracking  
- **Cost-Optimized Frontend**: Manual refresh only - no real-time updates to minimize costs
- **54+ Modem Support**: Simultaneous USB modem management with adaptive priority
- **NixOS Deployment**: Declarative system configuration and deployment

### Current Version Status

- **Daemon**: v3.6.0 - Lock-free architecture with BusctlDBus integration
- **Database**: v2.0.0 - Normalized schema with backward compatibility  
- **Frontend**: v1.16.0 - Cost-optimized manual refresh with keyword highlighting
- **Deployment**: NixOS flake-based with SOPS secrets management

## Quick Navigation

### Getting Started
- [System Architecture](./architecture/README.md) - High-level system design
- [Installation Guide](./installation/README.md) - Complete setup instructions
- [Quick Start](./quickstart.md) - Get running in 15 minutes

### Component Documentation
- [Zig Daemon](./daemon/README.md) - Lock-free SMS collection daemon
- [Database Schema](./database/README.md) - Normalized v2.0 architecture  
- [Frontend](./frontend/README.md) - Cost-optimized Svelte application
- [API Reference](./api/README.md) - Complete endpoint documentation

### Deployment & Operations
- [Deployment Guide](./deployment/README.md) - Orange Pi and Cloudflare deployment
- [Configuration](./configuration/README.md) - Environment and secrets setup
- [Monitoring](./monitoring/README.md) - Health checks and performance metrics
- [Troubleshooting](./troubleshooting/README.md) - Common issues and solutions

### Migration & Maintenance
- [Migration Guide](./migration/README.md) - v1 to v2 database migration
- [Performance Tuning](./performance/README.md) - Optimization strategies
- [Security](./security/README.md) - Auth0 setup and API key management

## Architecture Highlights

### Lock-Free Daemon (v3.6.0)
```
Main Thread → Worker Pool (8 threads) → ModemManager
     ↓              ↓                        ↓
Lock-Free Queues → Signal Cache → API Upload
```

### Normalized Database (v2.0)
```
modems (hardware) ← modem_state (volatile data)
   ↓                      ↓
sims (SIM cards) → messages (SMS content)
   ↓                      ↓
device_view (compatibility layer)
```

### Cost-Optimized Frontend
- Manual refresh only - no WebSocket/SSE overhead
- Efficient batch operations
- Cloudflare Workers edge deployment
- Auth0 RBAC with minimal API calls

## Recent Major Changes

### v3.6.0 - Lock-Free Architecture
- Eliminated all deadlocks through atomic operations
- 8-thread worker pool for parallel modem processing
- BusctlDBus integration (90% fewer subprocess calls)
- Hash collision fixes in signal cache

### v2.0.0 - Database Normalization
- Separated hardware from SIM card data
- Real-time state tracking in dedicated tables
- Backward compatibility through device_view
- Memory leak fixes in daemon

### Frontend Cost Optimization
- Removed all real-time features (WebSocket/SSE)
- Manual refresh workflow to minimize API calls
- Reduced Cloudflare Workers compute costs by ~80%
- Maintained full functionality through polling

## Support & Contributing

- **Issues**: Report problems in the project issue tracker
- **Performance**: See [Performance Guide](./performance/README.md) for optimization
- **Security**: Follow [Security Guidelines](./security/README.md) for safe deployment
- **Development**: See [Contributing Guide](./contributing/README.md) for code contributions

---

**Status**: Production Ready ✅  
**Last Updated**: January 2025  
**Version**: v3.6.0