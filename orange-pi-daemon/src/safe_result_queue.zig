const std = @import("std");
const types = @import("types.zig");

pub const SafeResultQueue = struct {
    mutex: std.Thread.Mutex = .{},
    items: std.ArrayList(*types.ModemCheckResult),
    allocator: std.mem.Allocator,

    pub fn init(allocator: std.mem.Allocator) SafeResultQueue {
        return .{
            .mutex = .{},
            .items = .empty,
            .allocator = allocator,
        };
    }

    pub fn deinit(self: *SafeResultQueue) void {
        self.items.deinit(self.allocator);
    }

    pub fn push(self: *SafeResultQueue, item: *types.ModemCheckResult) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        self.items.append(self.allocator, item) catch {};
    }

    pub fn tryPop(self: *SafeResultQueue) ?*types.ModemCheckResult {
        self.mutex.lock();
        defer self.mutex.unlock();
        if (self.items.items.len == 0) return null;
        const ptr = self.items.items[0];
        _ = self.items.orderedRemove(0);
        return ptr;
    }

    pub fn size(self: *SafeResultQueue) usize {
        self.mutex.lock();
        defer self.mutex.unlock();
        return self.items.items.len;
    }
};
