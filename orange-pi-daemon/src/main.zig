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
        
        // Always upload phone status updates - signal data is optional
        var has_signal_update = false;
        
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
                    has_signal_update = true;
                    
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
                        std.log.debug("🧵 Thread: Modem {s} has no cached signal data during signal check", .{ self.modem_id });
                        // Continue with upload even without signal data
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
                    std.log.debug("🧵 Thread: Modem {s} has no cached signal data after retrieval failure", .{ self.modem_id });
                    // Continue with upload even without signal data
                }
            }
        } else {
            // Use cached signal data if available, but don't skip upload if missing
            if (self.signal_cache.cache.get(self.modem_id)) |cached| {
                phone.signal = cached.signal_data.signal_percent;
                phone.rssi = cached.signal_data.rssi;
                phone.rsrq = cached.signal_data.rsrq;
                phone.rsrp = cached.signal_data.rsrp;
                phone.snr = cached.signal_data.snr;
                std.log.debug("🧵 Thread: Modem {s} using cached signal: {}%", .{ self.modem_id, cached.signal_data.signal_percent });
            } else {
                std.log.debug("🧵 Thread: Modem {s} has no cached signal data - uploading status without signal", .{ self.modem_id });
                // Phone status upload proceeds without signal data
            }
        }
        
        // Always upload phone status - signal data is optional
        const upload_reason = if (has_signal_update) "with signal update" else if (phone.signal != null) "with cached signal" else "status only";
        std.log.info("🧵 Thread: Uploading phone {s} ({s}): signal={?}", .{ phone.id, upload_reason, phone.signal });
        
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

        try self.makeRequest("/phones", payload);
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

        try self.makeRequest("/phones", payload);
        std.log.info("✅ Uploaded {d} phones via HTTP API", .{phones.len});
    }

    pub fn uploadMessages(self: *ApiClient, messages: []const Message) !void {
        if (messages.len == 0) return;
        
        self.mutex.lock();
        defer self.mutex.unlock();

        std.log.debug("📱 Preparing to upload {d} messages:", .{messages.len});
        for (messages, 0..) |msg, i| {
            std.log.debug("  Message {d}: phone_iccid={s}, phone_number={s}, content={s}, timestamp={s}", .{ i, msg.phone_iccid, msg.phone_number, msg.content, msg.timestamp });
            std.log.debug("🔍 MESSAGE UPLOAD DEBUG - Message {d}: content={s}, timestamp={s}, iccid={s}", .{ i, msg.content, msg.timestamp, msg.phone_iccid });
        }

        const messages_json = try json.stringifyAlloc(self.allocator, messages, .{ .emit_null_optional_fields = false });
        defer self.allocator.free(messages_json);
        
        std.log.debug("📄 Messages JSON payload length: {d} bytes", .{messages_json.len});

        const payload = try std.fmt.allocPrint(self.allocator, "{{\"messages\":{s}}}", .{messages_json});
        defer self.allocator.free(payload);
        
        std.log.debug("📦 Final payload length: {d} bytes", .{payload.len});

        try self.makeRequest("/messages", payload);
        std.log.info("✅ Uploaded {d} messages via HTTP API", .{messages.len});
    }

    fn makeRequest(self: *ApiClient, endpoint: []const u8, payload: []const u8) !void {
        const url_str = std.fmt.allocPrint(self.allocator, "{s}/api/control{s}", .{ self.config.api_url, endpoint }) catch |err| {
            std.log.warn("❌ Failed to allocate URL string: {any}", .{err});
            return err;
        };
        defer self.allocator.free(url_str);
        
        const uri = std.Uri.parse(url_str) catch |err| {
            std.log.warn("❌ Failed to parse URL {s}: {any}", .{ url_str, err });
            return err;
        };
        
        // Retry configuration
        const max_retries = 3;
        const base_delay_ms = 1000; // 1 second base delay
        
        var attempt: u32 = 0;
        while (attempt < max_retries) : (attempt += 1) {
            // Create a new HTTP client for this request (thread-safe)
            var http_client = http.Client{ .allocator = self.allocator };
            defer http_client.deinit();
            
            var server_header_buffer: [16 * 1024]u8 = undefined;
            
            // Create HTTP request
            const req_result = http_client.open(.POST, uri, .{
                .server_header_buffer = &server_header_buffer,
                .extra_headers = &[_]http.Header{
                    .{ .name = "content-type", .value = "application/json" },
                    .{ .name = "X-API-Key", .value = self.config.api_key },
                },
            });
            
            var req = req_result catch |err| {
                if (attempt < max_retries - 1) {
                    const delay_ms = base_delay_ms * (@as(u64, 1) << @intCast(attempt));
                    std.log.warn("🔄 Failed to open HTTP request to {s} (attempt {d}/{d}): {any}. Retrying in {d}ms...", .{ url_str, attempt + 1, max_retries, err, delay_ms });
                    std.time.sleep(delay_ms * std.time.ns_per_ms);
                    continue;
                } else {
                    std.log.warn("❌ Failed to open HTTP request to {s} after {d} attempts: {any}", .{ url_str, max_retries, err });
                    return err;
                }
            };
            defer req.deinit();
            
            // Set content length
            req.transfer_encoding = .{ .content_length = payload.len };
            
            // Send headers
            req.send() catch |err| {
                if (attempt < max_retries - 1) {
                    const delay_ms = base_delay_ms * (@as(u64, 1) << @intCast(attempt));
                    std.log.warn("🔄 Failed to send HTTP headers to {s} (attempt {d}/{d}): {any}. Retrying in {d}ms...", .{ url_str, attempt + 1, max_retries, err, delay_ms });
                    std.time.sleep(delay_ms * std.time.ns_per_ms);
                    continue;
                } else {
                    std.log.warn("❌ Failed to send HTTP headers to {s} after {d} attempts: {any}", .{ url_str, max_retries, err });
                    return err;
                }
            };
            
            // Write payload
            req.writeAll(payload) catch |err| {
                if (attempt < max_retries - 1) {
                    const delay_ms = base_delay_ms * (@as(u64, 1) << @intCast(attempt));
                    std.log.warn("🔄 Failed to write payload to {s} (attempt {d}/{d}): {any}. Retrying in {d}ms...", .{ url_str, attempt + 1, max_retries, err, delay_ms });
                    std.time.sleep(delay_ms * std.time.ns_per_ms);
                    continue;
                } else {
                    std.log.warn("❌ Failed to write payload to {s} after {d} attempts: {any}", .{ url_str, max_retries, err });
                    return err;
                }
            };
            
            // Finish request
            req.finish() catch |err| {
                if (attempt < max_retries - 1) {
                    const delay_ms = base_delay_ms * (@as(u64, 1) << @intCast(attempt));
                    std.log.warn("🔄 Failed to finish HTTP request to {s} (attempt {d}/{d}): {any}. Retrying in {d}ms...", .{ url_str, attempt + 1, max_retries, err, delay_ms });
                    std.time.sleep(delay_ms * std.time.ns_per_ms);
                    continue;
                } else {
                    std.log.warn("❌ Failed to finish HTTP request to {s} after {d} attempts: {any}", .{ url_str, max_retries, err });
                    return err;
                }
            };
            
            // Wait for response
            req.wait() catch |err| {
                if (attempt < max_retries - 1) {
                    const delay_ms = base_delay_ms * (@as(u64, 1) << @intCast(attempt));
                    std.log.warn("🔄 Failed to wait for response from {s} (attempt {d}/{d}): {any}. Retrying in {d}ms...", .{ url_str, attempt + 1, max_retries, err, delay_ms });
                    std.time.sleep(delay_ms * std.time.ns_per_ms);
                    continue;
                } else {
                    std.log.warn("❌ Failed to wait for response from {s} after {d} attempts: {any}", .{ url_str, max_retries, err });
                    return err;
                }
            };
            
            const status_code = @intFromEnum(req.response.status);
            std.log.debug("📊 HTTP status code: {d}", .{status_code});
            
            // Read response body for logging
            const response_body = req.reader().readAllAlloc(self.allocator, 8192) catch |err| {
                std.log.warn("⚠️ Failed to read response body from {s}: {any}", .{ url_str, err });
                if (status_code == 200) {
                    std.log.info("✅ HTTP request successful for {s}", .{endpoint});
                    return; // Success even without response body
                } else {
                    if (attempt < max_retries - 1) {
                        const delay_ms = base_delay_ms * (@as(u64, 1) << @intCast(attempt));
                        std.log.warn("🔄 HTTP request failed with status {d} (attempt {d}/{d}). Retrying in {d}ms...", .{ status_code, attempt + 1, max_retries, delay_ms });
                        std.time.sleep(delay_ms * std.time.ns_per_ms);
                        continue;
                    } else {
                        std.log.warn("❌ HTTP request failed with status {d} after {d} attempts", .{ status_code, max_retries });
                        return error.HttpRequestFailed;
                    }
                }
            };
            defer self.allocator.free(response_body);
            
            std.log.debug("📡 Raw HTTP response: {s}", .{response_body});
            
            if (status_code == 200) {
                // Success! Log if this was a retry
                if (attempt > 0) {
                    std.log.info("✅ HTTP request successful for {s} after {d} retries", .{ endpoint, attempt + 1 });
                } else {
                    std.log.info("✅ HTTP request successful for {s}", .{endpoint});
                }
                return;
            } else {
                if (attempt < max_retries - 1) {
                    const delay_ms = base_delay_ms * (@as(u64, 1) << @intCast(attempt));
                    std.log.warn("🔄 HTTP request failed with status {d} (attempt {d}/{d}). Retrying in {d}ms...", .{ status_code, attempt + 1, max_retries, delay_ms });
                    std.log.warn("🔄 Response body: {s}", .{response_body});
                    std.time.sleep(delay_ms * std.time.ns_per_ms);
                    continue;
                } else {
                    std.log.warn("❌ HTTP request failed with status {d} after {d} attempts", .{ status_code, max_retries });
                    std.log.warn("❌ Final response body: {s}", .{response_body});
                    return error.HttpRequestFailed;
                }
            }
        }
        
        // Should never reach here due to loop structure, but added for completeness
        std.log.warn("❌ Exhausted all retry attempts for makeRequest to {s}", .{endpoint});
        return error.HttpRequestFailed;
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
        
        try self.makeRequest("/heartbeat", heartbeat_json);
        std.log.info("💓 Sent daemon heartbeat", .{});
    }

    pub fn getPendingSMS(self: *ApiClient) ![]const u8 {
        const url_str = try std.fmt.allocPrint(self.allocator, "{s}/api/control/pending-sms", .{self.config.api_url});
        defer self.allocator.free(url_str);
        
        const uri = std.Uri.parse(url_str) catch |err| {
            std.log.warn("❌ Failed to parse URL {s}: {any}", .{ url_str, err });
            return error.GetPendingFailed;
        };
        
        // Retry configuration
        const max_retries = 3;
        const base_delay_ms = 1000; // 1 second base delay
        
        var attempt: u32 = 0;
        while (attempt < max_retries) : (attempt += 1) {
            // Create a new HTTP client for this request (thread-safe)
            var http_client = http.Client{ .allocator = self.allocator };
            defer http_client.deinit();
            
            var server_header_buffer: [16 * 1024]u8 = undefined;
            
            const req_result = http_client.open(.GET, uri, .{
                .server_header_buffer = &server_header_buffer,
                .extra_headers = &[_]http.Header{
                    .{ .name = "content-type", .value = "application/json" },
                    .{ .name = "X-API-Key", .value = self.config.api_key },
                },
            });
            
            var req = req_result catch |err| {
                if (attempt < max_retries - 1) {
                    const delay_ms = base_delay_ms * (@as(u64, 1) << @intCast(attempt)); // Exponential backoff: 1s, 2s, 4s
                    std.log.warn("🔄 Failed to open HTTP GET request to {s} (attempt {d}/{d}): {any}. Retrying in {d}ms...", .{ url_str, attempt + 1, max_retries, err, delay_ms });
                    std.time.sleep(delay_ms * std.time.ns_per_ms);
                    continue;
                } else {
                    std.log.warn("❌ Failed to open HTTP GET request to {s} after {d} attempts: {any}", .{ url_str, max_retries, err });
                    return error.GetPendingFailed;
                }
            };
            defer req.deinit();
            
            // Send request
            req.send() catch |err| {
                if (attempt < max_retries - 1) {
                    const delay_ms = base_delay_ms * (@as(u64, 1) << @intCast(attempt));
                    std.log.warn("🔄 Failed to send HTTP GET request to {s} (attempt {d}/{d}): {any}. Retrying in {d}ms...", .{ url_str, attempt + 1, max_retries, err, delay_ms });
                    std.time.sleep(delay_ms * std.time.ns_per_ms);
                    continue;
                } else {
                    std.log.warn("❌ Failed to send HTTP GET request to {s} after {d} attempts: {any}", .{ url_str, max_retries, err });
                    return error.GetPendingFailed;
                }
            };
            
            // Finish request (no body for GET)
            req.finish() catch |err| {
                if (attempt < max_retries - 1) {
                    const delay_ms = base_delay_ms * (@as(u64, 1) << @intCast(attempt));
                    std.log.warn("🔄 Failed to finish HTTP GET request to {s} (attempt {d}/{d}): {any}. Retrying in {d}ms...", .{ url_str, attempt + 1, max_retries, err, delay_ms });
                    std.time.sleep(delay_ms * std.time.ns_per_ms);
                    continue;
                } else {
                    std.log.warn("❌ Failed to finish HTTP GET request to {s} after {d} attempts: {any}", .{ url_str, max_retries, err });
                    return error.GetPendingFailed;
                }
            };
            
            // Wait for response
            req.wait() catch |err| {
                if (attempt < max_retries - 1) {
                    const delay_ms = base_delay_ms * (@as(u64, 1) << @intCast(attempt));
                    std.log.warn("🔄 Failed to wait for GET response from {s} (attempt {d}/{d}): {any}. Retrying in {d}ms...", .{ url_str, attempt + 1, max_retries, err, delay_ms });
                    std.time.sleep(delay_ms * std.time.ns_per_ms);
                    continue;
                } else {
                    std.log.warn("❌ Failed to wait for GET response from {s} after {d} attempts: {any}", .{ url_str, max_retries, err });
                    return error.GetPendingFailed;
                }
            };
            
            const status_code = @intFromEnum(req.response.status);
            
            if (status_code != 200) {
                if (attempt < max_retries - 1) {
                    const delay_ms = base_delay_ms * (@as(u64, 1) << @intCast(attempt));
                    std.log.warn("🔄 Failed to get pending SMS: HTTP status {d} (attempt {d}/{d}). Retrying in {d}ms...", .{ status_code, attempt + 1, max_retries, delay_ms });
                    std.time.sleep(delay_ms * std.time.ns_per_ms);
                    continue;
                } else {
                    std.log.warn("❌ Failed to get pending SMS after {d} attempts: HTTP status {d}", .{ max_retries, status_code });
                    return error.GetPendingFailed;
                }
            }
            
            // Read response body and return it (caller owns this memory)
            const response_body = req.reader().readAllAlloc(self.allocator, 1024 * 1024) catch |err| {
                if (attempt < max_retries - 1) {
                    const delay_ms = base_delay_ms * (@as(u64, 1) << @intCast(attempt));
                    std.log.warn("🔄 Failed to read GET response body from {s} (attempt {d}/{d}): {any}. Retrying in {d}ms...", .{ url_str, attempt + 1, max_retries, err, delay_ms });
                    std.time.sleep(delay_ms * std.time.ns_per_ms);
                    continue;
                } else {
                    std.log.warn("❌ Failed to read GET response body from {s} after {d} attempts: {any}", .{ url_str, max_retries, err });
                    return error.GetPendingFailed;
                }
            };
            
            // Success! Log if this was a retry
            if (attempt > 0) {
                std.log.info("✅ Successfully got pending SMS after {d} retries", .{attempt + 1});
            }
            
            return response_body; // Caller owns this memory
        }
        
        // Should never reach here due to loop structure, but added for completeness
        std.log.warn("❌ Exhausted all retry attempts for getPendingSMS", .{});
        return error.GetPendingFailed;
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

        try self.makeRequest("/sms-result", update_json);
        std.log.info("📝 Updated SMS status for message {s}: success={}", .{ message_id, success });
    }
};

