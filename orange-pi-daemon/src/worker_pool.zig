const std = @import("std");
const types = @import("types.zig");
const ModemManager = @import("modem_manager.zig").ModemManager;

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
};

/// Worker pool for parallel modem operations
pub const WorkerPool = struct {
    allocator: std.mem.Allocator,
    workers: []Worker,
    work_queue: WorkQueue,
    modem_manager: *ModemManager,
    should_exit: *std.atomic.Value(bool),
    
    const Self = @This();
    
    const Worker = struct {
        thread: std.Thread,
        pool: *WorkerPool,
        id: usize,
        
        fn run(self: *Worker) void {
            std.log.info("Worker {d} started", .{self.id});
            
            while (!self.pool.should_exit.load(.acquire)) {
                // Get work from queue
                const work = self.pool.work_queue.pop() orelse {
                    std.time.sleep(5 * std.time.ns_per_ms);
                    continue;
                };
                defer self.pool.allocator.free(work.modem_id);
                
                // Process work based on type
                switch (work.type) {
                    .CheckMessages => {
                        const messages = self.pool.modem_manager.getNewMessages(work.modem_id) catch |err| {
                            std.log.debug("Worker {d}: Failed to check messages for {s}: {any}", .{ self.id, work.modem_id, err });
                            continue;
                        };
                        
                        if (messages.len > 0) {
                            std.log.info("Worker {d}: Found {d} messages from {s}", .{ self.id, messages.len, work.modem_id });
                        }
                        
                        // Free messages
                        for (messages) |*msg| {
                            self.pool.allocator.free(msg.modem_id);
                            self.pool.allocator.free(msg.sms_id);
                            self.pool.allocator.free(msg.message.phone_iccid);
                            self.pool.allocator.free(msg.message.phone_number);
                            self.pool.allocator.free(msg.message.content);
                            self.pool.allocator.free(msg.message.timestamp);
                        }
                        self.pool.allocator.free(messages);
                    },
                    .CheckSignal => {
                        const signal = self.pool.modem_manager.getSignalQuality(work.modem_id) catch |err| {
                            std.log.debug("Worker {d}: Failed to check signal for {s}: {any}", .{ self.id, work.modem_id, err });
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
            }
            
            std.log.info("Worker {d} exiting", .{self.id});
        }
    };
    
    const WorkQueue = struct {
        items: std.ArrayList(WorkItem),
        mutex: std.Thread.Mutex,
        allocator: std.mem.Allocator,
        
        fn init(allocator: std.mem.Allocator) WorkQueue {
            return .{
                .items = std.ArrayList(WorkItem).init(allocator),
                .mutex = std.Thread.Mutex{},
                .allocator = allocator,
            };
        }
        
        fn deinit(self: *WorkQueue) void {
            for (self.items.items) |item| {
                self.allocator.free(item.modem_id);
            }
            self.items.deinit();
        }
        
        fn push(self: *WorkQueue, item: WorkItem) !void {
            self.mutex.lock();
            defer self.mutex.unlock();
            try self.items.append(item);
        }
        
        fn pop(self: *WorkQueue) ?WorkItem {
            self.mutex.lock();
            defer self.mutex.unlock();
            
            if (self.items.items.len == 0) return null;
            return self.items.orderedRemove(0);
        }
        
        fn size(self: *WorkQueue) usize {
            self.mutex.lock();
            defer self.mutex.unlock();
            return self.items.items.len;
        }
    };
    
    pub fn init(
        allocator: std.mem.Allocator,
        num_workers: usize,
        modem_manager: *ModemManager,
        should_exit: *std.atomic.Value(bool),
    ) !Self {
        var pool = Self{
            .allocator = allocator,
            .workers = try allocator.alloc(Worker, num_workers),
            .work_queue = WorkQueue.init(allocator),
            .modem_manager = modem_manager,
            .should_exit = should_exit,
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
        // Wait for all workers to finish
        for (self.workers) |*worker| {
            worker.thread.join();
        }
        
        self.work_queue.deinit();
        self.allocator.free(self.workers);
    }
    
    /// Submit work to the pool
    pub fn submit(self: *Self, work_type: WorkType, modem_id: []const u8) !void {
        const modem_id_copy = try self.allocator.dupe(u8, modem_id);
        try self.work_queue.push(.{
            .type = work_type,
            .modem_id = modem_id_copy,
        });
    }
    
    /// Get queue size
    pub fn queueSize(self: *Self) usize {
        return self.work_queue.size();
    }
};