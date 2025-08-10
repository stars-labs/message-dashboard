const std = @import("std");
const utils = @import("utils.zig");
const types = @import("types.zig");
const ModemManager = @import("modem_manager.zig").ModemManager;
const ApiClient = @import("api_client.zig").ApiClient;
const SignalCache = @import("signal_cache.zig").SignalCache;
const MessageQueue = @import("message_queue.zig").MessageQueue;
const worker_threads = @import("worker_threads.zig");
const build_options = @import("build_options");
const ModemPriority = @import("modem_priority.zig");
const MessageDeduplicator = @import("bloom_filter.zig").MessageDeduplicator;
const WorkerPool = @import("worker_pool.zig").WorkerPool;
const EventLoop = @import("event_loop.zig").EventLoop;
const ConnectionPool = @import("connection_pool.zig").ConnectionPool;

// Configure logging based on build options and runtime environment
const build_log_level: std.log.Level = blk: {
    const level_str = build_options.log_level;
    if (std.mem.eql(u8, level_str, "debug")) break :blk .debug;
    if (std.mem.eql(u8, level_str, "info")) break :blk .info;
    if (std.mem.eql(u8, level_str, "warn")) break :blk .warn;
    if (std.mem.eql(u8, level_str, "err")) break :blk .err;
    break :blk .info; // default
};

pub const std_options: std.Options = .{
    .log_level = build_log_level,
};


const ModemCheckResult = struct {
    modem_id: []const u8,
    messages: []types.MessageInfo,
    success: bool,
    allocator: std.mem.Allocator,
    
    pub fn deinit(self: *ModemCheckResult) void {
        if (self.success) {
            for (self.messages) |*msg| {
                self.allocator.free(msg.modem_id);
                self.allocator.free(msg.sms_id);
                self.allocator.free(msg.message.phone_iccid);
                self.allocator.free(msg.message.phone_number);
                self.allocator.free(msg.message.content);
                self.allocator.free(msg.message.timestamp);
            }
            self.allocator.free(self.messages);
        }
    }
};

const ParallelContext = struct {
    allocator: std.mem.Allocator,
    modem_manager: *ModemManager,
    message_queue: *MessageQueue,
    results_mutex: std.Thread.Mutex,
    results: *std.ArrayList(ModemCheckResult),
};

fn checkModemMessages(context: *ParallelContext, modem_id: []const u8) void {
    var result = ModemCheckResult{
        .modem_id = modem_id,
        .messages = &[_]types.MessageInfo{},
        .success = false,
        .allocator = context.allocator,
    };
    
    // Check messages for this modem
    const new_messages = context.modem_manager.getNewMessages(modem_id) catch |err| {
        std.log.debug("Failed to get messages from modem {s}: {any}", .{ modem_id, err });
        
        // Add failed result
        context.results_mutex.lock();
        defer context.results_mutex.unlock();
        context.results.append(result) catch {};
        return;
    };
    
    result.messages = new_messages;
    result.success = true;
    
    // Add result to shared list
    context.results_mutex.lock();
    defer context.results_mutex.unlock();
    context.results.append(result) catch |err| {
        std.log.err("Failed to store result: {any}", .{err});
        result.deinit();
    };
}

