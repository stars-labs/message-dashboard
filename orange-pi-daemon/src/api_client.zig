const std = @import("std");
const json = std.json;
const types = @import("types.zig");

/// Sync mode for state reconciliation
pub const SyncMode = enum {
    full,
    incremental,
    
    pub fn toString(self: SyncMode) []const u8 {
        return switch (self) {
            .full => "full",
            .incremental => "incremental",
        };
    }
};

/// HTTP API client for uploading data to the dashboard
pub const ApiClient = struct {
    allocator: std.mem.Allocator,
    config: types.Config,
    client: std.http.Client,
    session_id: []const u8,

    pub fn init(allocator: std.mem.Allocator, config: types.Config) ApiClient {
        // Generate unique session ID for this daemon instance
        var prng = std.Random.DefaultPrng.init(@intCast(std.time.timestamp()));
        const random = prng.random();
        const session_id = std.fmt.allocPrint(allocator, "daemon-{x}-{x}", .{
            random.int(u64),
            @as(u64, @intCast(std.time.timestamp())),
        }) catch "daemon-unknown";
        
        std.log.info("🔑 Daemon session ID: {s}", .{session_id});
        
        return .{ 
            .allocator = allocator, 
            .config = config,
            .client = std.http.Client{ .allocator = allocator },
            .session_id = session_id,
        };
    }
    
    pub fn deinit(self: *ApiClient) void {
        self.allocator.free(self.session_id);
        self.client.deinit();
    }

    pub fn uploadPhone(self: *ApiClient, phone: types.Phone) !void {
        const phones = [_]types.Phone{phone};
        const phones_json = try std.json.Stringify.valueAlloc(self.allocator, phones, .{ .emit_null_optional_fields = false });
        defer self.allocator.free(phones_json);

        const payload = try std.fmt.allocPrint(self.allocator, "{{\"phones\":{s}}}", .{phones_json});
        defer self.allocator.free(payload);

        try self.makeRequest("/phones", payload);
        std.log.debug("✅ Uploaded phone {s} via HTTP API", .{phone.iccid});
    }

    pub fn uploadPhones(self: *ApiClient, phones: []const types.Phone) !void {
        if (phones.len == 0) return;
        

        const phones_json = try std.json.Stringify.valueAlloc(self.allocator, phones, .{ .emit_null_optional_fields = false });
        defer self.allocator.free(phones_json);

        const payload = try std.fmt.allocPrint(self.allocator, "{{\"phones\":{s}}}", .{phones_json});
        defer self.allocator.free(payload);

        try self.makeRequest("/phones", payload);
        std.log.debug("✅ Uploaded {d} phones via HTTP API", .{phones.len});
    }

    /// Upload device data with sync mode for state reconciliation
    pub fn uploadDevicesWithSync(self: *ApiClient, modems: []const types.Modem, sims: []const types.SIM, sync_mode: SyncMode) !void {
        if (modems.len == 0 and sims.len == 0) return;
        
        // Use the new JSON API (std.json.Stringify.valueAlloc)
        const modems_json = try std.json.Stringify.valueAlloc(self.allocator, modems, .{ .emit_null_optional_fields = false });
        defer self.allocator.free(modems_json);
        
        const sims_json = try std.json.Stringify.valueAlloc(self.allocator, sims, .{ .emit_null_optional_fields = false });
        defer self.allocator.free(sims_json);
        
        const timestamp = try std.fmt.allocPrint(self.allocator, "{}", .{std.time.timestamp()});
        defer self.allocator.free(timestamp);

        const payload = try std.fmt.allocPrint(self.allocator, 
            "{{\"sync_mode\":\"{s}\",\"session_id\":\"{s}\",\"timestamp\":\"{s}\",\"modems\":{s},\"sims\":{s}}}", 
            .{ sync_mode.toString(), self.session_id, timestamp, modems_json, sims_json }
        );
        defer self.allocator.free(payload);

        // Upload to the correct API endpoint
        try self.makeRequest("/devices", payload);
        
        std.log.info("✅ Uploaded {d} modems and {d} SIMs via HTTP API (mode: {s})", .{ modems.len, sims.len, sync_mode.toString() });
    }
    
    /// Legacy upload without sync mode (for backward compatibility)
    pub fn uploadDevices(self: *ApiClient, modems: []const types.Modem, sims: []const types.SIM) !void {
        try self.uploadDevicesWithSync(modems, sims, .incremental);
    }

    pub fn uploadMessages(self: *ApiClient, messages: []const types.Message) !void {
        if (messages.len == 0) return;
        

        std.log.info("📤 Uploading {d} new messages to API", .{messages.len});
        for (messages, 0..) |msg, i| {
            
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

        // Use the new JSON API (std.json.Stringify.valueAlloc)  
        const messages_json = try std.json.Stringify.valueAlloc(self.allocator, messages, .{ .emit_null_optional_fields = false });
        defer self.allocator.free(messages_json);

        const payload = try std.fmt.allocPrint(self.allocator, "{{\"messages\":{s}}}", .{messages_json});
        defer self.allocator.free(payload);

        try self.makeRequest("/messages", payload);
        std.log.info("✅ Uploaded {d} messages via HTTP API", .{messages.len});
    }

    pub fn getPendingSms(self: *ApiClient) ![]const types.PendingSms {

        const url = try std.fmt.allocPrint(self.allocator, "{s}/api/control/pending-sms", .{self.config.api_url});
        defer self.allocator.free(url);

        std.log.debug("🌐 Making GET request to: {s}", .{url});

        const uri = try std.Uri.parse(url);
        
        // Make the HTTP request using the correct Zig 0.15.1 API
        var request = try self.client.request(.GET, uri, .{
            .extra_headers = &[_]std.http.Header{
                .{ .name = "X-API-Key", .value = self.config.api_key },
                .{ .name = "Accept", .value = "application/json" },
            },
        });
        defer request.deinit();

        // Read response body using buffer approach  
        var response_body: std.ArrayList(u8) = .empty;
        defer response_body.deinit(self.allocator);
        
        // Read data in chunks
        var buffer: [4096]u8 = undefined;
        while (true) {
            const bytes_read = request.reader.interface.readSliceShort(&buffer) catch |err| switch (err) {
                error.ReadFailed => break,
                else => return err,
            };
            if (bytes_read == 0) break;
            try response_body.appendSlice(self.allocator, buffer[0..bytes_read]);
        }

        std.log.debug("📥 Response body: {s}", .{response_body.items});

        // Parse JSON response
        const parsed = try std.json.parseFromSlice(struct {
            success: bool,
            pending_messages: []types.PendingSms,
        }, self.allocator, response_body.items, .{ .ignore_unknown_fields = true });
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

        std.log.debug("🌐 Making HTTP POST request to: {s}", .{url});
        std.log.debug("📤 Request payload: {s}", .{payload});

        // Use the fetch method for simpler implementation
        const result = self.client.fetch(.{
            .location = .{ .url = url },
            .method = .POST,
            .payload = payload,
            .extra_headers = &[_]std.http.Header{
                .{ .name = "Content-Type", .value = "application/json" },
                .{ .name = "X-API-Key", .value = self.config.api_key },
            },
        }) catch |err| {
            std.log.err("HTTP POST request failed: {any}", .{err});
            return error.HttpRequestFailed;
        };

        const status = @intFromEnum(result.status);
        std.log.debug("📥 HTTP Response Code: {d}", .{status});

        if (status < 200 or status >= 300) {
            std.log.err("HTTP request failed with status {d}", .{status});
            return error.HttpRequestFailed;
        }

        std.log.debug("📥 HTTP Response: Success", .{});
    }
};