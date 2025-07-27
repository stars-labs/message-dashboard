const std = @import("std");
const time = std.time;
const process = std.process;
const json = std.json;

// Configuration
const Config = struct {
    api_url: []const u8,
    api_key: []const u8,
    device_id: []const u8,
    daemon_version: []const u8,
    poll_interval: u32,
    upload_interval: u32,
    heartbeat_interval: u32,
};

// Data structures
const Message = struct {
    id: ?[]const u8 = null,
    phone_iccid: []const u8,
    phone_number: []const u8,
    content: []const u8,
    timestamp: []const u8,
};

const Phone = struct {
    number: ?[]const u8 = null,
    country: ?[]const u8 = null,
    flag: ?[]const u8 = null,
    carrier: ?[]const u8 = null,
    status: []const u8,
    signal: ?u8 = null,
    iccid: []const u8,
    rssi: ?f32 = null,
    rsrq: ?f32 = null,
    rsrp: ?f32 = null,
    snr: ?f32 = null,
    operator_name: ?[]const u8 = null,
    operator_id: ?[]const u8 = null,
    imei: ?[]const u8 = null,
    access_tech: ?[]const u8 = null,
};

const MessageInfo = struct {
    modem_id: []const u8,
    sms_id: []const u8,
    message: Message,
};

// Set log level
pub const std_options: std.Options = .{
    .log_level = .info,
};

// HTTP API Client
const ApiClient = struct {
    allocator: std.mem.Allocator,
    config: Config,

    pub fn init(allocator: std.mem.Allocator, config: Config) ApiClient {
        return .{ .allocator = allocator, .config = config };
    }

    pub fn uploadPhones(self: ApiClient, phones: []const Phone) !void {
        if (phones.len == 0) return;

        const phones_json = try json.stringifyAlloc(self.allocator, phones, .{ .emit_null_optional_fields = false });
        defer self.allocator.free(phones_json);

        const payload = try std.fmt.allocPrint(self.allocator, "{{\"phones\":{s}}}", .{phones_json});
        defer self.allocator.free(payload);

        try self.makeRequest("/phones", payload);
        std.log.info("✅ Uploaded {d} phones via HTTP API", .{phones.len});
    }

    pub fn uploadMessages(self: ApiClient, messages: []const Message) !void {
        if (messages.len == 0) return;

        std.log.info("📱 Preparing to upload {d} messages:", .{messages.len});
        for (messages, 0..) |msg, i| {
            std.log.info("  Message {d}: phone_iccid={s}, phone_number={s}, content_len={d}", .{ i, msg.phone_iccid, msg.phone_number, msg.content.len });
        }

        const messages_json = try json.stringifyAlloc(self.allocator, messages, .{ .emit_null_optional_fields = false });
        defer self.allocator.free(messages_json);
        
        std.log.info("📄 Messages JSON payload length: {d} bytes", .{messages_json.len});

        const payload = try std.fmt.allocPrint(self.allocator, "{{\"messages\":{s}}}", .{messages_json});
        defer self.allocator.free(payload);
        
        std.log.info("📦 Final payload length: {d} bytes", .{payload.len});

        try self.makeRequest("/messages", payload);
        std.log.info("✅ Uploaded {d} messages via HTTP API", .{messages.len});
    }

    fn makeRequest(self: ApiClient, endpoint: []const u8, payload: []const u8) !void {
        const url = try std.fmt.allocPrint(self.allocator, "{s}/api/control{s}", .{ self.config.api_url, endpoint });
        defer self.allocator.free(url);

        // Create temporary file for payload
        const temp_file = "/tmp/sms_payload.json";
        const file = std.fs.cwd().createFile(temp_file, .{}) catch |err| {
            std.log.warn("Failed to create temp file: {any}", .{err});
            return;
        };
        defer file.close();
        defer std.fs.cwd().deleteFile(temp_file) catch {};

        // Write payload to temp file
        file.writeAll(payload) catch |err| {
            std.log.warn("Failed to write payload to temp file: {any}", .{err});
            return;
        };

        // Prepare curl arguments with proper memory management
        const api_key_header = try std.fmt.allocPrint(self.allocator, "X-API-Key: {s}", .{self.config.api_key});
        defer self.allocator.free(api_key_header);
        
        const data_arg = try std.fmt.allocPrint(self.allocator, "@{s}", .{temp_file});
        defer self.allocator.free(data_arg);

        // Use curl for reliable HTTP POST
        const curl_result = std.process.Child.run(.{
            .allocator = self.allocator,
            .argv = &[_][]const u8{
                "curl",
                "-s",
                "-w", "%{http_code}",
                "-X", "POST",
                "-H", "Content-Type: application/json",
                "-H", api_key_header,
                "--data-binary", data_arg,
                url,
            },
        }) catch |err| {
            std.log.warn("Failed to execute curl: {any}", .{err});
            return;
        };
        defer self.allocator.free(curl_result.stdout);
        defer self.allocator.free(curl_result.stderr);

        std.log.info("🌐 Curl result for {s}: exit_code={d}, stdout_len={d}, stderr_len={d}", .{ endpoint, curl_result.term.Exited, curl_result.stdout.len, curl_result.stderr.len });
        
        if (curl_result.stderr.len > 0) {
            std.log.warn("🔧 Curl stderr: {s}", .{curl_result.stderr});
        }
        
        if (curl_result.term.Exited != 0) {
            std.log.warn("❌ Curl failed with exit code: {d}", .{curl_result.term.Exited});
            std.log.warn("❌ Stderr: {s}", .{curl_result.stderr});
            std.log.warn("❌ Stdout: {s}", .{curl_result.stdout});
            return;
        }

        std.log.info("📡 Raw curl response: {s}", .{curl_result.stdout});

        // Check HTTP status code (last 3 characters of stdout)
        if (curl_result.stdout.len >= 3) {
            const status_code = curl_result.stdout[curl_result.stdout.len - 3..];
            std.log.info("📊 HTTP status code: {s}", .{status_code});
            if (!std.mem.eql(u8, status_code, "200")) {
                std.log.warn("❌ HTTP request failed with status: {s}", .{status_code});
                std.log.warn("❌ Response body: {s}", .{curl_result.stdout[0..curl_result.stdout.len - 3]});
            } else {
                std.log.info("✅ HTTP request successful for {s}", .{endpoint});
            }
        } else {
            std.log.warn("⚠️ Unexpected curl response format, length: {d}", .{curl_result.stdout.len});
        }
    }
};

