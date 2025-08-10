# Orange Pi SMS Daemon Optimization Guide

## Quick Wins (Implement Today)

### 1. Fix Worker Pool Integration in Main Loop

**Current Issue**: Worker pool is created but not used in the main message checking loop.

**Fix** - Replace lines 322-346 in `main.zig`:

```zig
// OLD: Direct threading approach
const max_threads = @min(modems_to_check.len, 8);
var threads = std.ArrayList(std.Thread).init(allocator);
defer threads.deinit();

for (modems_to_check) |modem_id| {
    const thread = try std.Thread.spawn(.{}, checkModemMessages, .{ &parallel_context, modem_id });
    try threads.append(thread);
    // ... thread management ...
}

// NEW: Use the worker pool
// Submit all work to the pool
for (modems_to_check) |modem_id| {
    try worker_pool.submit(.CheckMessages, modem_id);
}

// Wait for completion with better timeout handling
const wait_start = std.time.milliTimestamp();
while (worker_pool.queueSize() > 0 and 
       std.time.milliTimestamp() - wait_start < 100) {
    std.time.sleep(1 * std.time.ns_per_ms);
}

// Process results from the worker pool
// (Results should be collected via a thread-safe queue in the worker pool)
```

### 2. Enable Batch Message Checking

**Current Issue**: Each modem checked individually even in parallel.

**Add to `modem_manager.zig`**:

```zig
/// Get new messages from multiple modems in parallel
pub fn getNewMessagesBatch(self: *ModemManager, modem_ids: [][]const u8) ![]types.MessageInfo {
    var all_messages = std.ArrayList(types.MessageInfo).init(self.allocator);
    var mutex = std.Thread.Mutex{};
    
    const max_concurrent = 8;
    var semaphore = std.Thread.Semaphore{};
    try semaphore.init(max_concurrent);
    defer semaphore.deinit();
    
    var threads = std.ArrayList(std.Thread).init(self.allocator);
    defer threads.deinit();
    
    const Context = struct {
        manager: *ModemManager,
        modem_id: []const u8,
        messages: *std.ArrayList(types.MessageInfo),
        mutex: *std.Thread.Mutex,
        semaphore: *std.Thread.Semaphore,
    };
    
    for (modem_ids) |modem_id| {
        semaphore.wait();
        const thread = try std.Thread.spawn(.{}, struct {
            fn run(ctx: Context) void {
                defer ctx.semaphore.post();
                
                const messages = ctx.manager.getNewMessages(ctx.modem_id) catch {
                    return;
                };
                
                ctx.mutex.lock();
                defer ctx.mutex.unlock();
                ctx.messages.appendSlice(messages) catch {};
            }
        }.run, .{Context{
            .manager = self,
            .modem_id = modem_id,
            .messages = &all_messages,
            .mutex = &mutex,
            .semaphore = &semaphore,
        }});
        try threads.append(thread);
    }
    
    for (threads.items) |thread| {
        thread.join();
    }
    
    return all_messages.toOwnedSlice();
}
```

### 3. Implement Subprocess Pooling (Quick Fix)

**Current Issue**: Creating new processes for every mmcli call.

**Add to `modem_manager.zig`**:

```zig
const SubprocessPool = struct {
    const Process = struct {
        child: std.process.Child,
        stdin: std.fs.File,
        stdout: std.fs.File,
        busy: bool,
    };
    
    processes: []Process,
    mutex: std.Thread.Mutex,
    allocator: std.mem.Allocator,
    
    pub fn init(allocator: std.mem.Allocator, size: usize) !SubprocessPool {
        var processes = try allocator.alloc(Process, size);
        // Initialize persistent mmcli processes
        // ... implementation ...
        return .{
            .processes = processes,
            .mutex = .{},
            .allocator = allocator,
        };
    }
    
    pub fn execute(self: *SubprocessPool, args: []const []const u8) ![]u8 {
        // Get available process from pool
        // Send command and read response
        // Return process to pool
    }
};
```

## Medium-Term Optimizations (This Week)

### 1. Complete D-Bus Integration

**Replace mmcli calls with direct D-Bus**:

```zig
// Add to busctl_dbus.zig
pub fn getNewMessages(self: *Self, modem_id: []const u8) ![]types.MessageInfo {
    const modem_path = try std.fmt.allocPrint(
        self.allocator,
        "{s}/Modem/{s}",
        .{ MODEM_MANAGER_PATH, modem_id }
    );
    defer self.allocator.free(modem_path);
    
    // Get SMS list via D-Bus
    const result = try std.process.Child.run(.{
        .allocator = self.allocator,
        .argv = &[_][]const u8{
            "busctl",
            "call",
            MODEM_MANAGER_SERVICE,
            modem_path,
            "org.freedesktop.ModemManager1.Modem.Messaging",
            "List",
        },
    });
    defer self.allocator.free(result.stdout);
    defer self.allocator.free(result.stderr);
    
    // Parse SMS paths and fetch each message
    var messages = std.ArrayList(types.MessageInfo).init(self.allocator);
    // ... parse and fetch implementation ...
    
    return messages.toOwnedSlice();
}
```

### 2. Implement Smart Caching

**Add to `modem_manager.zig`**:

