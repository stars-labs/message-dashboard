const std = @import("std");
const types = @import("types.zig");

pub const EventType = enum {
    ModemConnected,
    ModemDisconnected,
    MessageReceived,
    SignalChanged,
    Timer,
};

pub const Event = struct {
    type: EventType,
    modem_id: ?[]const u8 = null,
    data: ?*anyopaque = null,
    timestamp: i64,
};

pub const EventHandler = *const fn (event: Event) void;

/// Event-driven loop for reactive modem monitoring
pub const EventLoop = struct {
    allocator: std.mem.Allocator,
    events: std.fifo.LinearFifo(Event, .Dynamic),
    handlers: std.EnumMap(EventType, std.ArrayList(EventHandler)),
    mutex: std.Thread.Mutex,
    condition: std.Thread.Condition,
    running: std.atomic.Value(bool),
    thread: ?std.Thread = null,
    
    const Self = @This();
    
    pub fn init(allocator: std.mem.Allocator) Self {
        var handlers = std.EnumMap(EventType, std.ArrayList(EventHandler)){};
        inline for (@typeInfo(EventType).@"enum".fields) |field| {
            const event_type = @field(EventType, field.name);
            handlers.put(event_type, std.ArrayList(EventHandler).init(allocator));
        }
        
        return .{
            .allocator = allocator,
            .events = std.fifo.LinearFifo(Event, .Dynamic).init(allocator),
            .handlers = handlers,
            .mutex = std.Thread.Mutex{},
            .condition = std.Thread.Condition{},
            .running = std.atomic.Value(bool).init(false),
        };
    }
    
    pub fn deinit(self: *Self) void {
        self.stop();
        
        // Clean up event queue
        while (self.events.readItem()) |event| {
            if (event.modem_id) |id| {
                self.allocator.free(id);
            }
        }
        self.events.deinit();
        
        // Clean up handlers
        var it = self.handlers.iterator();
        while (it.next()) |entry| {
            entry.value.deinit();
        }
    }
    
    /// Register an event handler
    pub fn on(self: *Self, event_type: EventType, handler: EventHandler) !void {
        self.mutex.lock();
        defer self.mutex.unlock();
        
        if (self.handlers.getPtr(event_type)) |handlers| {
            try handlers.append(handler);
        }
    }
    
    /// Emit an event
    pub fn emit(self: *Self, event: Event) !void {
        self.mutex.lock();
        defer self.mutex.unlock();
        
        // Copy modem_id if present
        var event_copy = event;
        if (event.modem_id) |id| {
            event_copy.modem_id = try self.allocator.dupe(u8, id);
        }
        event_copy.timestamp = std.time.timestamp();
        
        try self.events.writeItem(event_copy);
        self.condition.signal();
    }
    
    /// Start the event loop
    pub fn start(self: *Self) !void {
        if (self.running.swap(true, .acquire)) {
            return; // Already running
        }
        
        self.thread = try std.Thread.spawn(.{}, run, .{self});
    }
    
    /// Stop the event loop
    pub fn stop(self: *Self) void {
        self.running.store(false, .release);
        self.condition.signal();
        
        if (self.thread) |thread| {
            thread.join();
            self.thread = null;
        }
    }
    
    fn run(self: *Self) void {
        std.log.info("Event loop started", .{});
        
        while (self.running.load(.acquire)) {
            self.mutex.lock();
            
            // Wait for events
            while (self.events.count == 0 and self.running.load(.acquire)) {
                self.condition.wait(&self.mutex);
            }
            
            // Process all pending events
            while (self.events.readItem()) |event| {
                self.mutex.unlock();
                self.processEvent(event);
                self.mutex.lock();
                
                // Free modem_id after processing
                if (event.modem_id) |id| {
                    self.allocator.free(id);
                }
            }
            
            self.mutex.unlock();
        }
        
        std.log.info("Event loop stopped", .{});
    }
    
    fn processEvent(self: *Self, event: Event) void {
        // Get handlers for this event type
        const handlers_opt = self.handlers.get(event.type);
        if (handlers_opt) |handlers| {
            for (handlers.items) |handler| {
                handler(event);
            }
        }
    }
    
    /// Create timer events at regular intervals
    pub fn scheduleTimer(self: *Self, interval_ms: u64) !void {
        const timer_thread = try std.Thread.spawn(.{}, timerThread, .{ self, interval_ms });
        timer_thread.detach();
    }
    
    fn timerThread(self: *Self, interval_ms: u64) void {
        while (self.running.load(.acquire)) {
            std.time.sleep(interval_ms * std.time.ns_per_ms);
            
            self.emit(.{
                .type = .Timer,
                .timestamp = std.time.timestamp(),
            }) catch |err| {
                std.log.warn("Failed to emit timer event: {any}", .{err});
            };
        }
    }
};