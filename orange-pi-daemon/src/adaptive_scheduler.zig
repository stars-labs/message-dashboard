const std = @import("std");

/// Adaptive scheduler that adjusts polling intervals based on activity
pub const AdaptiveScheduler = struct {
    allocator: std.mem.Allocator,
    base_interval: u64, // Base interval in nanoseconds
    min_interval: u64,
    max_interval: u64,
    current_interval: u64,
    last_activity: i64,
    activity_count: u64,
    mutex: std.Thread.Mutex,
    
    // Activity thresholds
    const HIGH_ACTIVITY_THRESHOLD = 10; // messages per minute
    const LOW_ACTIVITY_THRESHOLD = 1;   // messages per minute
    const ACTIVITY_WINDOW = 60 * std.time.ns_per_s; // 1 minute window
    
    pub fn init(allocator: std.mem.Allocator, base_interval_ms: u64) AdaptiveScheduler {
        const base_ns = base_interval_ms * std.time.ns_per_ms;
        return .{
            .allocator = allocator,
            .base_interval = base_ns,
            .min_interval = base_ns / 10, // 10x faster at peak
            .max_interval = base_ns * 10, // 10x slower when idle
            .current_interval = base_ns,
            .last_activity = std.time.nanoTimestamp(),
            .activity_count = 0,
            .mutex = .{},
        };
    }
    
    /// Record activity and adjust interval
    pub fn recordActivity(self: *AdaptiveScheduler, count: u64) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        
        const now = std.time.nanoTimestamp();
        const time_since_last = now - self.last_activity;
        
        // Reset counter if window expired
        if (time_since_last > ACTIVITY_WINDOW) {
            self.activity_count = count;
            self.last_activity = now;
        } else {
            self.activity_count += count;
        }
        
        // Calculate activity rate (messages per minute)
        const elapsed_minutes = @as(f64, @floatFromInt(time_since_last)) / @as(f64, @floatFromInt(ACTIVITY_WINDOW));
        const activity_rate = if (elapsed_minutes > 0) 
            @as(f64, @floatFromInt(self.activity_count)) / elapsed_minutes 
        else 
            @as(f64, @floatFromInt(self.activity_count));
        
        // Adjust interval based on activity
        if (activity_rate > HIGH_ACTIVITY_THRESHOLD) {
            // High activity - speed up
            self.current_interval = @max(self.min_interval, self.current_interval * 3 / 4);
        } else if (activity_rate < LOW_ACTIVITY_THRESHOLD) {
            // Low activity - slow down
            self.current_interval = @min(self.max_interval, self.current_interval * 5 / 4);
        } else {
            // Normal activity - gradually return to base
            const diff = @as(i64, @intCast(self.base_interval)) - @as(i64, @intCast(self.current_interval));
            self.current_interval = @intCast(@as(i64, @intCast(self.current_interval)) + @divTrunc(diff, 4));
        }
    }
    
    /// Get current sleep interval
    pub fn getSleepInterval(self: *AdaptiveScheduler) u64 {
        self.mutex.lock();
        defer self.mutex.unlock();
        return self.current_interval;
    }
    
    /// Sleep for the current interval
    pub fn sleep(self: *AdaptiveScheduler) void {
        const interval = self.getSleepInterval();
        std.time.sleep(interval);
    }
};