const std = @import("std");
const ModemManager = @import("modem_manager.zig").ModemManager;
const ApiClient = @import("api_client.zig").ApiClient;
const types = @import("types.zig");

const MODEM_CHECK_INTERVAL_MS = 5000; // Check each modem every 5 seconds
const API_SYNC_INTERVAL_MS = 10000;   // Sync to API every 10 seconds

fn notifySystemd(message: []const u8) void {
    var process = std.process.Child.init(&[_][]const u8{ "systemd-notify", message }, std.heap.page_allocator);
    process.stdin_behavior = .Ignore;
    process.stdout_behavior = .Ignore;
    process.stderr_behavior = .Ignore;
    _ = process.spawnAndWait() catch return;
}

pub fn main() !void {
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    const allocator = gpa.allocator();

    // Get API configuration from environment
    const api_url = std.posix.getenv("SMS_API_URL") orelse "http://localhost:8787";
    const api_key = std.posix.getenv("SMS_API_KEY") orelse {
        std.log.err("SMS_API_KEY environment variable not set", .{});
        return error.MissingApiKey;
    };

    std.log.info("🚀 Starting SMS daemon (SIMPLE single-threaded version - NO CONCURRENCY BUGS)", .{});
    std.log.info("📡 API URL: {s}", .{api_url});

    // Initialize modem manager
    var modem_manager = ModemManager.init(allocator);
    defer modem_manager.deinit();

    // Initialize API client
    const config = types.Config{
        .api_url = api_url,
        .api_key = api_key,
    };

    // Initialize API client
    var api_client = ApiClient.init(allocator, config);
    defer api_client.deinit();
    defer api_client.deinit();

    // Notify systemd we're ready
    if (std.posix.getenv("NOTIFY_SOCKET")) |_| {
        notifySystemd("READY=1");
        std.log.info("🔔 Notified systemd that daemon is ready", .{});
    }

    // Build initial list of valid modems
    var valid_modems = std.ArrayList([]const u8).init(allocator);
    defer {
        for (valid_modems.items) |modem| allocator.free(modem);
        valid_modems.deinit();
    }

    std.log.info("🔄 Building valid modem cache", .{});
    const all_modems = modem_manager.listModems() catch &[_][]const u8{};
    defer {
        for (all_modems) |modem| allocator.free(modem);
        allocator.free(all_modems);
    }

    for (all_modems) |modem_id| {
        const iccid_opt = modem_manager.getIccid(modem_id) catch continue;
        if (iccid_opt) |iccid| {
            allocator.free(iccid);
            try valid_modems.append(try allocator.dupe(u8, modem_id));
            std.log.info("✅ Cached modem {s} as valid", .{modem_id});
        }
    }

    std.log.info("🚀 Starting main loop with {d} modems (SIMPLE MODE)", .{valid_modems.items.len});

    var last_api_sync: i64 = 0;
    var last_cache_refresh: i64 = 0;
    var cycle_count: u64 = 0;

    // Main event loop - simple and sequential (NO THREADS)
    while (true) {
        const start_time = std.time.milliTimestamp();
        cycle_count += 1;

        var messages_found: usize = 0;

        // Check each modem sequentially (NO RACE CONDITIONS)
        for (valid_modems.items) |modem_id| {
            // Check for new messages
            const messages = modem_manager.getNewMessages(modem_id) catch |err| {
                std.log.debug("Failed to check modem {s}: {any}", .{ modem_id, err });
                continue;
            };
            defer {
                for (messages) |*msg| {
                    allocator.free(msg.modem_id);
                    allocator.free(msg.sms_id);
                    allocator.free(msg.message.phone_iccid);
                    allocator.free(msg.message.phone_number);
                    allocator.free(msg.message.content);
                    allocator.free(msg.message.timestamp);
                }
                allocator.free(messages);
            }

            if (messages.len > 0) {
                messages_found += messages.len;
                std.log.info("📨 Found {d} messages from modem {s}", .{ messages.len, modem_id });
                
                // Upload messages immediately
                for (messages) |msg| {
                    api_client.uploadMessage(msg.message) catch |err| {
                        std.log.err("Failed to upload message from {s}: {any}", .{ modem_id, err });
                        continue;
                    };
                    std.log.info("✅ Uploaded message from {s}", .{modem_id});
                }
            }
        }

        // Sync device status to API periodically
        const now = std.time.milliTimestamp();
        if (now - last_api_sync > API_SYNC_INTERVAL_MS) {
            std.log.debug("📤 Syncing device status to API", .{});
            
            var phones = std.ArrayList(types.Phone).init(allocator);
            defer {
                for (phones.items) |*phone| {
                    allocator.free(phone.id);
                    allocator.free(phone.iccid);
                    if (phone.phone_number) |pn| allocator.free(pn);
                    if (phone.operator_name) |op| allocator.free(op);
                    if (phone.manufacturer) |m| allocator.free(m);
                    if (phone.model) |m| allocator.free(m);
                    if (phone.firmware) |f| allocator.free(f);
                    if (phone.hardware) |h| allocator.free(h);
                }
                phones.deinit();
            }

            for (valid_modems.items) |modem_id| {
                const phone = modem_manager.getPhoneData(modem_id) catch continue;
                try phones.append(phone);
            }

            api_client.uploadPhoneData(phones.items) catch |err| {
                std.log.err("Failed to upload phone data: {any}", .{err});
            };
            
            last_api_sync = now;
        }

        // Refresh modem cache every 5 minutes
        if (now - last_cache_refresh > 300000) {
            std.log.info("🔄 Refreshing modem cache", .{});
            
            for (valid_modems.items) |modem| allocator.free(modem);
            valid_modems.clearRetainingCapacity();
            
            const current_modems = modem_manager.listModems() catch &[_][]const u8{};
            defer {
                for (current_modems) |modem| allocator.free(modem);
                allocator.free(current_modems);
            }
            
            for (current_modems) |modem_id| {
                const iccid_opt = modem_manager.getIccid(modem_id) catch continue;
                if (iccid_opt) |iccid| {
                    allocator.free(iccid);
                    try valid_modems.append(try allocator.dupe(u8, modem_id));
                }
            }
            
            last_cache_refresh = now;
            std.log.info("🔄 Cache refreshed: {d} valid modems", .{valid_modems.items.len});
        }

        // Log progress every 10 cycles or if messages found
        if (cycle_count % 10 == 0 or messages_found > 0) {
            const elapsed = std.time.milliTimestamp() - start_time;
            if (messages_found > 0) {
                std.log.info("🔍 Cycle {d}: checked {d} modems, found {d} messages in {d}ms", .{ 
                    cycle_count, valid_modems.items.len, messages_found, elapsed 
                });
            } else {
                std.log.info("🔍 Cycle {d}: checked {d} modems in {d}ms", .{ 
                    cycle_count, valid_modems.items.len, elapsed 
                });
            }
        }

        // Sleep until next check interval
        const cycle_duration = std.time.milliTimestamp() - start_time;
        if (cycle_duration < MODEM_CHECK_INTERVAL_MS) {
            const sleep_ms = @as(u64, @intCast(MODEM_CHECK_INTERVAL_MS - cycle_duration));
            std.time.sleep(sleep_ms * std.time.ns_per_ms);
        }
    }
}
