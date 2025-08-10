const std = @import("std");
const types = @import("types.zig");
const LockFreeMPMC = @import("lockfree_mpmc.zig").LockFreeMPMC;

/// Lock-free thread-safe message queue
pub const LockFreeMessageQueue = struct {
    queue: LockFreeMPMC(types.MessageInfo),
    allocator: std.mem.Allocator,
    
    pub fn init(allocator: std.mem.Allocator) LockFreeMessageQueue {
        return .{
            .queue = LockFreeMPMC(types.MessageInfo).init(allocator),
            .allocator = allocator,
        };
    }
    
    pub fn deinit(self: *LockFreeMessageQueue) void {
        // Drain all messages and free their memory
        while (self.queue.tryPop()) |msg| {
            self.allocator.free(msg.modem_id);
            self.allocator.free(msg.sms_id);
            self.allocator.free(msg.message.phone_iccid);
            self.allocator.free(msg.message.phone_number);
            self.allocator.free(msg.message.content);
            self.allocator.free(msg.message.timestamp);
        }
        self.queue.deinit();
    }
    
    pub fn push(self: *LockFreeMessageQueue, message: types.MessageInfo) !void {
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
        
        // Push to lock-free queue (blocking if full)
        self.queue.push(msg_copy);
    }
    
    pub fn pop(self: *LockFreeMessageQueue) ?types.MessageInfo {
        return self.queue.tryPop();
    }
    
    pub fn popBatch(self: *LockFreeMessageQueue, batch: []types.MessageInfo) usize {
        var count: usize = 0;
        while (count < batch.len) {
            if (self.queue.tryPop()) |msg| {
                batch[count] = msg;
                count += 1;
            } else {
                break;
            }
        }
        return count;
    }
    
    pub fn size(self: *LockFreeMessageQueue) usize {
        return self.queue.size();
    }
    
    pub fn isEmpty(self: *LockFreeMessageQueue) bool {
        return self.queue.isEmpty();
    }
};