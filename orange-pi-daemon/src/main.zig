const std = @import("std");
const utils = @import("utils.zig");
const types = @import("types.zig");
const ModemManager = @import("modem_manager.zig").ModemManager;
const ApiClient = @import("api_client.zig").ApiClient;
const LockFreeSignalCache = @import("lockfree_signal_cache.zig").LockFreeSignalCache;
const LockFreeMessageQueue = @import("lockfree_message_queue.zig").LockFreeMessageQueue;
const worker_threads = @import("worker_threads.zig");
const build_options = @import("build_options");
const LockFreePriorityManager = @import("lockfree_priority_manager.zig").LockFreePriorityManager;
// MessageDeduplicator removed - not needed for receiving messages
const WorkerPool = @import("worker_pool.zig").WorkerPool;
const LockFreeMPMC = @import("lockfree_mpmc.zig").LockFreeMPMC;

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


const ModemCheckResult = types.ModemCheckResult;

const ParallelContext = struct {
    allocator: std.mem.Allocator,
    modem_manager: *ModemManager,
    message_queue: *LockFreeMessageQueue,
    results: *LockFreeMPMC(ModemCheckResult),
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
        context.results.push(result);
        return;
    };
    
    result.messages = new_messages;
    result.success = true;
    
    // Add result to lock-free queue
    context.results.push(result);
}

