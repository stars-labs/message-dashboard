const std = @import("std");
const json = std.json;
const types = @import("types.zig");

/// HTTP API client for uploading data to the dashboard
pub const ApiClient = struct {
    allocator: std.mem.Allocator,
    config: types.Config,
    mutex: std.Thread.Mutex,
    client: std.http.Client,

    pub fn init(allocator: std.mem.Allocator, config: types.Config) ApiClient {
        return .{ 
            .allocator = allocator, 
            .config = config,
            .mutex = std.Thread.Mutex{},
            .client = std.http.Client{ .allocator = allocator },
        };
    }
    
    pub fn deinit(self: *ApiClient) void {
        self.client.deinit();
    }

    pub fn uploadPhone(self: *ApiClient, phone: types.Phone) !void {
        self.mutex.lock();
        defer self.mutex.unlock();
        
        const phones = [_]types.Phone{phone};
        const phones_json = try json.stringifyAlloc(self.allocator, phones, .{ .emit_null_optional_fields = false });
        defer self.allocator.free(phones_json);

        const payload = try std.fmt.allocPrint(self.allocator, "{{\"phones\":{s}}}", .{phones_json});
        defer self.allocator.free(payload);

        try self.makeRequest("/phones", payload);
        std.log.info("✅ Uploaded phone {s} via HTTP API", .{phone.iccid});
    }

    pub fn uploadPhones(self: *ApiClient, phones: []const types.Phone) !void {
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

    pub fn uploadMessages(self: *ApiClient, messages: []const types.Message) !void {
        if (messages.len == 0) return;
        
        self.mutex.lock();
        defer self.mutex.unlock();

        std.log.debug("📱 Preparing to upload {d} messages:", .{messages.len});
        for (messages, 0..) |msg, i| {
            std.log.debug("  Message {d}: phone_iccid={s}, phone_number={s}, content length={d}, timestamp={s}", .{ i, msg.phone_iccid, msg.phone_number, msg.content.len, msg.timestamp });
            std.log.debug("🔍 MESSAGE UPLOAD DEBUG - Message {d}: content={s}, timestamp={s}, iccid={s}", .{ i, msg.content, msg.timestamp, msg.phone_iccid });
            
            // Check if content is valid UTF-8
            const is_valid_utf8 = std.unicode.utf8ValidateSlice(msg.content);
            if (!is_valid_utf8) {
                std.log.warn("⚠️  Message {d} contains invalid UTF-8 and will be encoded as byte array", .{i});
                // Find the first invalid byte for debugging
                for (msg.content, 0..) |byte, pos| {
                    if (byte == 0xFE or byte == 0xFF) {
                        std.log.warn("⚠️  Found invalid byte 0x{X:0>2} at position {d}", .{ byte, pos });
                        break;
                    }
                }
            }
        }

        const messages_json = try json.stringifyAlloc(self.allocator, messages, .{ .emit_null_optional_fields = false });
        defer self.allocator.free(messages_json);

        const payload = try std.fmt.allocPrint(self.allocator, "{{\"messages\":{s}}}", .{messages_json});
        defer self.allocator.free(payload);

        try self.makeRequest("/messages", payload);
        std.log.info("✅ Uploaded {d} messages via HTTP API", .{messages.len});
    }

    pub fn getPendingSms(self: *ApiClient) ![]const types.PendingSms {
        self.mutex.lock();
        defer self.mutex.unlock();

        const url = try std.fmt.allocPrint(self.allocator, "{s}/api/control/pending-sms", .{self.config.api_url});
        defer self.allocator.free(url);

        std.log.debug("🌐 Making GET request to: {s}", .{url});

        const uri = try std.Uri.parse(url);
        
        // Create headers buffer
        var header_buffer: [4096]u8 = undefined;
        
        // Build request headers
        const api_key_header = try std.fmt.allocPrint(self.allocator, "X-API-Key: {s}", .{self.config.api_key});
        defer self.allocator.free(api_key_header);
        
        const extra_headers = [_]std.http.Header{
            .{ .name = "X-API-Key", .value = self.config.api_key },
            .{ .name = "Accept", .value = "application/json" },
        };
        
        // Create request options
        const options = std.http.Client.RequestOptions{
            .server_header_buffer = &header_buffer,
            .extra_headers = &extra_headers,
        };

        // Make the request
        var request = try self.client.open(.GET, uri, options);
        defer request.deinit();

        // Send request and wait for response
        try request.send();
        try request.wait();

        // Check status code
        if (request.response.status != .ok) {
            std.log.err("HTTP request failed with status {d}", .{@intFromEnum(request.response.status)});
            return error.HttpRequestFailed;
        }

        // Read response body
        const response_body = try request.reader().readAllAlloc(self.allocator, 1024 * 1024); // 1MB max
        defer self.allocator.free(response_body);

        std.log.debug("📥 Response body: {s}", .{response_body});

        // Parse JSON response
        const parsed = try json.parseFromSlice(struct {
            success: bool,
            pending_messages: []types.PendingSms,
        }, self.allocator, response_body, .{ .ignore_unknown_fields = true });
        defer parsed.deinit();

        // Allocate and copy the pending SMS list
        const result_sms = try self.allocator.alloc(types.PendingSms, parsed.value.pending_messages.len);
        for (parsed.value.pending_messages, 0..) |sms, i| {
            result_sms[i] = .{
                .id = try self.allocator.dupe(u8, sms.id),
                .phone_iccid = try self.allocator.dupe(u8, sms.phone_iccid),
                .phone_number = if (sms.phone_number) |pn| try self.allocator.dupe(u8, pn) else null,
                .content = try self.allocator.dupe(u8, sms.content),
                .recipient = try self.allocator.dupe(u8, sms.recipient),
                .created_at = try self.allocator.dupe(u8, sms.created_at),
            };
        }

        return result_sms;
    }

    pub fn markSmsAsSent(self: *ApiClient, sms_id: []const u8) !void {
        self.mutex.lock();
        defer self.mutex.unlock();

        // Use the correct endpoint and payload format
        const endpoint = "/sms-result";
        const payload = try std.fmt.allocPrint(self.allocator, 
            "{{\"message_id\":\"{s}\",\"success\":true}}", 
            .{sms_id}
        );
        defer self.allocator.free(payload);
        
        try self.makeRequest(endpoint, payload);
        std.log.info("✅ Marked SMS {s} as sent", .{sms_id});
    }

    fn makeRequest(self: *ApiClient, endpoint: []const u8, payload: []const u8) !void {
        const url = try std.fmt.allocPrint(self.allocator, "{s}/api/control{s}", .{ self.config.api_url, endpoint });
        defer self.allocator.free(url);

        std.log.debug("🌐 Making HTTP request to: {s}", .{url});
        std.log.debug("📤 Request payload: {s}", .{payload});

        const uri = try std.Uri.parse(url);
        
        // Create headers buffer
        var header_buffer: [4096]u8 = undefined;
        
        // Build request headers
        const extra_headers = [_]std.http.Header{
            .{ .name = "Content-Type", .value = "application/json" },
            .{ .name = "X-API-Key", .value = self.config.api_key },
        };
        
        // Create request options
        const options = std.http.Client.RequestOptions{
            .server_header_buffer = &header_buffer,
            .extra_headers = &extra_headers,
        };

        // Make the request
        var request = try self.client.open(.POST, uri, options);
        defer request.deinit();

        // Set transfer encoding
        request.transfer_encoding = .{ .content_length = payload.len };

        // Send headers and body
        try request.send();
        try request.writeAll(payload);
        try request.finish();

        // Wait for the response
        try request.wait();

        // Check status code
        const status = @intFromEnum(request.response.status);
        std.log.debug("📥 HTTP Response Code: {d}", .{status});

        if (status < 200 or status >= 300) {
            // Try to read error response
            const error_body = request.reader().readAllAlloc(self.allocator, 4096) catch |err| {
                std.log.err("Failed to read error response: {any}", .{err});
                return error.HttpRequestFailed;
            };
            defer self.allocator.free(error_body);
            
            std.log.err("HTTP request failed with status {d}", .{status});
            if (error_body.len > 0) {
                std.log.err("Response: {s}", .{error_body});
            }
            return error.HttpRequestFailed;
        }

        // Read success response body (if any)
        const response_body = request.reader().readAllAlloc(self.allocator, 4096) catch |err| {
            std.log.debug("No response body or failed to read: {any}", .{err});
            return;
        };
        defer self.allocator.free(response_body);

        if (response_body.len > 0) {
            std.log.debug("📥 Response body: {s}", .{response_body});
        }
    }
};