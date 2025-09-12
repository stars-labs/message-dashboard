const std = @import("std");
const types = @import("types.zig");

/// Manages state synchronization with retry logic and error handling
pub const SyncManager = struct {
    allocator: std.mem.Allocator,
    last_full_sync: ?i64,
    full_sync_attempts: u32,
    session_id: []const u8,
    
    const MAX_RETRY_ATTEMPTS = 3;
    const FULL_SYNC_INTERVAL = 3600; // Re-sync every hour as safety measure
    
    pub fn init(allocator: std.mem.Allocator, session_id: []const u8) SyncManager {
        return .{
            .allocator = allocator,
            .last_full_sync = null,
            .full_sync_attempts = 0,
            .session_id = session_id,
        };
    }
    
    /// Determines if a full sync is needed
    pub fn needsFullSync(self: *SyncManager) bool {
        // Always do full sync on startup
        if (self.last_full_sync == null) {
            return true;
        }
        
        // Full sync if too many attempts failed
        if (self.full_sync_attempts >= MAX_RETRY_ATTEMPTS) {
            std.log.warn("⚠️ Full sync failed {d} times, will retry next cycle", .{self.full_sync_attempts});
            return false; // Skip this cycle to avoid infinite loop
        }
        
        // Periodic full sync for safety
        const now = std.time.timestamp();
        if (now - self.last_full_sync.? > FULL_SYNC_INTERVAL) {
            std.log.info("🔄 Periodic full sync triggered (last was {d}s ago)", .{now - self.last_full_sync.?});
            return true;
        }
        
        return false;
    }
    
    /// Records successful sync
    pub fn recordSuccess(self: *SyncManager, is_full: bool) void {
        if (is_full) {
            self.last_full_sync = std.time.timestamp();
            self.full_sync_attempts = 0;
            std.log.info("✅ Full sync completed successfully at timestamp {d}", .{self.last_full_sync.?});
        }
    }
    
    /// Records failed sync attempt
    pub fn recordFailure(self: *SyncManager, is_full: bool, err: anyerror) void {
        if (is_full) {
            self.full_sync_attempts += 1;
            std.log.err("❌ Full sync attempt {d}/{d} failed: {any}", .{
                self.full_sync_attempts,
                MAX_RETRY_ATTEMPTS,
                err,
            });
        }
    }
    
    /// Validates sync data before sending
    pub fn validateSyncData(self: *SyncManager, modems: []const types.Modem, sims: []const types.SIM) !void {
        // Check for critical data integrity issues
        var modem_ids = std.hash_map.HashMap([]const u8, void, std.hash_map.StringContext, std.hash_map.default_max_load_percentage).init(self.allocator);
        defer modem_ids.deinit();
        
        var sim_ids = std.hash_map.HashMap([]const u8, void, std.hash_map.StringContext, std.hash_map.default_max_load_percentage).init(self.allocator);
        defer sim_ids.deinit();
        
        // Check for duplicate modem IDs
        for (modems) |modem| {
            if (modem_ids.contains(modem.equipment_id)) {
                std.log.err("🚨 Duplicate modem ID detected: {s}", .{modem.equipment_id});
                return error.DuplicateModemId;
            }
            try modem_ids.put(modem.equipment_id, {});
        }
        
        // Check for duplicate SIM ICCIDs
        for (sims) |sim| {
            if (sim_ids.contains(sim.iccid)) {
                std.log.err("🚨 Duplicate SIM ICCID detected: {s}", .{sim.iccid});
                return error.DuplicateSimIccid;
            }
            try sim_ids.put(sim.iccid, {});
            
            // Validate SIM modem association exists
            if (sim.current_modem_id) |modem_id| {
                if (!modem_ids.contains(modem_id)) {
                    std.log.warn("⚠️ SIM {s} references non-existent modem {s}", .{sim.iccid, modem_id});
                    // This is a warning, not an error - the API will handle it
                }
            }
        }
        
        std.log.debug("✅ Sync data validation passed: {d} modems, {d} SIMs", .{modems.len, sims.len});
    }
    
    /// Creates a sync checkpoint for recovery
    pub fn createCheckpoint(self: *SyncManager, modems: []const types.Modem, sims: []const types.SIM) ![]u8 {
        // Create a simple JSON checkpoint for debugging/recovery
        const checkpoint = try std.fmt.allocPrint(self.allocator,
            \\{{
            \\  "session_id": "{s}",
            \\  "timestamp": {},
            \\  "modem_count": {},
            \\  "sim_count": {},
            \\  "full_sync_attempts": {}
            \\}}
        , .{
            self.session_id,
            std.time.timestamp(),
            modems.len,
            sims.len,
            self.full_sync_attempts,
        });
        
        return checkpoint;
    }
    
    pub fn deinit(self: *SyncManager) void {
        _ = self;
        // Nothing to clean up currently
    }
};

/// Helper to detect and handle stale data
pub fn detectStaleData(allocator: std.mem.Allocator, modems: []const types.Modem) ![]const []const u8 {
    var stale_list = std.ArrayList([]const u8).init(allocator);
    errdefer stale_list.deinit();
    
    for (modems) |modem| {
        // Check if modem status indicates it might be stale
        if (std.mem.eql(u8, modem.status, "disconnected")) {
            // This modem appears disconnected but is being reported
            // This could indicate stale data from a previous run
            try stale_list.append(modem.equipment_id);
        }
    }
    
    return stale_list.toOwnedSlice();
}

/// Handles network failures with exponential backoff
pub const RetryManager = struct {
    attempt: u32,
    max_attempts: u32,
    base_delay_ms: u64,
    
    pub fn init(max_attempts: u32, base_delay_ms: u64) RetryManager {
        return .{
            .attempt = 0,
            .max_attempts = max_attempts,
            .base_delay_ms = base_delay_ms,
        };
    }
    
    pub fn shouldRetry(self: *RetryManager) bool {
        return self.attempt < self.max_attempts;
    }
    
    pub fn nextDelay(self: *RetryManager) u64 {
        self.attempt += 1;
        // Exponential backoff: delay * 2^attempt
        const multiplier = std.math.pow(u64, 2, self.attempt);
        return self.base_delay_ms * multiplier;
    }
    
    pub fn reset(self: *RetryManager) void {
        self.attempt = 0;
    }
};