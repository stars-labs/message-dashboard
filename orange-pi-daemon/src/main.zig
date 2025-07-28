const std = @import("std");
const time = std.time;
const process = std.process;
const json = std.json;
const http = std.http;

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
    signal: ?u8 = null,
    rssi: ?i32 = null,
    rsrq: ?i32 = null,
    rsrp: ?i32 = null,
    snr: ?i32 = null,
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

// Signal cache for tracking previous values
const SignalCache = struct {
    allocator: std.mem.Allocator,
    cache: std.HashMap([]const u8, CachedSignal, std.hash_map.StringContext, std.hash_map.default_max_load_percentage),
    
    const CachedSignal = struct {
        signal_data: SignalData,
        last_update: i64,
    };
    
    pub fn init(allocator: std.mem.Allocator) SignalCache {
        return .{
            .allocator = allocator,
            .cache = std.HashMap([]const u8, CachedSignal, std.hash_map.StringContext, std.hash_map.default_max_load_percentage).init(allocator),
        };
    }
    
    pub fn deinit(self: *SignalCache) void {
        var iterator = self.cache.iterator();
        while (iterator.next()) |entry| {
            self.allocator.free(entry.key_ptr.*);
        }
        self.cache.deinit();
    }
    
    pub fn shouldUpdate(self: *SignalCache, modem_id: []const u8, new_signal: SignalData) bool {
        const now = std.time.milliTimestamp();
        
        // Always update if not in cache
        if (self.cache.get(modem_id)) |cached| {
            // Don't update more than once every 5 seconds (0.2Hz)
            if (now - cached.last_update < 5000) {
                return false;
            }
            
            // Only update if signal changed by more than 5%
            const signal_diff = if (new_signal.signal_percent > cached.signal_data.signal_percent) 
                new_signal.signal_percent - cached.signal_data.signal_percent 
            else 
                cached.signal_data.signal_percent - new_signal.signal_percent;
                
            if (signal_diff < 5) {
                return false;
            }
        }
        
        return true;
    }
    
    pub fn updateCache(self: *SignalCache, modem_id: []const u8, signal_data: SignalData) !void {
        const key = try self.allocator.dupe(u8, modem_id);
        const cached_signal = CachedSignal{
            .signal_data = signal_data,
            .last_update = std.time.milliTimestamp(),
        };
        
        // Free old key if exists
        if (self.cache.fetchPut(key, cached_signal)) |maybe_old_entry| {
            if (maybe_old_entry) |old_entry| {
                self.allocator.free(old_entry.key);
            }
        } else |_| {}
    }
};

const SignalData = struct {
        signal_percent: u8,
        rssi: ?i32,
        rsrq: ?i32,
        rsrp: ?i32,
        snr: ?i32,
    };

