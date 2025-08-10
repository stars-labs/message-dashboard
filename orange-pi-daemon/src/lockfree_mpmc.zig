const std = @import("std");

/// Lock-free Multi-Producer Multi-Consumer Queue
/// Uses atomic operations and a ring buffer approach to eliminate deadlocks
/// Optimized for high-concurrency scenarios with 54+ modems
pub fn LockFreeMPMC(comptime T: type) type {
    return struct {
        const Self = @This();
        const CACHE_LINE_SIZE = 64;
        
        // Ring buffer with power-of-2 size for fast modulo operations
        const BUFFER_SIZE = 8192; // Must be power of 2
        const BUFFER_MASK = BUFFER_SIZE - 1;
        
        // Cache-aligned atomic counters to prevent false sharing
        const alignas = std.mem.alignForward;
        
        // Separate cache lines for producers and consumers to reduce contention
        head: std.atomic.Value(u64) align(CACHE_LINE_SIZE),
        tail: std.atomic.Value(u64) align(CACHE_LINE_SIZE),
        
        // Ring buffer with atomic slots
        buffer: [BUFFER_SIZE]Slot align(CACHE_LINE_SIZE),
        allocator: std.mem.Allocator,
        
        const Slot = struct {
            // Use separate sequence counter to handle ABA problem
            sequence: std.atomic.Value(u64),
            data: T,
            
            const Self_Slot = @This();
            
            pub fn init(seq: u64) Self_Slot {
                return .{
                    .sequence = std.atomic.Value(u64).init(seq),
                    .data = undefined,
                };
            }
        };
        
        pub fn init(allocator: std.mem.Allocator) Self {
            var queue = Self{
                .head = std.atomic.Value(u64).init(0),
                .tail = std.atomic.Value(u64).init(0),
                .buffer = undefined,
                .allocator = allocator,
            };
            
            // Initialize all slots with their sequence numbers
            for (&queue.buffer, 0..) |*slot, i| {
                slot.* = Slot.init(i);
            }
            
            return queue;
        }
        
        pub fn deinit(self: *Self) void {
            // Drain remaining items to prevent memory leaks
            while (self.tryPop()) |_| {}
        }
        
        /// Non-blocking push operation
        /// Returns true if successfully enqueued, false if queue is full
        pub fn tryPush(self: *Self, item: T) bool {
            var head = self.head.load(.acquire);
            
            while (true) {
                const slot_idx = head & BUFFER_MASK;
                const slot = &self.buffer[slot_idx];
                const seq = slot.sequence.load(.acquire);
                
                // Check if this slot is available for writing
                if (seq == head) {
                    // Try to claim this slot
                    const new_head = head + 1;
                    if (self.head.cmpxchgWeak(head, new_head, .acq_rel, .acquire)) |updated_head| {
                        head = updated_head;
                        continue;
                    }
                    
                    // Successfully claimed slot, write data
                    slot.data = item;
                    slot.sequence.store(head + 1, .release);
                    return true;
                } else if (seq < head) {
                    // Slot not yet ready, queue might be full
                    const tail = self.tail.load(.acquire);
                    if (head - tail >= BUFFER_SIZE) {
                        // Queue is definitely full
                        return false;
                    }
                    
                    // Retry with updated head
                    head = self.head.load(.acquire);
                    continue;
                } else {
                    // seq > head, someone else claimed this slot
                    head = self.head.load(.acquire);
                    continue;
                }
            }
        }
        
        /// Blocking push operation with exponential backoff
        /// Spins until item is successfully enqueued
        pub fn push(self: *Self, item: T) void {
            var backoff: u32 = 1;
            const max_backoff = 1024;
            
            while (!self.tryPush(item)) {
                // Exponential backoff to reduce CPU usage
                std.atomic.spinLoopHint();
                if (backoff < max_backoff) {
                    var i: u32 = 0;
                    while (i < backoff) : (i += 1) {
                        std.atomic.spinLoopHint();
                    }
                    backoff *= 2;
                } else {
                    // Yield to other threads if backoff gets too high
                    std.time.sleep(1);
                }
            }
        }
        
        /// Non-blocking pop operation
        /// Returns item if available, null if queue is empty
        pub fn tryPop(self: *Self) ?T {
            var tail = self.tail.load(.acquire);
            
            while (true) {
                const slot_idx = tail & BUFFER_MASK;
                const slot = &self.buffer[slot_idx];
                const seq = slot.sequence.load(.acquire);
                
                // Check if this slot has data ready to read
                if (seq == tail + 1) {
                    // Try to claim this slot
                    const new_tail = tail + 1;
                    if (self.tail.cmpxchgWeak(tail, new_tail, .acq_rel, .acquire)) |updated_tail| {
                        tail = updated_tail;
                        continue;
                    }
                    
                    // Successfully claimed slot, read data
                    const data = slot.data;
                    slot.sequence.store(tail + BUFFER_SIZE, .release);
                    return data;
                } else if (seq < tail + 1) {
                    // No data available
                    return null;
                } else {
                    // seq > tail + 1, someone else claimed this slot
                    tail = self.tail.load(.acquire);
                    continue;
                }
            }
        }
        
        /// Blocking pop operation with exponential backoff
        /// Returns item when one becomes available
        pub fn pop(self: *Self) T {
            var backoff: u32 = 1;
            const max_backoff = 1024;
            
            while (true) {
                if (self.tryPop()) |item| {
                    return item;
                }
                
                // Exponential backoff to reduce CPU usage
                std.atomic.spinLoopHint();
                if (backoff < max_backoff) {
                    var i: u32 = 0;
                    while (i < backoff) : (i += 1) {
                        std.atomic.spinLoopHint();
                    }
                    backoff *= 2;
                } else {
                    // Yield to other threads if backoff gets too high
                    std.time.sleep(1);
                }
            }
        }
        
        /// Get approximate queue size (may be stale due to concurrent access)
        pub fn size(self: *Self) usize {
            const head = self.head.load(.acquire);
            const tail = self.tail.load(.acquire);
            return @intCast(head - tail);
        }
        
        /// Check if queue is empty (may be stale due to concurrent access)
        pub fn isEmpty(self: *Self) bool {
            const head = self.head.load(.acquire);
            const tail = self.tail.load(.acquire);
            return head == tail;
        }
        
        /// Check if queue is full (may be stale due to concurrent access)
        pub fn isFull(self: *Self) bool {
            const head = self.head.load(.acquire);
            const tail = self.tail.load(.acquire);
            return head - tail >= BUFFER_SIZE;
        }
    };
}

