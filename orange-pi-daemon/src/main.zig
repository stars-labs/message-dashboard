const std = @import("std");
const http = std.http;
const json = std.json;
const time = std.time;
const process = std.process;

const Config = struct {
    api_url: []const u8,
    api_key: []const u8,
    upload_interval: u64, // seconds
    modem_ids: []const []const u8,
};

const Message = struct {
    id: ?[]const u8 = null,
    phone_id: []const u8,
    phone_number: []const u8,
    content: []const u8,
    source: ?[]const u8 = null,
    timestamp: []const u8,
};

const Phone = struct {
    id: []const u8,
    number: ?[]const u8 = null,
    country: ?[]const u8 = null,
    flag: ?[]const u8 = null,
    carrier: ?[]const u8 = null,
    status: []const u8,
    signal: ?u8 = null,
    iccid: ?[]const u8 = null,
    rssi: ?f32 = null,
    rsrq: ?f32 = null,
    rsrp: ?f32 = null,
    snr: ?f32 = null,
};

const MessageUploadRequest = struct {
    messages: []const Message,
};

const PhoneUpdateRequest = struct {
    phones: []const Phone,
};

const ModemManager = struct {
    allocator: std.mem.Allocator,
    
    pub fn init(allocator: std.mem.Allocator) ModemManager {
        return .{ .allocator = allocator };
    }
    
    pub fn getModemList(self: ModemManager) ![][]const u8 {
        var result = std.ArrayList([]const u8).init(self.allocator);
        defer result.deinit();
        
        const argv = [_][]const u8{ "mmcli", "-L" };
        const mmcli_result = try std.process.Child.run(.{
            .allocator = self.allocator,
            .argv = &argv,
        });
        defer self.allocator.free(mmcli_result.stdout);
        defer self.allocator.free(mmcli_result.stderr);
        
        var lines = std.mem.tokenizeScalar(u8, mmcli_result.stdout, '\n');
        while (lines.next()) |line| {
            // Parse modem ID from line like: "/org/freedesktop/ModemManager1/Modem/0 [huawei] E3372"
            if (std.mem.indexOf(u8, line, "/Modem/")) |pos| {
                const start = pos + 7; // Skip "/Modem/"
                var end = start;
                while (end < line.len and line[end] != ' ') : (end += 1) {}
                
                const modem_id = try self.allocator.dupe(u8, line[start..end]);
                try result.append(modem_id);
            }
        }
        
        return result.toOwnedSlice();
    }
    
    pub fn getPhoneNumber(self: ModemManager, modem_id: []const u8) !?[]const u8 {
        const argv = [_][]const u8{ "mmcli", "-m", modem_id, "-o" };
        const result = try std.process.Child.run(.{
            .allocator = self.allocator,
            .argv = &argv,
        });
        defer self.allocator.free(result.stdout);
        defer self.allocator.free(result.stderr);
        
        var lines = std.mem.tokenizeScalar(u8, result.stdout, '\n');
        while (lines.next()) |line| {
            if (std.mem.indexOf(u8, line, "own:")) |_| {
                const trimmed = std.mem.trim(u8, line, " \t");
                if (std.mem.indexOf(u8, trimmed, ": ")) |pos| {
                    const number = std.mem.trim(u8, trimmed[pos + 2 ..], " '\"");
                    if (number.len > 0) {
                        return try self.allocator.dupe(u8, number);
                    }
                }
            }
        }
        
        return null;
    }
    
    pub fn getSignalInfo(self: ModemManager, modem_id: []const u8) !Phone {
        const argv = [_][]const u8{ "mmcli", "-m", modem_id, "--signal-get" };
        const result = try std.process.Child.run(.{
            .allocator = self.allocator,
            .argv = &argv,
        });
        defer self.allocator.free(result.stdout);
        defer self.allocator.free(result.stderr);
        
        var phone = Phone{
            .id = try std.fmt.allocPrint(self.allocator, "SIM_{s}", .{modem_id}),
            .status = "online",
        };
        
        // Get phone number
        phone.number = try self.getPhoneNumber(modem_id);
        
        // Parse signal information
        var lines = std.mem.tokenizeScalar(u8, result.stdout, '\n');
        while (lines.next()) |line| {
            const trimmed = std.mem.trim(u8, line, " \t");
            
            if (std.mem.indexOf(u8, trimmed, "rssi:")) |_| {
                if (std.mem.indexOf(u8, trimmed, ": ")) |pos| {
                    const value_str = std.mem.trim(u8, trimmed[pos + 2 ..], " dBm");
                    phone.rssi = std.fmt.parseFloat(f32, value_str) catch null;
                }
            } else if (std.mem.indexOf(u8, trimmed, "rsrq:")) |_| {
                if (std.mem.indexOf(u8, trimmed, ": ")) |pos| {
                    const value_str = std.mem.trim(u8, trimmed[pos + 2 ..], " dB");
                    phone.rsrq = std.fmt.parseFloat(f32, value_str) catch null;
                }
            } else if (std.mem.indexOf(u8, trimmed, "rsrp:")) |_| {
                if (std.mem.indexOf(u8, trimmed, ": ")) |pos| {
                    const value_str = std.mem.trim(u8, trimmed[pos + 2 ..], " dBm");
                    phone.rsrp = std.fmt.parseFloat(f32, value_str) catch null;
                }
            } else if (std.mem.indexOf(u8, trimmed, "s/n:")) |_| {
                if (std.mem.indexOf(u8, trimmed, ": ")) |pos| {
                    const value_str = std.mem.trim(u8, trimmed[pos + 2 ..], " dB");
                    phone.snr = std.fmt.parseFloat(f32, value_str) catch null;
                }
            }
        }
        
        // Calculate signal strength percentage
        if (phone.rssi) |rssi| {
            if (rssi > -50) {
                phone.signal = 100;
            } else if (rssi > -60) {
                phone.signal = @intCast(@as(i32, 75) + @as(i32, @intFromFloat((rssi + 60) * 2.5)));
            } else if (rssi > -70) {
                phone.signal = @intCast(@as(i32, 50) + @as(i32, @intFromFloat((rssi + 70) * 2.5)));
            } else if (rssi > -80) {
                phone.signal = @intCast(@as(i32, 25) + @as(i32, @intFromFloat((rssi + 80) * 2.5)));
            } else {
                phone.signal = @intCast(@max(0, @as(i32, @intFromFloat((rssi + 100) * 1.25))));
            }
        }
        
        return phone;
    }
    
    pub fn getMessages(self: ModemManager, modem_id: []const u8) !struct { messages: []Message, sms_ids: [][]const u8 } {
        var messages = std.ArrayList(Message).init(self.allocator);
        defer messages.deinit();
        var message_sms_ids = std.ArrayList([]const u8).init(self.allocator);
        defer message_sms_ids.deinit();
        
        // List all SMS messages
        const list_argv = [_][]const u8{ "mmcli", "-m", modem_id, "--messaging-list-sms" };
        const list_result = try std.process.Child.run(.{
            .allocator = self.allocator,
            .argv = &list_argv,
        });
        defer self.allocator.free(list_result.stdout);
        defer self.allocator.free(list_result.stderr);
        
        var sms_ids = std.ArrayList([]const u8).init(self.allocator);
        defer sms_ids.deinit();
        
        // Parse SMS IDs
        var lines = std.mem.tokenizeScalar(u8, list_result.stdout, '\n');
        while (lines.next()) |line| {
            if (std.mem.indexOf(u8, line, "/SMS/")) |pos| {
                const start = pos + 5; // Skip "/SMS/"
                var end = start;
                while (end < line.len and line[end] >= '0' and line[end] <= '9') : (end += 1) {}
                
                const sms_id = try self.allocator.dupe(u8, line[start..end]);
                try sms_ids.append(sms_id);
            }
        }
        
        // Get details for each SMS
        for (sms_ids.items) |sms_id| {
            const sms_argv = [_][]const u8{ "mmcli", "-m", modem_id, "-s", sms_id };
            const sms_result = try std.process.Child.run(.{
                .allocator = self.allocator,
                .argv = &sms_argv,
            });
            defer self.allocator.free(sms_result.stdout);
            defer self.allocator.free(sms_result.stderr);
            
            var message = Message{
                .id = try std.fmt.allocPrint(self.allocator, "msg-{s}-{s}", .{ modem_id, sms_id }),
                .phone_id = try std.fmt.allocPrint(self.allocator, "SIM_{s}", .{modem_id}),
                .phone_number = "",
                .content = "",
                .timestamp = "",
            };
            
            // Parse SMS details
            var sms_lines = std.mem.tokenizeScalar(u8, sms_result.stdout, '\n');
            while (sms_lines.next()) |sms_line| {
                const trimmed = std.mem.trim(u8, sms_line, " \t");
                
                if (std.mem.indexOf(u8, trimmed, "number:")) |_| {
                    if (std.mem.indexOf(u8, trimmed, ": ")) |pos| {
                        message.phone_number = try self.allocator.dupe(u8, std.mem.trim(u8, trimmed[pos + 2 ..], " '\""));
                    }
                } else if (std.mem.indexOf(u8, trimmed, "text:")) |_| {
                    if (std.mem.indexOf(u8, trimmed, ": ")) |pos| {
                        message.content = try self.allocator.dupe(u8, std.mem.trim(u8, trimmed[pos + 2 ..], " '\""));
                    }
                } else if (std.mem.indexOf(u8, trimmed, "timestamp:")) |_| {
                    if (std.mem.indexOf(u8, trimmed, ": ")) |pos| {
                        const timestamp_str = std.mem.trim(u8, trimmed[pos + 2 ..], " '\"");
                        // Convert to ISO format
                        message.timestamp = try self.formatTimestamp(timestamp_str);
                    }
                }
            }
            
            if (message.content.len > 0) {
                try messages.append(message);
                try message_sms_ids.append(try self.allocator.dupe(u8, sms_id));
            }
        }
        
        return .{
            .messages = try messages.toOwnedSlice(),
            .sms_ids = try message_sms_ids.toOwnedSlice(),
        };
    }
    
    pub fn deleteMessage(self: ModemManager, modem_id: []const u8, sms_id: []const u8) !void {
        const delete_argv = [_][]const u8{ "mmcli", "-m", modem_id, "--messaging-delete-sms", sms_id };
        const result = try std.process.Child.run(.{
            .allocator = self.allocator,
            .argv = &delete_argv,
        });
        defer self.allocator.free(result.stdout);
        defer self.allocator.free(result.stderr);
        
        if (result.term.Exited != 0) {
            std.log.err("Failed to delete SMS {s} from modem {s}: {s}", .{ sms_id, modem_id, result.stderr });
        } else {
            std.log.info("Deleted SMS {s} from modem {s}", .{ sms_id, modem_id });
        }
    }
    
    fn formatTimestamp(self: ModemManager, timestamp: []const u8) ![]const u8 {
        // Convert mmcli timestamp format to ISO 8601
        // Example: "2024-01-09 10:30:00" -> "2024-01-09T10:30:00Z"
        var buffer = try self.allocator.alloc(u8, timestamp.len + 2);
        @memcpy(buffer[0..timestamp.len], timestamp);
        
        // Replace space with T
        if (std.mem.indexOf(u8, buffer, " ")) |pos| {
            buffer[pos] = 'T';
        }
        
        // Add Z suffix
        buffer[buffer.len - 2] = 'Z';
        buffer[buffer.len - 1] = 0;
        
        return buffer[0 .. buffer.len - 1];
    }
};