pub fn main() !void {
    const stdout = std.io.getStdOut().writer();
    try stdout.print("📱 Orange Pi SMS Dashboard Daemon v3.9.0 (Queue Management Edition)\n", .{});
    
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
    
    var signal_cache = LockFreeSignalCache.init(allocator);
    defer signal_cache.deinit();
    
    var message_queue = LockFreeMessageQueue.init(allocator);
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
        fn deviceWrapper(ctx: *worker_threads.WorkerContext) void {
            worker_threads.deviceStatusThread(ctx) catch |err| {
                std.log.err("Device status thread crashed: {any}", .{err});
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
    const device_thread = try std.Thread.spawn(.{}, ThreadWrapper.deviceWrapper, .{&context});
    const signal_thread = try std.Thread.spawn(.{}, ThreadWrapper.signalWrapper, .{&context});
    const sms_thread = try std.Thread.spawn(.{}, ThreadWrapper.smsWrapper, .{&context});
    
    // Initialize lock-free priority manager and deduplicator BEFORE starting workers
    // Lock-free implementation prevents all deadlocks
    var priority_manager = LockFreePriorityManager.init(allocator);
    defer priority_manager.deinit();
    
    // Message deduplicator removed - not needed for receiving messages
    // The server handles any necessary deduplication
    
    // Event loop removed - was causing deadlock and not being used
    
    // Get initial modem list and build cache of valid modems BEFORE starting workers
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
    
    // Initialize worker pool AFTER building modem cache to avoid deadlock
    // Reduce to 8 workers to prevent SystemResources errors with 54 modems
    const num_workers = 8;
    var worker_pool = try WorkerPool.init(allocator, num_workers, &modem_manager, &should_exit);
    defer worker_pool.deinit();
    
    // Start the worker threads now that the pool is fully initialized
    try worker_pool.start();
    
    std.log.info("🚀 Initialized {d} worker threads for parallel processing", .{num_workers});
    
    // Give workers time to fully initialize before starting main loop
    // This prevents deadlock when main thread starts using mutexes before workers are ready
    std.time.sleep(500 * std.time.ns_per_ms);
    std.log.info("✅ Worker initialization complete, starting main loop", .{});
    
    // Main loop with parallel checking
    var cycle_count: u64 = 0;
    var last_cache_refresh: i64 = std.time.timestamp();
    var last_storage_cleanup: i64 = std.time.timestamp();
    var last_queue_health_check: i64 = std.time.timestamp();
    var consecutive_queue_issues: u32 = 0;
    
    while (true) {
        cycle_count += 1;
        const cycle_start = std.time.nanoTimestamp();
        
        // Refresh cache every 30 seconds for faster detection of new modems
        if (std.time.timestamp() - last_cache_refresh > 30) {
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
        
        // Queue health check every 30 seconds
        if (std.time.timestamp() - last_queue_health_check > 30) {
            const queue_stats = worker_pool.getQueueStats();
            const queue_size = queue_stats.size;
            
            if (queue_size > valid_modems.items.len) {
                consecutive_queue_issues += 1;
                std.log.warn("⚠️ Queue health check: size={d} exceeds modem count={d} (issue #{d})", .{ 
                    queue_size, valid_modems.items.len, consecutive_queue_issues 
                });
                
                // If persistent issues, try to recover
                if (consecutive_queue_issues >= 3) {
                    std.log.err("🔧 Persistent queue issues detected. Attempting recovery...", .{});
                    
                    // Clear the work queue completely
                    var cleared: usize = 0;
                    while (worker_pool.work_queue.tryPop()) |work| {
                        allocator.free(work.modem_id);
                        cleared += 1;
                        if (cleared > 10000) break; // Safety limit
                    }
                    
                    std.log.info("✅ Cleared {d} items from work queue", .{cleared});
                    consecutive_queue_issues = 0;
                }
            } else {
                // Queue is healthy, reset counter
                if (consecutive_queue_issues > 0) {
                    std.log.info("✅ Queue health restored: size={d}", .{queue_size});
                }
                consecutive_queue_issues = 0;
            }
            
            last_queue_health_check = std.time.timestamp();
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
        
        // Create lock-free results queue for this cycle
        var results_queue = LockFreeMPMC(ModemCheckResult).init(allocator);
        defer results_queue.deinit();
        
        var parallel_context = ParallelContext{
            .allocator = allocator,
            .modem_manager = &modem_manager,
            .message_queue = &message_queue,
            .results = &results_queue,
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
        
        // Check if worker pool is still busy from previous cycle
        const initial_queue_size = worker_pool.queueSize();
        
        // CRITICAL: Only submit new work when queue is nearly empty
        // This prevents queue overflow and ensures workers can catch up
        if (initial_queue_size > 20) {
            const wait_ms: u64 = if (initial_queue_size > 100)
                100 // Very full - increased wait time
            else if (initial_queue_size > 50)
                50 // Moderately full
            else
                25; // Slightly full
                
            std.log.debug("⏳ Queue has {d} items, waiting {d}ms for workers to catch up", .{initial_queue_size, wait_ms});
            std.time.sleep(wait_ms * std.time.ns_per_ms);
            continue; // Skip this cycle completely
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
        const max_wait_ms: i64 = @max(50, @min(200, modems_to_check.len * 3)); // More generous timeout
        
        while (worker_pool.hasActiveWork()) {
            const elapsed = std.time.milliTimestamp() - start_wait;
            if (elapsed > max_wait_ms) {
                const pending = worker_pool.queueSize();
                if (pending > 0) {
                    std.log.debug("⏳ {d} modems still processing after {d}ms", .{ pending, elapsed });
                }
                break;
            }
            std.time.sleep(1 * std.time.ns_per_ms); // 1ms sleep for better balance
        }
        
        // Process all results and update priorities
        var total_messages: usize = 0;
        
        // Collect all results from lock-free queue
        var results = std.ArrayList(ModemCheckResult).init(allocator);
        defer {
            for (results.items) |*result| {
                result.deinit();
            }
            results.deinit();
        }
        
        // Drain results from lock-free queue
        const queue_size_before = results_queue.size();
        if (queue_size_before > 0) {
            std.log.debug("Results queue has {d} items before draining", .{queue_size_before});
        }
        var popped_count: usize = 0;
        while (results_queue.tryPop()) |result| {
            popped_count += 1;
            std.log.debug("Popped result: modem_id len={d}, success={}, messages.len={d}", .{result.modem_id.len, result.success, result.messages.len});
            try results.append(result);
            // Validate the result was appended correctly
            const appended = &results.items[results.items.len - 1];
            std.log.debug("After append: messages.len={d}", .{appended.messages.len});
        }
        if (queue_size_before > 0) {
            std.log.debug("Popped {d} results from queue (had {d}), results.items.len={d}", .{popped_count, queue_size_before, results.items.len});
        }
        
        // Process results with simplified logic to avoid panic
        if (results.items.len > 0) {
            std.log.debug("Processing {d} results in cycle {d}", .{results.items.len, cycle_count});
            
            // Simple foreach loop instead of complex bounds checking
            for (results.items) |*result| {
                // Basic validation only
                if (result.modem_id.len == 0) {
                    std.log.warn("Skipping result with empty modem_id", .{});
                    continue;
                }
                
                // Update modem priority based on whether messages were found
                const found_messages = result.success and result.messages.len > 0;
                priority_manager.updateModemPriority(result.modem_id, found_messages) catch |err| {
                    std.log.warn("Failed to update priority: {any}", .{err});
                };
                
                if (result.success) {
                    if (result.messages.len > 0) {
                        std.log.info("📬 Processing {d} messages from result", .{result.messages.len});
                        total_messages += result.messages.len;
                        
                        // Queue messages for upload
                        for (result.messages) |msg| {
                            message_queue.push(msg) catch |err| {
                                std.log.err("Failed to queue message: {any}", .{err});
                            };
                        }
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
            const worker_stats = worker_pool.getQueueStats();
            std.log.info("⚡ Cycle {d}: {d}ms total, ~{d}ms per modem, {d}/{d} modems checked", .{
                cycle_count, cycle_time_ms, avg_ms_per_modem, modems_to_check.len, valid_modems.items.len
            });
            std.log.info("🔧 Worker pool: queue_size={d}, head={d}, tail={d}, active_workers={d}", .{
                worker_stats.size, worker_stats.head, worker_stats.tail, worker_stats.active_workers
            });
            std.log.info("💾 Tracked messages: {d}", .{tracked_messages});
        }
        
        // Adaptive timing based on queue status and cycle performance
        const final_queue_size = worker_pool.queueSize();
        
        // Dynamic target based on queue health
        const base_target: u64 = 10 * std.time.ns_per_ms; // Reduced from 50ms to 10ms for faster response
        const target_cycle_time: u64 = if (final_queue_size > modems_to_check.len)
            // Queue is growing, slow down to let workers catch up
            @min(100 * std.time.ns_per_ms, base_target + (final_queue_size * 1 * std.time.ns_per_ms))
        else if (final_queue_size > 10)
            // Queue has some items, slightly slower cycle
            base_target + 10 * std.time.ns_per_ms
        else
            // Queue is healthy, use base target
            base_target;
        
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
    device_thread.join();
    signal_thread.join();
    sms_thread.join();
}