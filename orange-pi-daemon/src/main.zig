const std = @import("std");
const http = std.http;
const json = std.json;
const time = std.time;
const process = std.process;
const net = std.net;

// Import modules
const types = @import("types.zig");
const ModemManager = @import("modem_manager.zig").ModemManager;
const WebSocketClient = @import("websocket_client.zig").WebSocketClient;
const ModemHandler = @import("modem_handler.zig").ModemHandler;

// Re-export types for convenience
const Config = types.Config;
const Message = types.Message;
const Phone = types.Phone;
const MessageInfo = types.MessageInfo;

// Set log level - can be overridden at compile time
pub const std_options: std.Options = .{
    .log_level = if (@import("builtin").mode == .Debug)
        .debug
    else
        .info,
};

pub fn main() !void {
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    const allocator = gpa.allocator();

    // Read configuration from environment or config file
    const config = Config{
        .api_url = std.posix.getenv("SMS_API_URL") orelse "https://sexy.qzz.io",
        .api_key = std.posix.getenv("SMS_API_KEY") orelse "",
        .device_id = std.posix.getenv("SMS_DEVICE_ID") orelse "orange-pi-001",
        .daemon_version = "2.0.0",
    };

    if (config.api_key.len == 0) {
        std.log.err("SMS_API_KEY environment variable not set", .{});
        return;
    }

    // Initialize ModemManager for hardware interface
    var modem_manager = ModemManager.init(allocator);

    // Initialize WebSocket client for bidirectional communication
    var websocket_client = WebSocketClient.init(allocator, config);
    defer websocket_client.deinit();

    std.log.info("🚀 Starting SMS dashboard daemon v2.0.0 (multi-threaded)", .{});
    std.log.info("API URL: {s}", .{config.api_url});

    // Connect to WebSocket server
    try websocket_client.connect();

    if (!websocket_client.authenticated) {
        std.log.err("Failed to authenticate with WebSocket server", .{});
        return;
    }

    // Create modem handlers map
    var modem_handlers = std.StringHashMap(*ModemHandler).init(allocator);
    defer {
        var it = modem_handlers.iterator();
        while (it.next()) |entry| {
            entry.value_ptr.*.deinit();
        }
        modem_handlers.deinit();
    }

    std.log.info("🎯 Starting multi-threaded event-driven daemon", .{});

    var last_heartbeat_time: i64 = std.time.timestamp();
    var last_modem_check: i64 = std.time.timestamp();

    while (true) {
        // Check if WebSocket connection is still alive
        if (!websocket_client.running or websocket_client.connection == null) {
            std.log.info("WebSocket connection lost, attempting to reconnect...", .{});
            websocket_client.disconnect();
            std.time.sleep(5 * std.time.ns_per_s); // Wait before reconnecting

            websocket_client.connect() catch |err| {
                std.log.err("Failed to reconnect WebSocket: {any}", .{err});
                std.time.sleep(30 * std.time.ns_per_s); // Wait longer before next attempt
                continue;
            };

            if (!websocket_client.authenticated) {
                std.log.err("Failed to authenticate after reconnection", .{});
                std.time.sleep(30 * std.time.ns_per_s);
                continue;
            }

            std.log.info("✅ WebSocket reconnected successfully", .{});
            last_heartbeat_time = std.time.timestamp();
        }
        
        // Check for new modems periodically (every 30 seconds)
        const current_time = std.time.timestamp();
        if (current_time - last_modem_check >= 30) {
            last_modem_check = current_time;
            
            // Get list of modems
            const modems = try modem_manager.getModemList();
            defer {
                for (modems) |modem| {
                    allocator.free(modem);
                }
                allocator.free(modems);
            }

            std.log.info("🔍 Found {d} modems", .{modems.len});

            // Start handlers for new modems
            for (modems) |modem_id| {
                if (!modem_handlers.contains(modem_id)) {
                    // Create new handler for this modem
                    const handler = try ModemHandler.init(
                        allocator,
                        modem_id,
                        &modem_manager,
                        &websocket_client,
                    );
                    
                    try handler.start();
                    try modem_handlers.put(try allocator.dupe(u8, modem_id), handler);
                    
                    std.log.info("🚀 Started handler thread for new modem: {s}", .{modem_id});
                }
            }

            // Stop handlers for removed modems
            var to_remove = std.ArrayList([]const u8).init(allocator);
            defer to_remove.deinit();
            
            var it = modem_handlers.iterator();
            while (it.next()) |entry| {
                var found = false;
                for (modems) |modem_id| {
                    if (std.mem.eql(u8, entry.key_ptr.*, modem_id)) {
                        found = true;
                        break;
                    }
                }
                if (!found) {
                    try to_remove.append(entry.key_ptr.*);
                }
            }
            
            for (to_remove.items) |modem_id| {
                if (modem_handlers.fetchRemove(modem_id)) |entry| {
                    entry.value.deinit();
                    allocator.free(entry.key);
                    std.log.info("🛑 Stopped handler thread for removed modem: {s}", .{modem_id});
                }
            }
        }

        // All message processing is now handled by per-modem threads
        // Main thread only manages heartbeats and modem detection

        // Send heartbeat safely with overflow protection
        const current_heartbeat_time = std.time.timestamp();
        if (current_heartbeat_time - last_heartbeat_time >= 30) { // Send heartbeat every 30 seconds
            const time_diff = current_heartbeat_time - last_heartbeat_time;
            std.log.info("💓 Sending heartbeat (time since last: {d}s)", .{time_diff});

            const id = try websocket_client.generateMessageId();
            defer allocator.free(id);

            const timestamp = try websocket_client.formatTimestamp();
            defer allocator.free(timestamp);

            // Include active modem count in heartbeat
            const active_modems = modem_handlers.count();
            const heartbeat_message = try std.fmt.allocPrint(allocator,
                \\{{"type":"heartbeat","id":"{s}","timestamp":"{s}","data":{{"uptime":{d},"device_id":"{s}","active_modems":{d}}}}}
            , .{ id, timestamp, time_diff, config.device_id, active_modems });
            defer allocator.free(heartbeat_message);

            websocket_client.sendWebSocketMessage(heartbeat_message) catch |err| {
                std.log.err("Failed to send heartbeat: {any}", .{err});
            };

            std.log.info("💓 Sent heartbeat with {d} active modems", .{active_modems});
            last_heartbeat_time = current_heartbeat_time;
        }

        // Clean up any stale upload tracking (uploads that never got confirmed)
        websocket_client.cleanupStaleUploads();

        // Short sleep to prevent busy-waiting
        std.time.sleep(1 * std.time.ns_per_s); // 1 second main loop interval
    }
}