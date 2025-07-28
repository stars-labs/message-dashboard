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
    id: []const u8, // ICCID is used as the primary identifier
    iccid: []const u8,
    number: ?[]const u8 = null,
    status: []const u8,
    signal_strength: u8 = 0,
    operator_name: ?[]const u8 = null,
    operator_id: ?[]const u8 = null,
    network_type: ?[]const u8 = null,
    access_tech: ?[]const u8 = null,
    imei: ?[]const u8 = null,
};

const MessageInfo = struct {
    modem_id: []const u8,
    sms_id: []const u8,
    message: Message,
};

// Thread context for processing a single modem
const ModemThreadContext = struct {
    allocator: std.mem.Allocator,
    modem_manager: *ModemManager,
    api_client: *ApiClient,
    modem_id: []const u8,
    
    fn processModem(ctx: ModemThreadContext) void {
        const self = ctx;
        
        // Get modem status and details
        const modem_status = self.modem_manager.getModemState(self.modem_id) catch |err| {
            std.log.warn("Failed to get status for modem {s}: {any}", .{ self.modem_id, err });
            self.allocator.free(self.modem_id);
            return;
        };
        defer self.allocator.free(modem_status);
        
        std.log.info("🧵 Thread: Modem {s} state: {s}", .{ self.modem_id, modem_status });
        
        // Enable modem if it's disabled
        if (std.mem.eql(u8, modem_status, "disabled")) {
            std.log.info("🔧 Thread: Enabling disabled modem {s}", .{self.modem_id});
            self.modem_manager.enableModem(self.modem_id) catch |err| {
                std.log.warn("🧵 Thread: Failed to enable modem {s}: {any}", .{ self.modem_id, err });
            };
            // Give modem time to enable
            std.time.sleep(2 * std.time.ns_per_s);
        }
        
        // Get ICCID for this modem
        const iccid_opt = self.modem_manager.getIccid(self.modem_id) catch |err| {
            std.log.warn("🧵 Thread: Failed to get ICCID for modem {s}: {any}", .{ self.modem_id, err });
            self.allocator.free(self.modem_id);
            return;
        };
        
        const iccid = iccid_opt orelse {
            std.log.warn("🧵 Thread: Skipping modem {s}: No ICCID found", .{ self.modem_id });
            self.allocator.free(self.modem_id);
            return;
        };
        defer self.allocator.free(iccid);
        
        const iccid_copy = self.allocator.dupe(u8, iccid) catch {
            self.allocator.free(self.modem_id);
            return;
        };
        
        const status_copy = self.allocator.dupe(u8, modem_status) catch {
            self.allocator.free(iccid_copy);
            self.allocator.free(self.modem_id);
            return;
        };
        
        var phone = Phone{
            .id = iccid,
            .iccid = iccid_copy,
            .number = null,
            .status = status_copy,
            .signal_strength = 0,
            .operator_name = null,
            .operator_id = null,
            .network_type = null,
            .access_tech = null,
            .imei = null,
        };
        defer {
            if (phone.number) |num| self.allocator.free(num);
            self.allocator.free(phone.status);
            self.allocator.free(phone.iccid);
            if (phone.operator_name) |name| self.allocator.free(name);
            if (phone.operator_id) |id| self.allocator.free(id);
            if (phone.imei) |imei| self.allocator.free(imei);
            if (phone.access_tech) |tech| self.allocator.free(tech);
            self.allocator.free(self.modem_id);
        }
        
        // Get phone number if available
        if (self.modem_manager.getPhoneNumber(self.modem_id)) |number| {
            phone.number = number;
        } else |_| {}
        
        // TODO: Add more modem details when those functions are implemented
        // For now, we have the essential data: ICCID, phone number, and status
        
        // Upload this phone's data immediately
        self.api_client.uploadPhone(phone) catch |err| {
            std.log.warn("🧵 Thread: Failed to upload phone {s}: {any}", .{ phone.id, err });
        };
    }
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

    pub fn uploadPhone(self: ApiClient, phone: Phone) !void {
        const phones = [_]Phone{phone};
        const phones_json = try json.stringifyAlloc(self.allocator, phones, .{ .emit_null_optional_fields = false });
        defer self.allocator.free(phones_json);

        const payload = try std.fmt.allocPrint(self.allocator, "{{\"phones\":{s}}}", .{phones_json});
        defer self.allocator.free(payload);

        try self.makeRequest("/phones", payload);
        std.log.info("✅ Uploaded phone {s} via HTTP API", .{phone.id});
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

        // Create unique temporary file for each thread
        const thread_id = std.Thread.getCurrentId();
        const temp_file = try std.fmt.allocPrint(self.allocator, "/tmp/sms_payload_{d}.json", .{thread_id});
        defer self.allocator.free(temp_file);
        
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
            // Return current time in ISO format
            const now_ns = std.time.nanoTimestamp();
            const now_s = @divFloor(now_ns, std.time.ns_per_s);
            const now_ms = @divFloor(@mod(now_ns, std.time.ns_per_s), std.time.ns_per_ms);
            
            // Create ISO timestamp
            // Format: YYYY-MM-DDTHH:MM:SS.sssZ
            const epoch_seconds = @as(u64, @intCast(now_s));
            const days_since_epoch = epoch_seconds / 86400;
            const seconds_today = epoch_seconds % 86400;
            
            // Simple approximation for current date (this is approximate, not accounting for leap years properly)
            const year = 1970 + days_since_epoch / 365;
            const remaining_days = days_since_epoch % 365;
            const month = 1 + remaining_days / 30;
            const day = 1 + remaining_days % 30;
            
            const hours = seconds_today / 3600;
            const minutes = (seconds_today % 3600) / 60;
            const seconds = seconds_today % 60;
            
            return try std.fmt.allocPrint(self.allocator, "{d:0>4}-{d:0>2}-{d:0>2}T{d:0>2}:{d:0>2}:{d:0>2}.{d:0>3}Z", .{
                year, month, day, hours, minutes, seconds, now_ms
            });
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
    
    pub fn enableModem(self: ModemManager, modem_id: []const u8) !void {
        const result = try std.process.Child.run(.{
            .allocator = self.allocator,
            .argv = &[_][]const u8{ "mmcli", "-m", modem_id, "-e" },
        });
        defer self.allocator.free(result.stdout);
        defer self.allocator.free(result.stderr);
        
        if (result.term.Exited != 0) {
            std.log.warn("Failed to enable modem {s}: {s}", .{ modem_id, result.stderr });
            return error.ModemEnableFailed;
        }
        
        std.log.info("✅ Successfully enabled modem {s}", .{modem_id});
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

    // Extract version from executable path (/nix/store/xxx-sms-daemon-1.2.0/bin/sms-daemon)
    const exe_path = try std.fs.selfExePathAlloc(allocator);
    defer allocator.free(exe_path);
    
    var version_buf: [20]u8 = undefined;
    var version: []const u8 = "unknown";
    if (std.mem.indexOf(u8, exe_path, "sms-daemon-")) |pos| {
        const version_start = pos + 11; // length of "sms-daemon-"
        if (std.mem.indexOf(u8, exe_path[version_start..], "/")) |version_end| {
            const extracted_version = exe_path[version_start..version_start + version_end];
            const len = @min(extracted_version.len, version_buf.len);
            @memcpy(version_buf[0..len], extracted_version[0..len]);
            version = version_buf[0..len];
        }
    }

    // Read configuration
    const config = Config{
        .api_url = std.posix.getenv("SMS_API_URL") orelse "https://sexy.qzz.io",
        .api_key = std.posix.getenv("SMS_API_KEY") orelse "",
        .device_id = std.posix.getenv("SMS_DEVICE_ID") orelse "orange-pi-001",
        .daemon_version = version,
        .poll_interval = 2, // Fast polling
        .upload_interval = 30,
        .heartbeat_interval = 300,
    };

    if (config.api_key.len == 0) {
        std.log.err("SMS_API_KEY environment variable not set", .{});
        return;
    }

    std.log.info("🚀 Starting SMS dashboard daemon v{s} (multi-threaded)", .{config.daemon_version});
    std.log.info("API URL: {s}", .{config.api_url});
    std.log.info("Polling every {d} seconds", .{config.poll_interval});

    var modem_manager = ModemManager.init(allocator);
    var api_client = ApiClient.init(allocator, config);
    
    while (true) {
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

        std.log.info("🔄 Starting parallel phone updates for {d} modems", .{modems.len});
        
        // Create threads for parallel modem processing
        var threads = std.ArrayList(std.Thread).init(allocator);
        defer threads.deinit();
        
        // Process modems in parallel
        for (modems) |modem_id| {
            // Create a copy of modem_id for the thread
            const modem_id_copy = allocator.dupe(u8, modem_id) catch |err| {
                std.log.warn("Failed to allocate memory for modem ID: {any}", .{err});
                continue;
            };
            
            const context = ModemThreadContext{
                .allocator = allocator,
                .modem_manager = &modem_manager,
                .api_client = &api_client,
                .modem_id = modem_id_copy,
            };
            
            const thread = std.Thread.spawn(.{}, ModemThreadContext.processModem, .{context}) catch |err| {
                std.log.warn("Failed to spawn thread for modem {s}: {any}", .{ modem_id, err });
                allocator.free(modem_id_copy);
                continue;
            };
            threads.append(thread) catch |err| {
                std.log.warn("Failed to append thread to list: {any}", .{err});
                thread.join();
                continue;
            };
        }
        
        // Wait for all threads to complete
        for (threads.items) |thread| {
            thread.join();
        }
        
        std.log.info("✅ Completed parallel phone updates", .{});

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

        // Process messages from each modem (sequentially for now)
        for (modems) |modem_id| {
            // Check for new messages
            const new_messages = modem_manager.getNewMessages(modem_id) catch |err| {
                std.log.warn("Failed to get messages from modem {s}: {any}", .{ modem_id, err });
                continue;
            };
            // Memory is already managed by getNewMessages, no defer needed here

            if (new_messages.len > 0) {
                std.log.info("📬 Found {d} new messages on modem {s}", .{ new_messages.len, modem_id });
                total_new_messages += new_messages.len;

                for (new_messages, 0..) |message_info, i| {
                    std.log.info("  📨 Message {d}: SMS_ID={s}, ICCID={s}, from={s}", .{ 
                        i, message_info.sms_id, message_info.message.phone_iccid, message_info.message.phone_number 
                    });
                    
                    // Append the message info directly
                    try all_message_infos.append(message_info);
                }
            }
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