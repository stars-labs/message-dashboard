const std = @import("std");
const net = std.net;
const http = std.http;
const json = std.json;

// Import modules
const types = @import("types.zig");
const ModemManager = @import("modem_manager.zig").ModemManager;
const WebSocketClient = @import("websocket_client.zig").WebSocketClient;
const ApiClient = @import("api_client.zig").ApiClient;

// Import types
const Config = types.Config;
const Phone = types.Phone;
const Message = types.Message;
const MessageInfo = types.MessageInfo;
const ModemThreadData = types.ModemThreadData;

// Set log level - can be overridden at compile time
pub const std_options: std.Options = .{
    .log_level = if (@import("builtin").mode == .Debug)
        .debug
    else
        .info,
};

// Process a single modem in a separate thread
fn processModemInThread(data: *ModemThreadData) void {
    defer {
        data.allocator.free(data.modem_id);
        data.allocator.destroy(data);
    }

    // Cast modem_manager back to proper type
    const modem_manager = @as(*ModemManager, @ptrCast(@alignCast(data.modem_manager)));

    // Get phone status and signal
    const phone = modem_manager.getSignalInfo(data.modem_id) catch |err| {
        if (err == error.NoIccid) {
            std.log.warn("Thread: Skipping modem {s}: No ICCID found", .{data.modem_id});
        } else {
            std.log.err("Thread: Failed to get signal info for modem {s}: {any}", .{ data.modem_id, err });
        }
        return;
    };

    // Thread-safely add phone to shared list
    data.phone_mutex.lock();
    data.current_phones_shared.append(phone) catch |err| {
        std.log.err("Thread: Failed to add phone to shared list: {any}", .{err});
        data.phone_mutex.unlock();
        return;
    };
    data.phone_mutex.unlock();

    // Get messages with SMS IDs
    const msg_result = modem_manager.getMessages(data.modem_id) catch |err| {
        std.log.err("Thread: Failed to get messages for modem {s}: {any}", .{ data.modem_id, err });
        return;
    };

    // Thread-safely add messages to shared lists
    data.message_mutex.lock();
    defer data.message_mutex.unlock();

    for (msg_result.messages, 0..) |message, i| {
        // Update message phone_iccid to use the actual ICCID
        var updated_message = message;
        data.allocator.free(message.phone_iccid);
        updated_message.phone_iccid = data.allocator.dupe(u8, phone.iccid) catch |err| {
            std.log.err("Thread: Failed to duplicate ICCID: {any}", .{err});
            continue;
        };
        
        data.new_messages_shared.append(updated_message) catch |err| {
            std.log.err("Thread: Failed to add message to shared list: {any}", .{err});
            continue;
        };
        
        data.new_message_infos_shared.append(.{
            .modem_id = data.modem_id,
            .sms_id = msg_result.sms_ids[i],
            .message = updated_message,
        }) catch |err| {
            std.log.err("Thread: Failed to add message info to shared list: {any}", .{err});
            continue;
        };
    }

    std.log.info("Thread: Processed modem {s} - found {d} messages", .{ data.modem_id, msg_result.messages.len });
}

