const std = @import("std");
const types = @import("types.zig");
const ModemManager = @import("modem_manager.zig").ModemManager;
const MessageQueue = @import("message_queue.zig").MessageQueue;

/// Asynchronous modem pool for efficient parallel processing
pub const AsyncModemPool = struct {
    allocator: std.mem.Allocator,
    modem_manager: *ModemManager,
    message_queue: *MessageQueue,
    worker_count: usize,
    modem_channel: Channel([]const u8),
    shutdown: std.atomic.Value(bool),
    
    const Channel = std.ArrayList; // Simplified channel implementation
    
    pub fn init(
        allocator: std.mem.Allocator,
        modem_manager: *ModemManager,
        message_queue: *MessageQueue,
        worker_count: usize,
    ) AsyncModemPool {
        return .{
            .allocator = allocator,
            .modem_manager = modem_manager,
            .message_queue = message_queue,
            .worker_count = worker_count,
            .modem_channel = Channel([]const u8).init(allocator),
            .shutdown = std.atomic.Value(bool).init(false),
        };
    }
    
    pub fn deinit(self: *AsyncModemPool) void {
        self.shutdown.store(true, .release);
        self.modem_channel.deinit();
    }
    
    /// Worker thread that continuously processes modems from the channel
    fn worker(self: *AsyncModemPool) !void {
        while (!self.shutdown.load(.acquire)) {
            // Get next modem from channel (with timeout)
            const modem_id = self.getNextModem() orelse {
                std.time.sleep(10 * std.time.ns_per_ms);
                continue;
            };
            defer self.allocator.free(modem_id);
            
            // Process messages for this modem
            const messages = self.modem_manager.getNewMessages(modem_id) catch |err| {
                std.log.debug("Failed to get messages from modem {s}: {any}", .{ modem_id, err });
                continue;
            };
            
            // Queue messages for upload
            for (messages) |msg| {
                self.message_queue.push(msg) catch |err| {
                    std.log.err("Failed to queue message: {any}", .{err});
                };
            }
            
            // Free message data
            for (messages) |msg| {
                self.allocator.free(msg.modem_id);
                self.allocator.free(msg.sms_id);
                self.allocator.free(msg.message.phone_iccid);
                self.allocator.free(msg.message.phone_number);
                self.allocator.free(msg.message.content);
                self.allocator.free(msg.message.timestamp);
            }
            self.allocator.free(messages);
        }
    }
    
    /// Start worker threads
    pub fn start(self: *AsyncModemPool) ![]std.Thread {
        var workers = try self.allocator.alloc(std.Thread, self.worker_count);
        for (workers) |*w| {
            w.* = try std.Thread.spawn(.{}, worker, .{self});
        }
        return workers;
    }
    
    /// Submit a modem for processing
    pub fn submitModem(self: *AsyncModemPool, modem_id: []const u8) !void {
        const id_copy = try self.allocator.dupe(u8, modem_id);
        try self.modem_channel.append(id_copy);
    }
    
    fn getNextModem(self: *AsyncModemPool) ?[]const u8 {
        if (self.modem_channel.items.len > 0) {
            return self.modem_channel.orderedRemove(0);
        }
        return null;
    }
};