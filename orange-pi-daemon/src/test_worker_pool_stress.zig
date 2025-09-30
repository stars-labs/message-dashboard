const std = @import("std");
const testing = std.testing;
const types = @import("types.zig");
const WorkerPool = @import("worker_pool.zig").WorkerPool;
const ModemManager = @import("modem_manager.zig").ModemManager;
const SafeResultQueue = @import("safe_result_queue.zig").SafeResultQueue;
const LockFreeMessageQueue = @import("lockfree_message_queue.zig").LockFreeMessageQueue;

/// Mock ModemManager for testing that simulates real modem behavior
const MockModemManager = struct {
    allocator: std.mem.Allocator,
    message_counter: std.atomic.Value(u32),
    
    pub fn init(allocator: std.mem.Allocator) MockModemManager {
        return .{
            .allocator = allocator,
            .message_counter = std.atomic.Value(u32).init(0),
        };
    }
    
    pub fn deinit(self: *MockModemManager) void {
        _ = self;
    }
    
    /// Simulate getting new messages - occasionally returns messages to trigger UAF scenarios
    pub fn getNewMessages(self: *MockModemManager, modem_id: []const u8) ![]types.MessageInfo {
        const count = self.message_counter.fetchAdd(1, .monotonic);
        
        // Simulate occasional messages (every 10th call gets 1-3 messages)
        if (count % 10 == 0) {
            const num_messages = 1 + (count % 3);
            const messages = try self.allocator.alloc(types.MessageInfo, num_messages);
            
            for (messages, 0..) |*msg, i| {
                msg.* = types.MessageInfo{
                    .modem_id = try self.allocator.dupe(u8, modem_id),
                    .sms_id = try std.fmt.allocPrint(self.allocator, "sms_{d}_{d}", .{ count, i }),
                    .message = types.Message{
                        .phone_iccid = try std.fmt.allocPrint(self.allocator, "iccid_{s}", .{modem_id}),
                        .phone_number = try std.fmt.allocPrint(self.allocator, "+1555000{s}", .{modem_id}),
                        .content = try std.fmt.allocPrint(self.allocator, "Test message {d} from modem {s}", .{ i, modem_id }),
                        .timestamp = try std.fmt.allocPrint(self.allocator, "2024-09-30T{d:0>2}:00:00Z", .{i}),
                    },
                };
            }
            return messages;
        }
        
        // Most calls return no messages
        return try self.allocator.alloc(types.MessageInfo, 0);
    }
    
    pub fn getSignalQuality(self: *MockModemManager, modem_id: []const u8) !types.SignalData {
        _ = self;
        _ = modem_id;
        return types.SignalData{
            .signal_percent = 75,
            .rssi = -65,
            .rsrq = null,
            .rsrp = null,
            .snr = null,
        };
    }
};

/// Test context that mimics the real ParallelContext
const TestContext = struct {
    allocator: std.mem.Allocator,
    modem_manager: *MockModemManager,
    message_queue: *LockFreeMessageQueue,
    results: *SafeResultQueue,
};