// Modem Manager
const ModemManager = struct {
    allocator: std.mem.Allocator,
    warned_iccids: std.HashMap([]const u8, void, std.hash_map.StringContext, std.hash_map.default_max_load_percentage),
    failed_sms_ids: std.HashMap([]const u8, void, std.hash_map.StringContext, std.hash_map.default_max_load_percentage),

    pub fn init(allocator: std.mem.Allocator) ModemManager {
        return .{ 
            .allocator = allocator,
            .warned_iccids = std.HashMap([]const u8, void, std.hash_map.StringContext, std.hash_map.default_max_load_percentage).init(allocator),
            .failed_sms_ids = std.HashMap([]const u8, void, std.hash_map.StringContext, std.hash_map.default_max_load_percentage).init(allocator),
        };
    }
    
    pub fn deinit(self: *ModemManager) void {
        var iterator = self.warned_iccids.iterator();
        while (iterator.next()) |entry| {
            self.allocator.free(entry.key_ptr.*);
        }
        self.warned_iccids.deinit();
        
        var failed_iterator = self.failed_sms_ids.iterator();
        while (failed_iterator.next()) |entry| {
            self.allocator.free(entry.key_ptr.*);
        }
        self.failed_sms_ids.deinit();
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

                // Skip SMS IDs that previously failed to delete
                const sms_modem_key = try std.fmt.allocPrint(self.allocator, "{s}:{s}", .{ modem_id, sms_id_str });
                defer self.allocator.free(sms_modem_key);
                
                if (self.failed_sms_ids.contains(sms_modem_key)) {
                    std.log.info("Skipping SMS {s} on modem {s} (previously failed to delete)", .{ sms_id_str, modem_id });
                    continue;
                }

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
            // Get current time - std.time.timestamp() returns UTC seconds since epoch
            const utc_timestamp = std.time.timestamp();
            const now_ms = @rem(@as(u64, @intCast(std.time.milliTimestamp())), 1000);
            
            std.log.info("⏰ Using current UTC timestamp: {d}", .{utc_timestamp});
            
            // Convert Unix timestamp to broken down time (UTC)
            const secs_per_day = 86400;
            const days_since_epoch = @divFloor(utc_timestamp, secs_per_day);
            const secs_today = @rem(utc_timestamp, secs_per_day);
            
            // Calculate year, month, day using proper algorithm
            var year: u32 = 1970;
            var days_left = days_since_epoch;
            
            // Handle years (accounting for leap years)
            while (true) {
                const days_in_year: u32 = if (isLeapYear(year)) 366 else 365;
                if (days_left < days_in_year) break;
                days_left -= days_in_year;
                year += 1;
            }
            
            // Calculate month and day
            const days_in_months = if (isLeapYear(year)) 
                [_]u32{ 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31 }
            else 
                [_]u32{ 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31 };
            
            var month: u32 = 1;
            for (days_in_months) |days_in_month| {
                if (days_left < days_in_month) break;
                days_left -= days_in_month;
                month += 1;
            }
            const day = days_left + 1;
            
            // Calculate time components
            const hours = @divFloor(secs_today, 3600);
            const minutes = @divFloor(@rem(secs_today, 3600), 60);
            const seconds = @rem(secs_today, 60);
            
            return try std.fmt.allocPrint(self.allocator, "{d:0>4}-{d:0>2}-{d:0>2}T{d:0>2}:{d:0>2}:{d:0>2}.{d:0>3}Z", .{
                year, month, day, hours, minutes, seconds, now_ms
            });
        }

        if (std.mem.endsWith(u8, raw_timestamp, "Z")) {
            return try self.allocator.dupe(u8, raw_timestamp);
        }

        if (std.mem.indexOf(u8, raw_timestamp, "+")) |plus_pos| {
            // Extract timezone offset (e.g., "+08:00" or "+0800")
            const base = raw_timestamp[0..plus_pos];
            const offset_str = raw_timestamp[plus_pos+1..];
            
            // Parse offset hours (handle both "+08:00" and "+0800" formats)
            var offset_hours: i32 = 0;
            if (offset_str.len >= 2) {
                offset_hours = std.fmt.parseInt(i32, offset_str[0..2], 10) catch 0;
            }
            
            std.log.debug("⏰ SMS timestamp with offset: raw='{s}', base='{s}', offset=+{d}h", .{ raw_timestamp, base, offset_hours });
            
            // Parse the base timestamp and adjust for timezone
            if (parseLocalTimestamp(base)) |local_time| {
                // Subtract the timezone offset to get UTC
                const utc_timestamp = local_time - (@as(i64, offset_hours) * 3600);
                
                // Convert back to formatted timestamp
                const secs_per_day = 86400;
                const days_since_epoch = @divFloor(utc_timestamp, secs_per_day);
                const secs_today = @rem(utc_timestamp, secs_per_day);
                
                // Calculate year, month, day
                var year: u32 = 1970;
                var days_left = days_since_epoch;
                
                while (true) {
                    const days_in_year: u32 = if (isLeapYear(year)) 366 else 365;
                    if (days_left < days_in_year) break;
                    days_left -= days_in_year;
                    year += 1;
                }
                
                const days_in_months = if (isLeapYear(year)) 
                    [_]u32{ 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31 }
                else 
                    [_]u32{ 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31 };
                
                var month: u32 = 1;
                for (days_in_months) |days_in_month| {
                    if (days_left < days_in_month) break;
                    days_left -= days_in_month;
                    month += 1;
                }
                const day = days_left + 1;
                
                const hours = @divFloor(secs_today, 3600);
                const minutes = @divFloor(@rem(secs_today, 3600), 60);
                const seconds = @rem(secs_today, 60);
                
                return try std.fmt.allocPrint(self.allocator, "{d:0>4}-{d:0>2}-{d:0>2}T{d:0>2}:{d:0>2}:{d:0>2}.000Z", .{
                    year, month, day, hours, minutes, seconds
                });
            } else |_| {
                // Fallback: try to parse and reformat with proper padding
                // Handle timestamps with single-digit hours/minutes like "2025-07-29T2:0:17"
                if (base.len >= 10) {
                    // Try to extract components manually for more lenient parsing
                    var parts = std.mem.tokenizeAny(u8, base, "-T: ");
                    
                    const year_str = parts.next() orelse return try std.fmt.allocPrint(self.allocator, "{s}.000Z", .{base});
                    const month_str = parts.next() orelse return try std.fmt.allocPrint(self.allocator, "{s}.000Z", .{base});
                    const day_str = parts.next() orelse return try std.fmt.allocPrint(self.allocator, "{s}.000Z", .{base});
                    const hour_str = parts.next() orelse return try std.fmt.allocPrint(self.allocator, "{s}.000Z", .{base});
                    const minute_str = parts.next() orelse return try std.fmt.allocPrint(self.allocator, "{s}.000Z", .{base});
                    const second_str = parts.next() orelse "0";
                    
                    const year = std.fmt.parseInt(u32, year_str, 10) catch return try std.fmt.allocPrint(self.allocator, "{s}.000Z", .{base});
                    const month = std.fmt.parseInt(u32, month_str, 10) catch return try std.fmt.allocPrint(self.allocator, "{s}.000Z", .{base});
                    const day = std.fmt.parseInt(u32, day_str, 10) catch return try std.fmt.allocPrint(self.allocator, "{s}.000Z", .{base});
                    const hour = std.fmt.parseInt(u32, hour_str, 10) catch return try std.fmt.allocPrint(self.allocator, "{s}.000Z", .{base});
                    const minute = std.fmt.parseInt(u32, minute_str, 10) catch return try std.fmt.allocPrint(self.allocator, "{s}.000Z", .{base});
                    const second = std.fmt.parseInt(u32, second_str, 10) catch 0;
                    
                    // Reformat with proper padding
                    return try std.fmt.allocPrint(self.allocator, "{d:0>4}-{d:0>2}-{d:0>2}T{d:0>2}:{d:0>2}:{d:0>2}.000Z", .{
                        year, month, day, hour, minute, second
                    });
                }
                
                // Last resort fallback
                return try std.fmt.allocPrint(self.allocator, "{s}.000Z", .{base});
            }
        }

        // Handle SMS timestamps without timezone info
        // ModemManager on Orange Pi provides timestamps in LOCAL time (Beijing/UTC+8)
        // Always convert from Beijing time to UTC
        std.log.debug("⏰ SMS timestamp processing: raw='{s}' (assuming Beijing time)", .{raw_timestamp});
        
        // Parse the timestamp components
        if (parseLocalTimestamp(raw_timestamp)) |beijing_time| {
            // ALWAYS convert from Beijing time to UTC by subtracting 8 hours
            // This ensures consistent behavior regardless of when the message is processed
            const utc_timestamp = beijing_time - (8 * 3600);
            
            // Convert back to broken down time for formatting
            const secs_per_day = 86400;
            const days_since_epoch = @divFloor(utc_timestamp, secs_per_day);
            const secs_today = @rem(utc_timestamp, secs_per_day);
            
            // Calculate year, month, day using proper algorithm
            var year: u32 = 1970;
            var days_left = days_since_epoch;
            
            // Handle years (accounting for leap years)
            while (true) {
                const days_in_year: u32 = if (isLeapYear(year)) 366 else 365;
                if (days_left < days_in_year) break;
                days_left -= days_in_year;
                year += 1;
            }
            
            // Calculate month and day
            const days_in_months = if (isLeapYear(year)) 
                [_]u32{ 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31 }
            else 
                [_]u32{ 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31 };
            
            var month: u32 = 1;
            for (days_in_months) |days_in_month| {
                if (days_left < days_in_month) break;
                days_left -= days_in_month;
                month += 1;
            }
            const day = days_left + 1;
            
            // Calculate time components
            const hours = @divFloor(secs_today, 3600);
            const minutes = @divFloor(@rem(secs_today, 3600), 60);
            const seconds = @rem(secs_today, 60);
            
            const utc_formatted = try std.fmt.allocPrint(self.allocator, "{d:0>4}-{d:0>2}-{d:0>2}T{d:0>2}:{d:0>2}:{d:0>2}.000Z", .{
                year, month, day, hours, minutes, seconds
            });
            
            std.log.debug("⏰ SMS timestamp converted: '{s}' -> '{s}' (subtracted 8h for UTC)", .{ raw_timestamp, utc_formatted });
            return utc_formatted;
        } else |err| {
            // Fallback: if parsing fails, log the error and assume Beijing time
            std.log.warn("⚠️  Failed to parse timestamp '{s}': {any}, assuming Beijing time and converting to UTC", .{raw_timestamp, err});
            
            // Try a more lenient parsing approach
            // If the timestamp looks like ISO format but parsing failed, it might be missing seconds or have extra chars
            if (raw_timestamp.len >= 16) {
                // Try to extract just the date and time parts
                const clean_timestamp = if (raw_timestamp.len > 19) raw_timestamp[0..19] else raw_timestamp;
                
                // If it's too short, pad with zeros
                const padded = if (clean_timestamp.len == 16) 
                    try std.fmt.allocPrint(self.allocator, "{s}:00", .{clean_timestamp})
                else 
                    try self.allocator.dupe(u8, clean_timestamp);
                defer if (clean_timestamp.len == 16) self.allocator.free(padded);
                
                // Try parsing again with the cleaned timestamp
                if (parseLocalTimestamp(padded)) |beijing_time| {
                    // Convert Beijing time to UTC
                    const utc_time = beijing_time - (8 * 3600);
                    
                    // Format as UTC
                    const secs_per_day = 86400;
                    const days_since_epoch = @divFloor(utc_time, secs_per_day);
                    const secs_today = @rem(utc_time, secs_per_day);
                    
                    // Calculate components
                    var year: u32 = 1970;
                    var days_left = days_since_epoch;
                    
                    while (true) {
                        const days_in_year: u32 = if (isLeapYear(year)) 366 else 365;
                        if (days_left < days_in_year) break;
                        days_left -= days_in_year;
                        year += 1;
                    }
                    
                    const days_in_months = if (isLeapYear(year)) 
                        [_]u32{ 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31 }
                    else 
                        [_]u32{ 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31 };
                    
                    var month: u32 = 1;
                    for (days_in_months) |days_in_month| {
                        if (days_left < days_in_month) break;
                        days_left -= days_in_month;
                        month += 1;
                    }
                    const day = days_left + 1;
                    
                    const hours = @divFloor(secs_today, 3600);
                    const minutes = @divFloor(@rem(secs_today, 3600), 60);
                    const seconds = @rem(secs_today, 60);
                    
                    const utc_formatted = try std.fmt.allocPrint(self.allocator, "{d:0>4}-{d:0>2}-{d:0>2}T{d:0>2}:{d:0>2}:{d:0>2}.000Z", .{
                        year, month, day, hours, minutes, seconds
                    });
                    
                    std.log.info("⏰ Fallback timestamp converted: '{s}' -> '{s}' (Beijing to UTC)", .{ raw_timestamp, utc_formatted });
                    return utc_formatted;
                } else |_| {}
            }
            
            // Last resort: return current UTC time
            std.log.err("⚠️  Could not parse timestamp '{s}' at all, using current UTC time", .{raw_timestamp});
            const utc_timestamp = std.time.timestamp();
            
            // Format current UTC time
            const secs_per_day = 86400;
            const days_since_epoch = @divFloor(utc_timestamp, secs_per_day);
            const secs_today = @rem(utc_timestamp, secs_per_day);
            
            var year: u32 = 1970;
            var days_left = days_since_epoch;
            
            while (true) {
                const days_in_year: u32 = if (isLeapYear(year)) 366 else 365;
                if (days_left < days_in_year) break;
                days_left -= days_in_year;
                year += 1;
            }
            
            const days_in_months = if (isLeapYear(year)) 
                [_]u32{ 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31 }
            else 
                [_]u32{ 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31 };
            
            var month: u32 = 1;
            for (days_in_months) |days_in_month| {
                if (days_left < days_in_month) break;
                days_left -= days_in_month;
                month += 1;
            }
            const day = days_left + 1;
            
            const hours = @divFloor(secs_today, 3600);
            const minutes = @divFloor(@rem(secs_today, 3600), 60);
            const seconds = @rem(secs_today, 60);
            
            return try std.fmt.allocPrint(self.allocator, "{d:0>4}-{d:0>2}-{d:0>2}T{d:0>2}:{d:0>2}:{d:0>2}.000Z", .{
                year, month, day, hours, minutes, seconds
            });
        }
    }
    
    fn isLeapYear(year: u32) bool {
        return (year % 4 == 0 and year % 100 != 0) or (year % 400 == 0);
    }
    
    fn parseLocalTimestamp(timestamp_str: []const u8) !i64 {
        // Parse timestamp format: "2025-07-28 16:04:39" or "2025-07-28T16:04:39"
        // Expected to be in Asia/Shanghai timezone (+8)
        
        if (timestamp_str.len < 19) return error.InvalidTimestamp;
        
        // Extract date part: "2025-07-28"
        const year = try std.fmt.parseInt(u32, timestamp_str[0..4], 10);
        const month = try std.fmt.parseInt(u32, timestamp_str[5..7], 10);
        const day = try std.fmt.parseInt(u32, timestamp_str[8..10], 10);
        
        // Extract time part: "16:04:39" (can be after space or 'T')
        const time_start = if (timestamp_str[10] == ' ' or timestamp_str[10] == 'T') 11 else return error.InvalidTimestamp;
        
        const hour = try std.fmt.parseInt(u32, timestamp_str[time_start..time_start+2], 10);
        const minute = try std.fmt.parseInt(u32, timestamp_str[time_start+3..time_start+5], 10);
        const second = try std.fmt.parseInt(u32, timestamp_str[time_start+6..time_start+8], 10);
        
        // Validate ranges
        if (month < 1 or month > 12) return error.InvalidTimestamp;
        if (day < 1 or day > 31) return error.InvalidTimestamp;
        if (hour > 23 or minute > 59 or second > 59) return error.InvalidTimestamp;
        
        // Convert to Unix timestamp (assuming local time in Asia/Shanghai)
        // Calculate days since Unix epoch (1970-01-01)
        var days_since_epoch: i64 = 0;
        
        // Add days for complete years
        var y: u32 = 1970;
        while (y < year) : (y += 1) {
            days_since_epoch += if (isLeapYear(y)) 366 else 365;
        }
        
        // Add days for complete months in current year
        const days_in_months = if (isLeapYear(year)) 
            [_]u32{ 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31 }
        else 
            [_]u32{ 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31 };
        
        var m: u32 = 1;
        while (m < month) : (m += 1) {
            days_since_epoch += days_in_months[m - 1];
        }
        
        // Add remaining days
        days_since_epoch += @as(i64, @intCast(day - 1));
        
        // Convert to seconds and add time components
        const seconds_since_epoch = days_since_epoch * 86400 + 
            @as(i64, @intCast(hour)) * 3600 + 
            @as(i64, @intCast(minute)) * 60 + 
            @as(i64, @intCast(second));
        
        return seconds_since_epoch;
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
            // Check if the error is because the SMS doesn't exist
            if (std.mem.indexOf(u8, result.stderr, "not found") != null or
                std.mem.indexOf(u8, result.stderr, "doesn't exist") != null or
                std.mem.indexOf(u8, result.stderr, "No SMS") != null or
                std.mem.indexOf(u8, result.stderr, "couldn't find SMS") != null) {
                std.log.info("✅ SMS {s} no longer exists on modem {s} (already deleted)", .{ sms_id, modem_id });
            } else {
                std.log.debug("🔍 DELETE FAILURE DEBUG - Failed to delete SMS {s} from modem {s}. Exit code: {}, stderr: {s}", .{ sms_id, modem_id, result.term.Exited, result.stderr });
                return error.SmsDeleteFailed;
            }
        } else {
            std.log.info("✅ Successfully deleted SMS {s} from modem {s}", .{ sms_id, modem_id });
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
            std.log.warn("Failed to create SMS on modem {s}: exit_code={d}", .{ modem_id, result.term.Exited });
            std.log.warn("SMS creation stderr: {s}", .{result.stderr});
            std.log.warn("SMS creation stdout: {s}", .{result.stdout});
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
            std.log.warn("Failed to send SMS {s}: exit_code={d}", .{ sms_id, send_result.term.Exited });
            std.log.warn("SMS send stderr: {s}", .{send_result.stderr});
            std.log.warn("SMS send stdout: {s}", .{send_result.stdout});
            return error.SmsSendFailed;
        }

        std.log.info("✅ Successfully sent SMS {s} to {s}", .{ sms_id, recipient });
        return try self.allocator.dupe(u8, sms_id);
    }
};

