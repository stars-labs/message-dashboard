# Orange Pi SMS Daemon - Source Code Structure

## Module Overview

The daemon is organized into focused modules for better code organization and maintainability:

### Core Files
- **`main.zig`** - Application entry point, main loop, and orchestration
- **`types.zig`** - Shared data structures and type definitions
- **`utils.zig`** - Common utility functions

### Feature Modules
- **`modem_manager.zig`** - ModemManager (mmcli) interface and operations
- **`api_client.zig`** - HTTP API client for dashboard communication
- **`signal_cache.zig`** - Thread-safe signal quality caching system
- **`phone_collector.zig`** - Batched phone data collection for uploads
- **`modem_thread.zig`** - Per-modem processing thread implementation

## Module Responsibilities

### `types.zig`
Defines all shared data structures:
- `Config` - Application configuration
- `Phone` - Phone/modem status data
- `Message` - SMS message structure
- `MessageInfo` - Internal message tracking
- `SignalData` - Signal quality metrics

### `modem_manager.zig`
Handles all ModemManager interactions:
- List available modems
- Enable/disable modems
- Extract ICCID and phone numbers
- Read and delete SMS messages
- Send SMS messages
- Get signal quality
- Retrieve operator information

### `api_client.zig`
Manages API communication:
- Upload phone status (single or batch)
- Upload SMS messages
- HTTP request handling via curl
- Authentication with API key

### `signal_cache.zig`
Implements intelligent signal caching:
- Thread-safe cache operations
- Update throttling (5% change threshold)
- Minimum update interval (5 seconds)
- Reduces unnecessary modem queries

### `phone_collector.zig`
Enables batched uploads:
- Thread-safe phone data collection
- Deep copying of phone data
- Batch retrieval and clearing
- Memory management

### `modem_thread.zig`
Per-modem processing logic:
- Modem status checking
- Data collection (ICCID, phone, signal)
- Integration with signal cache
- Adding data to phone collector

### `utils.zig`
Common utilities:
- Configuration loading from environment
- Verification code extraction from SMS content

## Adding New Features

When adding new functionality:

1. **New data structures** → Add to `types.zig`
2. **Modem operations** → Add to `modem_manager.zig`
3. **API endpoints** → Add to `api_client.zig`
4. **Shared utilities** → Add to `utils.zig`
5. **New modules** → Create separate file and import in `main.zig`

## Thread Safety

All modules that handle shared state implement thread safety:
- `SignalCache` uses mutex for all operations
- `PhoneCollector` uses mutex for collection/retrieval
- `ApiClient` uses mutex for HTTP operations
- `ModemManager` maintains thread-safe failed SMS tracking

## Memory Management

Each module is responsible for its allocations:
- Deep copying when storing data
- Proper cleanup in `deinit()` methods
- Clear ownership of allocated memory
- Careful handling of optional fields