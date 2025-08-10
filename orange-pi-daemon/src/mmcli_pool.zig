const std = @import("std");

/// Command result cache entry
const CacheEntry = struct {
    result: []const u8,
    timestamp: i64,
    allocator: std.mem.Allocator,
    
    pub fn isExpired(self: CacheEntry, ttl_ms: i64) bool {
        const now = std.time.milliTimestamp();
        return (now - self.timestamp) > ttl_ms;
    }
    
    pub fn deinit(self: *CacheEntry) void {
        self.allocator.free(self.result);
    }
};

/// Connection pool for mmcli commands with caching
pub const MmcliPool = struct {
    allocator: std.mem.Allocator,
    cache: std.hash_map.HashMap([]const u8, CacheEntry, std.hash_map.StringContext, std.hash_map.default_max_load_percentage),
    mutex: std.Thread.Mutex,
    semaphore: std.Thread.Semaphore,
    max_concurrent: u32,
    
    // Cache TTLs for different command types
    const MODEM_LIST_TTL = 5000; // 5 seconds
    const MODEM_STATE_TTL = 2000; // 2 seconds
    const SIM_INFO_TTL = 30000; // 30 seconds
    const SIGNAL_TTL = 5000; // 5 seconds
    
    pub fn init(allocator: std.mem.Allocator, max_concurrent: u32) MmcliPool {
        return .{
            .allocator = allocator,
            .cache = std.hash_map.HashMap([]const u8, CacheEntry, std.hash_map.StringContext, std.hash_map.default_max_load_percentage).init(allocator),
            .mutex = .{},
            .semaphore = std.Thread.Semaphore{ .permits = max_concurrent },
            .max_concurrent = max_concurrent,
        };
    }
    
    pub fn deinit(self: *MmcliPool) void {
        var it = self.cache.iterator();
        while (it.next()) |entry| {
            self.allocator.free(entry.key_ptr.*);
            entry.value_ptr.deinit();
        }
        self.cache.deinit();
    }
    
    /// Execute mmcli command with caching and rate limiting
    pub fn execute(self: *MmcliPool, argv: []const []const u8, ttl_ms: i64) ![]const u8 {
        // Build cache key from command
        const cache_key = try std.mem.join(self.allocator, " ", argv);
        defer self.allocator.free(cache_key);
        
        // Check cache first
        self.mutex.lock();
        if (self.cache.get(cache_key)) |entry| {
            if (!entry.isExpired(ttl_ms)) {
                const result = try self.allocator.dupe(u8, entry.result);
                self.mutex.unlock();
                return result;
            }
            // Remove expired entry
            var removed = self.cache.fetchRemove(cache_key).?;
            self.allocator.free(removed.key);
            removed.value.deinit();
        }
        self.mutex.unlock();
        
        // Rate limit concurrent executions
        self.semaphore.wait();
        defer self.semaphore.post();
        
        // Execute command
        const result = try std.process.Child.run(.{
            .allocator = self.allocator,
            .argv = argv,
        });
        defer self.allocator.free(result.stderr);
        
        if (result.term.Exited != 0) {
            self.allocator.free(result.stdout);
            return error.CommandFailed;
        }
        
        // Cache successful results
        self.mutex.lock();
        defer self.mutex.unlock();
        
        const cache_key_copy = try self.allocator.dupe(u8, cache_key);
        const entry = CacheEntry{
            .result = result.stdout,
            .timestamp = std.time.milliTimestamp(),
            .allocator = self.allocator,
        };
        
        try self.cache.put(cache_key_copy, entry);
        
        // Return a copy for the caller
        return try self.allocator.dupe(u8, result.stdout);
    }
    
    /// Clear expired entries from cache
    pub fn cleanupCache(self: *MmcliPool) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        
        var to_remove = std.ArrayList([]const u8).init(self.allocator);
        defer to_remove.deinit();
        
        var it = self.cache.iterator();
        while (it.next()) |entry| {
            if (entry.value_ptr.isExpired(60000)) { // 1 minute max TTL
                try to_remove.append(entry.key_ptr.*) catch {};
            }
        }
        
        for (to_remove.items) |key| {
            if (self.cache.fetchRemove(key)) |removed| {
                self.allocator.free(removed.key);
                removed.value.deinit();
            }
        }
    }
};