```zig
const ModemCache = struct {
    const CacheEntry = struct {
        data: union(enum) {
            state: []const u8,
            iccid: ?[]const u8,
            phone_number: ?[]const u8,
            operator: OperatorInfo,
        },
        timestamp: i64,
        ttl: i64,
    };
    
    entries: std.StringHashMap(CacheEntry),
    mutex: std.Thread.Mutex,
    allocator: std.mem.Allocator,
    
    pub fn get(self: *ModemCache, key: []const u8) ?CacheEntry {
        self.mutex.lock();
        defer self.mutex.unlock();
        
        if (self.entries.get(key)) |entry| {
            if (std.time.timestamp() < entry.timestamp + entry.ttl) {
                return entry;
            }
            // Expired, remove it
            self.entries.remove(key);
        }
        return null;
    }
    
    pub fn put(self: *ModemCache, key: []const u8, entry: CacheEntry) !void {
        self.mutex.lock();
        defer self.mutex.unlock();
        try self.entries.put(key, entry);
    }
};
```

### 3. Event-Driven Message Detection

**Integrate the existing EventLoop**:

```zig
// In main.zig, setup event handlers
try event_loop.on(.MessageReceived, struct {
    fn onMessage(event: Event) void {
        // Process message immediately
        const modem_id = event.modem_id orelse return;
        priority_manager.updateModemPriority(modem_id, true) catch {};
    }
}.onMessage);

// Monitor D-Bus for ModemManager signals
try event_loop.on(.Timer, struct {
    fn checkDBusSignals(event: Event) void {
        // Check for new message signals via D-Bus
        // This avoids polling modems that have no new messages
    }
}.checkDBusSignals);
```

## Long-Term Optimizations (This Month)

### 1. Native ModemManager Bindings

Create proper Zig bindings for libmm-glib:

```zig
// mm_bindings.zig
const c = @cImport({
    @cInclude("libmm-glib/libmm-glib.h");
    @cInclude("glib.h");
});

pub const MMManager = struct {
    manager: *c.MMManager,
    
    pub fn init() !MMManager {
        // Initialize GLib and ModemManager
        c.g_type_init();
        const manager = c.mm_manager_new_sync(
            c.g_bus_get_sync(c.G_BUS_TYPE_SYSTEM, null, null),
            c.G_DBUS_OBJECT_MANAGER_CLIENT_FLAGS_NONE,
            null,
            null
        );
        return .{ .manager = manager };
    }
    
    pub fn listModems(self: *MMManager) ![]Modem {
        const objects = c.g_dbus_object_manager_get_objects(
            @ptrCast(self.manager)
        );
        defer c.g_list_free_full(objects, c.g_object_unref);
        
        // Convert GList to Zig slice
        // ... implementation ...
    }
};
```

### 2. Kernel Event Monitoring

Use inotify/udev for hardware changes:

```zig
// udev_monitor.zig
const UdevMonitor = struct {
    fd: std.posix.fd_t,
    
    pub fn init() !UdevMonitor {
        // Setup udev monitor for USB device events
        const udev = c.udev_new();
        const mon = c.udev_monitor_new_from_netlink(udev, "udev");
        c.udev_monitor_filter_add_match_subsystem_devtype(mon, "usb", null);
        c.udev_monitor_enable_receiving(mon);
        const fd = c.udev_monitor_get_fd(mon);
        
        return .{ .fd = fd };
    }
    
    pub fn pollEvents(self: *UdevMonitor) ![]DeviceEvent {
        // Use epoll to monitor for device changes
        // Return list of connect/disconnect events
    }
};
```

### 3. Zero-Allocation Message Processing

Use arena allocators for batch processing:

```zig
// In main loop
var arena = std.heap.ArenaAllocator.init(allocator);
defer arena.deinit();

// Process entire cycle with arena
const arena_allocator = arena.allocator();
const messages = try collectAllMessages(arena_allocator, modems);
try processMessages(arena_allocator, messages);
try uploadMessages(arena_allocator, messages);

// Everything freed at once when arena is reset
```

## Performance Monitoring

Add metrics collection:

```zig
const Metrics = struct {
    cycle_times: RingBuffer(i64, 1000),
    messages_per_second: f64,
    subprocess_count: u64,
    cache_hit_rate: f64,
    
    pub fn recordCycle(self: *Metrics, time_ms: i64) void {
        self.cycle_times.push(time_ms);
    }
    
    pub fn report(self: *const Metrics) void {
        const avg_cycle = self.cycle_times.average();
        std.log.info("Performance: cycle={d}ms, msgs/s={d:.1}, cache_hit={d:.1}%", .{
            avg_cycle,
            self.messages_per_second,
            self.cache_hit_rate * 100,
        });
    }
};
```

## Testing Performance Improvements

Run the benchmark before and after each optimization:

```bash
# Baseline
zig build benchmark > baseline.txt

# After optimization
zig build benchmark > optimized.txt

# Compare
diff baseline.txt optimized.txt
```

## Expected Results

| Optimization | Expected Improvement | Complexity |
|-------------|---------------------|------------|
| Worker Pool Fix | 20-30% faster | Low |
| Batch Operations | 15-25% faster | Medium |
| D-Bus Integration | 50-60% faster | High |
| Caching | 20-30% faster | Medium |
| Native Bindings | 70-80% faster | High |

## Priority Order

1. **Fix worker pool** (1 hour, 20-30% gain)
2. **Add subprocess pooling** (2 hours, 30-40% gain)
3. **Implement caching** (4 hours, 20-30% gain)
4. **Complete D-Bus** (8 hours, 50-60% gain)
5. **Native bindings** (16 hours, 70-80% gain)

Total expected improvement: **3-4x performance increase**