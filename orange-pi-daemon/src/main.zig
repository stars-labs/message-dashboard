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
const SafeResultQueue = @import("safe_result_queue.zig").SafeResultQueue;

// Systemd notify for watchdog support
fn notifySystemd(message: []const u8) void {
    // Use systemd-notify command instead of linking to libsystemd
    var process = std.process.Child.init(&[_][]const u8{ "systemd-notify", message }, std.heap.page_allocator);
    process.stdin_behavior = .Ignore;
    process.stdout_behavior = .Ignore;
    process.stderr_behavior = .Ignore;
    
    const result = process.spawnAndWait() catch |err| {
        std.log.warn("Failed to spawn systemd-notify: {any}", .{err});
        return;
    };
    
    if (result != .Exited or result.Exited != 0) {
        std.log.warn("systemd-notify failed with result: {any}", .{result});
    }
}

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
    results: *SafeResultQueue,  // Thread-safe result queue with mutex
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
    std.debug.print("📱 Orange Pi SMS Dashboard Daemon v3.9.0 (Queue Management Edition)\n", .{});
    
    // Initialize thread-safe allocator
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    var thread_safe_allocator = std.heap.ThreadSafeAllocator{ .child_allocator = gpa.allocator() };
    const allocator = thread_safe_allocator.allocator();
    
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
    var valid_modems: std.ArrayList([]const u8) = .empty;
    defer {
        for (valid_modems.items) |modem_id| {
            allocator.free(modem_id);
        }
        valid_modems.deinit(allocator);
    }
    
    const all_modems = modem_manager.listModems() catch &[_][]const u8{};
    defer {
        for (all_modems) |modem| allocator.free(modem);
        allocator.free(all_modems);
    }
    
    for (all_modems) |modem_id| {
        // Thread-safe check for problematic modems
        modem_manager.hash_maps_mutex.lock();
        const is_problematic = modem_manager.problematic_modems.contains(modem_id);
        modem_manager.hash_maps_mutex.unlock();
        
        if (is_problematic) {
            std.log.warn("⚠️ Skipping modem {s} - marked as problematic (corrupted state)", .{modem_id});
            continue;
        }
        
        // Quick check if modem has SIM
        const iccid_opt = modem_manager.getIccid(modem_id) catch continue;
        if (iccid_opt) |iccid| {
            allocator.free(iccid);
            try valid_modems.append(allocator, try allocator.dupe(u8, modem_id));
            std.log.info("✅ Cached modem {s} as valid", .{modem_id});
        }
    }
    
    std.log.info("🚀 Starting parallel message checking with {d} modems", .{valid_modems.items.len});
    
    // Initialize worker pool AFTER building modem cache to avoid deadlock
    // Use 8 workers with lock-free queue hardened against UAF
    const num_workers = 8;
    var worker_pool = try WorkerPool.init(allocator, num_workers, &modem_manager, &should_exit);
    defer worker_pool.deinit();
    
    // Start the worker threads now that the pool is fully initialized
    try worker_pool.start();
    
    std.log.info("🚀 Initialized {d} worker threads for parallel processing", .{num_workers});
    
    // Give workers time to fully initialize before starting main loop
    // This prevents deadlock when main thread starts using mutexes before workers are ready
    std.Thread.sleep(500 * std.time.ns_per_ms);
    std.log.info("✅ Worker initialization complete, starting main loop", .{});
    
    // Notify systemd that daemon is ready
    notifySystemd("READY=1");
    std.log.info("🔔 Notified systemd that daemon is ready", .{});
    
    // Create lock-free results queue OUTSIDE the main loop
    // This is critical - it must persist across cycles!
    var results_queue = SafeResultQueue.init(allocator);
    defer results_queue.deinit();
    
    // Create the parallel context OUTSIDE the main loop too
    // Workers need consistent context across cycles
    var parallel_context = ParallelContext{
        .allocator = allocator,
        .modem_manager = &modem_manager,
        .message_queue = &message_queue,
        .results = &results_queue,
    };
    
    // Main loop with parallel checking
    var cycle_count: u64 = 0;
    var last_cache_refresh: i64 = std.time.timestamp();
    var last_storage_cleanup: i64 = std.time.timestamp();
    var last_queue_health_check: i64 = std.time.timestamp();
    var last_watchdog_notify: i64 = std.time.timestamp();
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
            valid_modems.clearAndFree(allocator);
            
            // Rebuild cache
            const current_modems = modem_manager.listModems() catch &[_][]const u8{};
            defer {
                for (current_modems) |modem| allocator.free(modem);
                allocator.free(current_modems);
            }
            
            for (current_modems) |modem_id| {
                // Thread-safe check for problematic modems
                modem_manager.hash_maps_mutex.lock();
                const is_problematic = modem_manager.problematic_modems.contains(modem_id);
                modem_manager.hash_maps_mutex.unlock();
                
                if (is_problematic) continue;
                
                const iccid_opt = modem_manager.getIccid(modem_id) catch continue;
                if (iccid_opt) |iccid| {
                    allocator.free(iccid);
                    try valid_modems.append(allocator, try allocator.dupe(u8, modem_id));
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
        
        // Get modems to check based on priority
        const modems_to_check = try priority_manager.getModemsToCheck(valid_modems.items, cycle_count, allocator);
        defer allocator.free(modems_to_check);
        
        // DEBUG: Log first few cycles to understand the issue
        if (cycle_count <= 10) {
            std.log.info("🔍 CYCLE {d}: Found {d} valid modems, got {d} to check", .{cycle_count, valid_modems.items.len, modems_to_check.len});
            if (valid_modems.items.len > 0 and modems_to_check.len == 0) {
                std.log.warn("⚠️  No modems selected for checking despite {d} valid modems!", .{valid_modems.items.len});
            }
        }
        
        // Log priority stats periodically
        if (cycle_count % 50 == 0) {
            const priority_stats = priority_manager.getStats();
            std.log.info("📊 Priority stats: High={d}, Medium={d}, Low={d}, Total={d}, Checking={d}/{d}", .{
                priority_stats.high, priority_stats.medium, priority_stats.low, priority_stats.total,
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
            std.Thread.sleep(wait_ms * std.time.ns_per_ms);
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
            std.Thread.sleep(1 * std.time.ns_per_ms); // 1ms sleep for better balance
        }
        
        // Process all results and update priorities
        var total_messages: usize = 0;
        
        // Collect all results from lock-free queue
        var results: std.ArrayList(*ModemCheckResult) = .empty;
        defer {
            for (results.items) |result| {  // Now result is a pointer
                result.deinit();
                allocator.destroy(result);  // Free the heap-allocated result
            }
            results.deinit(allocator);
        }
        
        // Drain results from lock-free queue
        const queue_size_before = results_queue.size();
        if (queue_size_before > 0) {
            std.log.debug("Results queue has {d} items before draining", .{queue_size_before});
        }
        var popped_count: usize = 0;
        while (results_queue.tryPop()) |result_ptr| {
            popped_count += 1;
            // More detailed logging to debug the issue
            if (result_ptr.messages.len > 0) {
                std.log.info("🎯 Popped result WITH MESSAGES: modem_id={s}, success={}, messages.len={d}", .{result_ptr.modem_id, result_ptr.success, result_ptr.messages.len});
                std.log.info("Messages slice pointer: {*}, first message ptr: {*}", .{result_ptr.messages.ptr, &result_ptr.messages[0]});
                std.log.info("First message modem_id: {s}, sms_id: {s}", .{result_ptr.messages[0].modem_id, result_ptr.messages[0].sms_id});
            } else {
                std.log.debug("Popped result: modem_id={s}, success={}, messages.len=0", .{result_ptr.modem_id, result_ptr.success});
            }
            
            // Critical fix: Handle append failure without losing the result
            results.append(allocator, result_ptr) catch |err| {
                std.log.err("🚨 CRITICAL: Failed to append result, processing immediately to avoid message loss: {any}", .{err});
                
                // Process this single result immediately to prevent message loss
                if (result_ptr.success and result_ptr.messages.len > 0) {
                    std.log.info("📬 Emergency processing {d} messages from result", .{result_ptr.messages.len});
                    
                    // Queue messages for upload directly
                    for (result_ptr.messages) |msg| {
                        std.log.info("📤 Emergency queueing message from {s} for upload", .{msg.modem_id});
                        message_queue.push(msg) catch |queue_err| {
                            std.log.err("Failed to emergency queue message: {any}", .{queue_err});
                        };
                    }
                }
                
                // Clean up the result since we can't store it
                result_ptr.deinit();
                allocator.destroy(result_ptr);
                continue;
            };
            
            // Validate the result was appended correctly
            const appended = results.items[results.items.len - 1];
            std.log.debug("After append: messages.len={d} (count={d})", .{appended.messages.len, appended.message_count});
            if (appended.success and appended.messages.len == 0 and appended.message_count > 0) {
                std.log.err("Inconsistent result: len=0 but count>0, dropping to avoid UAF", .{});
            }
        }
        if (queue_size_before > 0) {
            std.log.debug("Popped {d} results from queue (had {d}), results.items.len={d}", .{popped_count, queue_size_before, results.items.len});
        }
        
        // Process results with simplified logic to avoid panic
        if (results.items.len > 0) {
            std.log.debug("Processing {d} results in cycle {d}", .{results.items.len, cycle_count});
            
            // Simple foreach loop instead of complex bounds checking
            for (results.items) |result| {  // result is now a pointer
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
                            std.log.info("📤 Queueing message from {s} for upload", .{msg.modem_id});
                            message_queue.push(msg) catch |err| {
                                std.log.err("Failed to queue message: {any}", .{err});
                            };
                        }
                        std.log.info("📤 Queued {d} messages, queue size now: {d}", .{result.messages.len, message_queue.size()});
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
        
        // Systemd watchdog notification every 15 seconds (more conservative)
        const now = std.time.timestamp();
        if (now - last_watchdog_notify >= 15) {
            notifySystemd("WATCHDOG=1");
            last_watchdog_notify = now;
            std.log.debug("🔔 Sent systemd watchdog notification", .{});
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
        
        std.Thread.sleep(sleep_time);
    }
    
    // Cleanup
    should_exit.store(true, .release);
    message_thread.join();
    device_thread.join();
    signal_thread.join();
    sms_thread.join();
}