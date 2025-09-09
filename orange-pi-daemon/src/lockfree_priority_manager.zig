const std = @import("std");

pub const Priority = enum(u8) {
    High = 0,
    Medium = 1,
    Low = 2,
};

pub const ModemPriority = struct {
    modem_id: [32]u8, // Fixed size for atomic operations
    modem_id_len: u8,
    priority: std.atomic.Value(u8),
    last_check: std.atomic.Value(i64),
    consecutive_empty: std.atomic.Value(u32),
    valid: std.atomic.Value(bool),
};

/// Lock-free priority manager using atomic operations
pub const LockFreePriorityManager = struct {
    const MAX_MODEMS = 256;
    
    modems: [MAX_MODEMS]ModemPriority align(64),
    count: std.atomic.Value(u32),
    allocator: std.mem.Allocator,
    
    pub fn init(allocator: std.mem.Allocator) LockFreePriorityManager {
        var manager = LockFreePriorityManager{
            .modems = undefined,
            .count = std.atomic.Value(u32).init(0),
            .allocator = allocator,
        };
        
        // Initialize all entries as invalid
        for (&manager.modems) |*modem| {
            modem.* = ModemPriority{
                .modem_id = [_]u8{0} ** 32,
                .modem_id_len = 0,
                .priority = std.atomic.Value(u8).init(@intFromEnum(Priority.Medium)),
                .last_check = std.atomic.Value(i64).init(0),
                .consecutive_empty = std.atomic.Value(u32).init(0),
                .valid = std.atomic.Value(bool).init(false),
            };
        }
        
        return manager;
    }
    
    pub fn deinit(self: *LockFreePriorityManager) void {
        _ = self;
    }
    
    fn findOrCreateSlot(self: *LockFreePriorityManager, modem_id: []const u8) ?*ModemPriority {
        // Validate input
        if (modem_id.len == 0 or modem_id.len > 32) {
            std.log.warn("Invalid modem_id length: {d}", .{modem_id.len});
            return null;
        }
        
        // First pass: look for existing entry
        for (&self.modems) |*modem| {
            if (!modem.valid.load(.acquire)) continue;
            
            if (modem.modem_id_len == modem_id.len and
                std.mem.eql(u8, modem.modem_id[0..modem.modem_id_len], modem_id)) {
                return modem;
            }
        }
        
        // Second pass: find empty slot
        for (&self.modems) |*modem| {
            // Try to claim this slot atomically
            if (modem.valid.cmpxchgWeak(false, true, .acq_rel, .acquire) == null) {
                // Successfully claimed slot - log for debugging
                const copy_len = @min(modem_id.len, 32);
                @memcpy(modem.modem_id[0..copy_len], modem_id[0..copy_len]);
                modem.modem_id_len = @intCast(copy_len);
                modem.priority.store(@intFromEnum(Priority.Medium), .release);
                modem.last_check.store(0, .release);
                modem.consecutive_empty.store(0, .release);
                const new_count = self.count.fetchAdd(1, .monotonic) + 1;
                std.log.debug("Created slot for modem {s} (total: {d})", .{ modem_id, new_count });
                return modem;
            }
        }
        
        const current_count = self.count.load(.acquire);
        std.log.err("Could not create slot for modem {s} - all {d} slots full (current count: {d})", .{ modem_id, MAX_MODEMS, current_count });
        return null; // All slots full
    }
    
    pub fn updateModemPriority(self: *LockFreePriorityManager, modem_id: []const u8, found_messages: bool) !void {
        const modem = self.findOrCreateSlot(modem_id) orelse return error.CacheFull;
        
        modem.last_check.store(std.time.timestamp(), .release);
        
        if (found_messages) {
            // Found messages - increase priority
            modem.priority.store(@intFromEnum(Priority.High), .release);
            modem.consecutive_empty.store(0, .release);
        } else {
            // No messages - decrease priority gradually
            const empty_count = modem.consecutive_empty.fetchAdd(1, .acq_rel) + 1;
            
            if (empty_count >= 10) {
                modem.priority.store(@intFromEnum(Priority.Low), .release);
            } else if (empty_count >= 5) {
                modem.priority.store(@intFromEnum(Priority.Medium), .release);
            }
        }
    }
    
    pub fn getModemsToCheck(self: *LockFreePriorityManager, all_modems: [][]const u8, cycle_count: u64, allocator: std.mem.Allocator) ![][]const u8 {
        var result = std.ArrayList([]const u8).init(allocator);
        errdefer result.deinit();
        
        const now = std.time.timestamp();
        
        for (all_modems) |modem_id| {
            // Get or create modem entry
            const modem = self.findOrCreateSlot(modem_id) orelse {
                std.log.warn("Could not find or create slot for modem {s}", .{modem_id});
                continue;
            };
            
            const priority = @as(Priority, @enumFromInt(modem.priority.load(.acquire)));
            const last_check = modem.last_check.load(.acquire);
            const time_since_check = now - last_check;
            
            // Determine if we should check this modem
            const should_check = switch (priority) {
                .High => true, // Always check high priority
                .Medium => cycle_count % 2 == 0 or time_since_check > 5,
                .Low => cycle_count % 5 == 0 or time_since_check > 15,
            };
            
            // Debug logging for first few cycles to understand the issue
            if (cycle_count < 10) {
                std.log.debug("Modem {s}: priority={s}, last_check={d}, time_since={d}, cycle={d}, should_check={}", 
                    .{ modem_id, @tagName(priority), last_check, time_since_check, cycle_count, should_check });
            }
            
            if (should_check) {
                try result.append(modem_id);
            }
        }
        
        return result.toOwnedSlice();
    }
    
    pub fn getStats(self: *LockFreePriorityManager) struct { high: u32, medium: u32, low: u32, total: u32 } {
        var high: u32 = 0;
        var medium: u32 = 0;
        var low: u32 = 0;
        var total: u32 = 0;
        
        for (&self.modems) |*modem| {
            if (!modem.valid.load(.acquire)) continue;
            
            total += 1;
            const priority = @as(Priority, @enumFromInt(modem.priority.load(.acquire)));
            switch (priority) {
                .High => high += 1,
                .Medium => medium += 1,
                .Low => low += 1,
            }
        }
        
        return .{ .high = high, .medium = medium, .low = low, .total = total };
    }
};