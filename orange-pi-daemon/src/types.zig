const std = @import("std");

/// Configuration for the SMS daemon
pub const Config = struct {
    api_url: []const u8,
    api_key: []const u8,
    check_interval: u64 = 30, // seconds - how often to update phone status
    message_check_interval: u64 = 100, // milliseconds - how often to check for new messages (default 10 Hz with sequential processing)
    signal_check_interval: u64 = 60, // seconds - how often to check signal quality (default 1 minute)
    max_retries: u32 = 3,
    retry_delay: u64 = 5, // seconds
};

/// SMS message data structure
pub const Message = struct {
    phone_iccid: []const u8,
    phone_number: []const u8,
    content: []const u8,
    timestamp: []const u8,
};

/// Phone/modem data structure
pub const Phone = struct {
    iccid: []const u8, // ICCID is the primary identifier
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
    manufacturer: ?[]const u8 = null,  // Modem manufacturer (e.g., "Quectel")
    model: ?[]const u8 = null,          // Modem model (e.g., "EC20")
    firmware_revision: ?[]const u8 = null, // Firmware version
    hardware_revision: ?[]const u8 = null, // Hardware version
    device_path: ?[]const u8 = null,    // USB device path (e.g., "/dev/ttyUSB0")
    modem_index: ?u32 = null,  // Modem ID from mmcli (e.g., 7 from /Modem/7)
    sim_index: ?u32 = null,    // SIM ID from mmcli (e.g., 12 from /SIM/12)
    usb_port: ?u32 = null,     // USB port number for physical identification
};

/// Internal message info including modem details
pub const MessageInfo = struct {
    modem_id: []const u8,
    sms_id: []const u8,
    message: Message,
};

/// Signal quality data
pub const SignalData = struct {
    signal_percent: u8,
    rssi: ?i32,
    rsrq: ?i32,
    rsrp: ?i32,
    snr: ?i32,
};

/// Pending SMS from API
pub const PendingSms = struct {
    id: []const u8,
    phone_iccid: []const u8,       // ICCID of the phone to send from
    phone_number: ?[]const u8,      // Original sender number (optional)
    content: []const u8,
    recipient: []const u8,          // Number to send to
    created_at: []const u8,
};

pub const ModemCheckResult = struct {
    modem_id: []const u8,
    messages: []MessageInfo,
    success: bool,
    allocator: std.mem.Allocator,
    
    pub fn deinit(self: *ModemCheckResult) void {
        if (self.success) {
            for (self.messages) |*msg| {
                self.allocator.free(msg.modem_id);
                self.allocator.free(msg.sms_id);
                self.allocator.free(msg.message.phone_iccid);
                self.allocator.free(msg.message.phone_number);
                self.allocator.free(msg.message.content);
                self.allocator.free(msg.message.timestamp);
            }
            self.allocator.free(self.messages);
        }
    }
};