const std = @import("std");
const types = @import("types.zig");
const ModemManager = @import("modem_manager.zig").ModemManager;
const LockFreeMPMC = @import("lockfree_mpmc.zig").LockFreeMPMC;

const ModemCheckResult = types.ModemCheckResult;

// Import types from main.zig
const ParallelContext = struct {
    allocator: std.mem.Allocator,
    modem_manager: *ModemManager,
    message_queue: *anyopaque, // LockFreeMessageQueue
    results: *LockFreeMPMC(ModemCheckResult),
};

pub const WorkType = enum {
    CheckMessages,
    CheckSignal,
    SendSMS,
    UpdatePhone,
};

pub const WorkItem = struct {
    type: WorkType,
    modem_id: []const u8,
    data: ?*anyopaque = null,
    context: ?*anyopaque = null,
};

/// Worker pool for parallel modem operations using lock-free queues
pub const WorkerPool = struct {
    allocator: std.mem.Allocator,
    workers: []Worker,
    work_queue: LockFreeMPMC(WorkItem),
    modem_manager: *ModemManager,
    should_exit: *std.atomic.Value(bool),
    pool_shutdown: std.atomic.Value(bool),
    active_workers: std.atomic.Value(u32),
    initialized: std.atomic.Value(bool),
    
    const Self = @This();
    
    const Worker = struct {
        thread: std.Thread,
        pool: *WorkerPool,
        id: usize,
        
        fn run(self: *Worker) void {
            // Wait for pool to be fully initialized
            while (!self.pool.initialized.load(.acquire)) {
                std.time.sleep(10 * std.time.ns_per_ms);
            }
            
            std.log.info("Worker {d} started", .{self.id});
            
            while (!self.pool.should_exit.load(.acquire) and !self.pool.pool_shutdown.load(.acquire)) {
                // Get work from lock-free queue with improved retry logic
                const work = blk: {
                    var retry_count: u32 = 0;
                    const max_retries = 10; // Increased retries for better success rate
                    var backoff_us: u64 = 10; // Start with 10 microseconds
                    
                    while (retry_count < max_retries) {
                        if (self.pool.work_queue.tryPop()) |item| {
                            break :blk item;
                        }
                        
                        retry_count += 1;
                        
                        // Progressive backoff strategy
                        if (retry_count <= 3) {
                            // First 3 attempts: just spin hints
                            std.atomic.spinLoopHint();
                        } else if (retry_count <= 6) {
                            // Next 3 attempts: very short sleeps
                            std.time.sleep(backoff_us * std.time.ns_per_us);
                            backoff_us = @min(backoff_us * 2, 100); // Cap at 100us
                        } else {
                            // Final attempts: slightly longer sleeps
                            std.time.sleep(500 * std.time.ns_per_us); // 0.5ms
                        }
                    }
                    
                    // If all retries failed, sleep longer and continue
                    // This gives time for queue to be refilled
                    std.time.sleep(5 * std.time.ns_per_ms);
                    continue;
                };
                defer self.pool.allocator.free(work.modem_id);
                
                // Mark as active worker
                _ = self.pool.active_workers.fetchAdd(1, .monotonic);
                
                
                // Process work based on type
                switch (work.type) {
                    .CheckMessages => {
                        // Get context if provided
                        if (work.context) |ctx_ptr| {
                            // Safely cast the context pointer with validation
                            if (@intFromPtr(ctx_ptr) % @alignOf(ParallelContext) != 0) {
                                std.log.err("Worker {d}: Invalid context alignment for modem {s}", .{ self.id, work.modem_id });
                                _ = self.pool.active_workers.fetchSub(1, .monotonic);
                                continue;
                            }
                            
                            const context: *ParallelContext = @ptrCast(@alignCast(ctx_ptr));
                            
                            var result = ModemCheckResult{
                                .modem_id = work.modem_id,
                                .messages = &[_]types.MessageInfo{},
                                .success = false,
                                .allocator = context.allocator,
                            };
                            
                            // Check messages for this modem
                            const messages = self.pool.modem_manager.getNewMessages(work.modem_id) catch |err| {
                                std.log.debug("Worker {d}: Failed to check messages for {s}: {any}", .{ self.id, work.modem_id, err });
                                
                                // Add failed result
                                context.results.push(result);
                                _ = self.pool.active_workers.fetchSub(1, .monotonic);
                                continue;
                            };
                            
                            result.messages = messages;
                            result.success = true;
                            
                            if (messages.len > 0) {
                                std.log.info("Worker {d}: Found {d} messages from {s}", .{ self.id, messages.len, work.modem_id });
                            }
                            
                            // Add result to lock-free queue
                            context.results.push(result);
                        } else {
                            // Fallback without context
                            const messages = self.pool.modem_manager.getNewMessages(work.modem_id) catch |err| {
                                std.log.debug("Worker {d}: Failed to check messages for {s}: {any}", .{ self.id, work.modem_id, err });
                                _ = self.pool.active_workers.fetchSub(1, .monotonic);
                                continue;
                            };
                            
                            if (messages.len > 0) {
                                std.log.info("Worker {d}: Found {d} messages from {s}", .{ self.id, messages.len, work.modem_id });
                            }
                            
                            // Free messages since no context to store them
                            for (messages) |*msg| {
                                self.pool.allocator.free(msg.modem_id);
                                self.pool.allocator.free(msg.sms_id);
                                self.pool.allocator.free(msg.message.phone_iccid);
                                self.pool.allocator.free(msg.message.phone_number);
                                self.pool.allocator.free(msg.message.content);
                                self.pool.allocator.free(msg.message.timestamp);
                            }
                            self.pool.allocator.free(messages);
                        }
                    },
                    .CheckSignal => {
                        const signal = self.pool.modem_manager.getSignalQuality(work.modem_id) catch |err| {
                            std.log.debug("Worker {d}: Failed to check signal for {s}: {any}", .{ self.id, work.modem_id, err });
                            _ = self.pool.active_workers.fetchSub(1, .monotonic);
                            continue;
                        };
                        
                        std.log.debug("Worker {d}: Signal for {s}: {d}%", .{ self.id, work.modem_id, signal.signal_percent });
                    },
                    .SendSMS => {
                        std.log.debug("Worker {d}: Sending SMS from {s}", .{ self.id, work.modem_id });
                        // SMS sending logic here
                    },
                    .UpdatePhone => {
                        std.log.debug("Worker {d}: Updating phone status for {s}", .{ self.id, work.modem_id });
                        // Phone update logic here
                    },
                }
                
                // Decrement active workers
                _ = self.pool.active_workers.fetchSub(1, .monotonic);
            }
            
            std.log.info("Worker {d} exiting", .{self.id});
        }
    };
    
    // ResultQueue is now replaced by LockFreeMPMC(WorkResult)
    // Legacy functions kept for API compatibility
    
    // WorkQueue is now replaced by LockFreeMPMC(WorkItem)
    // Legacy functions kept for API compatibility
    
    pub fn init(
        allocator: std.mem.Allocator,
        num_workers: usize,
        modem_manager: *ModemManager,
        should_exit: *std.atomic.Value(bool),
    ) !Self {
        const pool = Self{
            .allocator = allocator,
            .workers = try allocator.alloc(Worker, num_workers),
            .work_queue = LockFreeMPMC(WorkItem).init(allocator),
            .modem_manager = modem_manager,
            .should_exit = should_exit,
            .pool_shutdown = std.atomic.Value(bool).init(false),
            .active_workers = std.atomic.Value(u32).init(0),
            .initialized = std.atomic.Value(bool).init(false),
        };
        
        // DON'T start worker threads here - let main.zig handle it after pool is returned
        // This avoids the issue where workers reference a pool that hasn't been returned yet
        
        return pool;
    }
    
    /// Start the worker threads - call this after init returns
    pub fn start(self: *Self) !void {
        // Start worker threads
        for (self.workers, 0..) |*worker, i| {
            worker.* = Worker{
                .thread = undefined,
                .pool = self,
                .id = i,
            };
            worker.thread = try std.Thread.spawn(.{}, Worker.run, .{worker});
        }
        
        // Mark as initialized so workers can start processing
        self.initialized.store(true, .release);
    }
    
    pub fn deinit(self: *Self) void {
        // Signal all workers to exit using our separate flag
        self.pool_shutdown.store(true, .release);
        
        // Give workers time to see the exit flag
        std.time.sleep(100 * std.time.ns_per_ms);
        
        // Wait for all workers to finish
        for (self.workers) |*worker| {
            worker.thread.join();
        }
        
        self.work_queue.deinit();
        self.allocator.free(self.workers);
    }
    
    /// Submit work to the pool with context (now lock-free)
    pub fn submit(self: *Self, work_type: WorkType, modem_id: []const u8, context: ?*anyopaque) !void {
        const modem_id_copy = try self.allocator.dupe(u8, modem_id);
        self.work_queue.push(.{
            .type = work_type,
            .modem_id = modem_id_copy,
            .data = null,
            .context = context,
        });
    }
    
    /// Check if workers are still processing
    pub fn hasActiveWork(self: *Self) bool {
        return self.active_workers.load(.acquire) > 0 or !self.work_queue.isEmpty();
    }
    
    /// Get queue size with safety checks and enhanced debugging
    pub fn queueSize(self: *Self) usize {
        const size = self.work_queue.size();
        
        // Enhanced logging for queue growth debugging
        if (size > 1000) {
            const active_workers = self.active_workers.load(.acquire);
            const head = self.work_queue.head.load(.acquire);
            const tail = self.work_queue.tail.load(.acquire);
            std.log.warn("WorkerPool: Large queue size: {d} (head={d}, tail={d}, active_workers={d})", .{size, head, tail, active_workers});
        }
        
        return size;
    }
    
    /// Get detailed queue statistics for debugging
    pub fn getQueueStats(self: *Self) struct { size: usize, head: u64, tail: u64, active_workers: u32 } {
        return .{
            .size = self.work_queue.size(),
            .head = self.work_queue.head.load(.acquire),
            .tail = self.work_queue.tail.load(.acquire),
            .active_workers = self.active_workers.load(.acquire),
        };
    }
};