// Modem Manager
const ModemManager = struct {
    allocator: std.mem.Allocator,

    pub fn init(allocator: std.mem.Allocator) ModemManager {
        return .{ .allocator = allocator };
    }

    pub fn getModemList(self: ModemManager) ![][]const u8 {
        var result = std.ArrayList([]const u8).init(self.allocator);
        defer result.deinit();

        const mmcli_result = try std.process.Child.run(.{
            .allocator = self.allocator,
            .argv = &[_][]const u8{ "mmcli", "-L" },
        });
        defer self.allocator.free(mmcli_result.stdout);
        defer self.allocator.free(mmcli_result.stderr);

        var lines = std.mem.tokenizeScalar(u8, mmcli_result.stdout, '\n');
        while (lines.next()) |line| {
            if (std.mem.indexOf(u8, line, "/Modem/")) |pos| {
                const start = pos + 7;
                var end = start;
                while (end < line.len and line[end] != ' ') : (end += 1) {}
                const modem_id = try self.allocator.dupe(u8, line[start..end]);
                try result.append(modem_id);
            }
        }

        return result.toOwnedSlice();
    }

    pub fn getIccid(self: ModemManager, modem_id: []const u8) !?[]const u8 {
        const modem_result = try std.process.Child.run(.{
            .allocator = self.allocator,
            .argv = &[_][]const u8{ "mmcli", "-m", modem_id },
        });
        defer self.allocator.free(modem_result.stdout);
        defer self.allocator.free(modem_result.stderr);

        var sim_number: ?[]const u8 = null;
        var lines = std.mem.tokenizeScalar(u8, modem_result.stdout, '\n');
        while (lines.next()) |line| {
            if (std.mem.indexOf(u8, line, "primary sim path:")) |_| {
                if (std.mem.lastIndexOf(u8, line, "/SIM/")) |sim_pos| {
                    const start = sim_pos + 5;
                    var end = start;
                    while (end < line.len and line[end] >= '0' and line[end] <= '9') : (end += 1) {}
                    if (end > start) {
                        sim_number = line[start..end];
                        break;
                    }
                }
            }
        }

        const sim_num = sim_number orelse return null;

        const sim_result = try std.process.Child.run(.{
            .allocator = self.allocator,
            .argv = &[_][]const u8{ "mmcli", "-i", sim_num },
        });
        defer self.allocator.free(sim_result.stdout);
        defer self.allocator.free(sim_result.stderr);

        lines = std.mem.tokenizeScalar(u8, sim_result.stdout, '\n');
        while (lines.next()) |line| {
            if (std.mem.indexOf(u8, line, "iccid:")) |_| {
                const trimmed = std.mem.trim(u8, line, " \t");
                if (std.mem.indexOf(u8, trimmed, ": ")) |pos| {
                    const iccid = std.mem.trim(u8, trimmed[pos + 2 ..], " '\"");
                    if (iccid.len > 0 and !std.mem.eql(u8, iccid, "unknown")) {
                        std.log.warn("Using fallback ICCID {s} for modem {s} (SIM {s})", .{ iccid, modem_id, sim_num });
                        return try self.allocator.dupe(u8, iccid);
                    }
                }
            }
        }

        return null;
    }

    pub fn getPhoneNumber(self: ModemManager, modem_id: []const u8) !?[]const u8 {
        const result = try std.process.Child.run(.{
            .allocator = self.allocator,
            .argv = &[_][]const u8{ "mmcli", "-m", modem_id },
        });
        defer self.allocator.free(result.stdout);
        defer self.allocator.free(result.stderr);

        var lines = std.mem.tokenizeScalar(u8, result.stdout, '\n');
        while (lines.next()) |line| {
            if (std.mem.indexOf(u8, line, "own:")) |_| {
                const trimmed = std.mem.trim(u8, line, " \t");
                if (std.mem.indexOf(u8, trimmed, ": ")) |pos| {
                    const number = std.mem.trim(u8, trimmed[pos + 2 ..], " '\"");
                    if (number.len > 0 and !std.mem.eql(u8, number, "unknown")) {
                        return try self.allocator.dupe(u8, number);
                    }
                }
            }
        }
        return null;
    }

    pub fn getModemState(self: ModemManager, modem_id: []const u8) ![]const u8 {
        const result = try std.process.Child.run(.{
            .allocator = self.allocator,
            .argv = &[_][]const u8{ "mmcli", "-m", modem_id },
        });
        defer self.allocator.free(result.stdout);
        defer self.allocator.free(result.stderr);

        var lines = std.mem.tokenizeScalar(u8, result.stdout, '\n');
        while (lines.next()) |line| {
            if (std.mem.indexOf(u8, line, "state:")) |_| {
                const trimmed = std.mem.trim(u8, line, " \t");
                if (std.mem.indexOf(u8, trimmed, ": ")) |pos| {
                    const state = std.mem.trim(u8, trimmed[pos + 2 ..], " '\"");
                    return try self.allocator.dupe(u8, state);
                }
            }
        }
        return try self.allocator.dupe(u8, "unknown");
    }

    pub fn getNewMessages(self: ModemManager, modem_id: []const u8) ![]MessageInfo {
        const result = try std.process.Child.run(.{
            .allocator = self.allocator,
            .argv = &[_][]const u8{ "mmcli", "-m", modem_id, "--messaging-list-sms" },
        });
        defer self.allocator.free(result.stdout);
        defer self.allocator.free(result.stderr);

        var messages = std.ArrayList(MessageInfo).init(self.allocator);
        defer messages.deinit();

        var lines = std.mem.tokenizeScalar(u8, result.stdout, '\n');
        while (lines.next()) |line| {
            if (std.mem.indexOf(u8, line, "/SMS/")) |pos| {
                const start = pos + 5;
                var end = start;
                while (end < line.len and line[end] != ' ') : (end += 1) {}
                const sms_id_str = line[start..end];

                if (self.getSmsDetails(sms_id_str, modem_id)) |message_info| {
                    try messages.append(message_info);
                } else |_| {
                    continue;
                }
            }
        }

        return messages.toOwnedSlice();
    }

    fn getSmsDetails(self: ModemManager, sms_id: []const u8, modem_id: []const u8) !MessageInfo {
        const result = try std.process.Child.run(.{
            .allocator = self.allocator,
            .argv = &[_][]const u8{ "mmcli", "-s", sms_id },
        });
        defer self.allocator.free(result.stdout);
        defer self.allocator.free(result.stderr);

        var phone_number: ?[]const u8 = null;
        var content: ?[]const u8 = null;
        var timestamp: ?[]const u8 = null;

        const phone_iccid = try self.getIccid(modem_id);
        if (phone_iccid == null) return error.NoIccid;

        var lines = std.mem.tokenizeScalar(u8, result.stdout, '\n');
        while (lines.next()) |line| {
            const trimmed = std.mem.trim(u8, line, " \t");

            if (std.mem.indexOf(u8, trimmed, "number:")) |_| {
                if (std.mem.indexOf(u8, trimmed, ": ")) |pos| {
                    phone_number = try self.allocator.dupe(u8, std.mem.trim(u8, trimmed[pos + 2 ..], " '\""));
                }
            } else if (std.mem.indexOf(u8, trimmed, "text:")) |_| {
                if (std.mem.indexOf(u8, trimmed, ": ")) |pos| {
                    content = try self.allocator.dupe(u8, std.mem.trim(u8, trimmed[pos + 2 ..], " '\""));
                }
            } else if (std.mem.indexOf(u8, trimmed, "timestamp:")) |_| {
                if (std.mem.indexOf(u8, trimmed, ": ")) |pos| {
                    const raw_timestamp = std.mem.trim(u8, trimmed[pos + 2 ..], " '\"");
                    timestamp = try self.formatTimestamp(raw_timestamp);
                }
            }
        }

        if (phone_number == null or content == null or timestamp == null) {
            return error.IncompleteMessage;
        }

        const message = Message{
            .phone_iccid = phone_iccid.?,
            .phone_number = phone_number.?,
            .content = content.?,
            .timestamp = timestamp.?,
        };

        return MessageInfo{
            .modem_id = try self.allocator.dupe(u8, modem_id),
            .sms_id = try self.allocator.dupe(u8, sms_id),
            .message = message,
        };
    }

    fn formatTimestamp(self: ModemManager, raw_timestamp: []const u8) ![]const u8 {
        if (raw_timestamp.len == 0) {
            const now = std.time.timestamp();
            return try std.fmt.allocPrint(self.allocator, "{d}", .{now});
        }

        if (std.mem.endsWith(u8, raw_timestamp, "Z")) {
            return try self.allocator.dupe(u8, raw_timestamp);
        }

        if (std.mem.indexOf(u8, raw_timestamp, "+")) |plus_pos| {
            const base = raw_timestamp[0..plus_pos];
            return try std.fmt.allocPrint(self.allocator, "{s}.000Z", .{base});
        }

        return try std.fmt.allocPrint(self.allocator, "{s}.000Z", .{raw_timestamp});
    }

    pub fn deleteSms(self: ModemManager, modem_id: []const u8, sms_id: []const u8) !void {
        const result = try std.process.Child.run(.{
            .allocator = self.allocator,
            .argv = &[_][]const u8{ "mmcli", "-m", modem_id, "--messaging-delete-sms", sms_id },
        });
        defer self.allocator.free(result.stdout);
        defer self.allocator.free(result.stderr);

        if (result.term.Exited != 0) {
            std.log.warn("Failed to delete SMS {s} from modem {s}", .{ sms_id, modem_id });
        } else {
            std.log.info("Deleted SMS {s} from modem {s}", .{ sms_id, modem_id });
        }
    }
};

