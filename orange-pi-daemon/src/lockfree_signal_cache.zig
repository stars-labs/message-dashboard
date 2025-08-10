const std = @import("std");
const types = @import("types.zig");

/// Lock-free signal cache using atomic operations
pub const LockFreeSignalCache = struct {
    const Entry = struct {
        iccid: [32]u8, // Fixed size for atomic operations
        iccid_len: u8,
        signal_percent: u8,
        timestamp: i64,
        valid: std.atomic.Value(bool),
    };
    
    const CACHE_SIZE = 256; // Must be power of 2
    const CACHE_MASK = CACHE_SIZE - 1;
    
    entries: [CACHE_SIZE]Entry align(64),
    allocator: std.mem.Allocator,
    
    pub fn init(allocator: std.mem.Allocator) LockFreeSignalCache {
        var cache = LockFreeSignalCache{
            .entries = undefined,
            .allocator = allocator,
        };
        
        // Initialize all entries as invalid
        for (&cache.entries) |*entry| {
            entry.* = Entry{
                .iccid = [_]u8{0} ** 32,
                .iccid_len = 0,
                .signal_percent = 0,
                .timestamp = 0,
                .valid = std.atomic.Value(bool).init(false),
            };
        }
        
        return cache;
    }
    
    pub fn deinit(self: *LockFreeSignalCache) void {
        // Nothing to deallocate - fixed size array
        _ = self;
    }
    
    fn hash(iccid: []const u8) u32 {
        var h: u32 = 0;
        for (iccid) |byte| {
            h = h *% 31 +% byte;
        }
        return h;
    }
    
    pub fn put(self: *LockFreeSignalCache, iccid: []const u8, signal_percent: u8) void {
        const h = hash(iccid);
        const base_index = h & CACHE_MASK;
        
        // Linear probing to find an empty slot or matching ICCID
        var probes: usize = 0;
        while (probes < 8) : (probes += 1) { // Max 8 probes to avoid excessive searching
            const index = (base_index + probes) & CACHE_MASK;
            var entry = &self.entries[index];
            
            // Check if this slot is for the same ICCID or is empty/expired
            if (entry.valid.load(.acquire)) {
                if (entry.iccid_len == iccid.len and
                    std.mem.eql(u8, entry.iccid[0..entry.iccid_len], iccid)) {
                    // Found existing entry for this ICCID - update it
                    entry.signal_percent = signal_percent;
                    entry.timestamp = std.time.timestamp();
                    return;
                }
                // Check if entry is expired (older than 5 minutes)
                const now = std.time.timestamp();
                if (now - entry.timestamp <= 300) {
                    continue; // Slot is occupied by fresh data, try next
                }
            }
            
            // Found empty or expired slot - use it
            entry.valid.store(false, .release);
            
            // Copy ICCID (truncate if too long)
            const copy_len = @min(iccid.len, 32);
            @memcpy(entry.iccid[0..copy_len], iccid[0..copy_len]);
            entry.iccid_len = @intCast(copy_len);
            
            entry.signal_percent = signal_percent;
            entry.timestamp = std.time.timestamp();
            
            entry.valid.store(true, .release);
            return;
        }
        
        // All probed slots are occupied - forcibly use the base index
        var entry = &self.entries[base_index];
        entry.valid.store(false, .release);
        
        const copy_len = @min(iccid.len, 32);
        @memcpy(entry.iccid[0..copy_len], iccid[0..copy_len]);
        entry.iccid_len = @intCast(copy_len);
        
        entry.signal_percent = signal_percent;
        entry.timestamp = std.time.timestamp();
        
        entry.valid.store(true, .release);
    }
    
    pub fn get(self: *LockFreeSignalCache, iccid: []const u8) ?types.SignalData {
        const h = hash(iccid);
        const base_index = h & CACHE_MASK;
        
        // Linear probing to find matching ICCID
        var probes: usize = 0;
        while (probes < 8) : (probes += 1) { // Match the put() probe limit
            const index = (base_index + probes) & CACHE_MASK;
            const entry = &self.entries[index];
            
            if (!entry.valid.load(.acquire)) {
                continue; // Empty slot, keep searching
            }
            
            // Check if ICCID matches
            if (entry.iccid_len != iccid.len) {
                continue;
            }
            
            if (!std.mem.eql(u8, entry.iccid[0..entry.iccid_len], iccid)) {
                continue;
            }
            
            // Found matching ICCID - check if data is fresh (less than 5 minutes old)
            const now = std.time.timestamp();
            if (now - entry.timestamp > 300) {
                return null; // Data expired
            }
            
            return types.SignalData{
                .signal_percent = entry.signal_percent,
                .rssi = null,
                .rsrq = null,
                .rsrp = null,
                .snr = null,
            };
        }
        
        return null; // Not found after probing
    }
    
    pub fn clear(self: *LockFreeSignalCache) void {
        for (&self.entries) |*entry| {
            entry.valid.store(false, .release);
        }
    }
};