pub fn main() !void {
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    const allocator = gpa.allocator();

    // Read configuration from environment
    const config = Config{
        .api_url = std.posix.getenv("SMS_API_URL") orelse "https://sexy.qzz.io/",
        .api_key = std.posix.getenv("SMS_API_KEY") orelse "",
        .modem_ids = &[_][]const u8{}, // Will be auto-detected
        .device_id = std.posix.getenv("SMS_DEVICE_ID") orelse "orange-pi-001",
        .daemon_version = "2.0.0", // Updated version for refactored code
        .upload_interval = if (std.posix.getenv("SMS_UPLOAD_INTERVAL")) |val| std.fmt.parseInt(u32, val, 10) catch 60 else 60,
        .poll_interval = 2, // Fast polling for real-time detection
        .heartbeat_interval = 60,
        .reconnect_delay = 5,
    };

    if (config.api_key.len == 0) {
        std.log.err("SMS_API_KEY environment variable is required", .{});
        return error.MissingApiKey;
    }

    std.log.info("🚀 Starting SMS Dashboard Daemon v{s}", .{config.daemon_version});
    std.log.info("API URL: {s}", .{config.api_url});

    // Initialize components
    var modem_manager = ModemManager.init(allocator);
    var api_client = ApiClient.init(allocator, config);
    defer api_client.deinit();

    var websocket_client = WebSocketClient.init(allocator, config);
    defer websocket_client.deinit();

    // Connect to WebSocket
    websocket_client.connect() catch |err| {
        std.log.err("Failed to connect to WebSocket: {any}", .{err});
        std.log.info("Continuing with HTTP API fallback", .{});
    };

    // Start WebSocket listener thread if connected
    var listener_thread: ?std.Thread = null;
    if (websocket_client.running) {
        listener_thread = try std.Thread.spawn(.{}, WebSocketClient.messageListenLoop, .{&websocket_client});
    }
    defer if (listener_thread) |thread| thread.join();

    // Track phone states for change detection
    var last_phone_states = std.ArrayList(Phone).init(allocator);
    defer {
        for (last_phone_states.items) |phone| {
            if (phone.number) |num| allocator.free(num);
            if (phone.country) |c| allocator.free(c);
            if (phone.flag) |f| allocator.free(f);
            if (phone.carrier) |c| allocator.free(c);
            if (phone.operator_name) |o| allocator.free(o);
            if (phone.operator_id) |o| allocator.free(o);
            if (phone.imei) |i| allocator.free(i);
            if (phone.access_tech) |a| allocator.free(a);
            allocator.free(phone.iccid);
        }
        last_phone_states.deinit();
    }

    var initial_upload_done = false;

    // Thread-safe structures for multi-threaded polling
    var phone_mutex = std.Thread.Mutex{};
    var message_mutex = std.Thread.Mutex{};
    
    // Shared data structures
    var current_phones_shared = std.ArrayList(Phone).init(allocator);
    var new_messages_shared = std.ArrayList(Message).init(allocator);
    var new_message_infos_shared = std.ArrayList(MessageInfo).init(allocator);
    defer current_phones_shared.deinit();
    defer new_messages_shared.deinit();
    defer new_message_infos_shared.deinit();

    std.log.info("Starting multi-threaded daemon with faster polling", .{});

    var last_heartbeat_time: i64 = std.time.timestamp();

    // Main event loop
    while (true) {
        // Check if WebSocket connection is still alive
        if (!websocket_client.running or websocket_client.connection == null) {
            std.log.info("WebSocket connection lost, attempting to reconnect...", .{});
            websocket_client.disconnect();
            const reconnect_ns = @as(u64, config.reconnect_delay) * std.time.ns_per_s;
            std.time.sleep(reconnect_ns); // Wait before reconnecting

            websocket_client.connect() catch |err| {
                std.log.err("Failed to reconnect WebSocket: {any}", .{err});
                const long_wait_ns = @as(u64, 30) * std.time.ns_per_s;
                std.time.sleep(long_wait_ns); // Wait longer before next attempt
                continue;
            };

            if (!websocket_client.authenticated) {
                std.log.err("Failed to authenticate after reconnection", .{});
                const auth_wait_ns = @as(u64, 30) * std.time.ns_per_s;
                std.time.sleep(auth_wait_ns);
                continue;
            }

            std.log.info("WebSocket reconnected successfully", .{});
            last_heartbeat_time = std.time.timestamp();
        }

        // Get list of modems
        const modems = try modem_manager.getModemList();
        defer {
            for (modems) |modem| {
                allocator.free(modem);
            }
            allocator.free(modems);
        }

        // Thread-safe data structures for collecting results
        phone_mutex.lock();
        current_phones_shared.clearRetainingCapacity();
        phone_mutex.unlock();
        
        message_mutex.lock();
        new_messages_shared.clearRetainingCapacity();
        new_message_infos_shared.clearRetainingCapacity();
        message_mutex.unlock();

        // Process modems in parallel for faster detection
        if (modems.len > 0) {
            var threads = try allocator.alloc(std.Thread, modems.len);
            defer allocator.free(threads);

            // Start one thread per modem for parallel processing
            for (modems, 0..) |modem_id, i| {
                const thread_data = try allocator.create(ModemThreadData);
                thread_data.* = .{
                    .modem_id = try allocator.dupe(u8, modem_id),
                    .allocator = allocator,
                    .modem_manager = @as(*anyopaque, @ptrCast(&modem_manager)),
                    .phone_mutex = &phone_mutex,
                    .message_mutex = &message_mutex,
                    .current_phones_shared = &current_phones_shared,
                    .new_messages_shared = &new_messages_shared,
                    .new_message_infos_shared = &new_message_infos_shared,
                };
                
                threads[i] = try std.Thread.spawn(.{}, processModemInThread, .{thread_data});
            }

            // Wait for all threads to complete
            for (threads) |thread| {
                thread.join();
            }
        }

        // Copy results from shared structures to local ones
        var current_phones = std.ArrayList(Phone).init(allocator);
        var all_messages = std.ArrayList(Message).init(allocator);
        defer current_phones.deinit();
        defer all_messages.deinit();

        var message_infos = std.ArrayList(MessageInfo).init(allocator);
        defer message_infos.deinit();

        phone_mutex.lock();
        try current_phones.appendSlice(current_phones_shared.items);
        phone_mutex.unlock();

        message_mutex.lock();
        try all_messages.appendSlice(new_messages_shared.items);
        try message_infos.appendSlice(new_message_infos_shared.items);
        message_mutex.unlock();

        // Add test phone data when no modems are found (for debugging)
        if (modems.len == 0) {
            if (!initial_upload_done) {
                std.log.info("No modems found, adding test phone data for debugging", .{});
                const test_phone = Phone{
                    .iccid = "89860040191833946266",
                    .status = "offline",
                    .signal = 0,
                    .number = "+1234567890",
                    .country = "US",
                    .carrier = "Test Carrier",
                };
                try current_phones.append(test_phone);
            }
        }

        // Check if phone states have changed or first upload
        var phones_changed = !initial_upload_done;
        if (initial_upload_done and current_phones.items.len == last_phone_states.items.len) {
            for (current_phones.items, 0..) |phone, i| {
                if (i < last_phone_states.items.len) {
                    const last_phone = last_phone_states.items[i];
                    if (!std.mem.eql(u8, phone.iccid, last_phone.iccid) or
                        !std.mem.eql(u8, phone.status, last_phone.status) or
                        phone.signal != last_phone.signal)
                    {
                        phones_changed = true;
                        break;
                    }
                }
            }
        } else if (current_phones.items.len != last_phone_states.items.len) {
            phones_changed = true;
        }

        // Upload phone status only if changed
        if (phones_changed and current_phones.items.len > 0) {
            if (websocket_client.authenticated) {
                std.log.info("Phone states changed, uploading {d} phones", .{current_phones.items.len});
                websocket_client.sendPhoneUpdate(current_phones.items) catch |err| {
                    std.log.err("Failed to send phone update via WebSocket: {any}", .{err});
                };

                // Update last known states
                last_phone_states.clearRetainingCapacity();
                for (current_phones.items) |phone| {
                    try last_phone_states.append(phone);
                }
                initial_upload_done = true;
            } else {
                std.log.err("WebSocket not connected, cannot send phone updates", .{});
            }
        }

        // Upload messages if any
        if (all_messages.items.len > 0) {
            if (websocket_client.authenticated) {
                std.log.info("Found {d} new messages, uploading...", .{all_messages.items.len});
                const upload_id = try websocket_client.sendMessageUpload(all_messages.items, message_infos.items);
                std.log.info("📤 Messages sent with upload ID: {s}", .{upload_id});
                allocator.free(upload_id);
            } else {
                std.log.err("WebSocket not connected, cannot send messages", .{});
            }
        }

        // Send heartbeat if needed
        const current_time = std.time.timestamp();
        const current_safe = @as(u64, @intCast(if (current_time > 0) current_time else 0));
        const last_safe = @as(u64, @intCast(if (last_heartbeat_time > 0) last_heartbeat_time else 0));

        const time_diff = if (current_safe > last_safe) current_safe - last_safe else 0;

        if (time_diff >= 30) { // Send heartbeat every 30 seconds
            std.log.info("Sending heartbeat (time since last: {d}s)", .{time_diff});

            const id = try websocket_client.generateMessageId();
            defer allocator.free(id);

            const timestamp = try websocket_client.formatTimestamp();
            defer allocator.free(timestamp);

            const heartbeat_message = try std.fmt.allocPrint(allocator,
                \\{{"type":"heartbeat","id":"{s}","timestamp":"{s}","data":{{"uptime":{d},"device_id":"{s}"}}}}
            , .{ id, timestamp, time_diff, config.device_id });
            defer allocator.free(heartbeat_message);

            websocket_client.sendWebSocketMessage(heartbeat_message) catch |err| {
                std.log.err("Failed to send heartbeat: {any}", .{err});
            };

            std.log.info("Sent heartbeat", .{});
            last_heartbeat_time = current_time;
        }

        // Clean up any stale upload tracking
        websocket_client.cleanupStaleUploads();

        // Sleep for polling interval
        const sleep_ns = @as(u64, config.poll_interval) * std.time.ns_per_s;
        std.time.sleep(sleep_ns);
    }
}