pub fn main() !void {
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    const allocator = gpa.allocator();

    // Read configuration
    const config = Config{
        .api_url = std.posix.getenv("SMS_API_URL") orelse "https://sexy.qzz.io",
        .api_key = std.posix.getenv("SMS_API_KEY") orelse "",
        .device_id = std.posix.getenv("SMS_DEVICE_ID") orelse "orange-pi-001",
        .daemon_version = "1.1.1", // Added detailed HTTP and message debugging
        .poll_interval = 2, // Fast polling
        .upload_interval = 30,
        .heartbeat_interval = 300,
    };

    if (config.api_key.len == 0) {
        std.log.err("SMS_API_KEY environment variable not set", .{});
        return;
    }

    std.log.info("🚀 Starting SMS dashboard daemon v{s} (full)", .{config.daemon_version});
    std.log.info("API URL: {s}", .{config.api_url});
    std.log.info("Polling every {d} seconds", .{config.poll_interval});

    var modem_manager = ModemManager.init(allocator);
    var api_client = ApiClient.init(allocator, config);
    
    var last_heartbeat_time: i64 = std.time.timestamp();
    var current_phones = std.ArrayList(Phone).init(allocator);
    defer current_phones.deinit();

    while (true) {
        const current_time = std.time.timestamp();
        
        // Send heartbeat every 5 minutes
        if (current_time - last_heartbeat_time >= config.heartbeat_interval) {
            api_client.uploadPhones(current_phones.items) catch |err| {
                std.log.warn("Failed to upload phones: {any}", .{err});
            };
            last_heartbeat_time = current_time;
        }

        // Get list of all modems
        const modems = modem_manager.getModemList() catch |err| {
            std.log.err("Failed to get modem list: {any}", .{err});
            std.time.sleep(config.poll_interval * std.time.ns_per_s);
            continue;
        };
        defer {
            for (modems) |modem_id| {
                allocator.free(modem_id);
            }
            allocator.free(modems);
        }

        // Clear phones for this cycle
        for (current_phones.items) |phone| {
            if (phone.number) |num| allocator.free(num);
            allocator.free(phone.status);
            allocator.free(phone.iccid);
            if (phone.operator_name) |name| allocator.free(name);
            if (phone.operator_id) |id| allocator.free(id);
            if (phone.imei) |imei| allocator.free(imei);
            if (phone.access_tech) |tech| allocator.free(tech);
        }
        current_phones.clearRetainingCapacity();

        var total_new_messages: usize = 0;
        var all_message_infos = std.ArrayList(MessageInfo).init(allocator);
        defer {
            for (all_message_infos.items) |info| {
                allocator.free(info.modem_id);
                allocator.free(info.sms_id);
                allocator.free(info.message.phone_number);
                allocator.free(info.message.content);
                allocator.free(info.message.timestamp);
                allocator.free(info.message.phone_iccid);
            }
            all_message_infos.deinit();
        }

        // Process each modem
        for (modems) |modem_id| {
            const state = modem_manager.getModemState(modem_id) catch "unknown";
            defer allocator.free(state);

            std.log.info("Modem {s} state: {s}", .{ modem_id, state });

            // Get ICCID - required
            const iccid = modem_manager.getIccid(modem_id) catch |err| {
                std.log.warn("Skipping modem {s}: Failed to get ICCID: {any}", .{ modem_id, err });
                continue;
            };

            if (iccid == null) {
                std.log.warn("Skipping modem {s}: No ICCID found", .{modem_id});
                continue;
            }

            const phone_number = modem_manager.getPhoneNumber(modem_id) catch null;

            // Create phone entry
            const phone = Phone{
                .number = phone_number,
                .country = null,
                .flag = null,
                .carrier = null,
                .status = try allocator.dupe(u8, state),
                .signal = null,
                .iccid = iccid.?,
                .rssi = null,
                .rsrq = null,
                .rsrp = null,
                .snr = null,
                .operator_name = null,
                .operator_id = null,
                .imei = null,
                .access_tech = null,
            };

            try current_phones.append(phone);

            // Check for new messages
            const new_messages = modem_manager.getNewMessages(modem_id) catch |err| {
                std.log.warn("Failed to get messages for modem {s}: {any}", .{ modem_id, err });
                continue;
            };

            if (new_messages.len > 0) {
                std.log.info("📬 Found {d} new messages on modem {s}", .{ new_messages.len, modem_id });
                total_new_messages += new_messages.len;

                for (new_messages, 0..) |message_info, i| {
                    std.log.info("  📨 Message {d}: SMS_ID={s}, ICCID={s}, from={s}", .{ 
                        i, message_info.sms_id, message_info.message.phone_iccid, message_info.message.phone_number 
                    });
                    try all_message_infos.append(message_info);
                }
            }
        }

        // Upload phone data if we have any phones
        if (current_phones.items.len > 0) {
            api_client.uploadPhones(current_phones.items) catch |err| {
                std.log.warn("Failed to upload phones: {any}", .{err});
            };
        }

        // Upload messages if we have any
        if (all_message_infos.items.len > 0) {
            var messages = std.ArrayList(Message).init(allocator);
            defer messages.deinit();

            for (all_message_infos.items) |info| {
                try messages.append(info.message);
            }

            api_client.uploadMessages(messages.items) catch |err| {
                std.log.warn("Failed to upload messages: {any}", .{err});
            };

            // Delete uploaded messages from modems
            for (all_message_infos.items) |info| {
                modem_manager.deleteSms(info.modem_id, info.sms_id) catch |err| {
                    std.log.warn("Failed to delete SMS {s} from modem {s}: {any}", .{ info.sms_id, info.modem_id, err });
                };
            }

            std.log.info("✅ Processed and uploaded {d} new messages", .{total_new_messages});
        }

        // Wait before next poll
        std.time.sleep(config.poll_interval * std.time.ns_per_s);
    }
}