test "WorkerPool stress test - simulate UAF conditions" {
    var arena = std.heap.ArenaAllocator.init(testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    
    // Create mock components
    var mock_modem_manager = MockModemManager.init(allocator);
    defer mock_modem_manager.deinit();
    
    var message_queue = LockFreeMessageQueue.init(allocator);
    defer message_queue.deinit();
    
    var results_queue = SafeResultQueue.init(allocator);
    defer results_queue.deinit();
    
    var should_exit = std.atomic.Value(bool).init(false);
    defer should_exit.store(true, .release);
    
    // Create worker pool with 8 workers to match production
    const num_workers = 8;
    var worker_pool = try WorkerPool.init(allocator, num_workers, @ptrCast(&mock_modem_manager), &should_exit);
    defer worker_pool.deinit();
    
    try worker_pool.start();
    
    // Create test context
    var test_context = TestContext{
        .allocator = allocator,
        .modem_manager = &mock_modem_manager,
        .message_queue = &message_queue,
        .results = &results_queue,
    };
    
    // Simulate the high-stress scenario that caused UAF
    const num_modems = 90; // Match production load
    const num_cycles = 100; // Run many cycles to trigger race conditions
    
    std.log.info("🧪 Starting stress test: {d} workers, {d} modems, {d} cycles", .{ num_workers, num_modems, num_cycles });
    
    var total_messages_processed: u32 = 0;
    var total_results_processed: u32 = 0;
    
    for (0..num_cycles) |cycle| {
        // Submit work for all modems (like real production)
        for (0..num_modems) |modem_idx| {
            const modem_id = try std.fmt.allocPrint(allocator, "{d}", .{modem_idx});
            try worker_pool.submit(.CheckMessages, modem_id, &test_context);
        }
        
        // Wait for workers to process (with timeout to avoid hanging)
        const start_wait = std.time.milliTimestamp();
        const max_wait_ms = 200; // 200ms timeout
        
        while (worker_pool.hasActiveWork()) {
            const elapsed = std.time.milliTimestamp() - start_wait;
            if (elapsed > max_wait_ms) {
                std.log.warn("⚠️ Cycle {d}: Workers taking longer than {d}ms", .{ cycle, max_wait_ms });
                break;
            }
            std.Thread.sleep(1 * std.time.ns_per_ms);
        }
        
        // Process results (simulate main loop)
        var cycle_results: u32 = 0;
        while (results_queue.tryPop()) |result| {
            cycle_results += 1;
            total_results_processed += 1;
            
            // Process messages if any
            if (result.success and result.messages.len > 0) {
                total_messages_processed += @intCast(result.messages.len);
                
                // Queue messages (simulate real flow)
                for (result.messages) |msg| {
                    try message_queue.push(msg);
                }
            }
            
            // Clean up result
            result.deinit();
            allocator.destroy(result);
        }
        
        // Log progress every 10 cycles
        if (cycle % 10 == 0) {
            const queue_size = worker_pool.queueSize();
            std.log.info("📊 Cycle {d}/{d}: processed {d} results, queue_size={d}", .{ cycle, num_cycles, cycle_results, queue_size });
        }
        
        // Small delay between cycles to allow cleanup
        std.Thread.sleep(5 * std.time.ns_per_ms);
    }
    
    // Final cleanup - ensure all workers are done
    std.Thread.sleep(100 * std.time.ns_per_ms);
    
    // Verify no memory corruption occurred
    const final_queue_size = worker_pool.queueSize();
    const final_results_size = results_queue.size();
    
    std.log.info("✅ Stress test completed successfully!", .{});
    std.log.info("📊 Final stats: messages={d}, results={d}, queue_size={d}, results_queue_size={d}", 
        .{ total_messages_processed, total_results_processed, final_queue_size, final_results_size });
    
    // Assertions to ensure test validity
    try testing.expect(total_results_processed > 0); // Should have processed some results
    try testing.expect(final_queue_size == 0); // No work should be pending
    try testing.expect(final_results_size == 0); // No results should be pending
    
    // Drain any remaining messages from message queue
    var drained_messages: u32 = 0;
    while (message_queue.pop()) |_| {
        drained_messages += 1;
        if (drained_messages > 10000) break; // Safety limit
    }
    
    std.log.info("🧹 Drained {d} messages from message queue", .{drained_messages});
}

test "SafeResultQueue concurrent access" {
    const allocator = testing.allocator;
    
    var results_queue = SafeResultQueue.init(allocator);
    defer results_queue.deinit();
    
    // Test concurrent push/pop operations
    const num_threads = 8;
    const items_per_thread = 100;
    
    var threads: [num_threads]std.Thread = undefined;
    var push_count = std.atomic.Value(u32).init(0);
    var pop_count = std.atomic.Value(u32).init(0);
    
    const ThreadContext = struct {
        queue: *SafeResultQueue,
        allocator: std.mem.Allocator,
        push_count: *std.atomic.Value(u32),
        pop_count: *std.atomic.Value(u32),
        thread_id: u32,
    };
    
    // Producer threads
    for (0..num_threads / 2) |i| {
        const context = try allocator.create(ThreadContext);
        context.* = .{
            .queue = &results_queue,
            .allocator = allocator,
            .push_count = &push_count,
            .pop_count = &pop_count,
            .thread_id = @intCast(i),
        };
        
        threads[i] = try std.Thread.spawn(.{}, struct {
            fn run(ctx: *ThreadContext) void {
                for (0..items_per_thread) |item_idx| {
                    const result = ctx.allocator.create(types.ModemCheckResult) catch return;
                    result.* = types.ModemCheckResult{
                        .modem_id = std.fmt.allocPrint(ctx.allocator, "modem_{d}_{d}", .{ ctx.thread_id, item_idx }) catch return,
                        .messages = ctx.allocator.alloc(types.MessageInfo, 0) catch return,
                        .success = true,
                        .allocator = ctx.allocator,
                        .message_count = 0,
                    };
                    
                    ctx.queue.push(result);
                    _ = ctx.push_count.fetchAdd(1, .monotonic);
                }
            }
        }.run, .{context});
    }
    
    // Consumer threads
    for (num_threads / 2..num_threads) |i| {
        const context = try allocator.create(ThreadContext);
        context.* = .{
            .queue = &results_queue,
            .allocator = allocator,
            .push_count = &push_count,
            .pop_count = &pop_count,
            .thread_id = @intCast(i),
        };
        
        threads[i] = try std.Thread.spawn(.{}, struct {
            fn run(ctx: *ThreadContext) void {
                while (ctx.pop_count.load(.acquire) < (items_per_thread * num_threads / 2)) {
                    if (ctx.queue.tryPop()) |result| {
                        // Clean up
                        ctx.allocator.free(result.modem_id);
                        ctx.allocator.free(result.messages);
                        ctx.allocator.destroy(result);
                        _ = ctx.pop_count.fetchAdd(1, .monotonic);
                    } else {
                        std.Thread.sleep(1 * std.time.ns_per_ms);
                    }
                }
            }
        }.run, .{context});
    }
    
    // Wait for all threads
    for (&threads) |*thread| {
        thread.join();
    }
    
    const final_push = push_count.load(.acquire);
    const final_pop = pop_count.load(.acquire);
    
    std.log.info("📊 Concurrent test: pushed={d}, popped={d}", .{ final_push, final_pop });
    
    try testing.expect(final_push == final_pop);
    try testing.expect(results_queue.size() == 0);
}