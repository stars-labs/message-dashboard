const std = @import("std");

// Configuration structure
pub const Config = struct {
    api_url: []const u8,
    api_key: []const u8,
    modem_ids: []const []const u8,
    device_id: []const u8,
    daemon_version: []const u8,
    upload_interval: u32,
    poll_interval: u32,
    heartbeat_interval: u32,
    reconnect_delay: u32,
};

// Phone structure
pub const Phone = struct {
    iccid: []const u8,
    number: ?[]const u8 = null,
    country: ?[]const u8 = null,
    flag: ?[]const u8 = null,
    carrier: ?[]const u8 = null,
    status: []const u8,
    signal: ?i32 = null,
    rssi: ?i32 = null,
    rsrq: ?i32 = null,
    rsrp: ?i32 = null,
    snr: ?i32 = null,
    operator_name: ?[]const u8 = null,
    operator_id: ?[]const u8 = null,
    imei: ?[]const u8 = null,
    access_tech: ?[]const u8 = null,
};

// Message structure
pub const Message = struct {
    id: []const u8,
    phone_iccid: []const u8,
    phone_number: ?[]const u8,
    content: []const u8,
    timestamp: []const u8,
};

// Message info for tracking SMS deletion
pub const MessageInfo = struct {
    modem_id: []const u8,
    sms_id: []const u8,
    message: Message,
};

// Modem info structure
pub const ModemInfo = struct {
    operator_name: ?[]const u8,
    operator_id: ?[]const u8,
    imei: ?[]const u8,
    access_tech: ?[]const u8,
};

// SIM operator info
pub const SimOperatorInfo = struct {
    operator_name: ?[]const u8,
    operator_id: ?[]const u8,
};

// Message result from modem
pub const MessageResult = struct {
    messages: []Message,
    sms_ids: [][]const u8,
};

// API request structures
pub const MessageUploadRequest = struct {
    messages: []const Message,
};

pub const PhoneUpdateRequest = struct {
    phones: []const Phone,
};

// WebSocket message structures
pub const WebSocketMessage = struct {
    type: []const u8,
    id: []const u8,
    timestamp: []const u8,
    data: ?std.json.Value = null,
};

// Pending upload tracking
pub const PendingUpload = struct {
    pub const PendingMessageInfo = struct {
        modem_id: []const u8,
        sms_id: []const u8,
    };

    id: []const u8,
    timestamp: i64,
    message_infos: []PendingMessageInfo,
};

// Thread data structure for parallel modem processing
pub const ModemThreadData = struct {
    modem_id: []const u8,
    allocator: std.mem.Allocator,
    modem_manager: *anyopaque, // Will be cast to *ModemManager in main
    phone_mutex: *std.Thread.Mutex,
    message_mutex: *std.Thread.Mutex,
    current_phones_shared: *std.ArrayList(Phone),
    new_messages_shared: *std.ArrayList(Message),
    new_message_infos_shared: *std.ArrayList(MessageInfo),
};