// Thread context for processing a single modem
const ModemThreadContext = struct {
    allocator: std.mem.Allocator,
    modem_manager: *ModemManager,
    api_client: *ApiClient,
    signal_cache: *SignalCache,
    modem_id: []const u8,
    check_signal: bool, // Whether to check signal this cycle
    
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
            .signal = null,
            .rssi = null,
            .rsrq = null,
            .rsrp = null,
            .snr = null,
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
        
        var should_upload = true;
        
        // Get signal quality only if it's time to check and if it should be updated
        if (self.check_signal) {
            if (self.modem_manager.getSignalQuality(self.modem_id)) |signal_data| {
                // Check if we should update based on cache
                if (self.signal_cache.shouldUpdate(self.modem_id, signal_data)) {
                    phone.signal = signal_data.signal_percent;
                    phone.rssi = signal_data.rssi;
                    phone.rsrq = signal_data.rsrq;
                    phone.rsrp = signal_data.rsrp;
                    phone.snr = signal_data.snr;
                    
                    // Update cache
                    self.signal_cache.updateCache(self.modem_id, signal_data) catch |err| {
                        std.log.warn("Failed to update signal cache for modem {s}: {any}", .{ self.modem_id, err });
                    };
                    
                    std.log.info("🧵 Thread: Modem {s} signal updated: {}%, RSSI: {?}, RSRQ: {?}, RSRP: {?}, SNR: {?}", .{
                        self.modem_id, 
                        signal_data.signal_percent,
                        signal_data.rssi,
                        signal_data.rsrq,
                        signal_data.rsrp,
                        signal_data.snr
                    });
                } else {
                    // Use cached signal data if available
                    if (self.signal_cache.cache.get(self.modem_id)) |cached| {
                        phone.signal = cached.signal_data.signal_percent;
                        phone.rssi = cached.signal_data.rssi;
                        phone.rsrq = cached.signal_data.rsrq;
                        phone.rsrp = cached.signal_data.rsrp;
                        phone.snr = cached.signal_data.snr;
                        std.log.info("🧵 Thread: Modem {s} using cached signal (no update needed): {}%", .{ self.modem_id, cached.signal_data.signal_percent });
                    } else {
                        std.log.warn("🧵 Thread: Modem {s} has no cached signal data during signal check - skipping upload", .{ self.modem_id });
                        should_upload = false;
                    }
                }
            } else |err| {
                std.log.warn("🧵 Thread: Failed to get signal quality for modem {s}: {any}", .{ self.modem_id, err });
                // Use cached signal data if available when signal retrieval fails
                if (self.signal_cache.cache.get(self.modem_id)) |cached| {
                    phone.signal = cached.signal_data.signal_percent;
                    phone.rssi = cached.signal_data.rssi;
                    phone.rsrq = cached.signal_data.rsrq;
                    phone.rsrp = cached.signal_data.rsrp;
                    phone.snr = cached.signal_data.snr;
                    std.log.info("🧵 Thread: Modem {s} using cached signal after retrieval failure: {}%", .{ self.modem_id, cached.signal_data.signal_percent });
                } else {
                    std.log.warn("🧵 Thread: Modem {s} has no cached signal data after retrieval failure - skipping upload", .{ self.modem_id });
                    should_upload = false;
                }
            }
        } else {
            // Use cached signal data if available
            if (self.signal_cache.cache.get(self.modem_id)) |cached| {
                phone.signal = cached.signal_data.signal_percent;
                phone.rssi = cached.signal_data.rssi;
                phone.rsrq = cached.signal_data.rsrq;
                phone.rsrp = cached.signal_data.rsrp;
                phone.snr = cached.signal_data.snr;
                std.log.info("🧵 Thread: Modem {s} using cached signal: {}%", .{ self.modem_id, cached.signal_data.signal_percent });
            } else {
                std.log.warn("🧵 Thread: Modem {s} has no cached signal data - skipping upload to prevent null signals", .{ self.modem_id });
                should_upload = false;
            }
        }
        
        // Only upload if we have signal data (either fresh or cached)
        if (should_upload) {
            std.log.info("🧵 Thread: Uploading phone {s} with signal: {?}", .{ phone.id, phone.signal });
            self.api_client.uploadPhone(phone) catch |err| {
                std.log.warn("🧵 Thread: Failed to upload phone {s}: {any}", .{ phone.id, err });
            };
        } else {
            std.log.warn("🧵 Thread: Skipping upload for modem {s} - no signal data available", .{ self.modem_id });
        }
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
    mutex: std.Thread.Mutex,

    pub fn init(allocator: std.mem.Allocator, config: Config) ApiClient {
        return .{ 
            .allocator = allocator, 
            .config = config,
            .mutex = std.Thread.Mutex{},
        };
    }
    
    pub fn deinit(self: *ApiClient) void {
        // No HTTP client to deinit since we create them per request
        _ = self;
    }

    pub fn uploadPhone(self: *ApiClient, phone: Phone) !void {
        self.mutex.lock();
        defer self.mutex.unlock();
        
        const phones = [_]Phone{phone};
        const phones_json = try json.stringifyAlloc(self.allocator, phones, .{ .emit_null_optional_fields = false });
        defer self.allocator.free(phones_json);

        const payload = try std.fmt.allocPrint(self.allocator, "{{\"phones\":{s}}}", .{phones_json});
        defer self.allocator.free(payload);

        self.makeRequest("/phones", payload);
        std.log.info("✅ Uploaded phone {s} via HTTP API", .{phone.id});
    }

    pub fn uploadPhones(self: *ApiClient, phones: []const Phone) !void {
        if (phones.len == 0) return;
        
        self.mutex.lock();
        defer self.mutex.unlock();

        const phones_json = try json.stringifyAlloc(self.allocator, phones, .{ .emit_null_optional_fields = false });
        defer self.allocator.free(phones_json);

        const payload = try std.fmt.allocPrint(self.allocator, "{{\"phones\":{s}}}", .{phones_json});
        defer self.allocator.free(payload);

        self.makeRequest("/phones", payload);
        std.log.info("✅ Uploaded {d} phones via HTTP API", .{phones.len});
    }

    pub fn uploadMessages(self: *ApiClient, messages: []const Message) !void {
        if (messages.len == 0) return;
        
        self.mutex.lock();
        defer self.mutex.unlock();

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

        self.makeRequest("/messages", payload);
        std.log.info("✅ Uploaded {d} messages via HTTP API", .{messages.len});
    }

    fn makeRequest(self: *ApiClient, endpoint: []const u8, payload: []const u8) void {
        const url_str = std.fmt.allocPrint(self.allocator, "{s}/api/control{s}", .{ self.config.api_url, endpoint }) catch |err| {
            std.log.warn("❌ Failed to allocate URL string: {any}", .{err});
            return;
        };
        defer self.allocator.free(url_str);
        
        const uri = std.Uri.parse(url_str) catch |err| {
            std.log.warn("❌ Failed to parse URL {s}: {any}", .{ url_str, err });
            return;
        };
        
        // Create a new HTTP client for this request (thread-safe)
        var http_client = http.Client{ .allocator = self.allocator };
        defer http_client.deinit();
        
        var server_header_buffer: [16 * 1024]u8 = undefined;
        
        // Create HTTP request
        var req = http_client.open(.POST, uri, .{
            .server_header_buffer = &server_header_buffer,
            .extra_headers = &[_]http.Header{
                .{ .name = "content-type", .value = "application/json" },
                .{ .name = "x-api-key", .value = self.config.api_key },
            },
        }) catch |err| {
            std.log.warn("❌ Failed to open HTTP request to {s}: {any}", .{ url_str, err });
            return;
        };
        defer req.deinit();
        
        // Set content length
        req.transfer_encoding = .{ .content_length = payload.len };
        
        // Send headers
        req.send() catch |err| {
            std.log.warn("❌ Failed to send HTTP headers to {s}: {any}", .{ url_str, err });
            return;
        };
        
        // Write payload
        req.writeAll(payload) catch |err| {
            std.log.warn("❌ Failed to write payload to {s}: {any}", .{ url_str, err });
            return;
        };
        
        // Finish request
        req.finish() catch |err| {
            std.log.warn("❌ Failed to finish HTTP request to {s}: {any}", .{ url_str, err });
            return;
        };
        
        // Wait for response
        req.wait() catch |err| {
            std.log.warn("❌ Failed to wait for response from {s}: {any}", .{ url_str, err });
            return;
        };
        
        const status_code = @intFromEnum(req.response.status);
        std.log.info("📊 HTTP status code: {d}", .{status_code});
        
        // Read response body for logging
        const response_body = req.reader().readAllAlloc(self.allocator, 8192) catch |err| {
            std.log.warn("⚠️ Failed to read response body from {s}: {any}", .{ url_str, err });
            if (status_code == 200) {
                std.log.info("✅ HTTP request successful for {s}", .{endpoint});
            } else {
                std.log.warn("❌ HTTP request failed with status: {d}", .{status_code});
            }
            return;
        };
        defer self.allocator.free(response_body);
        
        std.log.info("📡 Raw HTTP response: {s}", .{response_body});
        
        if (status_code == 200) {
            std.log.info("✅ HTTP request successful for {s}", .{endpoint});
        } else {
            std.log.warn("❌ HTTP request failed with status: {d}", .{status_code});
            std.log.warn("❌ Response body: {s}", .{response_body});
        }
    }
    
    pub fn sendHeartbeat(self: *ApiClient) !void {
        self.mutex.lock();
        defer self.mutex.unlock();
        const heartbeat_data = .{
            .device_id = self.config.device_id,
            .version = self.config.daemon_version,
            .status = "online",
        };
        
        const heartbeat_json = try json.stringifyAlloc(self.allocator, heartbeat_data, .{});
        defer self.allocator.free(heartbeat_json);
        
        self.makeRequest("/heartbeat", heartbeat_json);
        std.log.info("💓 Sent daemon heartbeat", .{});
    }

    pub fn getPendingSMS(self: *ApiClient) ![]const u8 {
        const url_str = try std.fmt.allocPrint(self.allocator, "{s}/api/control/pending-sms", .{self.config.api_url});
        defer self.allocator.free(url_str);
        
        const uri = std.Uri.parse(url_str) catch |err| {
            std.log.warn("❌ Failed to parse URL {s}: {any}", .{ url_str, err });
            return error.GetPendingFailed;
        };
        
        // Create a new HTTP client for this request (thread-safe)
        var http_client = http.Client{ .allocator = self.allocator };
        defer http_client.deinit();
        
        var server_header_buffer: [16 * 1024]u8 = undefined;
        
        // Create HTTP GET request
        var req = http_client.open(.GET, uri, .{
            .server_header_buffer = &server_header_buffer,
            .extra_headers = &[_]http.Header{
                .{ .name = "content-type", .value = "application/json" },
                .{ .name = "x-api-key", .value = self.config.api_key },
            },
        }) catch |err| {
            std.log.warn("❌ Failed to open HTTP GET request to {s}: {any}", .{ url_str, err });
            return error.GetPendingFailed;
        };
        defer req.deinit();
        
        // Send request
        req.send() catch |err| {
            std.log.warn("❌ Failed to send HTTP GET request to {s}: {any}", .{ url_str, err });
            return error.GetPendingFailed;
        };
        
        // Finish request (no body for GET)
        req.finish() catch |err| {
            std.log.warn("❌ Failed to finish HTTP GET request to {s}: {any}", .{ url_str, err });
            return error.GetPendingFailed;
        };
        
        // Wait for response
        req.wait() catch |err| {
            std.log.warn("❌ Failed to wait for GET response from {s}: {any}", .{ url_str, err });
            return error.GetPendingFailed;
        };
        
        const status_code = @intFromEnum(req.response.status);
        
        if (status_code != 200) {
            std.log.warn("Failed to get pending SMS: HTTP status {d}", .{status_code});
            return error.GetPendingFailed;
        }
        
        // Read response body and return it (caller owns this memory)
        const response_body = req.reader().readAllAlloc(self.allocator, 1024 * 1024) catch |err| {
            std.log.warn("❌ Failed to read GET response body from {s}: {any}", .{ url_str, err });
            return error.GetPendingFailed;
        };
        
        return response_body; // Caller owns this memory
    }

    pub fn updateSMSResult(self: *ApiClient, message_id: []const u8, success: bool, sms_id: ?[]const u8, error_message: ?[]const u8) !void {
        self.mutex.lock();
        defer self.mutex.unlock();
        const update_data = .{
            .message_id = message_id,
            .success = success,
            .sms_id = sms_id,
            .error_message = error_message,
        };

        const update_json = try json.stringifyAlloc(self.allocator, update_data, .{});
        defer self.allocator.free(update_json);

        self.makeRequest("/sms-result", update_json);
        std.log.info("📝 Updated SMS status for message {s}: success={}", .{ message_id, success });
    }
};