pub fn main() !void {
    var gpa = std.heap.GeneralPurposeAllocator(.{ .thread_safe = true }){};
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
        
        // If no modems found, mark all phones as offline
        if (modems.len == 0) {
            std.log.warn("⚠️  No modems found - marking all phones as offline", .{});
            
            // Create a special offline status update
            const offline_phone = Phone{
                .id = "ALL_PHONES_OFFLINE",
                .iccid = "ALL_PHONES_OFFLINE",
                .number = null,
                .status = "offline",
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
            
            // Send special offline status to server
            api_client.uploadPhone(offline_phone) catch |err| {
                std.log.warn("Failed to mark phones as offline: {any}", .{err});
            };
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
                std.log.debug("📬 Found {d} new messages on modem {s}", .{ new_messages.len, modem_id });
                total_new_messages += new_messages.len;

                for (new_messages, 0..) |message_info, i| {
                    std.log.debug("  📨 Message {d}: SMS_ID={s}, ICCID={s}, from={s}", .{ 
                        i, message_info.sms_id, message_info.message.phone_iccid, message_info.message.phone_number 
                    });
                    
                    // Append the message info directly
                    try all_message_infos.append(message_info);
                }
            }
        }

        // Upload messages if we have any
        if (all_message_infos.items.len > 0) {
            // Deduplicate messages before uploading
            var seen_messages = std.hash_map.HashMap([]const u8, bool, std.hash_map.StringContext, 80).init(allocator);
            defer seen_messages.deinit();
            
            var unique_message_infos = std.ArrayList(MessageInfo).init(allocator);
            defer unique_message_infos.deinit();
            
            for (all_message_infos.items) |info| {
                // Create a unique key for each message
                const key = try std.fmt.allocPrint(allocator, "{s}|{s}|{s}", .{
                    info.message.phone_iccid,
                    info.message.content,
                    info.message.timestamp
                });
                defer allocator.free(key);
                
                if (!seen_messages.contains(key)) {
                    try seen_messages.put(key, true);
                    try unique_message_infos.append(info);
                    std.log.debug("✅ DEDUP DEBUG - Keeping message: content={s}, timestamp={s}, key={s}", .{ info.message.content, info.message.timestamp, key });
                } else {
                    std.log.debug("⚠️  DEDUP DEBUG - Skipping duplicate in batch: content={s}, timestamp={s}, key={s}", .{ 
                        info.message.content, info.message.timestamp, key
                    });
                    
                    // Free the duplicate's memory
                    allocator.free(info.modem_id);
                    allocator.free(info.sms_id);
                    allocator.free(info.message.phone_number);
                    allocator.free(info.message.content);
                    allocator.free(info.message.timestamp);
                    allocator.free(info.message.phone_iccid);
                }
            }
            
            std.log.debug("📋 Deduped {d} messages to {d} unique messages", .{ 
                all_message_infos.items.len, unique_message_infos.items.len 
            });
            
            var messages = std.ArrayList(Message).init(allocator);
            defer messages.deinit();

            for (unique_message_infos.items) |info| {
                try messages.append(info.message);
            }

            // Try to upload messages and track success
            const upload_result = blk: {
                api_client.uploadMessages(messages.items) catch |err| {
                    std.log.warn("Failed to upload messages: {any}", .{err});
                    break :blk false;
                };
                break :blk true;
            };

            // Only delete messages if upload was successful
            if (upload_result) {
                std.log.info("📤 Upload successful, deleting messages from modems...", .{});
                
                // Delete only the unique messages that were uploaded
                for (unique_message_infos.items) |info| {
                    modem_manager.deleteSms(info.modem_id, info.sms_id) catch |err| {
                        std.log.warn("Failed to delete SMS {s} from modem {s}: {any}", .{ info.sms_id, info.modem_id, err });
                        
                        // Mark this SMS as failed so we don't try to process it again
                        const sms_modem_key = try std.fmt.allocPrint(allocator, "{s}:{s}", .{ info.modem_id, info.sms_id });
                        const owned_key = try allocator.dupe(u8, sms_modem_key);
                        allocator.free(sms_modem_key);
                        try modem_manager.failed_sms_ids.put(owned_key, {});
                        
                        std.log.info("Added SMS {s} on modem {s} to failed list", .{ info.sms_id, info.modem_id });
                    };
                }
            } else {
                std.log.warn("⚠️  Upload failed, keeping messages on modems to retry later", .{});
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