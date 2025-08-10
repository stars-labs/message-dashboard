const std = @import("std");
const types = @import("types.zig");
const ModemManager = @import("modem_manager.zig").ModemManager;
const LockFreeMPMC = @import("lockfree_mpmc.zig").LockFreeMPMC;

// Import types from main.zig
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
    message_queue: *anyopaque, // MessageQueue
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

pub const WorkResult = struct {
    type: WorkType,
    modem_id: []const u8,
    success: bool,
    messages: ?[]types.MessageInfo = null,
    signal: ?types.SignalData = null,
    error_msg: ?[]const u8 = null,
};

/// Worker pool for parallel modem operations using lock-free queues
pub const WorkerPool = struct {
    allocator: std.mem.Allocator,
    workers: []Worker,
    work_queue: LockFreeMPMC(WorkItem),
    result_queue: LockFreeMPMC(WorkResult),
    modem_manager: *ModemManager,
    should_exit: *std.atomic.Value(bool),
    pool_shutdown: std.atomic.Value(bool),
    active_workers: std.atomic.Value(u32),
    
    const Self = @This();
    
    const Worker = struct {
        thread: std.Thread,
        pool: *WorkerPool,
        id: usize,
        
        fn run(self: *Worker) void {
            std.log.info("Worker {d} started", .{self.id});
            
            while (!self.pool.should_exit.load(.acquire) and !self.pool.pool_shutdown.load(.acquire)) {
                // Get work from lock-free queue (non-blocking)
                const work = self.pool.work_queue.tryPop() orelse {
                    // Short sleep to prevent busy-waiting while allowing fast response
                    std.time.sleep(1 * std.time.ns_per_ms);
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
        var pool = Self{
            .allocator = allocator,
            .workers = try allocator.alloc(Worker, num_workers),
            .work_queue = LockFreeMPMC(WorkItem).init(allocator),
            .result_queue = LockFreeMPMC(WorkResult).init(allocator),
            .modem_manager = modem_manager,
            .should_exit = should_exit,
            .pool_shutdown = std.atomic.Value(bool).init(false),
            .active_workers = std.atomic.Value(u32).init(0),
        };
        
        // Start worker threads
        for (pool.workers, 0..) |*worker, i| {
            worker.* = Worker{
                .thread = undefined,
                .pool = &pool,
                .id = i,
            };
            worker.thread = try std.Thread.spawn(.{}, Worker.run, .{worker});
        }
        
        return pool;
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
        self.result_queue.deinit();
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
    
    /// Get queue size
    pub fn queueSize(self: *Self) usize {
        return self.work_queue.size();
    }
    
    /// Get all results (drain the result queue)
    pub fn getResults(self: *Self) ![]WorkResult {
        var results = std.ArrayList(WorkResult).init(self.allocator);
        defer results.deinit();
        
        // Drain all available results
        while (self.result_queue.tryPop()) |result| {
            try results.append(result);
        }
        
        return results.toOwnedSlice();
    }
};