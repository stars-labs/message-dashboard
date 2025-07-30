const std = @import("std");
const utils = @import("utils.zig");
const types = @import("types.zig");
const ModemManager = @import("modem_manager.zig").ModemManager;
const ApiClient = @import("api_client.zig").ApiClient;
const SignalCache = @import("signal_cache.zig").SignalCache;
const MessageQueue = @import("message_queue.zig").MessageQueue;
const worker_threads = @import("worker_threads.zig");

// Configure logging - will be overridden by LOG_LEVEL env var if set
pub const std_options: std.Options = .{
    .log_level = .debug,
};

// Custom log function to ensure debug logs work in production
pub fn log(
    comptime message_level: std.log.Level,
    comptime scope: @TypeOf(.enum_literal),
    comptime format: []const u8,
    args: anytype,
) void {
    // Get log level from environment variable if available
    const env_level = std.process.getEnvVarOwned(std.heap.page_allocator, "LOG_LEVEL") catch null;
    defer if (env_level) |l| std.heap.page_allocator.free(l);
    
    const runtime_level: std.log.Level = if (env_level) |level_str| blk: {
        if (std.mem.eql(u8, level_str, "debug")) break :blk .debug;
        if (std.mem.eql(u8, level_str, "info")) break :blk .info;
        if (std.mem.eql(u8, level_str, "warn")) break :blk .warn;
        if (std.mem.eql(u8, level_str, "err")) break :blk .err;
        break :blk std_options.log_level;
    } else std_options.log_level;
    
    // Only log if the message level is at or above the runtime level
    if (@intFromEnum(message_level) < @intFromEnum(runtime_level)) return;
    
    const level_txt = comptime message_level.asText();
    const prefix = if (scope == .default) ": " else "(" ++ @tagName(scope) ++ "): ";
    
    const stderr = std.io.getStdErr().writer();
    
    std.debug.lockStdErr();
    defer std.debug.unlockStdErr();
    
    stderr.print("{s}" ++ prefix ++ format ++ "\n", .{level_txt} ++ args) catch {};
}

const ModemCheckResult = struct {
    modem_id: []const u8,
    messages: []types.MessageInfo,
    success: bool,
    allocator: std.mem.Allocator,
    
    pub fn deinit(self: *ModemCheckResult) void {
        if (self.success) {
            for (self.messages) |*msg| {
                self.allocator.free(msg.modem_id);
                self.allocator.free(msg.sms_id);
                self.allocator.free(msg.message.phone_iccid);
                self.allocator.free(msg.message.phone_number);
                self.allocator.free(msg.message.content);
                self.allocator.free(msg.message.timestamp);
            }
            self.allocator.free(self.messages);
        }
    }
};

const ParallelContext = struct {
    allocator: std.mem.Allocator,
    modem_manager: *ModemManager,
    message_queue: *MessageQueue,
    results_mutex: std.Thread.Mutex,
    results: *std.ArrayList(ModemCheckResult),
};

fn checkModemMessages(context: *ParallelContext, modem_id: []const u8) void {
    var result = ModemCheckResult{
        .modem_id = modem_id,
        .messages = &[_]types.MessageInfo{},
        .success = false,
        .allocator = context.allocator,
    };
    
    // Check messages for this modem
    const new_messages = context.modem_manager.getNewMessages(modem_id) catch |err| {
        std.log.debug("Failed to get messages from modem {s}: {any}", .{ modem_id, err });
        
        // Add failed result
        context.results_mutex.lock();
        defer context.results_mutex.unlock();
        context.results.append(result) catch {};
        return;
    };
    
    result.messages = new_messages;
    result.success = true;
    
    // Add result to shared list
    context.results_mutex.lock();
    defer context.results_mutex.unlock();
    context.results.append(result) catch |err| {
        std.log.err("Failed to store result: {any}", .{err});
        result.deinit();
    };
}

