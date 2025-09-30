const std = @import("std");
const testing = std.testing;
const types = @import("types.zig");
const SafeResultQueue = @import("safe_result_queue.zig").SafeResultQueue;

test "SafeResultQueue thread safety under stress" {
    const allocator = testing.allocator;
    
    var results_queue = SafeResultQueue.init(allocator);
    defer results_queue.deinit();
    
    // Simulate the exact crash scenario: 8 workers, high concurrency
    const num_producer_threads = 8;
    const items_per_producer = 50;
    
    var producer_threads: [num_producer_threads]std.Thread = undefined;
    var items_produced = std.atomic.Value(u32).init(0);
    var items_consumed = std.atomic.Value(u32).init(0);
    
    // Start producer threads (simulate workers)
    for (&producer_threads, 0..) |*thread, i| {
        thread.* = try std.Thread.spawn(.{}, struct {
            fn run(thread_id: usize, queue: *SafeResultQueue, alloc: std.mem.Allocator, counter: *std.atomic.Value(u32)) void {
                for (0..items_per_producer) |item_idx| {
                    // Create a result (simulate worker creating ModemCheckResult)
                    const result = alloc.create(types.ModemCheckResult) catch return;
                    
                    const modem_id = std.fmt.allocPrint(alloc, "modem_{d}_{d}", .{ thread_id, item_idx }) catch return;
                    const messages = alloc.alloc(types.MessageInfo, 0) catch return;
                    
                    result.* = types.ModemCheckResult{
                        .modem_id = modem_id,
                        .messages = messages,
                        .success = true,
                        .allocator = alloc,
                        .message_count = 0,
                    };
                    
                    // Push to queue (this is where UAF would occur)
                    queue.push(result);
                    _ = counter.fetchAdd(1, .monotonic);
                    
                    // Small random delay to create more realistic timing
                    if (item_idx % 3 == 0) {
                        std.Thread.sleep(1 * std.time.ns_per_ms);
                    }
                }
            }
        }.run, .{ i, &results_queue, allocator, &items_produced });
    }
    
    // Consumer loop (simulate main thread)
    const total_expected = num_producer_threads * items_per_producer;
    var consumed = std.ArrayList(*types.ModemCheckResult){};
    defer {
        for (consumed.items) |result| {
            allocator.free(result.modem_id);
            allocator.free(result.messages);
            allocator.destroy(result);
        }
        consumed.deinit(allocator);
    }
    
    // Consume results as they come in
    while (items_consumed.load(.acquire) < total_expected) {
        if (results_queue.tryPop()) |result| {
            try consumed.append(allocator, result);
            _ = items_consumed.fetchAdd(1, .monotonic);
        } else {
            // Small delay to prevent spinning
            std.Thread.sleep(1 * std.time.ns_per_ms);
        }
    }
    
    // Wait for all producer threads to finish
    for (&producer_threads) |*thread| {
        thread.join();
    }
    
    const final_produced = items_produced.load(.acquire);
    const final_consumed = items_consumed.load(.acquire);
    
    std.debug.print("Stress test results: produced={d}, consumed={d}, expected={d}\n", .{ final_produced, final_consumed, total_expected });
    
    try testing.expect(final_produced == total_expected);
    try testing.expect(final_consumed == total_expected);
    try testing.expect(results_queue.size() == 0);
    try testing.expect(consumed.items.len == total_expected);
}

test "SafeResultQueue vs LockFreeMPMC behavior comparison" {
    const allocator = testing.allocator;
    
    // Test the SafeResultQueue implementation
    var safe_queue = SafeResultQueue.init(allocator);
    defer safe_queue.deinit();
    
    // Basic operations that would cause UAF in lock-free version
    const result1 = try allocator.create(types.ModemCheckResult);
    result1.* = types.ModemCheckResult{
        .modem_id = try allocator.dupe(u8, "test_modem_1"),
        .messages = try allocator.alloc(types.MessageInfo, 0),
        .success = true,
        .allocator = allocator,
        .message_count = 0,
    };
    
    const result2 = try allocator.create(types.ModemCheckResult);
    result2.* = types.ModemCheckResult{
        .modem_id = try allocator.dupe(u8, "test_modem_2"),
        .messages = try allocator.alloc(types.MessageInfo, 0),
        .success = true,
        .allocator = allocator,
        .message_count = 0,
    };
    
    // Push results
    safe_queue.push(result1);
    safe_queue.push(result2);
    
    try testing.expect(safe_queue.size() == 2);
    
    // Pop results
    const popped1 = safe_queue.tryPop().?;
    const popped2 = safe_queue.tryPop().?;
    const popped3 = safe_queue.tryPop();
    
    try testing.expect(popped1 == result1);
    try testing.expect(popped2 == result2);
    try testing.expect(popped3 == null);
    try testing.expect(safe_queue.size() == 0);
    
    // Clean up
    allocator.free(popped1.modem_id);
    allocator.free(popped1.messages);
    allocator.destroy(popped1);
    
    allocator.free(popped2.modem_id);
    allocator.free(popped2.messages);
    allocator.destroy(popped2);
}

test "Memory consistency under rapid push/pop cycles" {
    const allocator = testing.allocator;
    
    var queue = SafeResultQueue.init(allocator);
    defer queue.deinit();
    
    // Rapid cycles that would expose memory ordering issues
    const num_cycles = 1000;
    
    for (0..num_cycles) |i| {
        const result = try allocator.create(types.ModemCheckResult);
        result.* = types.ModemCheckResult{
            .modem_id = try std.fmt.allocPrint(allocator, "cycle_{d}", .{i}),
            .messages = try allocator.alloc(types.MessageInfo, 0),
            .success = true,
            .allocator = allocator,
            .message_count = 0,
        };
        
        queue.push(result);
        
        // Immediately pop it back
        const popped = queue.tryPop().?;
        try testing.expect(popped == result);
        try testing.expect(std.mem.eql(u8, popped.modem_id, result.modem_id));
        
        // Clean up
        allocator.free(popped.modem_id);
        allocator.free(popped.messages);
        allocator.destroy(popped);
    }
    
    try testing.expect(queue.size() == 0);
    std.debug.print("Completed {d} rapid push/pop cycles without UAF\n", .{num_cycles});
}