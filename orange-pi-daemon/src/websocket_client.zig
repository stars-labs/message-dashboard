const std = @import("std");
const net = std.net;
const http = std.http;
const json = std.json;
const types = @import("types.zig");

const Config = types.Config;
const Phone = types.Phone;
const Message = types.Message;
const MessageInfo = types.MessageInfo;
const PendingUpload = types.PendingUpload;
const WebSocketMessage = types.WebSocketMessage;

pub const WebSocketClient = struct {
    allocator: std.mem.Allocator,
    config: Config,
    connection: ?net.Stream = null,
    authenticated: bool = false,
    running: bool = false,
    pending_uploads: std.StringHashMap(PendingUpload),

    pub fn init(allocator: std.mem.Allocator, config: Config) WebSocketClient {
        return .{
            .allocator = allocator,
            .config = config,
            .pending_uploads = std.StringHashMap(PendingUpload).init(allocator),
        };
    }

    pub fn deinit(self: *WebSocketClient) void {
        self.disconnect();
        
        var it = self.pending_uploads.iterator();
        while (it.next()) |entry| {
            self.allocator.free(entry.key_ptr.*);
            self.allocator.free(entry.value_ptr.id);
            for (entry.value_ptr.message_infos) |info| {
                self.allocator.free(info.modem_id);
                self.allocator.free(info.sms_id);
            }
            self.allocator.free(entry.value_ptr.message_infos);
        }
        self.pending_uploads.deinit();
    }

    pub fn connect(self: *WebSocketClient) !void {
        const uri = try std.Uri.parse(self.config.api_url);
        const host_component = uri.host orelse return error.NoHost;
        const host = switch (host_component) {
            .raw => |h| h,
            .percent_encoded => |h| h,
        };
        const port = uri.port orelse @as(u16, if (std.mem.eql(u8, uri.scheme, "https")) 443 else 80);

        std.log.info("🔗 Attempting WebSocket connection to {s}/api/daemon-ws", .{self.config.api_url});

        // For now, just use plain TCP connection
        // TODO: Add proper TLS support when API is stabilized
        self.connection = try std.net.tcpConnectToHost(self.allocator, host, port);

        // Send WebSocket handshake
        try self.sendHandshake();
        
        self.running = true;
        
        // Authenticate immediately after connection
        try self.authenticate();
    }

    pub fn disconnect(self: *WebSocketClient) void {
        if (self.connection) |conn| {
            conn.close();
            self.connection = null;
        }
        self.authenticated = false;
        self.running = false;
    }

    fn sendHandshake(self: *WebSocketClient) !void {
        const uri = try std.Uri.parse(self.config.api_url);
        const host_component = uri.host orelse return error.NoHost;
        const host = switch (host_component) {
            .raw => |h| h,
            .percent_encoded => |h| h,
        };
        
        // Generate WebSocket key
        var key_bytes: [16]u8 = undefined;
        std.crypto.random.bytes(&key_bytes);
        
        var key_buf: [24]u8 = undefined;
        const key = std.base64.standard.Encoder.encode(&key_buf, &key_bytes);
        
        const handshake = try std.fmt.allocPrint(self.allocator,
            "GET /api/daemon-ws HTTP/1.1\r\n" ++
            "Host: {s}\r\n" ++
            "Upgrade: websocket\r\n" ++
            "Connection: Upgrade\r\n" ++
            "Sec-WebSocket-Key: {s}\r\n" ++
            "Sec-WebSocket-Version: 13\r\n" ++
            "Authorization: Bearer {s}\r\n" ++
            "\r\n",
            .{ host, key, self.config.api_key }
        );
        defer self.allocator.free(handshake);
        
        std.log.info("Sending WebSocket handshake request", .{});
        _ = try self.connection.?.writer().writeAll(handshake);
        
        std.log.info("Waiting for WebSocket handshake response", .{});
        
        // Read handshake response
        var response_buffer: [1024]u8 = undefined;
        const response_len = try self.connection.?.reader().readAll(&response_buffer);
        const response = response_buffer[0..response_len];
        
        std.log.info("WebSocket handshake response: {s}", .{response});
        
        // Check if handshake was successful
        if (std.mem.indexOf(u8, response, "101 Switching Protocols") == null) {
            std.log.err("WebSocket handshake failed: {s}", .{response});
            return error.HandshakeFailed;
        }
    }

    pub fn sendWebSocketMessage(self: *WebSocketClient, message: []const u8) !void {
        if (self.connection == null) return error.NoConnection;
        
        // Create WebSocket frame (text frame)
        const frame = try self.createWebSocketFrame(message, 0x1);
        defer self.allocator.free(frame);
        
        // Send frame
        _ = try self.connection.?.writer().writeAll(frame);
        
        // Data is sent immediately
    }

    pub fn createWebSocketFrame(self: WebSocketClient, payload: []const u8, opcode: u8) ![]const u8 {
        const payload_len = payload.len;
        
        // Limit payload size to prevent overflow
        if (payload_len > 32768) {
            return error.PayloadTooLarge;
        }
        
        var frame_size: usize = 2; // Basic frame header
        
        // Calculate frame size based on payload length
        if (payload_len < 126) {
            frame_size += payload_len;
        } else if (payload_len < 65536) {
            frame_size += 2 + payload_len;
        } else {
            frame_size += 8 + payload_len;
        }
        
        // Add masking key size
        frame_size += 4;
        
        // Check for overflow in frame size calculation
        if (frame_size < payload_len) {
            return error.FrameSizeOverflow;
        }
        
        var frame = try self.allocator.alloc(u8, frame_size);
        var frame_index: usize = 0;
        
        // First byte: FIN=1, opcode=specified
        frame[frame_index] = 0x80 | opcode;
        frame_index += 1;
        
        // Second byte: MASK=1, payload length
        if (payload_len < 126) {
            frame[frame_index] = 0x80 | @as(u8, @intCast(payload_len));
            frame_index += 1;
        } else if (payload_len < 65536) {
            frame[frame_index] = 0x80 | 126;
            frame_index += 1;
            frame[frame_index] = @as(u8, @intCast(payload_len >> 8));
            frame_index += 1;
            frame[frame_index] = @as(u8, @intCast(payload_len & 0xFF));
            frame_index += 1;
        } else {
            frame[frame_index] = 0x80 | 127;
            frame_index += 1;
            // Add 64-bit length (simplified for now)
            for (0..8) |i| {
                frame[frame_index + i] = if (i >= 4) @as(u8, @intCast((payload_len >> @intCast((7 - i) * 8)) & 0xFF)) else 0;
            }
            frame_index += 8;
        }
        
        // Masking key (simple static key for now)
        const mask_key = [_]u8{ 0x12, 0x34, 0x56, 0x78 };
        for (mask_key) |byte| {
            frame[frame_index] = byte;
            frame_index += 1;
        }
        
        // Masked payload
        for (payload, 0..) |byte, i| {
            frame[frame_index + i] = byte ^ mask_key[i % 4];
        }
        
        return frame;
    }

    pub fn authenticate(self: *WebSocketClient) !void {
        const auth_message = try self.createAuthMessage();
        defer self.allocator.free(auth_message);
        
        std.log.info("Sending authentication message", .{});
        
        // Send authentication via WebSocket
        try self.sendWebSocketMessage(auth_message);
        
        // Bearer token authentication complete
        std.log.info("WebSocket connection ready with bearer token authentication", .{});
    }

    pub fn sendPhoneUpdate(self: *WebSocketClient, phones: []const Phone) !void {
        if (!self.authenticated) return;
        if (phones.len == 0) {
            std.log.info("No phones to update, skipping WebSocket phone update", .{});
            return;
        }
        
        const message = try self.createPhoneUpdateMessage(phones);
        defer self.allocator.free(message);
        
        std.log.info("Sending phone update via WebSocket: {d} phones", .{phones.len});
        
        // Log raw JSON at debug level (only shown when compiled with debug mode)
        std.log.debug("Phone update JSON: {s}", .{message});
        
        // Send via WebSocket only
        try self.sendWebSocketMessage(message);
        
        std.log.info("✅ Phone update sent successfully ({d} phones)", .{phones.len});
    }

    pub fn sendMessageUpload(self: *WebSocketClient, messages: []const Message, message_infos: []const MessageInfo) ![]const u8 {
        if (!self.authenticated) return error.NotAuthenticated;
        
        const message = try self.createMessageUploadMessage(messages);
        defer self.allocator.free(message);
        
        // Extract the message ID to track this upload
        const parsed = json.parseFromSlice(json.Value, self.allocator, message, .{}) catch return error.InvalidJson;
        defer parsed.deinit();
        
        const upload_id = if (parsed.value.object.get("id")) |id|
            if (id == .string) try self.allocator.dupe(u8, id.string) else return error.InvalidMessageId
        else
            return error.MissingMessageId;
        
        // Store the message info for later deletion when confirmed
        var pending_infos = try self.allocator.alloc(PendingUpload.PendingMessageInfo, message_infos.len);
        for (message_infos, 0..) |info, i| {
            pending_infos[i] = .{
                .modem_id = try self.allocator.dupe(u8, info.modem_id),
                .sms_id = try self.allocator.dupe(u8, info.sms_id),
            };
        }
        
        const pending = PendingUpload{
            .id = try self.allocator.dupe(u8, upload_id),
            .timestamp = std.time.timestamp(),
            .message_infos = pending_infos,
        };
        
        // Store pending upload
        try self.pending_uploads.put(try self.allocator.dupe(u8, upload_id), pending);
        
        std.log.info("Sending message upload via WebSocket: {d} messages (upload_id: {s})", .{ messages.len, upload_id });
        
        // Send via WebSocket
        try self.sendWebSocketMessage(message);
        
        return upload_id;
    }

    // Helper functions for creating messages
    fn createAuthMessage(self: WebSocketClient) ![]const u8 {
        const id = try self.generateMessageId();
        defer self.allocator.free(id);
        
        const timestamp = try self.formatTimestamp();
        defer self.allocator.free(timestamp);
        
        return try std.fmt.allocPrint(self.allocator,
            \\{{"type":"auth","id":"{s}","timestamp":"{s}","data":{{"api_key":"{s}","device_id":"{s}","daemon_version":"{s}"}}}}
        , .{ id, timestamp, self.config.api_key, self.config.device_id, self.config.daemon_version });
    }

    fn createPhoneUpdateMessage(self: WebSocketClient, phones: []const Phone) ![]const u8 {
        const id = try self.generateMessageId();
        defer self.allocator.free(id);
        
        const timestamp = try self.formatTimestamp();
        defer self.allocator.free(timestamp);
        
        const phones_json = try json.stringifyAlloc(self.allocator, phones, .{ .emit_null_optional_fields = false });
        defer self.allocator.free(phones_json);
        
        return try std.fmt.allocPrint(self.allocator,
            \\{{"type":"phone_update","id":"{s}","timestamp":"{s}","data":{{"phones":{s}}}}}
        , .{ id, timestamp, phones_json });
    }

    fn createMessageUploadMessage(self: WebSocketClient, messages: []const Message) ![]const u8 {
        const id = try self.generateMessageId();
        defer self.allocator.free(id);
        
        const timestamp = try self.formatTimestamp();
        defer self.allocator.free(timestamp);
        
        const messages_json = try json.stringifyAlloc(self.allocator, messages, .{ .emit_null_optional_fields = false });
        defer self.allocator.free(messages_json);
        
        // Extract just the array part from messages JSON
        const messages_array = if (std.mem.indexOf(u8, messages_json, "[")) |start| blk: {
            if (std.mem.lastIndexOf(u8, messages_json, "]")) |end| {
                break :blk messages_json[start..end + 1];
            } else {
                std.log.warn("JSON end bracket not found, using full messages JSON", .{});
                break :blk messages_json;
            }
        } else blk: {
            std.log.warn("JSON start bracket not found, using full messages JSON", .{});
            break :blk messages_json;
        };
        
        return try std.fmt.allocPrint(self.allocator,
            \\{{"type":"message_upload","id":"{s}","timestamp":"{s}","data":{{"messages":{s}}}}}
        , .{ id, timestamp, messages_array });
    }

    pub fn generateMessageId(self: WebSocketClient) ![]const u8 {
        const timestamp = std.time.milliTimestamp();
        return try std.fmt.allocPrint(self.allocator, "msg-{d}", .{timestamp});
    }

    pub fn formatTimestamp(self: WebSocketClient) ![]const u8 {
        const timestamp_ms = std.time.milliTimestamp();
        _ = @divTrunc(timestamp_ms, 1000); // timestamp_s
        const ms = @mod(timestamp_ms, 1000);
        
        // Simple ISO timestamp format
        // This is a simplified version - in production you'd want proper date formatting
        return try std.fmt.allocPrint(self.allocator,
            "2025-07-26T12:00:00.{d:0>3}Z",
            .{ms},
        );
    }

    pub fn cleanupStaleUploads(self: *WebSocketClient) void {
        const current_time = std.time.timestamp();
        var to_remove = std.ArrayList([]const u8).init(self.allocator);
        defer to_remove.deinit();
        
        var it = self.pending_uploads.iterator();
        while (it.next()) |entry| {
            // Remove uploads older than 5 minutes
            if (current_time - entry.value_ptr.timestamp > 300) {
                to_remove.append(entry.key_ptr.*) catch continue;
            }
        }
        
        for (to_remove.items) |key| {
            if (self.pending_uploads.fetchRemove(key)) |entry| {
                self.allocator.free(entry.key);
                self.allocator.free(entry.value.id);
                for (entry.value.message_infos) |info| {
                    self.allocator.free(info.modem_id);
                    self.allocator.free(info.sms_id);
                }
                self.allocator.free(entry.value.message_infos);
            }
        }
    }

    pub fn messageListenLoop(self: *WebSocketClient) void {
        std.log.info("🎧 Message listening thread started", .{});
        while (self.running) {
            self.readWebSocketMessage() catch |err| {
                switch (err) {
                    error.ConnectionClosed => {
                        // Connection was closed, exit the loop to trigger reconnection
                        std.log.info("WebSocket connection closed in message listener", .{});
                        self.running = false;
                        break;
                    },
                    error.InvalidFrameHeader => {
                        // Invalid frame, might be a temporary issue
                        std.time.sleep(100 * std.time.ns_per_ms);
                    },
                    else => {
                        std.log.err("Error reading WebSocket message: {any}", .{err});
                        std.time.sleep(1 * std.time.ns_per_s); // Wait before retrying
                    },
                }
            };
        }
        std.log.info("🎧 Message listening thread stopped", .{});
    }

    fn readWebSocketMessage(self: *WebSocketClient) !void {
        if (self.connection == null) return;
        
        // Read WebSocket frame header
        var frame_header: [2]u8 = undefined;
        const bytes_read = self.connection.?.reader().readAll(&frame_header) catch |err| {
            std.log.err("❌ Failed to read WebSocket frame header: {any}", .{err});
            return err;
        };
        if (bytes_read == 0) {
            // Connection closed - reconnect
            std.log.info("WebSocket connection closed, attempting to reconnect...", .{});
            self.connection = null;
            self.running = false;
            return error.ConnectionClosed;
        }
        if (bytes_read != 2) {
            std.log.warn("🔍 Frame header read failed: got {d} bytes instead of 2", .{bytes_read});
            return error.InvalidFrameHeader;
        }
        
        _ = (frame_header[0] & 0x80) != 0; // fin bit
        const opcode = frame_header[0] & 0x0F;
        const masked = (frame_header[1] & 0x80) != 0;
        var payload_len = @as(u64, frame_header[1] & 0x7F);
        
        // Read extended payload length if needed
        if (payload_len == 126) {
            var len_bytes: [2]u8 = undefined;
            _ = try self.connection.?.reader().readAll(&len_bytes);
            payload_len = (@as(u64, len_bytes[0]) << 8) | @as(u64, len_bytes[1]);
        } else if (payload_len == 127) {
            var len_bytes: [8]u8 = undefined;
            _ = try self.connection.?.reader().readAll(&len_bytes);
            payload_len = 0;
            for (len_bytes) |byte| {
                // Prevent overflow by limiting payload_len to 32KB
                const shifted = payload_len << 8;
                if (shifted > 32768 or shifted < payload_len) { // Check for overflow
                    payload_len = 32768;
                    break;
                }
                const new_payload_len = shifted | @as(u64, byte);
                if (new_payload_len > 32768) {
                    payload_len = 32768;
                    break;
                }
                payload_len = new_payload_len;
            }
        }
        
        // Read masking key if present
        var mask_key: [4]u8 = undefined;
        if (masked) {
            _ = try self.connection.?.reader().readAll(&mask_key);
        }
        
        // Read payload with safe size limits
        if (payload_len > 0 and payload_len < 32768) { // Limit to 32KB for safety
            const safe_len = @min(payload_len, 32767);
            if (safe_len > std.math.maxInt(usize)) {
                return error.PayloadTooLarge;
            }
            const payload = try self.allocator.alloc(u8, @as(usize, @intCast(safe_len)));
            defer self.allocator.free(payload);
            
            _ = try self.connection.?.reader().readAll(payload);
            
            // Unmask payload if needed
            if (masked) {
                for (payload, 0..) |*byte, i| {
                    byte.* ^= mask_key[i % 4];
                }
            }
            
            // Process different opcodes
            switch (opcode) {
                0x1 => { // Text frame
                    const text = std.mem.sliceTo(payload, 0);
                    std.log.info("📨 Received WebSocket message: {s}", .{text});
                    try self.handleWebSocketMessage(text);
                },
                0x8 => { // Close frame
                    std.log.info("WebSocket close frame received", .{});
                    self.running = false;
                    return error.ConnectionClosed;
                },
                0x9 => { // Ping frame
                    std.log.debug("Received ping, sending pong", .{});
                    const pong = try self.createWebSocketFrame(payload, 0xA);
                    defer self.allocator.free(pong);
                    _ = try self.connection.?.writer().writeAll(pong);
                },
                0xA => { // Pong frame
                    std.log.debug("Received pong", .{});
                },
                else => {
                    std.log.warn("Unhandled WebSocket opcode: {d}", .{opcode});
                },
            }
        }
    }

    fn handleWebSocketMessage(self: *WebSocketClient, text: []const u8) !void {
        const parsed = json.parseFromSlice(WebSocketMessage, self.allocator, text, .{ .ignore_unknown_fields = true }) catch |err| {
            std.log.err("Failed to parse WebSocket message: {any}", .{err});
            return;
        };
        defer parsed.deinit();
        
        const msg = parsed.value;
        std.log.info("📋 Processing message type: {s}", .{msg.type});
        
        if (std.mem.eql(u8, msg.type, "connected")) {
            std.log.info("Connected to WebSocket server", .{});
            self.authenticated = true;
        } else if (std.mem.eql(u8, msg.type, "ack")) {
            if (msg.data) |data| {
                if (data.object.get("request_id")) |request_id| {
                    if (request_id == .string) {
                        // Handle acknowledgment
                        if (self.pending_uploads.fetchRemove(request_id.string)) |entry| {
                            std.log.info("✅ Messages confirmed uploaded, cleaning up {d} SMS messages", .{entry.value.message_infos.len});
                            
                            // Clean up the removed entry
                            self.allocator.free(entry.key);
                            self.allocator.free(entry.value.id);
                            for (entry.value.message_infos) |info| {
                                self.allocator.free(info.modem_id);
                                self.allocator.free(info.sms_id);
                            }
                            self.allocator.free(entry.value.message_infos);
                        }
                    }
                }
                
                if (data.object.get("message")) |message| {
                    if (message == .string) {
                        std.log.info("✅ Server acknowledged: {s}", .{message.string});
                    }
                }
            }
        } else if (std.mem.eql(u8, msg.type, "error")) {
            if (msg.data) |data| {
                if (data.object.get("request_id")) |request_id| {
                    if (request_id == .string) {
                        // Remove from pending uploads on error
                        if (self.pending_uploads.fetchRemove(request_id.string)) |entry| {
                            std.log.err("❌ Upload failed for request {s}, removing from pending", .{request_id.string});
                            
                            // Clean up the removed entry
                            self.allocator.free(entry.key);
                            self.allocator.free(entry.value.id);
                            for (entry.value.message_infos) |info| {
                                self.allocator.free(info.modem_id);
                                self.allocator.free(info.sms_id);
                            }
                            self.allocator.free(entry.value.message_infos);
                        }
                    }
                }
                
                if (data.object.get("message")) |message| {
                    if (message == .string) {
                        std.log.err("❌ Server error: {s}", .{message.string});
                    }
                }
            }
        }
    }
};