// Modem Manager
const ModemManager = struct {
    allocator: std.mem.Allocator,
    warned_iccids: std.HashMap([]const u8, void, std.hash_map.StringContext, std.hash_map.default_max_load_percentage),

    pub fn init(allocator: std.mem.Allocator) ModemManager {
        return .{ 
            .allocator = allocator,
            .warned_iccids = std.HashMap([]const u8, void, std.hash_map.StringContext, std.hash_map.default_max_load_percentage).init(allocator),
        };
    }
    
    pub fn deinit(self: *ModemManager) void {
        var iterator = self.warned_iccids.iterator();
        while (iterator.next()) |entry| {
            self.allocator.free(entry.key_ptr.*);
        }
        self.warned_iccids.deinit();
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

    pub fn getIccid(self: *ModemManager, modem_id: []const u8) !?[]const u8 {
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
                        // Only warn once per ICCID to avoid log spam
                        if (!self.warned_iccids.contains(iccid)) {
                            std.log.warn("Using fallback ICCID {s} for modem {s} (SIM {s})", .{ iccid, modem_id, sim_num });
                            const iccid_key = try self.allocator.dupe(u8, iccid);
                            self.warned_iccids.put(iccid_key, {}) catch |err| {
                                std.log.warn("Failed to cache ICCID warning: {any}", .{err});
                                self.allocator.free(iccid_key);
                            };
                        }
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

    pub fn getSignalQuality(self: ModemManager, modem_id: []const u8) !SignalData {
        // First enable signal monitoring with a 5-second refresh rate
        _ = std.process.Child.run(.{
            .allocator = self.allocator,
            .argv = &[_][]const u8{ "mmcli", "-m", modem_id, "--signal-setup=5" },
        }) catch |err| {
            std.log.debug("Signal setup failed for modem {s}: {any}", .{ modem_id, err });
        };
        
        // Wait a moment for signal data to be available
        std.time.sleep(100 * std.time.ns_per_ms);
        
        const result = try std.process.Child.run(.{
            .allocator = self.allocator,
            .argv = &[_][]const u8{ "mmcli", "-m", modem_id, "--signal-get" },
        });
        defer self.allocator.free(result.stdout);
        defer self.allocator.free(result.stderr);

        var signal_percent: u8 = 0;
        var rssi: ?i32 = null;
        var rsrq: ?i32 = null;
        var rsrp: ?i32 = null;
        var snr: ?i32 = null;

        var lines = std.mem.tokenizeScalar(u8, result.stdout, '\n');
        while (lines.next()) |line| {
            const trimmed = std.mem.trim(u8, line, " \t");
            
            // Look for signal quality percentage
            if (std.mem.indexOf(u8, trimmed, "quality:")) |_| {
                if (std.mem.indexOf(u8, trimmed, ": ")) |pos| {
                    const value_str = std.mem.trim(u8, trimmed[pos + 2 ..], " %'\"");
                    if (std.fmt.parseInt(u8, value_str, 10)) |value| {
                        signal_percent = value;
                    } else |_| {}
                }
            }
            
            // Look for RSSI
            if (std.mem.indexOf(u8, trimmed, "rssi:")) |_| {
                if (std.mem.indexOf(u8, trimmed, ": ")) |pos| {
                    const value_str = std.mem.trim(u8, trimmed[pos + 2 ..], " dBm'\"");
                    // Handle float values like -49.00
                    if (std.fmt.parseFloat(f32, value_str)) |value| {
                        rssi = @intFromFloat(value);
                    } else |_| {}
                }
            }
            
            // Look for RSRQ
            if (std.mem.indexOf(u8, trimmed, "rsrq:")) |_| {
                if (std.mem.indexOf(u8, trimmed, ": ")) |pos| {
                    const value_str = std.mem.trim(u8, trimmed[pos + 2 ..], " dB'\"");
                    if (std.fmt.parseFloat(f32, value_str)) |value| {
                        rsrq = @intFromFloat(value);
                    } else |_| {}
                }
            }
            
            // Look for RSRP
            if (std.mem.indexOf(u8, trimmed, "rsrp:")) |_| {
                if (std.mem.indexOf(u8, trimmed, ": ")) |pos| {
                    const value_str = std.mem.trim(u8, trimmed[pos + 2 ..], " dBm'\"");
                    if (std.fmt.parseFloat(f32, value_str)) |value| {
                        rsrp = @intFromFloat(value);
                    } else |_| {}
                }
            }
            
            // Look for SNR (s/n in mmcli output)
            if (std.mem.indexOf(u8, trimmed, "s/n:") != null) {
                if (std.mem.indexOf(u8, trimmed, ": ")) |pos| {
                    const value_str = std.mem.trim(u8, trimmed[pos + 2 ..], " dB'\"");
                    if (std.fmt.parseFloat(f32, value_str)) |value| {
                        snr = @intFromFloat(value);
                    } else |_| {}
                }
            }
        }

        // Calculate signal percentage from RSSI if not provided
        if (signal_percent == 0 and rssi != null) {
            // Map RSSI to percentage (rough approximation)
            // -50 dBm = excellent (100%)
            // -80 dBm = good (50%) 
            // -100 dBm = poor (0%)
            const rssi_val = rssi.?;
            if (rssi_val >= -50) {
                signal_percent = 100;
            } else if (rssi_val <= -100) {
                signal_percent = 0;
            } else {
                // Linear interpolation between -50 and -100
                const normalized = @as(f32, @floatFromInt(rssi_val + 100)) / 50.0;
                signal_percent = @intFromFloat(normalized * 100.0);
            }
        }
        
        return SignalData{
            .signal_percent = signal_percent,
            .rssi = rssi,
            .rsrq = rsrq,
            .rsrp = rsrp,
            .snr = snr,
        };
    }

    pub fn getNewMessages(self: *ModemManager, modem_id: []const u8) ![]MessageInfo {
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

    fn getSmsDetails(self: *ModemManager, sms_id: []const u8, modem_id: []const u8) !MessageInfo {
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

    pub fn sendSms(self: ModemManager, modem_id: []const u8, recipient: []const u8, content: []const u8) ![]const u8 {
        std.log.info("📤 Sending SMS from modem {s} to {s}: {s}", .{ modem_id, recipient, content });
        
        const sms_arg = try std.fmt.allocPrint(self.allocator, "text={s},number={s}", .{content, recipient});
        defer self.allocator.free(sms_arg);
        
        const result = try std.process.Child.run(.{
            .allocator = self.allocator,
            .argv = &[_][]const u8{ "mmcli", "-m", modem_id, "--messaging-create-sms", sms_arg },
        });
        defer self.allocator.free(result.stdout);
        defer self.allocator.free(result.stderr);

        if (result.term.Exited != 0) {
            std.log.warn("Failed to create SMS on modem {s}: {s}", .{ modem_id, result.stderr });
            return error.SmsCreateFailed;
        }

        // Extract SMS ID from output (format: "Successfully created SMS: /org/freedesktop/ModemManager1/SMS/XX")
        var sms_id: []const u8 = "";
        var lines = std.mem.tokenizeScalar(u8, result.stdout, '\n');
        while (lines.next()) |line| {
            if (std.mem.indexOf(u8, line, "/SMS/")) |pos| {
                const start = pos + 5;
                var end = start;
                while (end < line.len and line[end] != ' ' and line[end] != '\n') : (end += 1) {}
                sms_id = line[start..end];
                break;
            }
        }

        if (sms_id.len == 0) {
            std.log.warn("Could not extract SMS ID from: {s}", .{result.stdout});
            return error.SmsIdNotFound;
        }

        // Send the SMS
        const send_result = try std.process.Child.run(.{
            .allocator = self.allocator,
            .argv = &[_][]const u8{ "mmcli", "-s", sms_id, "--send" },
        });
        defer self.allocator.free(send_result.stdout);
        defer self.allocator.free(send_result.stderr);

        if (send_result.term.Exited != 0) {
            std.log.warn("Failed to send SMS {s}: {s}", .{ sms_id, send_result.stderr });
            return error.SmsSendFailed;
        }

        std.log.info("✅ Successfully sent SMS {s} to {s}", .{ sms_id, recipient });
        return try self.allocator.dupe(u8, sms_id);
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
    defer modem_manager.deinit();
    var api_client = ApiClient.init(allocator, config);
    defer api_client.deinit();
    var signal_cache = SignalCache.init(allocator);
    defer signal_cache.deinit();
    
    // Send initial heartbeat
    api_client.sendHeartbeat() catch |err| {
        std.log.warn("Failed to send initial heartbeat: {any}", .{err});
    };
    
    var last_heartbeat_time = std.time.milliTimestamp();
    const heartbeat_interval_ms: i64 = 60000; // 60 seconds
    
    // Separate timing for SMS (10Hz = 100ms) and signal updates (0.2Hz = 5000ms)
    var last_signal_check = std.time.milliTimestamp();
    const sms_interval_ms: i64 = 100; // 10Hz for SMS
    const signal_interval_ms: i64 = 5000; // 0.2Hz for signal
    
    while (true) {
        const now = std.time.milliTimestamp();
        
        // Check if it's time for signal updates
        const should_check_signal = (now - last_signal_check) >= signal_interval_ms;
        if (should_check_signal) {
            last_signal_check = now;
        }
        
        // Get list of all modems
        const modems = modem_manager.getModemList() catch |err| {
            std.log.err("Failed to get modem list: {any}", .{err});
            std.time.sleep(sms_interval_ms * std.time.ns_per_ms);
            continue;
        };
        defer {
            for (modems) |modem_id| {
                allocator.free(modem_id);
            }
            allocator.free(modems);
        }

        if (should_check_signal) {
            std.log.info("🔄 Starting parallel phone updates for {d} modems (with signal check)", .{modems.len});
        }
        
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
                .signal_cache = &signal_cache,
                .modem_id = modem_id_copy,
                .check_signal = should_check_signal,
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
            defer allocator.free(new_messages); // Free the slice returned by getNewMessages

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

        // Check for pending SMS to send
        if (api_client.getPendingSMS()) |response| {
            defer allocator.free(response);
            
            // Parse JSON response
            if (json.parseFromSlice(json.Value, allocator, response, .{})) |parsed_response| {
                defer parsed_response.deinit();
                
                if (parsed_response.value.object.get("pending_messages")) |messages_value| {
                    if (messages_value.array.items.len > 0) {
                        std.log.info("📤 Found {d} pending SMS to send", .{messages_value.array.items.len});
                        
                        for (messages_value.array.items) |msg| {
                            const phone_iccid = msg.object.get("phone_iccid").?.string;
                            const recipient = msg.object.get("recipient").?.string;
                            const content = msg.object.get("content").?.string;
                            const message_id = msg.object.get("id").?.string;
                            
                            // Find modem with matching ICCID
                            var sms_sent = false;
                            for (modems) |modem_id| {
                                const modem_iccid = modem_manager.getIccid(modem_id) catch continue;
                                if (modem_iccid != null and std.mem.eql(u8, modem_iccid.?, phone_iccid)) {
                                    // Send SMS
                                    if (modem_manager.sendSms(modem_id, recipient, content)) |sms_id| {
                                        defer allocator.free(sms_id);
                                        
                                        std.log.info("✅ Sent SMS {s} with ID {s}", .{ message_id, sms_id });
                                        
                                        // Update message status to sent
                                        api_client.updateSMSResult(message_id, true, sms_id, null) catch |err| {
                                            std.log.warn("Failed to update SMS status for {s}: {any}", .{ message_id, err });
                                        };
                                        
                                        sms_sent = true;
                                        break;
                                    } else |err| {
                                        std.log.warn("Failed to send SMS {s}: {any}", .{ message_id, err });
                                        
                                        // Update message status to failed
                                        const error_msg = try std.fmt.allocPrint(allocator, "Send failed: {any}", .{err});
                                        defer allocator.free(error_msg);
                                        
                                        api_client.updateSMSResult(message_id, false, null, error_msg) catch |update_err| {
                                            std.log.warn("Failed to update SMS status for {s}: {any}", .{ message_id, update_err });
                                        };
                                        
                                        sms_sent = true; // Don't try other modems for this message
                                        break;
                                    }
                                }
                            }
                            
                            // If no matching modem found, mark as failed
                            if (!sms_sent) {
                                const error_msg = try std.fmt.allocPrint(allocator, "No modem found with ICCID {s}", .{phone_iccid});
                                defer allocator.free(error_msg);
                                
                                api_client.updateSMSResult(message_id, false, null, error_msg) catch |err| {
                                    std.log.warn("Failed to update SMS status for {s}: {any}", .{ message_id, err });
                                };
                            }
                        }
                    }
                }
            } else |err| {
                std.log.warn("Failed to parse pending SMS response: {any}", .{err});
            }
        } else |err| {
            std.log.debug("No pending SMS or failed to get: {any}", .{err});
        }

        // Send heartbeat if it's time
        const current_time = std.time.milliTimestamp();
        if (current_time - last_heartbeat_time >= heartbeat_interval_ms) {
            api_client.sendHeartbeat() catch |err| {
                std.log.warn("Failed to send heartbeat: {any}", .{err});
            };
            last_heartbeat_time = current_time;
        }

        // Wait before next poll - use SMS interval for high-frequency checking
        std.time.sleep(sms_interval_ms * std.time.ns_per_ms);
    }
}