// Test the lock-free queue implementation
test "LockFreeMPMC basic operations" {
    var queue = LockFreeMPMC(i32).init(std.testing.allocator);
    defer queue.deinit();
    
    // Test empty queue
    try std.testing.expect(queue.isEmpty());
    try std.testing.expect(queue.tryPop() == null);
    
    // Test single item
    try std.testing.expect(queue.tryPush(42));
    try std.testing.expect(!queue.isEmpty());
    
    const item = queue.tryPop().?;
    try std.testing.expect(item == 42);
    try std.testing.expect(queue.isEmpty());
}

test "LockFreeMPMC concurrent stress test" {
    const num_producers = 4;
    const num_consumers = 4;
    const items_per_producer = 1000;
    
    var queue = LockFreeMPMC(u32).init(std.testing.allocator);
    defer queue.deinit();
    
    var produced_sum: std.atomic.Value(u64) = std.atomic.Value(u64).init(0);
    var consumed_sum: std.atomic.Value(u64) = std.atomic.Value(u64).init(0);
    var active_producers = std.atomic.Value(u32).init(num_producers);
    
    const ProducerContext = struct {
        queue: *LockFreeMPMC(u32),
        produced_sum: *std.atomic.Value(u64),
        start_value: u32,
        count: u32,
        
        fn run(ctx: @This()) void {
            var sum: u64 = 0;
            var i: u32 = 0;
            while (i < ctx.count) {
                const value = ctx.start_value + i;
                ctx.queue.push(value);
                sum += value;
                i += 1;
            }
            _ = ctx.produced_sum.fetchAdd(sum, .monotonic);
        }
    };
    
    const ConsumerContext = struct {
        queue: *LockFreeMPMC(u32),
        consumed_sum: *std.atomic.Value(u64),
        active_producers: *std.atomic.Value(u32),
        
        fn run(ctx: @This()) void {
            var sum: u64 = 0;
            while (true) {
                if (ctx.queue.tryPop()) |value| {
                    sum += value;
                } else if (ctx.active_producers.load(.acquire) == 0 and ctx.queue.isEmpty()) {
                    break;
                } else {
                    std.time.sleep(1);
                }
            }
            _ = ctx.consumed_sum.fetchAdd(sum, .monotonic);
        }
    };
    
    // Start producer threads
    var producer_threads: [num_producers]std.Thread = undefined;
    for (&producer_threads, 0..) |*thread, i| {
        const context = ProducerContext{
            .queue = &queue,
            .produced_sum = &produced_sum,
            .start_value = @intCast(i * items_per_producer),
            .count = items_per_producer,
        };
        thread.* = try std.Thread.spawn(.{}, ProducerContext.run, .{context});
    }
    
    // Start consumer threads
    var consumer_threads: [num_consumers]std.Thread = undefined;
    for (&consumer_threads) |*thread| {
        const context = ConsumerContext{
            .queue = &queue,
            .consumed_sum = &consumed_sum,
            .active_producers = &active_producers,
        };
        thread.* = try std.Thread.spawn(.{}, ConsumerContext.run, .{context});
    }
    
    // Wait for producers to finish
    for (&producer_threads) |*thread| {
        thread.join();
    }
    _ = active_producers.store(0, .release);
    
    // Wait for consumers to finish
    for (&consumer_threads) |*thread| {
        thread.join();
    }
    
    // Verify all items were processed correctly
    const final_produced = produced_sum.load(.acquire);
    const final_consumed = consumed_sum.load(.acquire);
    
    try std.testing.expect(final_produced == final_consumed);
    try std.testing.expect(queue.isEmpty());
}