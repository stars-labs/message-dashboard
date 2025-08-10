const std = @import("std");

/// Bloom filter for fast message deduplication
pub const BloomFilter = struct {
    bits: []u8,
    size_bits: usize,
    hash_count: u8,
    mutex: std.Thread.Mutex,
    
    const Self = @This();
    
    /// Create a new bloom filter
    /// size_bytes: Size of the bit array in bytes
    /// hash_count: Number of hash functions to use (3-5 recommended)
    pub fn init(allocator: std.mem.Allocator, size_bytes: usize, hash_count: u8) !Self {
        const bits = try allocator.alloc(u8, size_bytes);
        @memset(bits, 0);
        
        return Self{
            .bits = bits,
            .size_bits = size_bytes * 8,
            .hash_count = hash_count,
            .mutex = std.Thread.Mutex{},
        };
    }
    
    pub fn deinit(self: *Self, allocator: std.mem.Allocator) void {
        allocator.free(self.bits);
    }
    
    /// Hash function using FNV-1a
    fn hash(data: []const u8, seed: u32) u64 {
        var h: u64 = 14695981039346656037; // FNV offset basis
        h = h +% seed; // Add seed for multiple hash functions
        
        for (data) |byte| {
            h = h ^ byte;
            h = h *% 1099511628211; // FNV prime
        }
        
        return h;
    }
    
    /// Set a bit at the given index
    fn setBit(self: *Self, index: usize) void {
        const byte_index = index / 8;
        const bit_index = @as(u3, @intCast(index % 8));
        self.bits[byte_index] |= (@as(u8, 1) << bit_index);
    }
    
    /// Check if a bit is set at the given index
    fn getBit(self: *const Self, index: usize) bool {
        const byte_index = index / 8;
        const bit_index = @as(u3, @intCast(index % 8));
        return (self.bits[byte_index] & (@as(u8, 1) << bit_index)) != 0;
    }
    
    /// Add an item to the bloom filter
    pub fn add(self: *Self, data: []const u8) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        
        var i: u8 = 0;
        while (i < self.hash_count) : (i += 1) {
            const h = hash(data, i);
            const index = h % self.size_bits;
            self.setBit(index);
        }
    }
    
    /// Check if an item might be in the bloom filter
    /// Returns false if definitely not present, true if possibly present
    pub fn mayContain(self: *Self, data: []const u8) bool {
        self.mutex.lock();
        defer self.mutex.unlock();
        
        var i: u8 = 0;
        while (i < self.hash_count) : (i += 1) {
            const h = hash(data, i);
            const index = h % self.size_bits;
            if (!self.getBit(index)) {
                return false; // Definitely not in the set
            }
        }
        return true; // Possibly in the set
    }
    
    /// Clear all bits in the filter
    pub fn clear(self: *Self) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        @memset(self.bits, 0);
    }
    
    /// Estimate the number of items in the filter (for debugging)
    pub fn estimateCount(self: *Self) f64 {
        self.mutex.lock();
        defer self.mutex.unlock();
        
        var set_bits: usize = 0;
        for (self.bits) |byte| {
            set_bits += @popCount(byte);
        }
        
        const m = @as(f64, @floatFromInt(self.size_bits));
        const k = @as(f64, @floatFromInt(self.hash_count));
        const x = @as(f64, @floatFromInt(set_bits));
        
        // Estimate using: n = -(m/k) * ln(1 - x/m)
        if (x == 0) return 0;
        if (x == @as(f64, @floatFromInt(self.size_bits))) return m; // Saturated
        
        const ratio = x / m;
        return -(m / k) * @log(1.0 - ratio);
    }
    
    /// Calculate false positive probability (for debugging)
    pub fn falsePositiveProbability(self: *Self) f64 {
        const set_bits = self.estimateCount();
        const m = @as(f64, @floatFromInt(self.size_bits));
        const k = @as(f64, @floatFromInt(self.hash_count));
        
        // P = (1 - e^(-kn/m))^k
        const exponent = -k * set_bits / m;
        const base = 1.0 - @exp(exponent);
        return std.math.pow(f64, base, k);
    }
};

/// Persistent message deduplicator using bloom filter + LRU cache
pub const MessageDeduplicator = struct {
    bloom: BloomFilter,
    recent_messages: std.StringHashMap(i64), // Message hash -> timestamp
    allocator: std.mem.Allocator,
    max_recent: usize,
    mutex: std.Thread.Mutex,
    
    const Self = @This();
    
    pub fn init(allocator: std.mem.Allocator) !Self {
        // 64KB bloom filter for ~100k messages with 1% false positive rate
        const bloom = try BloomFilter.init(allocator, 64 * 1024, 5);
        
        return Self{
            .bloom = bloom,
            .recent_messages = std.StringHashMap(i64).init(allocator),
            .allocator = allocator,
            .max_recent = 10000, // Keep last 10k message hashes
            .mutex = std.Thread.Mutex{},
        };
    }
    
    pub fn deinit(self: *Self) void {
        self.bloom.deinit(self.allocator);
        var it = self.recent_messages.iterator();
        while (it.next()) |entry| {
            self.allocator.free(entry.key_ptr.*);
        }
        self.recent_messages.deinit();
    }
    
    /// Create a unique key for a message
    pub fn makeKey(allocator: std.mem.Allocator, phone_iccid: []const u8, content: []const u8, timestamp: []const u8) ![]u8 {
        return std.fmt.allocPrint(allocator, "{s}|{s}|{s}", .{ phone_iccid, content, timestamp });
    }
    
    /// Check if we've seen this message before
    pub fn isDuplicate(self: *Self, key: []const u8) bool {
        self.mutex.lock();
        defer self.mutex.unlock();
        
        // First check bloom filter (fast path)
        if (!self.bloom.mayContain(key)) {
            return false; // Definitely new
        }
        
        // Then check recent messages cache (slow path)
        if (self.recent_messages.contains(key)) {
            return true; // Definitely duplicate
        }
        
        // Bloom filter says maybe, but not in cache
        // This could be a false positive or an old message
        return false; // Treat as new
    }
    
    /// Add a message to the deduplicator
    pub fn addMessage(self: *Self, key: []const u8) !void {
        self.mutex.lock();
        defer self.mutex.unlock();
        
        // Add to bloom filter
        self.bloom.add(key);
        
        // Add to recent messages cache
        const key_copy = try self.allocator.dupe(u8, key);
        try self.recent_messages.put(key_copy, std.time.timestamp());
        
        // Prune old entries if too many
        if (self.recent_messages.count() > self.max_recent) {
            // Simple pruning: remove oldest 10%
            const to_remove = self.max_recent / 10;
            var removed: usize = 0;
            
            var it = self.recent_messages.iterator();
            while (it.next()) |entry| {
                if (removed >= to_remove) break;
                self.allocator.free(entry.key_ptr.*);
                _ = self.recent_messages.remove(entry.key_ptr.*);
                removed += 1;
            }
        }
    }
    
    /// Get deduplication stats
    pub fn getStats(self: *Self) struct { bloom_estimate: f64, cache_size: usize, false_positive_prob: f64 } {
        self.mutex.lock();
        defer self.mutex.unlock();
        
        return .{
            .bloom_estimate = self.bloom.estimateCount(),
            .cache_size = self.recent_messages.count(),
            .false_positive_prob = self.bloom.falsePositiveProbability(),
        };
    }
};