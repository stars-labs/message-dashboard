const std = @import("std");

/// Tracks processed messages to prevent duplicate uploads
pub const MessageTracker = struct {
    allocator: std.mem.Allocator,
    processed_messages: std.hash_map.StringHashMap(i64),
    mutex: std.Thread.Mutex,
    max_age_ns: i64, // Max age in nanoseconds before removing from cache
    
    const Self = @This();
    
    pub fn init(allocator: std.mem.Allocator) Self {
        return .{
            .allocator = allocator,
            .processed_messages = std.hash_map.StringHashMap(i64).init(allocator),
            .mutex = std.Thread.Mutex{},
            .max_age_ns = 24 * 60 * 60 * std.time.ns_per_s, // 24 hours
        };
    }
    
    pub fn deinit(self: *Self) void {
        var iterator = self.processed_messages.iterator();
        while (iterator.next()) |entry| {
            self.allocator.free(entry.key_ptr.*);
        }
        self.processed_messages.deinit();
    }
    
    /// Generate a unique key for a message
    fn generateKey(self: *Self, modem_id: []const u8, sms_id: []const u8, phone_number: []const u8, timestamp: []const u8) ![]u8 {
        return try std.fmt.allocPrint(self.allocator, "{s}:{s}:{s}:{s}", .{ modem_id, sms_id, phone_number, timestamp });
    }
    
    /// Check if a message has been processed
    pub fn isProcessed(self: *Self, modem_id: []const u8, sms_id: []const u8, phone_number: []const u8, timestamp: []const u8) !bool {
        const key = try self.generateKey(modem_id, sms_id, phone_number, timestamp);
        defer self.allocator.free(key);
        
        self.mutex.lock();
        defer self.mutex.unlock();
        
        // Clean up old entries first
        self.cleanupOldEntries();
        
        return self.processed_messages.contains(key);
    }
    
    /// Mark a message as processed
    pub fn markProcessed(self: *Self, modem_id: []const u8, sms_id: []const u8, phone_number: []const u8, timestamp: []const u8) !void {
        const key = try self.generateKey(modem_id, sms_id, phone_number, timestamp);
        const owned_key = try self.allocator.dupe(u8, key);
        defer self.allocator.free(key);
        
        const now = @as(i64, @intCast(std.time.nanoTimestamp()));
        
        self.mutex.lock();
        defer self.mutex.unlock();
        
        try self.processed_messages.put(owned_key, now);
        
        std.log.debug("📝 Marked message as processed: {s}", .{owned_key});
    }
    
    /// Clean up entries older than max_age
    fn cleanupOldEntries(self: *Self) void {
        const now = @as(i64, @intCast(std.time.nanoTimestamp()));
        var to_remove = std.ArrayList([]const u8).init(self.allocator);
        defer to_remove.deinit();
        
        var iterator = self.processed_messages.iterator();
        while (iterator.next()) |entry| {
            if (now - entry.value_ptr.* > self.max_age_ns) {
                to_remove.append(entry.key_ptr.*) catch continue;
            }
        }
        
        for (to_remove.items) |key| {
            if (self.processed_messages.fetchRemove(key)) |removed| {
                self.allocator.free(removed.key);
            }
        }
        
        if (to_remove.items.len > 0) {
            std.log.debug("🧹 Cleaned up {d} old message entries", .{to_remove.items.len});
        }
    }
    
    /// Get the number of tracked messages
    pub fn count(self: *Self) usize {
        self.mutex.lock();
        defer self.mutex.unlock();
        return self.processed_messages.count();
    }
    
    /// Clear all tracked messages
    pub fn clear(self: *Self) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        
        var iterator = self.processed_messages.iterator();
        while (iterator.next()) |entry| {
            self.allocator.free(entry.key_ptr.*);
        }
        self.processed_messages.clearAndFree();
    }
};

// Tests
test "MessageTracker basic operations" {
    const allocator = std.testing.allocator;
    var tracker = MessageTracker.init(allocator);
    defer tracker.deinit();
    
    // Test marking a message as processed
    try tracker.markProcessed("modem1", "sms123", "+1234567890", "2025-01-01T12:00:00Z");
    
    // Check if it's marked as processed
    const is_processed = try tracker.isProcessed("modem1", "sms123", "+1234567890", "2025-01-01T12:00:00Z");
    try std.testing.expect(is_processed);
    
    // Check a different message
    const not_processed = try tracker.isProcessed("modem1", "sms124", "+1234567890", "2025-01-01T12:00:00Z");
    try std.testing.expect(!not_processed);
    
    // Check count
    try std.testing.expectEqual(@as(usize, 1), tracker.count());
}

test "MessageTracker cleanup old entries" {
    const allocator = std.testing.allocator;
    var tracker = MessageTracker.init(allocator);
    defer tracker.deinit();
    
    // Set max age to 1 second for testing
    tracker.max_age_ns = std.time.ns_per_s;
    
    // Add a message
    try tracker.markProcessed("modem1", "sms123", "+1234567890", "2025-01-01T12:00:00Z");
    try std.testing.expectEqual(@as(usize, 1), tracker.count());
    
    // Wait a bit more than 1 second
    std.time.sleep(1100 * std.time.ns_per_ms);
    
    // Check if message is still processed (will trigger cleanup)
    const is_processed = try tracker.isProcessed("modem1", "sms123", "+1234567890", "2025-01-01T12:00:00Z");
    try std.testing.expect(!is_processed);
    
    // Count should be 0 after cleanup
    try std.testing.expectEqual(@as(usize, 0), tracker.count());
}