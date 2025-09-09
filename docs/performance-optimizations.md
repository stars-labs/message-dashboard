# SMS System Performance Optimizations

## Critical Performance Issues

### Current Latency Breakdown
- **Total end-to-end latency**: 280ms - 2880ms (typical ~1000ms)
- **Major contributors**:
  - Daemon polling cycle: 50-200ms
  - Message processor sleep: 100ms
  - Batch accumulation: 0-1000ms
  - HTTP overhead: 20-50ms per request

## Immediate Optimizations (Can implement now)

### 1. Reduce Polling Intervals

**File**: `orange-pi-daemon/src/main.zig`
```zig
// Line 476-489: Reduce base target from 50ms to 10ms
const base_target: u64 = 10 * std.time.ns_per_ms; // Was 50ms
const target_cycle_time: u64 = if (final_queue_size > modems_to_check.len)
    @min(100 * std.time.ns_per_ms, base_target + (final_queue_size * 1 * std.time.ns_per_ms)) // Was 200ms max
else if (final_queue_size > 10)
    base_target + 10 * std.time.ns_per_ms // Was 20ms additional
else
    base_target;
```

**File**: `orange-pi-daemon/src/worker_threads.zig`
```zig
// Line 36: Reduce message processor sleep from 100ms to 10ms
std.time.sleep(10 * std.time.ns_per_ms); // Was 100ms
```

### 2. Implement Immediate Message Upload

**File**: `orange-pi-daemon/src/worker_threads.zig`
```zig
// Line 26-38: Add immediate upload for small batches
pub fn messageProcessorThread(context: *WorkerContext) !void {
    std.log.info("🚀 Message processor thread started", .{});
    
    var last_batch_time = std.time.milliTimestamp();
    
    while (!context.should_exit.load(.acquire)) {
        var batch_buffer: [50]types.MessageInfo = undefined;
        const queue_size = context.message_queue.size();
        
        if (queue_size > 0) {
            const message_count = context.message_queue.popBatch(&batch_buffer);
            
            if (message_count > 0) {
                const messages = batch_buffer[0..message_count];
                
                // Immediate upload for small batches or timeout
                const now = std.time.milliTimestamp();
                const should_upload = message_count >= 10 or // Upload if we have 10+ messages
                                     (message_count > 0 and now - last_batch_time > 100); // Or after 100ms
                
                if (should_upload) {
                    // Process and upload immediately
                    try processAndUploadMessages(context, messages);
                    last_batch_time = now;
                } else {
                    // Re-queue for batching
                    for (messages) |msg| {
                        try context.message_queue.push(msg);
                    }
                }
            }
        }
        
        std.time.sleep(10 * std.time.ns_per_ms); // Reduced from 100ms
    }
}
```

### 3. Reduce Cache Refresh Interval

**File**: `orange-pi-daemon/src/main.zig`
```zig
// Line 211: Reduce cache refresh from 5 minutes to 30 seconds
if (std.time.timestamp() - last_cache_refresh > 30) { // Was 300 seconds
```

### 4. Enable Connection Keep-Alive

**File**: `orange-pi-daemon/src/api_client.zig`
```zig
// Add connection pooling configuration
pub const ApiClient = struct {
    allocator: std.mem.Allocator,
    config: types.Config,
    client: std.http.Client,
    
    pub fn init(allocator: std.mem.Allocator, config: types.Config) ApiClient {
        var client = std.http.Client{ .allocator = allocator };
        // Enable connection pooling
        client.connection_pool_size = 4; // Keep 4 connections alive
        return .{ 
            .allocator = allocator, 
            .config = config,
            .client = client,
        };
    }
```

### 5. Implement Database Batch Inserts

**File**: `sms-dashboard/server/handlers/control.js`
```javascript
// Use D1 batch API for message inserts
async uploadMessages(request) {
    // ... existing code ...
    
    // Batch all inserts in a single transaction
    const statements = [];
    for (const msg of uniqueMessages) {
        statements.push(env.DB.prepare(
            `INSERT INTO messages (id, phone_iccid, phone_number, content, timestamp, type, verification_code, status)
             VALUES (?, ?, ?, ?, ?, 'received', ?, 'received')`
        ).bind(
            msg.id, msg.phone_iccid, msg.phone_number, 
            msg.content, msg.timestamp, msg.verification_code
        ));
    }
    
    // Execute all inserts in one batch
    if (statements.length > 0) {
        await env.DB.batch(statements);
    }
}
```

## Medium-Term Optimizations

### 6. Implement Priority-Based Checking
- Check modems with recent activity more frequently
- Already partially implemented but needs tuning
- Reduce check frequency for idle modems to 1/10th rate

### 7. Add Performance Metrics

Create a monitoring endpoint to track:
- Message detection latency
- Queue depths over time
- Processing times per stage
- HTTP request durations

### 8. Optimize Worker Pool Size

```zig
// Line 185: Increase workers for better parallelism
const num_workers = 32; // Was 16, increase for 54 modems
```

## Long-Term Architecture Changes

### 9. Event-Driven Architecture
- Replace polling with ModemManager D-Bus signals
- Implement webhook from ModemManager on SMS arrival
- Use condition variables instead of sleep loops

### 10. WebSocket Restoration
- Re-implement WebSocket for real-time updates
- Use Durable Objects for connection management
- Eliminate SSE polling delay

### 11. Edge Message Processing
- Process messages at edge before database write
- Implement write-through cache for recent messages
- Use KV for temporary message storage

## Expected Performance Improvements

With immediate optimizations (1-5):
- **Polling cycle**: 50ms → 10ms (-40ms)
- **Message processor**: 100ms → 10ms (-90ms)  
- **Cache refresh**: Faster new modem detection
- **HTTP**: 20-50ms → 10-20ms (with keep-alive)
- **Database**: 10-30ms → 5-10ms (batch inserts)

**New expected latency**: 100ms - 500ms (typical ~200ms)
**Improvement**: 5x faster message delivery

## Implementation Priority

1. **Immediate** (Today):
   - Reduce polling intervals (1)
   - Immediate message upload (2)
   - Connection keep-alive (4)

2. **This Week**:
   - Database batch inserts (5)
   - Cache refresh reduction (3)
   - Add metrics endpoint (7)

3. **Next Sprint**:
   - Priority-based checking improvements (6)
   - Worker pool optimization (8)
   - Event-driven architecture research (9)

## Monitoring Recommendations

Add these metrics to track improvements:

```javascript
// Add to control.js
const metrics = {
    messageReceived: Date.now(),
    daemonPolled: null,
    uploaded: null,
    dbWritten: null,
    broadcast: null
};

// Log at each stage
console.log(`[PERF] Stage: ${stage}, Latency: ${Date.now() - metrics.messageReceived}ms`);
```

## Build Optimization

Ensure production builds use maximum optimization:

```bash
# Build daemon with maximum optimization
zig build -Doptimize=ReleaseFast -Dlog_level=info

# Consider using Profile-Guided Optimization (PGO)
zig build -Doptimize=ReleaseFast -Dpgo=true
```