const ApiClient = struct {
    allocator: std.mem.Allocator,
    config: Config,
    client: http.Client,
    
    pub fn init(allocator: std.mem.Allocator, config: Config) ApiClient {
        return .{
            .allocator = allocator,
            .config = config,
            .client = http.Client{ .allocator = allocator },
        };
    }
    
    pub fn deinit(self: *ApiClient) void {
        self.client.deinit();
    }
    
    pub fn uploadMessages(self: *ApiClient, messages: []const Message) !void {
        if (messages.len == 0) return;
        
        const request_body = MessageUploadRequest{ .messages = messages };
        const json_body = try json.stringifyAlloc(self.allocator, request_body, .{});
        defer self.allocator.free(json_body);
        
        const url = try std.fmt.allocPrint(self.allocator, "{s}/api/control/messages", .{self.config.api_url});
        defer self.allocator.free(url);
        
        const uri = try std.Uri.parse(url);
        
        var server_header_buffer: [16384]u8 = undefined;
        var request = try self.client.open(.POST, uri, .{
            .server_header_buffer = &server_header_buffer,
            .extra_headers = &[_]http.Header{
                .{ .name = "X-API-Key", .value = self.config.api_key },
                .{ .name = "Content-Type", .value = "application/json" },
            },
            .keep_alive = false,
        });
        defer request.deinit();
        
        request.transfer_encoding = .{ .content_length = json_body.len };
        try request.send();
        try request.writer().writeAll(json_body);
        try request.finish();
        
        try request.wait();
        
        if (request.response.status != .ok) {
            std.log.err("Failed to upload messages: {}", .{request.response.status});
        } else {
            std.log.info("Successfully uploaded {} messages", .{messages.len});
        }
    }
    
    pub fn updatePhones(self: *ApiClient, phones: []const Phone) !void {
        if (phones.len == 0) return;
        
        const request_body = PhoneUpdateRequest{ .phones = phones };
        const json_body = try json.stringifyAlloc(self.allocator, request_body, .{});
        defer self.allocator.free(json_body);
        
        const url = try std.fmt.allocPrint(self.allocator, "{s}/api/control/phones", .{self.config.api_url});
        defer self.allocator.free(url);
        
        const uri = try std.Uri.parse(url);
        
        var server_header_buffer: [16384]u8 = undefined;
        var request = try self.client.open(.POST, uri, .{
            .server_header_buffer = &server_header_buffer,
            .extra_headers = &[_]http.Header{
                .{ .name = "X-API-Key", .value = self.config.api_key },
                .{ .name = "Content-Type", .value = "application/json" },
            },
            .keep_alive = false,
        });
        defer request.deinit();
        
        request.transfer_encoding = .{ .content_length = json_body.len };
        try request.send();
        try request.writer().writeAll(json_body);
        try request.finish();
        
        try request.wait();
        
        if (request.response.status != .ok) {
            std.log.err("Failed to update phones: {}", .{request.response.status});
        } else {
            std.log.info("Successfully updated {} phones", .{phones.len});
        }
    }
};

