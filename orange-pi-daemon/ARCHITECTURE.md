# Orange Pi SMS Daemon Architecture (v3.6.0)

## Overview

The Orange Pi SMS Daemon is a high-performance, lock-free SMS management system designed to handle 54+ USB modems simultaneously. Built in Zig for performance and safety, it interfaces with ModemManager via D-Bus to collect SMS messages and phone status information, forwarding them to a cloud dashboard in real-time.

## Core Design Principles

1. **Lock-Free Architecture**: All shared data structures use atomic operations to prevent deadlocks
2. **Parallel Processing**: Worker pool with 8 threads for concurrent modem operations
3. **Adaptive Scheduling**: Priority-based polling adjusts frequency based on message activity
4. **Zero-Copy Where Possible**: Minimizes memory allocations and copies
5. **Graceful Degradation**: Falls back from BusctlDBus → mmcli → error handling

## System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Main Thread                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │   main.zig   │  │ Event Loop   │  │ Coordination │          │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘          │
└─────────┼──────────────────┼──────────────────┼─────────────────┘
          │                  │                  │
          ▼                  ▼                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Worker Threads (4)                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐         │
│  │   Messages   │  │Phone Status  │  │   Signals    │         │
│  │   Processor  │  │   Updater    │  │   Monitor    │         │
│  └──────────────┘  └──────────────┘  └──────────────┘         │
│  ┌──────────────┐                                              │
│  │ SMS Sender   │                                              │
│  └──────────────┘                                              │
└─────────────────────────────────────────────────────────────────┘
          │                  │                  │
          ▼                  ▼                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Worker Pool (8 threads)                       │
│  ┌──────────────────────────────────────────────────┐          │
│  │         Parallel Modem Message Checking          │          │
│  └──────────────────────────────────────────────────┘          │
└─────────────────────────────────────────────────────────────────┘
          │                  │                  │
          ▼                  ▼                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Lock-Free Data Structures                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐         │
│  │Message Queue │  │Signal Cache  │  │Priority Mgr  │         │
│  │    (MPMC)    │  │  (Hash Map)  │  │   (Atomic)   │         │
│  └──────────────┘  └──────────────┘  └──────────────┘         │
└─────────────────────────────────────────────────────────────────┘
          │                  │                  │
          ▼                  ▼                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                      External Systems                            │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐         │
│  │ModemManager  │  │   D-Bus      │  │  Dashboard   │         │
│  │   (mmcli)    │  │  (busctl)    │  │    (API)     │         │
│  └──────────────┘  └──────────────┘  └──────────────┘         │
└─────────────────────────────────────────────────────────────────┘
```

## Component Details

### Core Components

#### `main.zig` - Application Orchestrator
**Purpose**: Entry point and main event loop coordinator

**Key Responsibilities**:
- Initializes all subsystems (ModemManager, API client, worker threads)
- Manages the main event loop with 50ms adaptive timing
- Coordinates parallel message checking across 54+ modems
- Handles graceful shutdown and cleanup
- Manages modem cache refresh (every 5 minutes)
- Performs SMS storage cleanup (every 10 minutes)

**Key Functions**:
- `main()`: Entry point, initializes systems and runs event loop
- `checkModemMessages()`: Processes messages for a single modem
- Cache management and periodic maintenance

#### `types.zig` - Type Definitions
**Purpose**: Central repository for all data structures

**Key Types**:
- `Config`: Application configuration (API URL, keys, intervals)
- `Phone`: Complete phone/modem state representation
- `Message`: SMS message structure
- `MessageInfo`: Message with metadata
- `SignalData`: Signal quality metrics (RSSI, RSRQ, RSRP, SNR)
- `PendingSms`: Outgoing SMS to be sent
- `ModemCheckResult`: Result of checking a modem for messages

**Design Notes**:
- All types use optional fields (`?Type`) for nullable values
- Allocator passed explicitly for memory management
- Proper cleanup via `deinit()` methods

### Hardware Interaction Layer

#### `modem_manager.zig` - ModemManager Interface
**Purpose**: Abstracts all hardware communication

**Key Features**:
- Dual-mode operation: BusctlDBus (fast) with mmcli fallback
- Problematic modem tracking to avoid crashes
- Message tracking to prevent duplicates
- Automatic modem enabling when disabled

**Critical Methods**:
- `listModems()`: Discovers all connected modems
- `getIccid()`: Retrieves SIM card identifier
- `getNewMessages()`: Fetches unread SMS messages
- `sendSms()`: Sends SMS via modem
- `deleteMessage()`: Removes processed messages
- `cleanupModemStorage()`: Prevents SMS storage overflow

**Performance Optimizations**:
- Uses BusctlDBus when available (90% subprocess reduction)
- Caches problematic modems to avoid repeated failures
- Tracks processed messages to prevent reprocessing

#### `busctl_dbus.zig` - D-Bus Performance Wrapper
**Purpose**: High-performance alternative to mmcli

**Key Advantages**:
- Direct D-Bus communication via busctl
- 90% reduction in subprocess overhead
- No C dependencies (pure subprocess calls)
- Automatic fallback on failure

**Implementation**:
- Uses busctl commands instead of mmcli
- Caches modem information to reduce queries
- Parses D-Bus property format directly

### Network Communication

#### `api_client.zig` - Dashboard API Client
**Purpose**: HTTP communication with cloud dashboard

**Key Features**:
- Native Zig HTTP client (std.http.Client)
- Automatic retry with exponential backoff
- JSON serialization/deserialization
- API key authentication

**API Endpoints**:
- `/api/control/phones`: Batch phone status upload
- `/api/control/messages`: Message upload
- `/api/control/pending-sms`: Fetch SMS to send
- `/api/control/sms-sent`: Confirm SMS delivery

### Threading & Concurrency

#### `worker_threads.zig` - Dedicated Thread Management
**Purpose**: Manages specialized worker threads

**Thread Types**:
1. **Message Processor**: Uploads collected messages to API
2. **Phone Status**: Periodic phone status updates (every 30s)
3. **Signal Monitor**: Signal quality monitoring (every 60s)
4. **SMS Sender**: Polls and sends outgoing SMS (every 5s)

**Design Pattern**:
- Each thread has dedicated responsibility
- Communicates via lock-free queues
- Graceful shutdown via atomic flags

#### `worker_pool.zig` - Parallel Processing Engine
**Purpose**: Manages pool of worker threads for parallel operations

**Key Features**:
- 8 worker threads for concurrent processing
- Lock-free work queue (MPMC)
- Work stealing for load balancing
- Supports different work types (CheckMessages, CheckSignal, etc.)

**Implementation**:
- Workers wait on lock-free queue
- Main thread submits work items
- Results collected asynchronously

### Lock-Free Data Structures

#### `lockfree_mpmc.zig` - Multi-Producer Multi-Consumer Queue
**Purpose**: Thread-safe message passing without locks

**Algorithm**: Ring buffer with atomic head/tail pointers
**Key Features**:
- Wait-free producers
- Lock-free consumers
- Cache-line aligned to prevent false sharing
- Exponential backoff on contention

#### `lockfree_message_queue.zig` - Message Queue Wrapper
**Purpose**: Type-safe wrapper around MPMC for messages

**Features**:
- Specialized for MessageInfo type
- Batch operations support
- Size tracking

#### `lockfree_signal_cache.zig` - Signal Data Cache
**Purpose**: Thread-safe signal quality caching

**Implementation**:
- Fixed-size hash table (256 entries)
- Linear probing for collision resolution (8 probes max)
- Atomic validity flags
- Time-based expiration (5 minutes)

#### `lockfree_priority_manager.zig` - Adaptive Priority System
**Purpose**: Manages modem polling priorities

**Priority Levels**:
- **High**: Check every cycle (active messages)
- **Medium**: Check every 2 cycles
- **Low**: Check every 5 cycles

**Algorithm**:
- Tracks consecutive empty polls
- Automatically adjusts priority based on activity
- Atomic operations for thread safety

### Supporting Components

#### `sms_sender.zig` - Outgoing SMS Handler
**Purpose**: Manages sending SMS messages

**Process Flow**:
1. Fetch pending SMS from API
2. Select appropriate modem (prefer specified ICCID)
3. Send via ModemManager
4. Report success/failure to API
5. Handle retries and failures

#### `phone_collector.zig` - Batch Phone Updates
**Purpose**: Collects phone updates for batch upload

**Features**:
- Accumulates updates over time window
- Batch upload for efficiency
- Automatic flush on size/time thresholds

#### `bloom_filter.zig` - Message Deduplication
**Purpose**: Prevents duplicate message processing

**Implementation**:
- Bloom filter for O(1) lookups
- LRU cache for recent messages
- Configurable false positive rate
- Periodic cleanup

#### `message_tracker.zig` - Processed Message Tracking
**Purpose**: Tracks which messages have been processed

**Features**:
- Prevents reprocessing after crashes
- Memory-efficient storage
- Automatic expiration

#### `modem_processor.zig` - Individual Modem Processing
**Purpose**: Processes a single modem's data

**Responsibilities**:
- Collect modem details (IMEI, model, etc.)
- Retrieve signal quality
- Check for new messages
- Update phone collector

#### `utils.zig` - Utility Functions
**Purpose**: Common helper functions

**Utilities**:
- Configuration loading from environment
- String manipulation
- Error handling helpers

#### `build_options` - Build Configuration
**Purpose**: Compile-time configuration

**Options**:
- Log level (debug/info/warn/error)
- Optimization level
- Feature flags

## Data Flows

### Message Collection Flow
```
ModemManager → listModems() → Worker Pool → checkModemMessages() 
    → getNewMessages() → Deduplication → Message Queue 
    → Message Processor Thread → API Upload → deleteMessage()
