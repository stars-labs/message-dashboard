const std = @import("std");

/// Connection pool for HTTP client to reuse connections
pub const ConnectionPool = struct {
    allocator: std.mem.Allocator,
    connections: std.ArrayList(*std.http.Client),
    available: std.ArrayList(bool),
    mutex: std.Thread.Mutex,
    max_connections: usize,
    
    const Self = @This();
    
    pub fn init(allocator: std.mem.Allocator) Self {
        return .{
            .allocator = allocator,
            .connections = std.ArrayList(*std.http.Client).init(allocator),
            .available = std.ArrayList(bool).init(allocator),
            .mutex = std.Thread.Mutex{},
            .max_connections = 4, // Keep 4 persistent connections
        };
    }
    
    pub fn deinit(self: *Self) void {
        for (self.connections.items) |client| {
            client.deinit();
            self.allocator.destroy(client);
        }
        self.connections.deinit();
        self.available.deinit();
    }
    
    /// Get an available connection from the pool
    pub fn acquire(self: *Self) !*std.http.Client {
        self.mutex.lock();
        defer self.mutex.unlock();
        
        // Find an available connection
        for (self.available.items, 0..) |available, i| {
            if (available) {
                self.available.items[i] = false;
                return self.connections.items[i];
            }
        }
        
        // Create new connection if under limit
        if (self.connections.items.len < self.max_connections) {
            const client = try self.allocator.create(std.http.Client);
            client.* = std.http.Client{ .allocator = self.allocator };
            try self.connections.append(client);
            try self.available.append(false);
            return client;
        }
        
        // Wait for available connection (simple spin wait)
        while (true) {
            self.mutex.unlock();
            std.time.sleep(1 * std.time.ns_per_ms);
            self.mutex.lock();
            
            for (self.available.items, 0..) |available, i| {
                if (available) {
                    self.available.items[i] = false;
                    return self.connections.items[i];
                }
            }
        }
    }
    
    /// Release a connection back to the pool
    pub fn release(self: *Self, client: *std.http.Client) void {
        self.mutex.lock();
        defer self.mutex.unlock();
        
        for (self.connections.items, 0..) |conn, i| {
            if (conn == client) {
                self.available.items[i] = true;
                return;
            }
        }
    }
};