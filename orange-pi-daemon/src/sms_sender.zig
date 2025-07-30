const std = @import("std");
const types = @import("types.zig");
const ModemManager = @import("modem_manager.zig").ModemManager;
const ApiClient = @import("api_client.zig").ApiClient;

/// Represents an outgoing SMS message
pub const OutgoingSMS = struct {
    id: []const u8,
    recipient: []const u8,         // Number to send to
    phone_iccid: []const u8,       // ICCID of the phone to send from
    content: []const u8,
    created_at: []const u8,
    
    pub fn deinit(self: *OutgoingSMS, allocator: std.mem.Allocator) void {
        allocator.free(self.id);
        allocator.free(self.recipient);
        allocator.free(self.phone_iccid);
        allocator.free(self.content);
        allocator.free(self.created_at);
    }
};

/// SMS sender responsible for fetching and sending SMS messages
pub const SMSSender = struct {
    allocator: std.mem.Allocator,
    api_client: *ApiClient,
    modem_manager: *ModemManager,
    config: types.Config,
    
    pub fn init(allocator: std.mem.Allocator, api_client: *ApiClient, modem_manager: *ModemManager, config: types.Config) SMSSender {
        return .{
            .allocator = allocator,
            .api_client = api_client,
            .modem_manager = modem_manager,
            .config = config,
        };
    }
    
    /// Get pending SMS messages from API
    pub fn getPendingSMS(self: *SMSSender) ![]OutgoingSMS {
        // Use the API client to get pending SMS
        const pending_sms = self.api_client.getPendingSms() catch |err| {
            // Only log in non-test builds
            if (@import("builtin").is_test == false) {
                std.log.err("Failed to get pending SMS: {any}", .{err});
            }
            return &[_]OutgoingSMS{};
        };
        defer {
            // Free the pending SMS data
            for (pending_sms) |sms| {
                self.allocator.free(sms.id);
                self.allocator.free(sms.phone_iccid);
                if (sms.phone_number) |pn| self.allocator.free(pn);
                self.allocator.free(sms.content);
                self.allocator.free(sms.recipient);
                self.allocator.free(sms.created_at);
            }
            self.allocator.free(pending_sms);
        }
        
        // Convert PendingSms to OutgoingSMS
        var sms_list = std.ArrayList(OutgoingSMS).init(self.allocator);
        defer sms_list.deinit();
        
        for (pending_sms) |sms| {
            const outgoing = OutgoingSMS{
                .id = try self.allocator.dupe(u8, sms.id),
                .recipient = try self.allocator.dupe(u8, sms.recipient),
                .phone_iccid = try self.allocator.dupe(u8, sms.phone_iccid),
                .content = try self.allocator.dupe(u8, sms.content),
                .created_at = try self.allocator.dupe(u8, sms.created_at),
            };
            try sms_list.append(outgoing);
        }
        
        // Convert to owned slice
        const result = try sms_list.toOwnedSlice();
        std.log.info("📱 Found {d} pending SMS messages", .{result.len});
        return result;
    }
    
    /// Find modem ID for a given ICCID
    pub fn findModemForIccid(self: *SMSSender, target_iccid: []const u8) ?[]const u8 {
        // Get list of modems
        const modems = self.modem_manager.listModems() catch return null;
        defer {
            for (modems) |modem| self.allocator.free(modem);
            self.allocator.free(modems);
        }
        
        // Check each modem for matching ICCID
        for (modems) |modem_id| {
            const iccid_opt = self.modem_manager.getIccid(modem_id) catch continue;
            if (iccid_opt) |iccid| {
                defer self.allocator.free(iccid);
                if (std.mem.eql(u8, iccid, target_iccid)) {
                    return self.allocator.dupe(u8, modem_id) catch null;
                }
            }
        }
        
        return null;
    }
    
    /// Send an SMS message
    pub fn sendSMS(self: *SMSSender, sms: OutgoingSMS) !void {
        // Find the modem for this ICCID
        const modem_id = self.findModemForIccid(sms.phone_iccid) orelse {
            // Only log in non-test builds
            if (@import("builtin").is_test == false) {
                std.log.err("No modem found for ICCID: {s}", .{sms.phone_iccid});
            }
            try self.reportSMSResult(sms.id, false, "No modem found for ICCID");
            return error.ModemNotFound;
        };
        defer self.allocator.free(modem_id);
        
        std.log.info("📤 Sending SMS from modem {s} to {s}", .{ modem_id, sms.recipient });
        
        // Send the SMS using ModemManager
        const sms_id = self.modem_manager.sendSms(modem_id, sms.recipient, sms.content) catch |err| {
            std.log.err("Failed to send SMS: {any}", .{err});
            try self.reportSMSResult(sms.id, false, "Failed to send SMS");
            return err;
        };
        
        // Report success
        try self.reportSMSResult(sms.id, true, "SMS sent successfully");
        std.log.info("✅ SMS sent successfully to {s} (SMS ID: {s})", .{ sms.recipient, sms_id });
    }
    
    /// Report SMS result back to API
    pub fn reportSMSResult(self: *SMSSender, message_id: []const u8, success: bool, message: []const u8) !void {
        _ = message;
        
        // Only mark as sent if actually successful
        if (success) {
            // Mark the SMS as sent using the API client
            self.api_client.markSmsAsSent(message_id) catch |err| {
                std.log.err("Failed to mark SMS as sent: {any}", .{err});
                return err;
            };
        } else {
            // TODO: Add API method to mark SMS as failed
            if (@import("builtin").is_test == false) {
                std.log.warn("SMS {s} failed to send - not marking as sent", .{message_id});
            }
        }
    }
};