pub fn main() !void {
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    const allocator = gpa.allocator();
    
    // Read configuration from environment or config file
    const config = Config{
        .api_url = std.posix.getenv("SMS_API_URL") orelse "https://sexy.qzz.io",
        .api_key = std.posix.getenv("SMS_API_KEY") orelse "",
        .upload_interval = 60, // 1 minute
        .modem_ids = &[_][]const u8{}, // Will be auto-detected
    };
    
    if (config.api_key.len == 0) {
        std.log.err("SMS_API_KEY environment variable not set", .{});
        return;
    }
    
    var modem_manager = ModemManager.init(allocator);
    var api_client = ApiClient.init(allocator, config);
    defer api_client.deinit();
    
    std.log.info("Starting SMS dashboard daemon...", .{});
    std.log.info("API URL: {s}", .{config.api_url});
    std.log.info("Upload interval: {} seconds", .{config.upload_interval});
    
    while (true) {
        // Get list of modems
        const modems = try modem_manager.getModemList();
        defer {
            for (modems) |modem| {
                allocator.free(modem);
            }
            allocator.free(modems);
        }
        
        std.log.info("Found {} modems", .{modems.len});
        
        var all_phones = std.ArrayList(Phone).init(allocator);
        var all_messages = std.ArrayList(Message).init(allocator);
        defer all_phones.deinit();
        defer all_messages.deinit();
        
        // Structure to track messages and their SMS IDs for deletion
        const MessageInfo = struct {
            modem_id: []const u8,
            sms_id: []const u8,
            message: Message,
        };
        var message_infos = std.ArrayList(MessageInfo).init(allocator);
        defer message_infos.deinit();
        
        // Process each modem
        for (modems) |modem_id| {
            // Get phone status and signal
            const phone = modem_manager.getSignalInfo(modem_id) catch |err| {
                std.log.err("Failed to get signal info for modem {s}: {}", .{ modem_id, err });
                continue;
            };
            try all_phones.append(phone);
            
            // Get messages with SMS IDs
            const msg_result = modem_manager.getMessages(modem_id) catch |err| {
                std.log.err("Failed to get messages for modem {s}: {}", .{ modem_id, err });
                continue;
            };
            
            // Store messages with their metadata
            for (msg_result.messages, 0..) |message, i| {
                try all_messages.append(message);
                try message_infos.append(.{
                    .modem_id = modem_id,
                    .sms_id = msg_result.sms_ids[i],
                    .message = message,
                });
            }
        }
        
        // Upload phone status
        if (all_phones.items.len > 0) {
            api_client.updatePhones(all_phones.items) catch |err| {
                std.log.err("Failed to update phones: {}", .{err});
            };
        }
        
        // Upload messages and delete on success
        if (all_messages.items.len > 0) {
            api_client.uploadMessages(all_messages.items) catch |err| {
                std.log.err("Failed to upload messages: {}", .{err});
                // Don't delete messages if upload failed
                continue;
            };
            
            // Upload successful, delete messages from modems
            std.log.info("Upload successful, deleting {} messages from modems", .{message_infos.items.len});
            for (message_infos.items) |info| {
                modem_manager.deleteMessage(info.modem_id, info.sms_id) catch |err| {
                    std.log.err("Failed to delete message {s}: {}", .{ info.sms_id, err });
                };
            }
        }
        
        // Sleep for the configured interval
        std.time.sleep(config.upload_interval * std.time.ns_per_s);
    }
}