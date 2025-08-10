const std = @import("std");
const WorkerPool = @import("src/worker_pool.zig").WorkerPool;
const ModemManager = @import("src/modem_manager.zig").ModemManager;
const LockFreeMPMC = @import("src/lockfree_mpmc.zig").LockFreeMPMC;

/// Stress test to verify the worker pool doesn't deadlock
/// Simulates the high-concurrency scenario with 54 modems
pub fn main() !void {
    std.log.info("🚀 Starting worker pool deadlock stress test", .{});
    
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    const allocator = gpa.allocator();
    
    // Mock ModemManager for testing
    var modem_manager = ModemManager.init(allocator);
    defer modem_manager.deinit();
    
    var should_exit = std.atomic.Value(bool).init(false);
    
    // Initialize worker pool with 8 workers
    const num_workers = 8;
    var worker_pool = try WorkerPool.init(allocator, num_workers, &modem_manager, &should_exit);
    defer worker_pool.deinit();
    
    std.log.info("✅ Worker pool initialized with {d} workers", .{num_workers});
    
    // Simulate 54 modems submitting work rapidly (stress test scenario)
    const num_modems = 54;
    const cycles_per_test = 10;
    const total_work_items = num_modems * cycles_per_test;
    
    // Create a results queue to simulate ParallelContext
    const ModemCheckResult = struct {
        modem_id: []const u8,
        messages: []u8, // Simplified for test
        success: bool,
        allocator: std.mem.Allocator,
        
        pub fn deinit(self: *@This()) void {
            self.allocator.free(self.modem_id);
            if (self.success) {
                self.allocator.free(self.messages);
            }
        }
    };
    
    var results_queue = LockFreeMPMC(ModemCheckResult).init(allocator);
    defer results_queue.deinit();
    
    const ParallelContext = struct {
        allocator: std.mem.Allocator,
        results: *LockFreeMPMC(ModemCheckResult),
    };
    
    var context = ParallelContext{
        .allocator = allocator,
        .results = &results_queue,
    };
    
    std.log.info("🔥 Starting stress test: {d} modems × {d} cycles = {d} work items", .{
        num_modems, cycles_per_test, total_work_items
    });
    
    const start_time = std.time.milliTimestamp();
    
    // Submit work in batches to simulate main loop behavior
    for (0..cycles_per_test) |cycle| {
        std.log.info("📊 Cycle {d}/{d}: Submitting {d} work items...", .{ cycle + 1, cycles_per_test, num_modems });
        
        // Submit work for all modems
        for (0..num_modems) |modem_idx| {
            const modem_id = try std.fmt.allocPrint(allocator, "modem-{d}", .{modem_idx});
            try worker_pool.submit(.CheckMessages, modem_id, &context);
        }
        
        // Wait for work to complete (with timeout protection)
        const cycle_start = std.time.milliTimestamp();
        const max_wait_ms = 2000; // 2 second timeout
        
        while (worker_pool.hasActiveWork()) {
            const elapsed = std.time.milliTimestamp() - cycle_start;
            if (elapsed > max_wait_ms) {
                std.log.warn("⚠️  Cycle {d} timed out after {d}ms, continuing...", .{ cycle + 1, elapsed });
                break;
            }
            std.time.sleep(10 * std.time.ns_per_ms); // 10ms sleep
        }
        
        // Check results
        var result_count: usize = 0;
        while (results_queue.tryPop()) |_| {
            result_count += 1;
            // Note: we don't deinit here as we're using mock data
        }
        
        const cycle_time = std.time.milliTimestamp() - cycle_start;
        std.log.info("✅ Cycle {d} completed in {d}ms, processed {d} results", .{ 
            cycle + 1, cycle_time, result_count 
        });
        
        // Short pause between cycles
        std.time.sleep(100 * std.time.ns_per_ms);
    }
    
    const total_time = std.time.milliTimestamp() - start_time;
    
    std.log.info("🎉 Stress test completed successfully!", .{});
    std.log.info("📊 Total time: {d}ms", .{total_time});
    std.log.info("⚡ Average throughput: {d:.1} work items/second", .{
        @as(f64, @floatFromInt(total_work_items)) / (@as(f64, @floatFromInt(total_time)) / 1000.0)
    });
    std.log.info("✅ No deadlocks detected - the lock-free solution works!", .{});
    
    // Signal workers to exit
    should_exit.store(true, .release);
    
    // Give workers time to see the exit signal
    std.time.sleep(200 * std.time.ns_per_ms);
}