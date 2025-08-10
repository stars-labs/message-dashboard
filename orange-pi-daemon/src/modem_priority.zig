const std = @import("std");

/// Priority levels for modem polling
pub const Priority = enum(u8) {
    High = 0,    // Check every cycle (active modems)
    Medium = 1,  // Check every 5 cycles
    Low = 2,     // Check every 20 cycles
};

/// Modem priority tracker
pub const ModemPriority = struct {
    modem_id: []const u8,
    priority: Priority,
    last_message_time: i64,
    last_check_time: i64,
    message_count: u32,
    cycles_since_check: u32,
    
    const Self = @This();
    
    /// Check if this modem should be checked in the current cycle
    pub fn shouldCheck(self: *Self, cycle_count: u64) bool {
        return switch (self.priority) {
            .High => true,  // Always check high priority
            .Medium => cycle_count % 5 == 0 or self.cycles_since_check >= 5,
            .Low => cycle_count % 20 == 0 or self.cycles_since_check >= 20,
        };
    }
    
    /// Update priority based on activity
    pub fn updatePriority(self: *Self, found_messages: bool) void {
        const now = std.time.timestamp();
        
        if (found_messages) {
            self.last_message_time = now;
            self.message_count += 1;
            self.priority = .High;
            self.cycles_since_check = 0;
        } else {
            self.cycles_since_check += 1;
            
            // Downgrade priority based on inactivity
            const time_since_message = now - self.last_message_time;
            if (time_since_message > 300) { // 5 minutes
                self.priority = .Low;
            } else if (time_since_message > 60) { // 1 minute
                self.priority = .Medium;
            }
            // Stay High if recent activity (< 1 minute)
        }
        
        self.last_check_time = now;
    }
};

/// Priority manager for all modems
pub const PriorityManager = struct {
    priorities: std.StringHashMap(ModemPriority),
    allocator: std.mem.Allocator,
    mutex: std.Thread.Mutex,
    
    const Self = @This();
    
    pub fn init(allocator: std.mem.Allocator) Self {
        return .{
            .priorities = std.StringHashMap(ModemPriority).init(allocator),
            .allocator = allocator,
            .mutex = std.Thread.Mutex{},
        };
    }
    
    pub fn deinit(self: *Self) void {
        var it = self.priorities.iterator();
        while (it.next()) |entry| {
            self.allocator.free(entry.key_ptr.*);
        }
        self.priorities.deinit();
    }
    
    /// Get or create priority entry for a modem
    pub fn getOrCreate(self: *Self, modem_id: []const u8) !*ModemPriority {
        self.mutex.lock();
        defer self.mutex.unlock();
        
        const result = try self.priorities.getOrPut(modem_id);
        if (!result.found_existing) {
            const key = try self.allocator.dupe(u8, modem_id);
            result.key_ptr.* = key;
            result.value_ptr.* = ModemPriority{
                .modem_id = key,
                .priority = .Medium,  // Start with medium priority
                .last_message_time = 0,
                .last_check_time = 0,
                .message_count = 0,
                .cycles_since_check = 0,
            };
        }
        return result.value_ptr;
    }
    
    /// Get modems that should be checked this cycle
    pub fn getModemsToCheck(self: *Self, all_modems: [][]const u8, cycle_count: u64, allocator: std.mem.Allocator) ![][]const u8 {
        self.mutex.lock();
        defer self.mutex.unlock();
        
        var to_check = std.ArrayList([]const u8).init(allocator);
        
        for (all_modems) |modem_id| {
            const priority = try self.getOrCreate(modem_id);
            if (priority.shouldCheck(cycle_count)) {
                try to_check.append(modem_id);
            }
        }
        
        return to_check.toOwnedSlice();
    }
    
    /// Update modem priority after checking
    pub fn updateModemPriority(self: *Self, modem_id: []const u8, found_messages: bool) !void {
        const priority = try self.getOrCreate(modem_id);
        priority.updatePriority(found_messages);
    }
    
    /// Get statistics for logging
    pub fn getStats(self: *Self) struct { high: u32, medium: u32, low: u32 } {
        self.mutex.lock();
        defer self.mutex.unlock();
        
        var high: u32 = 0;
        var medium: u32 = 0;
        var low: u32 = 0;
        
        var it = self.priorities.valueIterator();
        while (it.next()) |priority| {
            switch (priority.priority) {
                .High => high += 1,
                .Medium => medium += 1,
                .Low => low += 1,
            }
        }
        return .{ .high = high, .medium = medium, .low = low };
    }
};