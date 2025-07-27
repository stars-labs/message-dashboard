const std = @import("std");
const ModemManager = @import("modem_manager.zig").ModemManager;
const WebSocketClient = @import("websocket_client.zig").WebSocketClient;
const types = @import("types.zig");

const Message = types.Message;
const Phone = types.Phone;

pub const ModemHandler = struct {
    allocator: std.mem.Allocator,
    modem_id: []const u8,
    modem_manager: *ModemManager,
    websocket_client: *WebSocketClient,
    running: std.atomic.Value(bool),
    thread: ?std.Thread = null,
    check_interval_ms: u64 = 5000, // Check every 5 seconds

    pub fn init(
        allocator: std.mem.Allocator,
        modem_id: []const u8,
        modem_manager: *ModemManager,
        websocket_client: *WebSocketClient,
    ) !*ModemHandler {
        const handler = try allocator.create(ModemHandler);
        handler.* = .{
            .allocator = allocator,
            .modem_id = try allocator.dupe(u8, modem_id),
            .modem_manager = modem_manager,
            .websocket_client = websocket_client,
            .running = std.atomic.Value(bool).init(false),
            .thread = null,
        };
        return handler;
    }

    pub fn deinit(self: *ModemHandler) void {
        self.stop();
        self.allocator.free(self.modem_id);
        self.allocator.destroy(self);
    }

    pub fn start(self: *ModemHandler) !void {
        if (self.running.load(.acquire)) return;
        
        self.running.store(true, .release);
        self.thread = try std.Thread.spawn(.{}, threadMain, .{self});
    }

    pub fn stop(self: *ModemHandler) void {
        if (!self.running.load(.acquire)) return;
        
        self.running.store(false, .release);
        if (self.thread) |thread| {
            thread.join();
            self.thread = null;
        }
    }

    fn threadMain(self: *ModemHandler) void {
        std.log.info("🚀 Modem handler thread started for modem {s}", .{self.modem_id});
        
        // Initial phone status update
        self.updatePhoneStatus() catch |err| {
            std.log.err("Failed to update phone status for modem {s}: {any}", .{ self.modem_id, err });
        };

        while (self.running.load(.acquire)) {
            // Process messages for this modem
            self.processModemMessages() catch |err| {
                std.log.err("Error processing messages for modem {s}: {any}", .{ self.modem_id, err });
            };

            // Update phone status periodically
            self.updatePhoneStatus() catch |err| {
                std.log.err("Failed to update phone status for modem {s}: {any}", .{ self.modem_id, err });
            };

            // Sleep before next check
            std.time.sleep(self.check_interval_ms * std.time.ns_per_ms);
        }

        std.log.info("🛑 Modem handler thread stopped for modem {s}", .{self.modem_id});
    }

    fn processModemMessages(self: *ModemHandler) !void {
        // Get messages from this specific modem
        const msg_result = try self.modem_manager.getMessages(self.modem_id);
        defer {
            for (msg_result.messages) |msg| {
                self.allocator.free(msg.id.?);
                self.allocator.free(msg.phone_number);
                self.allocator.free(msg.content);
                self.allocator.free(msg.timestamp);
                self.allocator.free(msg.phone_iccid);
            }
            self.allocator.free(msg_result.messages);
            for (msg_result.sms_ids) |sms_id| {
                self.allocator.free(sms_id);
            }
            self.allocator.free(msg_result.sms_ids);
        }

        if (msg_result.messages.len == 0) {
            return; // No new messages
        }

        std.log.info("📬 Found {d} new messages on modem {s}", .{ msg_result.messages.len, self.modem_id });

        // Immediately upload messages for this modem
        if (self.websocket_client.*.authenticated) {
            // Create message info for tracking
            var message_infos = try self.allocator.alloc(types.MessageInfo, msg_result.messages.len);
            defer self.allocator.free(message_infos);

            for (msg_result.messages, msg_result.sms_ids, 0..) |message, sms_id, i| {
                message_infos[i] = .{
                    .modem_id = self.modem_id,
                    .sms_id = sms_id,
                    .message = message,
                };

                // Log for audit
                std.log.info("📨 UPLOADING SMS from modem {s}: From={s} ICCID={s} Content={s}", .{
                    self.modem_id,
                    message.phone_number,
                    message.phone_iccid,
                    message.content,
                });
            }

            // Upload immediately (no batching needed since it's per modem)
            _ = self.websocket_client.*.sendMessageUpload(msg_result.messages, message_infos) catch |err| {
                std.log.err("Failed to upload messages from modem {s}: {any}", .{ self.modem_id, err });
                return;
            };

            std.log.info("✅ Successfully uploaded {d} messages from modem {s}", .{ msg_result.messages.len, self.modem_id });
        } else {
            std.log.warn("WebSocket not authenticated, cannot upload messages from modem {s}", .{self.modem_id});
        }
    }

    fn updatePhoneStatus(self: *ModemHandler) !void {
        // Get phone info for this specific modem
        const phone_info = self.modem_manager.*.getSignalInfo(self.modem_id) catch |err| {
            std.log.err("Failed to get phone info for modem {s}: {any}", .{ self.modem_id, err });
            return;
        };
        defer {
            self.allocator.free(phone_info.iccid);
            if (phone_info.number) |num| self.allocator.free(num);
            if (phone_info.carrier) |c| self.allocator.free(c);
            if (phone_info.operator_name) |op| self.allocator.free(op);
            if (phone_info.operator_id) |id| self.allocator.free(id);
            if (phone_info.imei) |imei| self.allocator.free(imei);
            if (phone_info.access_tech) |tech| self.allocator.free(tech);
        }

        // Send phone update for just this modem
        if (self.websocket_client.*.authenticated) {
            const phones = [_]Phone{phone_info};
            self.websocket_client.sendPhoneUpdate(&phones) catch |err| {
                std.log.err("Failed to send phone update for modem {s}: {any}", .{ self.modem_id, err });
            };
        }
    }
};