```

### SMS Sending Flow
```
API (pending SMS) → SMS Sender Thread → Select Modem 
    → sendSms() → ModemManager → Report Status → API
```

### Status Update Flow
```
Timer → Phone Status Thread → Parallel Modem Processing 
    → Collect Phone Data → Phone Collector → Batch Upload → API
```

## Lock-Free Architecture

### Why Lock-Free?
With 54+ modems and 12+ threads, traditional mutex-based synchronization would cause:
- Deadlocks under high load
- Priority inversion
- Convoy effects
- Poor scalability

### Lock-Free Benefits
- **No Deadlocks**: Impossible by design
- **Better Scalability**: Linear with CPU cores
- **Predictable Latency**: No blocking waits
- **Progress Guarantee**: At least one thread makes progress

### Implementation Strategy
1. **Atomic Operations**: All shared state uses atomics
2. **Memory Ordering**: Careful use of acquire/release semantics
3. **ABA Prevention**: Sequence numbers in pointers
4. **Cache Alignment**: Prevent false sharing

## Performance Optimizations

### Subprocess Reduction
- **BusctlDBus**: 90% reduction vs mmcli
- **Batch Operations**: Group API calls
- **Caching**: Signal data, modem states

### Memory Efficiency
- **Arena Allocators**: Bulk allocation/deallocation
- **String Interning**: Reuse common strings
- **Fixed-Size Buffers**: Avoid dynamic allocation

### CPU Optimization
- **Parallel Processing**: 8-core utilization
- **Work Stealing**: Balance load across workers
- **Adaptive Timing**: Adjust based on activity

## Error Handling & Recovery

### Modem Failures
- Track problematic modems
- Skip on subsequent iterations
- Automatic retry after timeout

### API Failures
- Exponential backoff
- Local queuing
- Eventual consistency

### Storage Management
- Automatic SMS cleanup
- Prevent storage overflow
- Aggressive mode for high volumes

## Threading Model

### Main Thread
- Event loop coordination
- Work distribution
- Cache management

### Worker Threads (4 dedicated)
1. Message processor
2. Phone status updater
3. Signal monitor
4. SMS sender

### Worker Pool (8 threads)
- Parallel modem checking
- Dynamic work assignment
- Load balancing

## Configuration

### Environment Variables
- `SMS_API_URL`: Dashboard endpoint
- `SMS_API_KEY`: Authentication key
- `SMS_CHECK_INTERVAL`: Phone update frequency
- `SMS_MESSAGE_CHECK_MS`: Message check interval
- `SMS_SIGNAL_INTERVAL`: Signal check frequency

### Compile-Time Options
- Log level (debug/info/warn/error)
- Buffer sizes
- Thread counts
- Timeout values

## Key Design Patterns

### Producer-Consumer
Lock-free queues connect producers (modem checkers) with consumers (API uploaders)

### Worker Pool
Distributes work across multiple threads for parallel processing

### Adaptive Priority
Dynamically adjusts polling frequency based on activity

### Graceful Degradation
Falls back through multiple methods (BusctlDBus → mmcli → skip)

### Batch Processing
Accumulates updates for efficient API communication

## Integration Points

### ModemManager
- Primary hardware interface
- SMS and modem control
- Signal quality monitoring

### D-Bus
- System bus communication
- Property queries
- Method invocation

### Dashboard API
- RESTful HTTP endpoints
- JSON data format
- API key authentication

## Future Improvements

### Potential Enhancements
1. WebSocket for real-time updates
2. Direct libmm-glib integration
3. Distributed daemon instances
4. Machine learning for priority prediction
5. Compression for API payloads

### Known Limitations
1. Maximum 256 modems (can be increased)
2. Fixed worker pool size
3. No persistent message storage
4. Single dashboard endpoint

## Version History

- **v3.6.0**: Code cleanup, hash collision fix
- **v3.5.0**: BusctlDBus integration
- **v3.4.0**: Complete lock-free conversion
- **v3.0.0**: Initial high-performance rewrite

## Conclusion

The Orange Pi SMS Daemon represents a sophisticated approach to managing high modem counts with excellent performance characteristics. The lock-free architecture ensures scalability and reliability, while the adaptive algorithms optimize resource usage. The clean separation of concerns and modular design make it maintainable and extensible for future requirements.