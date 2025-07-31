const std = @import("std");
const types = @import("types.zig");

const SIGNAL_UPDATE_THRESHOLD = 5; // Update if signal changes by more than 5%
const MIN_UPDATE_INTERVAL = 5 * std.time.ns_per_s; // Minimum 5 seconds between updates

/// Cached signal data with timestamp
const CachedSignal = struct {
    signal_data: types.SignalData,
    timestamp: i64,
};

/// Thread-safe signal cache for modems
pub const SignalCache = struct {
    allocator: std.mem.Allocator,
    cache: std.HashMap([]const u8, CachedSignal, std.hash_map.StringContext, std.hash_map.default_max_load_percentage),
    mutex: std.Thread.Mutex,

    pub fn init(allocator: std.mem.Allocator) SignalCache {
        return .{
            .allocator = allocator,
            .cache = std.HashMap([]const u8, CachedSignal, std.hash_map.StringContext, std.hash_map.default_max_load_percentage).init(allocator),
            .mutex = std.Thread.Mutex{},
        };
    }

    pub fn deinit(self: *SignalCache) void {
        var it = self.cache.iterator();
        while (it.next()) |entry| {
            self.allocator.free(entry.key_ptr.*);
        }
        self.cache.deinit();
    }

    pub fn shouldUpdate(self: *SignalCache, modem_id: []const u8, new_signal: types.SignalData) bool {
        self.mutex.lock();
        defer self.mutex.unlock();

        const now = std.time.milliTimestamp();

        if (self.cache.get(modem_id)) |cached| {
            // Check time threshold
            const time_diff = now - cached.timestamp;
            if (time_diff < MIN_UPDATE_INTERVAL / std.time.ns_per_ms) {
                return false;
            }

            // Check signal change threshold
            const old_signal = cached.signal_data.signal_percent;
            const new_signal_percent = new_signal.signal_percent;
            const signal_diff = if (old_signal > new_signal_percent) 
                old_signal - new_signal_percent 
            else 
                new_signal_percent - old_signal;

            return signal_diff >= SIGNAL_UPDATE_THRESHOLD;
        }

        // No cached data, should update
        return true;
    }

    pub fn updateCache(self: *SignalCache, modem_id: []const u8, signal_data: types.SignalData) !void {
        self.mutex.lock();
        defer self.mutex.unlock();

        const modem_id_copy = try self.allocator.dupe(u8, modem_id);
        errdefer self.allocator.free(modem_id_copy);

        const cached = CachedSignal{
            .signal_data = signal_data,
            .timestamp = std.time.milliTimestamp(),
        };

        // If key exists, free the old key
        if (self.cache.fetchRemove(modem_id)) |kv| {
            self.allocator.free(kv.key);
        }

        try self.cache.put(modem_id_copy, cached);
    }

    pub fn getSignal(self: *SignalCache, modem_id: []const u8) ?types.SignalData {
        self.mutex.lock();
        defer self.mutex.unlock();

        if (self.cache.get(modem_id)) |cached| {
            return cached.signal_data;
        }
        return null;
    }
};