pub fn main() !void {
    const stdout = std.io.getStdOut().writer();
    try stdout.print("📱 Orange Pi SMS Dashboard Daemon v1.31.0\n", .{});
    
    // Initialize allocator
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    const allocator = gpa.allocator();
    
    // Load configuration
    const config = try utils.loadConfig(allocator);
    defer allocator.free(config.api_url);
    defer allocator.free(config.api_key);
    
    std.log.info("🔧 Configuration loaded - API: {s}", .{config.api_url});
    std.log.info("📊 Message checking: parallel (ultra-fast)", .{});
    std.log.info("📊 Phone updates: every {}s", .{config.check_interval});
    std.log.info("📊 Signal checks: every {}s", .{config.signal_check_interval});
    std.log.info("📤 SMS sending: enabled (polling every 5s)", .{});
    
    // Initialize components
    var modem_manager = ModemManager.init(allocator);
    defer modem_manager.deinit();
    
    var api_client = ApiClient.init(allocator, config);
    defer api_client.deinit();
    
    var signal_cache = SignalCache.init(allocator);
    defer signal_cache.deinit();
    
    var message_queue = MessageQueue.init(allocator);
    defer message_queue.deinit();
    
    // Shared exit flag
    var should_exit = std.atomic.Value(bool).init(false);
    
    // Create worker context
    var context = worker_threads.WorkerContext{
        .allocator = allocator,
        .config = config,
        .message_queue = &message_queue,
        .modem_manager = &modem_manager,
        .api_client = &api_client,
        .signal_cache = &signal_cache,
        .should_exit = &should_exit,
    };
    
    // Thread wrapper to handle errors
    const ThreadWrapper = struct {
        fn messageWrapper(ctx: *worker_threads.WorkerContext) void {
            worker_threads.messageProcessorThread(ctx) catch |err| {
                std.log.err("Message processor thread crashed: {any}", .{err});
            };
        }
        fn phoneWrapper(ctx: *worker_threads.WorkerContext) void {
            worker_threads.phoneStatusThread(ctx) catch |err| {
                std.log.err("Phone status thread crashed: {any}", .{err});
            };
        }
        fn signalWrapper(ctx: *worker_threads.WorkerContext) void {
            worker_threads.signalMonitorThread(ctx) catch |err| {
                std.log.err("Signal monitor thread crashed: {any}", .{err});
            };
        }
        fn smsWrapper(ctx: *worker_threads.WorkerContext) void {
            worker_threads.smsSenderThread(ctx) catch |err| {
                std.log.err("SMS sender thread crashed: {any}", .{err});
            };
        }
    };
    
    // Start worker threads
    const message_thread = try std.Thread.spawn(.{}, ThreadWrapper.messageWrapper, .{&context});
    const phone_thread = try std.Thread.spawn(.{}, ThreadWrapper.phoneWrapper, .{&context});
    const signal_thread = try std.Thread.spawn(.{}, ThreadWrapper.signalWrapper, .{&context});
    const sms_thread = try std.Thread.spawn(.{}, ThreadWrapper.smsWrapper, .{&context});
    
    // Get initial modem list and build cache of valid modems
    std.log.info("🔄 Building valid modem cache", .{});
    var valid_modems = std.ArrayList([]const u8).init(allocator);
    defer {
        for (valid_modems.items) |modem_id| {
            allocator.free(modem_id);
        }
        valid_modems.deinit();
    }
    
    const all_modems = modem_manager.listModems() catch &[_][]const u8{};
    defer {
        for (all_modems) |modem| allocator.free(modem);
        allocator.free(all_modems);
    }
    
    for (all_modems) |modem_id| {
        if (modem_manager.problematic_modems.contains(modem_id)) continue;
        
        // Quick check if modem has SIM
        const iccid_opt = modem_manager.getIccid(modem_id) catch continue;
        if (iccid_opt) |iccid| {
            allocator.free(iccid);
            try valid_modems.append(try allocator.dupe(u8, modem_id));
            std.log.info("✅ Cached modem {s} as valid", .{modem_id});
        }
    }
    
    std.log.info("🚀 Starting parallel message checking with {d} modems", .{valid_modems.items.len});
    
    // Main loop with parallel checking
    var cycle_count: u64 = 0;
    var last_cache_refresh: i64 = std.time.timestamp();
    
    while (true) {
        cycle_count += 1;
        const cycle_start = std.time.nanoTimestamp();
        
        // Refresh cache every 5 minutes
        if (std.time.timestamp() - last_cache_refresh > 300) {
            std.log.info("🔄 Refreshing modem cache", .{});
            
            // Clear old cache
            for (valid_modems.items) |old_modem| {
                allocator.free(old_modem);
            }
            valid_modems.clearAndFree();
            
            // Rebuild cache
            const current_modems = modem_manager.listModems() catch &[_][]const u8{};
            defer {
                for (current_modems) |modem| allocator.free(modem);
                allocator.free(current_modems);
            }
            
            for (current_modems) |modem_id| {
                if (modem_manager.problematic_modems.contains(modem_id)) continue;
                
                const iccid_opt = modem_manager.getIccid(modem_id) catch continue;
                if (iccid_opt) |iccid| {
                    allocator.free(iccid);
                    try valid_modems.append(try allocator.dupe(u8, modem_id));
                }
            }
            
            last_cache_refresh = std.time.timestamp();
            std.log.info("🔄 Cache refreshed: {d} valid modems", .{valid_modems.items.len});
        }
        
        // Create shared results storage
        var results = std.ArrayList(ModemCheckResult).init(allocator);
        defer {
            for (results.items) |*result| {
                result.deinit();
            }
            results.deinit();
        }
        
        var parallel_context = ParallelContext{
            .allocator = allocator,
            .modem_manager = &modem_manager,
            .message_queue = &message_queue,
            .results_mutex = .{},
            .results = &results,
        };
        
        // Spawn threads for parallel checking (limit to reasonable number)
        const max_threads = @min(valid_modems.items.len, 8); // Don't overwhelm ModemManager
        var threads = std.ArrayList(std.Thread).init(allocator);
        defer threads.deinit();
        
        var modem_idx: usize = 0;
        while (modem_idx < valid_modems.items.len) {
            const batch_size = @min(max_threads, valid_modems.items.len - modem_idx);
            
            // Spawn batch of threads
            for (0..batch_size) |i| {
                const idx = modem_idx + i;
                if (idx >= valid_modems.items.len) break;
                
                const thread = try std.Thread.spawn(.{}, checkModemMessages, .{ &parallel_context, valid_modems.items[idx] });
                try threads.append(thread);
            }
            
            // Wait for batch to complete
            for (threads.items) |thread| {
                thread.join();
            }
            threads.clearRetainingCapacity();
            
            modem_idx += batch_size;
        }
        
        // Process all results
        var total_messages: usize = 0;
        for (results.items) |*result| {
            if (result.success) {
                total_messages += result.messages.len;
                
                // Queue messages for processing
                for (result.messages) |msg| {
                    message_queue.push(msg) catch |err| {
                        std.log.err("Failed to queue message: {any}", .{err});
                    };
                }
            }
        }
        
        const cycle_end = std.time.nanoTimestamp();
        const cycle_time_ms = @divFloor(cycle_end - cycle_start, std.time.ns_per_ms);
        
        if (total_messages > 0) {
            std.log.info("📬 Found {d} messages in cycle {d} ({d}ms) (queue: {d})", .{
                total_messages, cycle_count, cycle_time_ms, message_queue.size()
            });
        }
        
        // Performance stats every 20 cycles
        if (cycle_count % 20 == 0) {
            const avg_ms_per_modem = if (valid_modems.items.len > 0) 
                @divFloor(cycle_time_ms, valid_modems.items.len) else 0;
            std.log.info("⚡ Cycle {d}: {d}ms total, ~{d}ms per modem, {d} modems", .{
                cycle_count, cycle_time_ms, avg_ms_per_modem, valid_modems.items.len
            });
        }
        
        // Small delay to prevent overwhelming the system
        std.time.sleep(100 * std.time.ns_per_ms); // 100ms between cycles
    }
    
    // Cleanup
    should_exit.store(true, .release);
    message_thread.join();
    phone_thread.join();
    signal_thread.join();
    sms_thread.join();
}