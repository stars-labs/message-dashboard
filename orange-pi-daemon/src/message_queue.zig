const std = @import("std");
const types = @import("types.zig");

/// Thread-safe message queue
pub const MessageQueue = struct {
    messages: std.ArrayList(types.MessageInfo),
    mutex: std.Thread.Mutex,
    allocator: std.mem.Allocator,
    
    pub fn init(allocator: std.mem.Allocator) MessageQueue {
        return .{
            .messages = std.ArrayList(types.MessageInfo).init(allocator),
            .mutex = .{},
            .allocator = allocator,
        };
    }
    
    pub fn deinit(self: *MessageQueue) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        
        // Free all message data
        for (self.messages.items) |msg| {
            self.allocator.free(msg.modem_id);
            self.allocator.free(msg.sms_id);
            self.allocator.free(msg.message.phone_iccid);
            self.allocator.free(msg.message.phone_number);
            self.allocator.free(msg.message.content);
            self.allocator.free(msg.message.timestamp);
        }
        self.messages.deinit();
    }
    
    pub fn push(self: *MessageQueue, message: types.MessageInfo) !void {
        self.mutex.lock();
        defer self.mutex.unlock();
        
        // Create a copy of the message for storage
        const msg_copy = types.MessageInfo{
            .modem_id = try self.allocator.dupe(u8, message.modem_id),
            .sms_id = try self.allocator.dupe(u8, message.sms_id),
            .message = types.Message{
                .phone_iccid = try self.allocator.dupe(u8, message.message.phone_iccid),
                .phone_number = try self.allocator.dupe(u8, message.message.phone_number),
                .content = try self.allocator.dupe(u8, message.message.content),
                .timestamp = try self.allocator.dupe(u8, message.message.timestamp),
            },
        };
        
        try self.messages.append(msg_copy);
    }
    
    pub fn popBatch(self: *MessageQueue, max_count: usize) ![]types.MessageInfo {
        self.mutex.lock();
        defer self.mutex.unlock();
        
        if (self.messages.items.len == 0) {
            return self.allocator.alloc(types.MessageInfo, 0);
        }
        
        const count = @min(max_count, self.messages.items.len);
        const batch = try self.allocator.alloc(types.MessageInfo, count);
        
        // Move messages to batch
        for (0..count) |i| {
            batch[i] = self.messages.items[i];
        }
        
        // Remove from queue
        for (0..count) |_| {
            _ = self.messages.orderedRemove(0);
        }
        
        return batch;
    }
    
    pub fn size(self: *MessageQueue) usize {
        self.mutex.lock();
        defer self.mutex.unlock();
        return self.messages.items.len;
    }
};