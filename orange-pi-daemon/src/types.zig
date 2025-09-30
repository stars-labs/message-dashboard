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
    phone_number: []const u8,  // Sender's phone number for received messages
    content: []const u8,
    timestamp: []const u8,
    sender: ?[]const u8 = null,  // Alternative field for sender
    smsc: ?[]const u8 = null,    // SMS center number
    storage: ?[]const u8 = null, // Storage location (SIM, ME, etc.)
    pdu_type: ?[]const u8 = null, // PDU type
    message_class: ?u8 = null,   // Message class (0-3)
};

/// Phone/modem data structure
/// Modem hardware information
pub const Modem = struct {
    equipment_id: []const u8,           // Primary key (IMEI)
    manufacturer: ?[]const u8 = null,   // Modem manufacturer (e.g., "Quectel")
    model: ?[]const u8 = null,          // Modem model (e.g., "EC20")
    firmware_revision: ?[]const u8 = null, // Firmware version
    hardware_revision: ?[]const u8 = null, // Hardware version
    device_path: ?[]const u8 = null,    // USB device path (e.g., "/dev/ttyUSB0")
    status: []const u8,                 // connected, disconnected, sim-missing
    modem_index: ?u32 = null,          // Modem ID from mmcli (e.g., 7 from /Modem/7)
    usb_port: ?u32 = null,             // USB port number for physical identification
    signal: ?u8 = null,                // Signal strength percentage
    rssi: ?i32 = null,                 // Received Signal Strength Indicator
    rsrq: ?i32 = null,                 // Reference Signal Received Quality
    rsrp: ?i32 = null,                 // Reference Signal Received Power
    snr: ?i32 = null,                  // Signal-to-Noise Ratio
};

/// SIM card information
pub const SIM = struct {
    iccid: []const u8,                  // Primary key (ICCID)
    phone_number: ?[]const u8 = null,   // Phone number if available
    current_modem_id: ?[]const u8 = null, // Foreign key to Modem.equipment_id
    operator_name: ?[]const u8 = null,  // Carrier name
    operator_id: ?[]const u8 = null,    // MCC+MNC
    network_type: ?[]const u8 = null,   // Network type
    access_tech: ?[]const u8 = null,    // Access technology (LTE, 3G, etc)
    status: []const u8,                 // active, inactive, removed
    sim_index: ?u32 = null,             // SIM ID from mmcli (e.g., 12 from /SIM/12)
};

/// Legacy Phone struct for backward compatibility (will be removed)
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
    message_count: u32 = 0,
    
    pub fn deinit(self: *ModemCheckResult) void {
        if (self.success and self.messages.len > 0) {
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