pub fn main() !void {
    const stdout = std.io.getStdOut().writer();
    try stdout.print("📱 Orange Pi SMS Dashboard Daemon v3.1.0\n", .{});
    
    // Initialize allocator
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    const allocator = gpa.allocator();
    
    // Load configuration
    const config = try utils.loadConfig(allocator);
    defer allocator.free(config.api_url);
    defer allocator.free(config.api_key);
    
    std.log.info("🔧 Configuration loaded - API: {s}", .{config.api_url});
    std.log.info("📊 Message checking: parallel (ultra-fast)", .{});
    std.log.info("📊 Phone updates: every {}s", .{config.check_interval});
    std.log.info("📊 Signal checks: every {}s", .{config.signal_check_interval});
    std.log.info("📤 SMS sending: enabled (polling every 5s)", .{});
    
    // Initialize components
    var modem_manager = ModemManager.init(allocator);
    defer modem_manager.deinit();
    
    var api_client = ApiClient.init(allocator, config);
    defer api_client.deinit();
    
    var signal_cache = SignalCache.init(allocator);
    defer signal_cache.deinit();
    
    var message_queue = MessageQueue.init(allocator);
    defer message_queue.deinit();
    
    // Shared exit flag
    var should_exit = std.atomic.Value(bool).init(false);
    
    // Create worker context
    var context = worker_threads.WorkerContext{
        .allocator = allocator,
        .config = config,
        .message_queue = &message_queue,
        .modem_manager = &modem_manager,
        .api_client = &api_client,
        .signal_cache = &signal_cache,
        .should_exit = &should_exit,
    };
    
    // Thread wrapper to handle errors
    const ThreadWrapper = struct {
        fn messageWrapper(ctx: *worker_threads.WorkerContext) void {
            worker_threads.messageProcessorThread(ctx) catch |err| {
                std.log.err("Message processor thread crashed: {any}", .{err});
            };
        }
        fn phoneWrapper(ctx: *worker_threads.WorkerContext) void {
            worker_threads.phoneStatusThread(ctx) catch |err| {
                std.log.err("Phone status thread crashed: {any}", .{err});
            };
        }
        fn signalWrapper(ctx: *worker_threads.WorkerContext) void {
            worker_threads.signalMonitorThread(ctx) catch |err| {
                std.log.err("Signal monitor thread crashed: {any}", .{err});
            };
        }
        fn smsWrapper(ctx: *worker_threads.WorkerContext) void {
            worker_threads.smsSenderThread(ctx) catch |err| {
                std.log.err("SMS sender thread crashed: {any}", .{err});
            };
        }
    };
    
    // Start worker threads
    const message_thread = try std.Thread.spawn(.{}, ThreadWrapper.messageWrapper, .{&context});
    const phone_thread = try std.Thread.spawn(.{}, ThreadWrapper.phoneWrapper, .{&context});
    const signal_thread = try std.Thread.spawn(.{}, ThreadWrapper.signalWrapper, .{&context});
    const sms_thread = try std.Thread.spawn(.{}, ThreadWrapper.smsWrapper, .{&context});
    
    // Initialize priority manager and deduplicator
    var priority_manager = ModemPriority.PriorityManager.init(allocator);
    defer priority_manager.deinit();
    
    var deduplicator = try MessageDeduplicator.init(allocator);
    defer deduplicator.deinit();
    
    // Initialize worker pool for parallel processing
    const num_workers = @min(8, std.Thread.getCpuCount() catch 4); // Use up to 8 workers or CPU count
    var worker_pool = try WorkerPool.init(allocator, num_workers, &modem_manager, &should_exit);
    defer worker_pool.deinit();
    
    // Initialize event loop for reactive processing
    var event_loop = EventLoop.init(allocator);
    defer event_loop.deinit();
    try event_loop.start();
    
    std.log.info("🚀 Initialized with {d} worker threads for parallel processing", .{num_workers});
    
    // Get initial modem list and build cache of valid modems
    std.log.info("🔄 Building valid modem cache", .{});
    var valid_modems = std.ArrayList([]const u8).init(allocator);
    defer {
        for (valid_modems.items) |modem_id| {
            allocator.free(modem_id);
        }
        valid_modems.deinit();
    }
    
    const all_modems = modem_manager.listModems() catch &[_][]const u8{};
    defer {
        for (all_modems) |modem| allocator.free(modem);
        allocator.free(all_modems);
    }
    
    for (all_modems) |modem_id| {
        if (modem_manager.problematic_modems.contains(modem_id)) {
            std.log.warn("⚠️ Skipping modem {s} - marked as problematic (corrupted state)", .{modem_id});
            continue;
        }
        
        // Quick check if modem has SIM
        const iccid_opt = modem_manager.getIccid(modem_id) catch continue;
        if (iccid_opt) |iccid| {
            allocator.free(iccid);
            try valid_modems.append(try allocator.dupe(u8, modem_id));
            std.log.info("✅ Cached modem {s} as valid", .{modem_id});
        }
    }
    
    std.log.info("🚀 Starting parallel message checking with {d} modems", .{valid_modems.items.len});
    
    // Main loop with parallel checking
    var cycle_count: u64 = 0;
    var last_cache_refresh: i64 = std.time.timestamp();
    var last_storage_cleanup: i64 = std.time.timestamp();
    
    while (true) {
        cycle_count += 1;
        const cycle_start = std.time.nanoTimestamp();
        
        // Refresh cache every 5 minutes
        if (std.time.timestamp() - last_cache_refresh > 300) {
            std.log.info("🔄 Refreshing modem cache", .{});
            
            // Clear old cache
            for (valid_modems.items) |old_modem| {
                allocator.free(old_modem);
            }
            valid_modems.clearAndFree();
            
            // Rebuild cache
            const current_modems = modem_manager.listModems() catch &[_][]const u8{};
            defer {
                for (current_modems) |modem| allocator.free(modem);
                allocator.free(current_modems);
            }
            
            for (current_modems) |modem_id| {
                if (modem_manager.problematic_modems.contains(modem_id)) continue;
                
                const iccid_opt = modem_manager.getIccid(modem_id) catch continue;
                if (iccid_opt) |iccid| {
                    allocator.free(iccid);
                    try valid_modems.append(try allocator.dupe(u8, modem_id));
                }
            }
            
            last_cache_refresh = std.time.timestamp();
            std.log.info("🔄 Cache refreshed: {d} valid modems", .{valid_modems.items.len});
        }
        
        // Clean up SMS storage every 10 minutes to prevent overflow
        if (std.time.timestamp() - last_storage_cleanup > 600) {
            std.log.info("🧹 Running periodic SMS storage cleanup", .{});
            
            for (valid_modems.items) |modem_id| {
                modem_manager.cleanupModemStorage(modem_id) catch |err| {
                    std.log.warn("Failed to cleanup storage for modem {s}: {any}", .{ modem_id, err });
                };
            }
            
            last_storage_cleanup = std.time.timestamp();
        }
        
        // Create shared results storage
        var results = std.ArrayList(ModemCheckResult).init(allocator);
        defer {
            for (results.items) |*result| {
                result.deinit();
            }
            results.deinit();
        }
        
        var parallel_context = ParallelContext{
            .allocator = allocator,
            .modem_manager = &modem_manager,
            .message_queue = &message_queue,
            .results_mutex = .{},
            .results = &results,
        };
        
        // Get modems to check based on priority
        const modems_to_check = try priority_manager.getModemsToCheck(valid_modems.items, cycle_count, allocator);
        defer allocator.free(modems_to_check);
        
        // Log priority stats periodically
        if (cycle_count % 50 == 0) {
            const priority_stats = priority_manager.getStats();
            std.log.info("📊 Priority stats: High={d}, Medium={d}, Low={d}, Checking={d}/{d}", .{
                priority_stats.high, priority_stats.medium, priority_stats.low,
                modems_to_check.len, valid_modems.items.len
            });
        }
        
        // Submit work to worker pool for parallel processing
        for (modems_to_check) |modem_id| {
            // Validate context pointer alignment before submitting
            const context_ptr = &parallel_context;
            if (@intFromPtr(context_ptr) % @alignOf(ParallelContext) != 0) {
                std.log.err("Context alignment issue detected for modem {s}", .{modem_id});
                continue;
            }
            try worker_pool.submit(.CheckMessages, modem_id, context_ptr);
        }
        
        // Wait for work to complete (with smart timeout)
        const start_wait = std.time.milliTimestamp();
        const max_wait_ms: i64 = @max(20, @min(100, modems_to_check.len * 2)); // Dynamic timeout based on modem count
        
        while (worker_pool.hasActiveWork()) {
            const elapsed = std.time.milliTimestamp() - start_wait;
            if (elapsed > max_wait_ms) {
                const pending = worker_pool.queueSize();
                if (pending > 0) {
                    std.log.debug("⏳ {d} modems still processing after {d}ms", .{ pending, elapsed });
                }
                break;
            }
            std.time.sleep(500 * std.time.ns_per_us); // 0.5ms sleep for faster response
        }
        
        // Process all results and update priorities
        var total_messages: usize = 0;
        
        // Add safety check for results processing
        if (results.items.len == 0) {
            std.log.debug("No results to process in cycle {d}", .{cycle_count});
        }
        
        for (results.items) |*result| {
            // Update modem priority based on whether messages were found
            const found_messages = result.success and result.messages.len > 0;
            priority_manager.updateModemPriority(result.modem_id, found_messages) catch |err| {
                std.log.warn("Failed to update priority for modem {s}: {any}", .{ result.modem_id, err });
            };
            
            if (result.success) {
                total_messages += result.messages.len;
                
                // Queue messages for processing with deduplication
                for (result.messages) |msg| {
                    // Create deduplication key
                    const key = MessageDeduplicator.makeKey(allocator, msg.message.phone_iccid, msg.message.content, msg.message.timestamp) catch {
                        // If we can't make a key, queue it anyway
                        message_queue.push(msg) catch |err| {
                            std.log.err("Failed to queue message: {any}", .{err});
                        };
                        continue;
                    };
                    defer allocator.free(key);
                    
                    // Check for duplicate
                    if (!deduplicator.isDuplicate(key)) {
                        message_queue.push(msg) catch |err| {
                            std.log.err("Failed to queue message: {any}", .{err});
                        };
                        deduplicator.addMessage(key) catch |err| {
                            std.log.warn("Failed to add message to deduplicator: {any}", .{err});
                        };
                    }
                }
            }
        }
        
        const cycle_end = std.time.nanoTimestamp();
        const cycle_time_ms = @divFloor(cycle_end - cycle_start, std.time.ns_per_ms);
        
        if (total_messages > 0) {
            std.log.info("📬 Found {d} messages in cycle {d} ({d}ms) (queue: {d})", .{
                total_messages, cycle_count, cycle_time_ms, message_queue.size()
            });
        }
        
        // Performance stats every 20 cycles
        if (cycle_count % 20 == 0) {
            const avg_ms_per_modem = if (modems_to_check.len > 0) 
                @divFloor(cycle_time_ms, modems_to_check.len) else 0;
            const tracked_messages = modem_manager.message_tracker.count();
            const dedup_stats = deduplicator.getStats();
            std.log.info("⚡ Cycle {d}: {d}ms total, ~{d}ms per modem, {d}/{d} modems checked", .{
                cycle_count, cycle_time_ms, avg_ms_per_modem, modems_to_check.len, valid_modems.items.len
            });
            std.log.info("📈 Dedup stats: ~{d:.0} in bloom, {d} in cache, {d:.3}% false positive", .{
                dedup_stats.bloom_estimate, dedup_stats.cache_size, dedup_stats.false_positive_prob * 100
            });
            std.log.info("💾 Tracked messages: {d}", .{tracked_messages});
        }
        
        // Adaptive timing: sleep only remaining time to reach target cycle time
        const target_cycle_time: u64 = 50 * std.time.ns_per_ms; // 50ms target for faster response
        const actual_cycle_time: u64 = @intCast(cycle_time_ms * std.time.ns_per_ms);
        
        const sleep_time: u64 = if (actual_cycle_time < target_cycle_time)
            target_cycle_time - actual_cycle_time  // Sleep remaining time
        else
            1 * std.time.ns_per_ms;  // Minimal sleep if cycle took longer than target
        
        std.time.sleep(sleep_time);
    }
    
    // Cleanup
    should_exit.store(true, .release);
    message_thread.join();
    phone_thread.join();
    signal_thread.join();
    sms_thread.join();
}