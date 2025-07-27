const std = @import("std");

pub const Config = struct {
    api_url: []const u8,
    api_key: []const u8,
    device_id: []const u8,
    daemon_version: []const u8 = "2.0.0",
};

pub const Phone = struct {
    iccid: []const u8,
    number: ?[]const u8 = null,
    country: ?[]const u8 = null,
    flag: ?[]const u8 = null,
    carrier: ?[]const u8 = null,
    status: []const u8 = "offline",
    signal: u8 = 0,
    rssi: ?i32 = null,
    rsrq: ?i32 = null,
    rsrp: ?i32 = null,
    snr: ?i32 = null,
    operator_name: ?[]const u8 = null,
    operator_id: ?[]const u8 = null,
    imei: ?[]const u8 = null,
    access_tech: ?[]const u8 = null,
};

pub const Message = struct {
    id: ?[]const u8 = null,
    phone_iccid: []const u8,
    phone_number: []const u8,
    content: []const u8,
    source: ?[]const u8 = null,
    timestamp: []const u8,
};

pub const MessageInfo = struct {
    modem_id: []const u8,
    sms_id: []const u8,
    message: Message,
};

pub const MessageResult = struct {
    messages: []Message,
    sms_ids: [][]const u8,
};

pub const ModemInfo = struct {
    operator_name: ?[]const u8,
    operator_id: ?[]const u8,
    imei: ?[]const u8,
    access_tech: ?[]const u8,
};

pub const SimOperatorInfo = struct {
    operator_name: ?[]const u8,
    operator_id: ?[]const u8,
};

pub const PendingUpload = struct {
    id: []const u8,
    message_infos: []PendingMessageInfo,
    timestamp: i64,
    
    pub const PendingMessageInfo = struct {
        modem_id: []const u8,
        sms_id: []const u8,
    };
};

pub const WebSocketMessage = struct {
    type: []const u8,
    id: []const u8,
    timestamp: []const u8,
    data: std.json.Value,
};

pub const SendMessageRequest = struct {
    phone_id: []const u8,
    recipient: []const u8,
    content: []const u8,
    priority: ?[]const u8 = null,
};

pub const MessageUploadRequest = struct {
    messages: []const Message,
};

pub const PhoneUpdateRequest = struct {
    phones: []const Phone,
};

pub const MessageUploadData = struct {
    messages: []const Message,
};