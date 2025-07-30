const std = @import("std");
const testing = std.testing;
const ModemManager = @import("modem_manager.zig").ModemManager;
const types = @import("types.zig");

// Test helper to create ModemManager with mocked mmcli output
const MockModemManager = struct {
    allocator: std.mem.Allocator,
    base: ModemManager,
    mock_output: []const u8,
    
    fn init(allocator: std.mem.Allocator) MockModemManager {
        return .{
            .allocator = allocator,
            .base = ModemManager.init(allocator),
            .mock_output = "",
        };
    }
    
    fn deinit(self: *MockModemManager) void {
        self.base.deinit();
    }
    
    fn setMockOutput(self: *MockModemManager, output: []const u8) void {
        self.mock_output = output;
    }
    
    // Parse mmcli output directly for testing
    fn parseSmsOutput(self: *MockModemManager, output: []const u8, iccid: []const u8) !types.MessageInfo {
        var phone_number: ?[]const u8 = null;
        var content: ?[]const u8 = null;
        var timestamp: ?[]const u8 = null;
        
        var content_lines = std.ArrayList([]const u8).init(self.allocator);
        defer content_lines.deinit();
        var parsing_content = false;
        
        var lines = std.mem.tokenizeScalar(u8, output, '\n');
        while (lines.next()) |line| {
            const trimmed = std.mem.trim(u8, line, " \t");
            
            if (std.mem.indexOf(u8, trimmed, "number:")) |_| {
                parsing_content = false;
                if (std.mem.indexOf(u8, trimmed, ": ")) |pos| {
                    const value = std.mem.trim(u8, trimmed[pos + 2 ..], " '\"");
                    if (value.len > 0) {
                        phone_number = try self.allocator.dupe(u8, value);
                    }
                }
            } else if (std.mem.indexOf(u8, trimmed, "text:")) |_| {
                parsing_content = true;
                if (std.mem.indexOf(u8, trimmed, ": ")) |pos| {
                    const value = std.mem.trim(u8, trimmed[pos + 2 ..], " '\"");
                    if (value.len > 0) {
                        try content_lines.append(try self.allocator.dupe(u8, value));
                    }
                }
            } else if (std.mem.indexOf(u8, trimmed, "timestamp:")) |_| {
                parsing_content = false;
                if (std.mem.indexOf(u8, trimmed, ": ")) |pos| {
                    var ts_raw = std.mem.trim(u8, trimmed[pos + 2 ..], " '\"");
                    
                    // Extract timezone offset if present
                    // Default to UTC+8 (Beijing time) if no timezone is specified
                    var timezone_offset_hours: i8 = 8;
                    var ts_without_tz = ts_raw;
                    var has_timezone = false;
                    
                    if (std.mem.indexOf(u8, ts_raw, "+")) |plus_pos| {
                        has_timezone = true;
                        const tz_str = ts_raw[plus_pos + 1 ..];
                        if (tz_str.len >= 2) {
                            timezone_offset_hours = std.fmt.parseInt(i8, tz_str[0..2], 10) catch 0;
                        }
                        ts_without_tz = ts_raw[0..plus_pos];
                    }
                    
                    // Parse and convert to UTC
                    if (std.mem.count(u8, ts_without_tz, "/") == 2) {
                        var parts = std.mem.tokenizeScalar(u8, ts_without_tz, '/');
                        const year_str = parts.next() orelse return error.InvalidTimestamp;
                        const month_str = parts.next() orelse return error.InvalidTimestamp;
                        const rest = parts.next() orelse return error.InvalidTimestamp;
                        
                        var date_time = std.mem.tokenizeScalar(u8, rest, ',');
                        const day_str = date_time.next() orelse return error.InvalidTimestamp;
                        const time_str = std.mem.trim(u8, date_time.next() orelse return error.InvalidTimestamp, " ");
                        
                        const year = try std.fmt.parseInt(u16, year_str, 10);
                        const month = try std.fmt.parseInt(u8, month_str, 10);
                        const day = try std.fmt.parseInt(u8, day_str, 10);
                        
                        var time_parts = std.mem.tokenizeScalar(u8, time_str, ':');
                        const hour_str = time_parts.next() orelse return error.InvalidTimestamp;
                        const min_str = time_parts.next() orelse return error.InvalidTimestamp;
                        const sec_str = time_parts.next() orelse "00";
                        
                        const hour = try std.fmt.parseInt(u8, hour_str, 10);
                        const min = try std.fmt.parseInt(u8, min_str, 10);
                        const sec = try std.fmt.parseInt(u8, sec_str, 10);
                        
                        // Convert to UTC
                        const hour_i32: i32 = @intCast(hour);
                        const adjusted_hour_i32 = hour_i32 - timezone_offset_hours;
                        
                        var final_hour: u8 = undefined;
                        var final_day = day;
                        
                        if (adjusted_hour_i32 < 0) {
                            final_hour = @intCast(adjusted_hour_i32 + 24);
                            if (day > 1) final_day = day - 1;
                        } else if (adjusted_hour_i32 >= 24) {
                            final_hour = @intCast(adjusted_hour_i32 - 24);
                            if (day < 31) final_day = day + 1;
                        } else {
                            final_hour = @intCast(adjusted_hour_i32);
                        }
                        
                        const full_year = if (year < 100) 2000 + year else year;
                        
                        timestamp = try std.fmt.allocPrint(self.allocator, 
                            "{d:0>4}-{d:0>2}-{d:0>2}T{d:0>2}:{d:0>2}:{d:0>2}.000Z", 
                            .{ full_year, month, final_day, final_hour, min, sec }
                        );
                    } else if (std.mem.indexOf(u8, ts_raw, "T") != null) {
                        // ISO format - check if we already extracted timezone
                        if (has_timezone) {
                            // We already extracted timezone, need to convert to UTC
                            // Parse ISO format: YYYY-MM-DDTHH:MM:SS[.mmm]
                            var parts = std.mem.tokenizeScalar(u8, ts_without_tz, 'T');
                            const date_part = parts.next() orelse return error.InvalidTimestamp;
                            const time_part = parts.next() orelse return error.InvalidTimestamp;
                            
                            // Parse date
                            var date_split = std.mem.tokenizeScalar(u8, date_part, '-');
                            const year_s = date_split.next() orelse return error.InvalidTimestamp;
                            const month_s = date_split.next() orelse return error.InvalidTimestamp;
                            const day_s = date_split.next() orelse return error.InvalidTimestamp;
                            
                            const year = try std.fmt.parseInt(u16, year_s, 10);
                            const month = try std.fmt.parseInt(u8, month_s, 10);
                            const day = try std.fmt.parseInt(u8, day_s, 10);
                            
                            // Parse time
                            var time_str = time_part;
                            var millis_str: ?[]const u8 = null;
                            if (std.mem.indexOf(u8, time_part, ".")) |dot_pos| {
                                time_str = time_part[0..dot_pos];
                                millis_str = time_part[dot_pos + 1..];
                            }
                            
                            var time_split = std.mem.tokenizeScalar(u8, time_str, ':');
                            const hour_s = time_split.next() orelse return error.InvalidTimestamp;
                            const min_s = time_split.next() orelse return error.InvalidTimestamp;
                            const sec_s = time_split.next() orelse "00";
                            
                            const hour = try std.fmt.parseInt(u8, hour_s, 10);
                            const min = try std.fmt.parseInt(u8, min_s, 10);
                            const sec = try std.fmt.parseInt(u8, sec_s, 10);
                            
                            // Convert to UTC using the extracted timezone offset
                            const hour_i32: i32 = @intCast(hour);
                            const adjusted_hour_i32 = hour_i32 - timezone_offset_hours;
                            
                            var final_hour: u8 = undefined;
                            var final_day = day;
                            
                            if (adjusted_hour_i32 < 0) {
                                final_hour = @intCast(adjusted_hour_i32 + 24);
                                final_day = if (day > 1) day - 1 else day;
                            } else if (adjusted_hour_i32 >= 24) {
                                final_hour = @intCast(adjusted_hour_i32 - 24);
                                final_day = if (day < 31) day + 1 else day;
                            } else {
                                final_hour = @intCast(adjusted_hour_i32);
                            }
                            
                            // Format with milliseconds if present
                            if (millis_str) |ms| {
                                timestamp = try std.fmt.allocPrint(self.allocator, 
                                    "{d:0>4}-{d:0>2}-{d:0>2}T{d:0>2}:{d:0>2}:{d:0>2}.{s}Z", 
                                    .{ year, month, final_day, final_hour, min, sec, ms }
                                );
                            } else {
                                timestamp = try std.fmt.allocPrint(self.allocator, 
                                    "{d:0>4}-{d:0>2}-{d:0>2}T{d:0>2}:{d:0>2}:{d:0>2}.000Z", 
                                    .{ year, month, final_day, final_hour, min, sec }
                                );
                            }
                        } else if (std.mem.endsWith(u8, ts_raw, "Z")) {
                            // Already has UTC timezone
                            timestamp = try self.allocator.dupe(u8, ts_raw);
                        } else {
                            // Missing timezone, assume Beijing time and convert to UTC
                            // Parse ISO format: YYYY-MM-DDTHH:MM:SS[.mmm]
                            var parts = std.mem.tokenizeScalar(u8, ts_raw, 'T');
                            const date_part = parts.next() orelse return error.InvalidTimestamp;
                            const time_part = parts.next() orelse return error.InvalidTimestamp;
                            
                            // Parse date
                            var date_split = std.mem.tokenizeScalar(u8, date_part, '-');
                            const year_s = date_split.next() orelse return error.InvalidTimestamp;
                            const month_s = date_split.next() orelse return error.InvalidTimestamp;
                            const day_s = date_split.next() orelse return error.InvalidTimestamp;
                            
                            const year = try std.fmt.parseInt(u16, year_s, 10);
                            const month = try std.fmt.parseInt(u8, month_s, 10);
                            const day = try std.fmt.parseInt(u8, day_s, 10);
                            
                            // Parse time
                            var time_str = time_part;
                            var millis_str: ?[]const u8 = null;
                            if (std.mem.indexOf(u8, time_part, ".")) |dot_pos| {
                                time_str = time_part[0..dot_pos];
                                millis_str = time_part[dot_pos + 1..];
                            }
                            
                            var time_split = std.mem.tokenizeScalar(u8, time_str, ':');
                            const hour_s = time_split.next() orelse return error.InvalidTimestamp;
                            const min_s = time_split.next() orelse return error.InvalidTimestamp;
                            const sec_s = time_split.next() orelse "00";
                            
                            const hour = try std.fmt.parseInt(u8, hour_s, 10);
                            const min = try std.fmt.parseInt(u8, min_s, 10);
                            const sec = try std.fmt.parseInt(u8, sec_s, 10);
                            
                            // Convert Beijing time to UTC (subtract 8 hours)
                            const hour_i32: i32 = @intCast(hour);
                            const adjusted_hour_i32 = hour_i32 - 8;
                            
                            var final_hour: u8 = undefined;
                            var final_day = day;
                            
                            if (adjusted_hour_i32 < 0) {
                                final_hour = @intCast(adjusted_hour_i32 + 24);
                                final_day = if (day > 1) day - 1 else day;
                            } else {
                                final_hour = @intCast(adjusted_hour_i32);
                            }
                            
                            // Format with milliseconds if present
                            if (millis_str) |ms| {
                                timestamp = try std.fmt.allocPrint(self.allocator, 
                                    "{d:0>4}-{d:0>2}-{d:0>2}T{d:0>2}:{d:0>2}:{d:0>2}.{s}Z", 
                                    .{ year, month, final_day, final_hour, min, sec, ms }
                                );
                            } else {
                                timestamp = try std.fmt.allocPrint(self.allocator, 
                                    "{d:0>4}-{d:0>2}-{d:0>2}T{d:0>2}:{d:0>2}:{d:0>2}.000Z", 
                                    .{ year, month, final_day, final_hour, min, sec }
                                );
                            }
                        }
                    } else {
                        timestamp = try self.allocator.dupe(u8, ts_raw);
                    }
                }
            } else if (parsing_content) {
                // Check if this looks like a new field
                if (std.mem.indexOf(u8, trimmed, ":") != null and trimmed.len > 0 and
                    trimmed[0] != ' ' and trimmed[0] != '|') {
                    // This is likely a new field, stop parsing content
                    parsing_content = false;
                } else {
                    // Handle continuation lines
                    var content_start: usize = 0;
                    
                    // Skip the formatting prefix like "|                      "
                    if (trimmed.len > 0 and trimmed[0] == '|') {
                        content_start = 1;
                        while (content_start < trimmed.len and trimmed[content_start] == ' ') {
                            content_start += 1;
                        }
                    }
                    
                    if (content_start < trimmed.len) {
                        const content_part = trimmed[content_start..];
                        
                        // Check if this line is just formatting (dashes, equals, underscores, etc.)
                        var is_formatting_line = true;
                        for (content_part) |c| {
                            if (c != '-' and c != '=' and c != '_' and c != ' ' and c != '*') {
                                is_formatting_line = false;
                                break;
                            }
                        }
                        
                        // Only append if it's not a formatting line
                        if (!is_formatting_line and content_part.len > 0) {
                            try content_lines.append(try self.allocator.dupe(u8, content_part));
                        }
                    } else if (trimmed.len == 0 or (trimmed.len > 0 and trimmed[0] == '|' and content_start >= trimmed.len)) {
                        // Empty line or line with just "|" and spaces
                        try content_lines.append(try self.allocator.dupe(u8, ""));
                    }
                }
            }
        }
        
        // Combine content lines
        if (content_lines.items.len > 0) {
            var total_len: usize = 0;
            for (content_lines.items, 0..) |line, i| {
                total_len += line.len;
                if (i < content_lines.items.len - 1) total_len += 1; // Add 1 for newline between lines
            }
            
            const combined_content = try self.allocator.alloc(u8, total_len);
            var pos: usize = 0;
            for (content_lines.items, 0..) |line, i| {
                @memcpy(combined_content[pos..pos + line.len], line);
                pos += line.len;
                if (i < content_lines.items.len - 1) {
                    combined_content[pos] = '\n';
                    pos += 1;
                }
                self.allocator.free(line);
            }
            
            // Clean up content by removing trailing non-UTF8 bytes (like 0xAA)
            var clean_len = combined_content.len;
            while (clean_len > 0) {
                const last_byte = combined_content[clean_len - 1];
                
                // Remove specific modem control characters
                if (last_byte == 0xAA or last_byte == 0xFF) {
                    clean_len -= 1;
                    continue;
                }
                
                // For other high bytes, check if they're part of valid UTF-8
                if (last_byte >= 0x80) {
                    // Check if this is a valid UTF-8 sequence ending
                    if (!std.unicode.utf8ValidateSlice(combined_content[0..clean_len])) {
                        clean_len -= 1;
                        continue;
                    }
                }
                break;
            }
            
            // Allocate clean content
            const clean_content = try self.allocator.alloc(u8, clean_len);
            @memcpy(clean_content[0..clean_len], combined_content[0..clean_len]);
            self.allocator.free(combined_content);
            
            content = clean_content;
        }
        
        if (phone_number == null or content == null) {
            if (phone_number) |pn| self.allocator.free(pn);
            if (content) |c| self.allocator.free(c);
            if (timestamp) |ts| self.allocator.free(ts);
            return error.InvalidSmsData;
        }
        
        return types.MessageInfo{
            .modem_id = try self.allocator.dupe(u8, "0"),
            .sms_id = try self.allocator.dupe(u8, "1"),
            .message = types.Message{
                .phone_iccid = try self.allocator.dupe(u8, iccid),
                .phone_number = phone_number.?,
                .content = content.?,
                .timestamp = timestamp orelse try self.allocator.dupe(u8, ""),
            },
        };
    }
};

test "mmcli parse simple single-line SMS" {
    var mock = MockModemManager.init(testing.allocator);
    defer mock.deinit();
    
    const output =
        \\SMS/1 (received)
        \\  -----------------------------------
        \\  Content    |              number: +1234567890
        \\             |                text: Your verification code is 123456
        \\             |           timestamp: 2025/07/30,15:30:45+08
        \\  -----------------------------------
    ;
    
    const result = try mock.parseSmsOutput(output, "89860123456789012345");
    defer {
        testing.allocator.free(result.modem_id);
        testing.allocator.free(result.sms_id);
        testing.allocator.free(result.message.phone_iccid);
        testing.allocator.free(result.message.phone_number);
        testing.allocator.free(result.message.content);
        testing.allocator.free(result.message.timestamp);
    }
    
    try testing.expectEqualStrings("+1234567890", result.message.phone_number);
    try testing.expectEqualStrings("Your verification code is 123456", result.message.content);
    // 15:30:45+08 converts to 07:30:45Z
    try testing.expectEqualStrings("2025-07-30T07:30:45.000Z", result.message.timestamp);
}

test "mmcli parse multiline SMS content" {
    var mock = MockModemManager.init(testing.allocator);
    defer mock.deinit();
    
    const output =
        \\SMS/2 (received)
        \\  -----------------------------------
        \\  Content    |              number: +0987654321
        \\             |                text: Hello,
        \\             |                      This is a multiline message.
        \\             |                      It spans multiple lines.
        \\             |                      
        \\             |                      Best regards
        \\             |           timestamp: 2025/07/30,16:45:00+08
        \\  -----------------------------------
    ;
    
    const result = try mock.parseSmsOutput(output, "89860123456789012345");
    defer {
        testing.allocator.free(result.modem_id);
        testing.allocator.free(result.sms_id);
        testing.allocator.free(result.message.phone_iccid);
        testing.allocator.free(result.message.phone_number);
        testing.allocator.free(result.message.content);
        testing.allocator.free(result.message.timestamp);
    }
    
    try testing.expectEqualStrings("+0987654321", result.message.phone_number);
    const expected_content = "Hello,\nThis is a multiline message.\nIt spans multiple lines.\n\nBest regards";
    try testing.expectEqualStrings(expected_content, result.message.content);
}

test "mmcli parse SMS with special characters" {
    var mock = MockModemManager.init(testing.allocator);
    defer mock.deinit();
    
    const output =
        \\SMS/3 (received)
        \\  -----------------------------------
        \\  Content    |              number: +1112223333
        \\             |                text: Special chars: !@#$%^&*()_+-={}[]|:;<>?,./
        \\             |           timestamp: 2025/07/30,17:00:00+08
        \\  -----------------------------------
    ;
    
    const result = try mock.parseSmsOutput(output, "89860123456789012345");
    defer {
        testing.allocator.free(result.modem_id);
        testing.allocator.free(result.sms_id);
        testing.allocator.free(result.message.phone_iccid);
        testing.allocator.free(result.message.phone_number);
        testing.allocator.free(result.message.content);
        testing.allocator.free(result.message.timestamp);
    }
    
    try testing.expectEqualStrings("Special chars: !@#$%^&*()_+-={}[]|:;<>?,./", result.message.content);
}

test "mmcli parse SMS with Unicode/Chinese characters" {
    var mock = MockModemManager.init(testing.allocator);
    defer mock.deinit();
    
    const output =
        \\SMS/4 (received)
        \\  -----------------------------------
        \\  Content    |              number: +8613800138000
        \\             |                text: 您的验证码是：888888
        \\             |                      请在5分钟内使用
        \\             |           timestamp: 2025/07/30,18:15:30+08
        \\  -----------------------------------
    ;
    
    const result = try mock.parseSmsOutput(output, "89860123456789012345");
    defer {
        testing.allocator.free(result.modem_id);
        testing.allocator.free(result.sms_id);
        testing.allocator.free(result.message.phone_iccid);
        testing.allocator.free(result.message.phone_number);
        testing.allocator.free(result.message.content);
        testing.allocator.free(result.message.timestamp);
    }
    
    try testing.expectEqualStrings("+8613800138000", result.message.phone_number);
    try testing.expectEqualStrings("您的验证码是：888888\n请在5分钟内使用", result.message.content);
}

test "mmcli parse SMS with empty content lines" {
    var mock = MockModemManager.init(testing.allocator);
    defer mock.deinit();
    
    const output =
        \\SMS/5 (received)
        \\  -----------------------------------
        \\  Content    |              number: +1234567890
        \\             |                text: Line 1
        \\             |                      
        \\             |                      
        \\             |                      Line 4 after empty lines
        \\             |           timestamp: 2025/07/30,19:00:00+08
        \\  -----------------------------------
    ;
    
    const result = try mock.parseSmsOutput(output, "89860123456789012345");
    defer {
        testing.allocator.free(result.modem_id);
        testing.allocator.free(result.sms_id);
        testing.allocator.free(result.message.phone_iccid);
        testing.allocator.free(result.message.phone_number);
        testing.allocator.free(result.message.content);
        testing.allocator.free(result.message.timestamp);
    }
    
    try testing.expectEqualStrings("Line 1\n\n\nLine 4 after empty lines", result.message.content);
}

test "mmcli parse SMS with quoted phone number" {
    var mock = MockModemManager.init(testing.allocator);
    defer mock.deinit();
    
    const output =
        \\SMS/6 (received)
        \\  -----------------------------------
        \\  Content    |              number: '+1234567890'
        \\             |                text: "Quoted text message"
        \\             |           timestamp: '2025/07/30,20:00:00+08'
        \\  -----------------------------------
    ;
    
    const result = try mock.parseSmsOutput(output, "89860123456789012345");
    defer {
        testing.allocator.free(result.modem_id);
        testing.allocator.free(result.sms_id);
        testing.allocator.free(result.message.phone_iccid);
        testing.allocator.free(result.message.phone_number);
        testing.allocator.free(result.message.content);
        testing.allocator.free(result.message.timestamp);
    }
    
    try testing.expectEqualStrings("+1234567890", result.message.phone_number);
    try testing.expectEqualStrings("Quoted text message", result.message.content);
    // 20:00:00+08 converts to 12:00:00Z
    try testing.expectEqualStrings("2025-07-30T12:00:00.000Z", result.message.timestamp);
}

test "mmcli parse SMS with colon in content" {
    var mock = MockModemManager.init(testing.allocator);
    defer mock.deinit();
    
    const output =
        \\SMS/7 (received)
        \\  -----------------------------------
        \\  Content    |              number: +1234567890
        \\             |                text: Meeting at 3:00 PM
        \\             |                      Location: Conference Room A
        \\             |                      Time: 15:00-16:00
        \\             |           timestamp: 2025/07/30,21:00:00+08
        \\  -----------------------------------
    ;
    
    const result = try mock.parseSmsOutput(output, "89860123456789012345");
    defer {
        testing.allocator.free(result.modem_id);
        testing.allocator.free(result.sms_id);
        testing.allocator.free(result.message.phone_iccid);
        testing.allocator.free(result.message.phone_number);
        testing.allocator.free(result.message.content);
        testing.allocator.free(result.message.timestamp);
    }
    
    // Content lines that are indented (start with | and spaces) should be kept even with colons
    const expected = "Meeting at 3:00 PM\nLocation: Conference Room A\nTime: 15:00-16:00";
    try testing.expectEqualStrings(expected, result.message.content);
}

test "mmcli parse SMS with missing timestamp" {
    var mock = MockModemManager.init(testing.allocator);
    defer mock.deinit();
    
    const output =
        \\SMS/8 (received)
        \\  -----------------------------------
        \\  Content    |              number: +1234567890
        \\             |                text: Message without timestamp
    ;
    
    const result = try mock.parseSmsOutput(output, "89860123456789012345");
    defer {
        testing.allocator.free(result.modem_id);
        testing.allocator.free(result.sms_id);
        testing.allocator.free(result.message.phone_iccid);
        testing.allocator.free(result.message.phone_number);
        testing.allocator.free(result.message.content);
        testing.allocator.free(result.message.timestamp);
    }
    
    try testing.expectEqualStrings("Message without timestamp", result.message.content);
    try testing.expectEqualStrings("", result.message.timestamp);
}

test "mmcli parse SMS with various timestamp formats" {
    var mock = MockModemManager.init(testing.allocator);
    defer mock.deinit();
    
    // Test ISO format with timezone
    const output1 =
        \\SMS/9 (received)
        \\  -----------------------------------
        \\  Content    |              number: +1234567890
        \\             |                text: Test
        \\             |           timestamp: 2025/07/30,15:30:45+0800
        \\  -----------------------------------
    ;
    
    const result1 = try mock.parseSmsOutput(output1, "89860123456789012345");
    defer {
        testing.allocator.free(result1.modem_id);
        testing.allocator.free(result1.sms_id);
        testing.allocator.free(result1.message.phone_iccid);
        testing.allocator.free(result1.message.phone_number);
        testing.allocator.free(result1.message.content);
        testing.allocator.free(result1.message.timestamp);
    }
    
    // 15:30:45+0800 converts to 07:30:45Z
    try testing.expectEqualStrings("2025-07-30T07:30:45.000Z", result1.message.timestamp);
}

test "mmcli parse invalid SMS - missing phone number" {
    var mock = MockModemManager.init(testing.allocator);
    defer mock.deinit();
    
    const output =
        \\SMS/10 (received)
        \\  -----------------------------------
        \\  Content    |                text: Message without phone number
        \\             |           timestamp: 2025/07/30,22:00:00+08
        \\  -----------------------------------
    ;
    
    const result = mock.parseSmsOutput(output, "89860123456789012345");
    try testing.expectError(error.InvalidSmsData, result);
}

test "mmcli parse invalid SMS - missing content" {
    var mock = MockModemManager.init(testing.allocator);
    defer mock.deinit();
    
    const output =
        \\SMS/11 (received)
        \\  -----------------------------------
        \\  Content    |              number: +1234567890
        \\             |           timestamp: 2025/07/30,22:00:00+08
        \\  -----------------------------------
    ;
    
    const result = mock.parseSmsOutput(output, "89860123456789012345");
    try testing.expectError(error.InvalidSmsData, result);
}

test "mmcli parse SMS with unusual formatting" {
    var mock = MockModemManager.init(testing.allocator);
    defer mock.deinit();
    
    const output =
        \\SMS/12 (received)
        \\  -----------------------------------
        \\  Content    |              number:+1234567890
        \\             |                text:No spaces after colons
        \\             |           timestamp:2025/07/30,23:00:00+08
        \\  -----------------------------------
    ;
    
    // This test should fail because parser expects ": " (colon + space)
    const result = mock.parseSmsOutput(output, "89860123456789012345");
    try testing.expectError(error.InvalidSmsData, result);
}

test "mmcli parse SMS with extra whitespace" {
    var mock = MockModemManager.init(testing.allocator);
    defer mock.deinit();
    
    const output =
        \\SMS/13 (received)
        \\  -----------------------------------
        \\  Content    |              number: +1234567890    
        \\             |                text: Message with extra spaces    
        \\             |                      around the content     
        \\             |           timestamp: 2025/07/30,23:30:00+08    
        \\  -----------------------------------
    ;
    
    const result = try mock.parseSmsOutput(output, "89860123456789012345");
    defer {
        testing.allocator.free(result.modem_id);
        testing.allocator.free(result.sms_id);
        testing.allocator.free(result.message.phone_iccid);
        testing.allocator.free(result.message.phone_number);
        testing.allocator.free(result.message.content);
        testing.allocator.free(result.message.timestamp);
    }
    
    try testing.expectEqualStrings("+1234567890", result.message.phone_number);
    try testing.expectEqualStrings("Message with extra spaces\naround the content", result.message.content);
}

test "mmcli parse SMS with timezone conversion UTC+8 to UTC" {
    var mock = MockModemManager.init(testing.allocator);
    defer mock.deinit();
    
    const output =
        \\SMS/14 (received)
        \\  -----------------------------------
        \\  Content    |              number: +8613800138000
        \\             |                text: Test timezone conversion
        \\             |           timestamp: 2025/07/30,10:25:46+08
        \\  -----------------------------------
    ;
    
    const result = try mock.parseSmsOutput(output, "89860118803452905448");
    defer {
        testing.allocator.free(result.modem_id);
        testing.allocator.free(result.sms_id);
        testing.allocator.free(result.message.phone_iccid);
        testing.allocator.free(result.message.phone_number);
        testing.allocator.free(result.message.content);
        testing.allocator.free(result.message.timestamp);
    }
    
    try testing.expectEqualStrings("+8613800138000", result.message.phone_number);
    try testing.expectEqualStrings("Test timezone conversion", result.message.content);
    // 10:25:46+08 should become 02:25:46Z (subtract 8 hours)
    try testing.expectEqualStrings("2025-07-30T02:25:46.000Z", result.message.timestamp);
}

test "mmcli parse SMS with timezone conversion crossing day boundary" {
    var mock = MockModemManager.init(testing.allocator);
    defer mock.deinit();
    
    const output =
        \\SMS/15 (received)
        \\  -----------------------------------
        \\  Content    |              number: +8613800138000
        \\             |                text: Early morning message
        \\             |           timestamp: 2025/07/31,02:30:00+08
        \\  -----------------------------------
    ;
    
    const result = try mock.parseSmsOutput(output, "89860118803452905448");
    defer {
        testing.allocator.free(result.modem_id);
        testing.allocator.free(result.sms_id);
        testing.allocator.free(result.message.phone_iccid);
        testing.allocator.free(result.message.phone_number);
        testing.allocator.free(result.message.content);
        testing.allocator.free(result.message.timestamp);
    }
    
    // 02:30:00+08 on July 31 should become 18:30:00Z on July 30 (previous day)
    try testing.expectEqualStrings("2025-07-30T18:30:00.000Z", result.message.timestamp);
}

test "mmcli parse SMS without timezone (assumes UTC+8)" {
    var mock = MockModemManager.init(testing.allocator);
    defer mock.deinit();
    
    const output =
        \\SMS/16 (received)
        \\  -----------------------------------
        \\  Content    |              number: 10010
        \\             |                text: 【广东联通】提醒您
        \\             |           timestamp: 2025/07/30,18:14:02
        \\  -----------------------------------
    ;
    
    const result = try mock.parseSmsOutput(output, "89860117801718603428");
    defer {
        testing.allocator.free(result.modem_id);
        testing.allocator.free(result.sms_id);
        testing.allocator.free(result.message.phone_iccid);
        testing.allocator.free(result.message.phone_number);
        testing.allocator.free(result.message.content);
        testing.allocator.free(result.message.timestamp);
    }
    
    try testing.expectEqualStrings("10010", result.message.phone_number);
    try testing.expectEqualStrings("【广东联通】提醒您", result.message.content);
    // 18:14:02 without timezone should be treated as Beijing time (UTC+8)
    // so 18:14:02 - 8 hours = 10:14:02Z
    try testing.expectEqualStrings("2025-07-30T10:14:02.000Z", result.message.timestamp);
}

test "mmcli parse SMS with trailing 0xAA byte (modem control character)" {
    var mock = MockModemManager.init(testing.allocator);
    defer mock.deinit();
    
    // Create output with Chinese text followed by 0xAA byte
    const chinese_text = "凄凄切切凄凄切切";
    var content_with_aa = try testing.allocator.alloc(u8, chinese_text.len + 1);
    defer testing.allocator.free(content_with_aa);
    @memcpy(content_with_aa[0..chinese_text.len], chinese_text);
    content_with_aa[chinese_text.len] = 0xAA; // Add trailing 0xAA
    
    var output_buffer = std.ArrayList(u8).init(testing.allocator);
    defer output_buffer.deinit();
    
    try output_buffer.appendSlice(
        \\SMS/17 (received)
        \\  -----------------------------------
        \\  Content    |              number: +6592401051
        \\             |                text: 
    );
    try output_buffer.appendSlice(content_with_aa);
    try output_buffer.appendSlice(
        \\
        \\             |           timestamp: 2025/07/30,19:57:07+08
        \\  -----------------------------------
    );
    
    const result = try mock.parseSmsOutput(output_buffer.items, "8965030124051507919");
    defer {
        testing.allocator.free(result.modem_id);
        testing.allocator.free(result.sms_id);
        testing.allocator.free(result.message.phone_iccid);
        testing.allocator.free(result.message.phone_number);
        testing.allocator.free(result.message.content);
        testing.allocator.free(result.message.timestamp);
    }
    
    try testing.expectEqualStrings("+6592401051", result.message.phone_number);
    // Content should have 0xAA removed and formatting dashes excluded
    try testing.expectEqualStrings(chinese_text, result.message.content);
    // Verify no 0xAA in content
    try testing.expect(result.message.content[result.message.content.len - 1] != 0xAA);
    // Verify last character is '切' (the last Chinese character)
    try testing.expect(result.message.content[result.message.content.len - 3] == 0xE5); // First byte of '切'
    // Timestamp with +08 should be converted to UTC
    try testing.expectEqualStrings("2025-07-30T11:57:07.000Z", result.message.timestamp);
}

test "mmcli parse SMS with ISO timestamp missing timezone" {
    var mock = MockModemManager.init(testing.allocator);
    defer mock.deinit();
    
    const output =
        \\SMS/18 (received)
        \\  -----------------------------------
        \\  Content    |              number: +8613800138000
        \\             |                text: Test message
        \\             |           timestamp: 2025-07-30T20:16:36
        \\  -----------------------------------
    ;
    
    const result = try mock.parseSmsOutput(output, "89860118803452905448");
    defer {
        testing.allocator.free(result.modem_id);
        testing.allocator.free(result.sms_id);
        testing.allocator.free(result.message.phone_iccid);
        testing.allocator.free(result.message.phone_number);
        testing.allocator.free(result.message.content);
        testing.allocator.free(result.message.timestamp);
    }
    
    try testing.expectEqualStrings("+8613800138000", result.message.phone_number);
    try testing.expectEqualStrings("Test message", result.message.content);
    // ISO timestamp without timezone should be converted from Beijing time to UTC
    try testing.expectEqualStrings("2025-07-30T12:16:36.000Z", result.message.timestamp);
}

test "mmcli parse SMS with ISO timestamp with milliseconds missing timezone" {
    var mock = MockModemManager.init(testing.allocator);
    defer mock.deinit();
    
    const output =
        \\SMS/19 (received)
        \\  -----------------------------------
        \\  Content    |              number: +8613800138000
        \\             |                text: Test with millis
        \\             |           timestamp: 2025-07-30T20:16:36.123
        \\  -----------------------------------
    ;
    
    const result = try mock.parseSmsOutput(output, "89860118803452905448");
    defer {
        testing.allocator.free(result.modem_id);
        testing.allocator.free(result.sms_id);
        testing.allocator.free(result.message.phone_iccid);
        testing.allocator.free(result.message.phone_number);
        testing.allocator.free(result.message.content);
        testing.allocator.free(result.message.timestamp);
    }
    
    try testing.expectEqualStrings("+8613800138000", result.message.phone_number);
    try testing.expectEqualStrings("Test with millis", result.message.content);
    // ISO timestamp with milliseconds should be converted from Beijing time to UTC
    try testing.expectEqualStrings("2025-07-30T12:16:36.123Z", result.message.timestamp);
}

test "mmcli parse SMS with Beijing time 20:32 should convert to UTC 12:32" {
    var mock = MockModemManager.init(testing.allocator);
    defer mock.deinit();
    
    const output =
        \\SMS/20 (received)
        \\  -----------------------------------
        \\  Content    |              number: +6592401051
        \\             |                text: 午餐
        \\             |                      -----------------------
        \\             |           timestamp: 2025-07-30T20:32:14
        \\  -----------------------------------
    ;
    
    const result = try mock.parseSmsOutput(output, "8965030124051507919");
    defer {
        testing.allocator.free(result.modem_id);
        testing.allocator.free(result.sms_id);
        testing.allocator.free(result.message.phone_iccid);
        testing.allocator.free(result.message.phone_number);
        testing.allocator.free(result.message.content);
        testing.allocator.free(result.message.timestamp);
    }
    
    try testing.expectEqualStrings("+6592401051", result.message.phone_number);
    try testing.expectEqualStrings("午餐", result.message.content);
    // Beijing time 20:32:14 should become UTC 12:32:14
    try testing.expectEqualStrings("2025-07-30T12:32:14.000Z", result.message.timestamp);
}

test "mmcli parse SMS excludes formatting lines" {
    var mock = MockModemManager.init(testing.allocator);
    defer mock.deinit();
    
    const output =
        \\SMS/21 (received)
        \\  -----------------------------------
        \\  Content    |              number: +1234567890
        \\             |                text: Real content
        \\             |                      ====================
        \\             |                      More real content
        \\             |                      --------------------
        \\             |                      * * * * * * * * * *
        \\             |                      Final line
        \\             |                      ____________________
        \\             |           timestamp: 2025-07-30T10:00:00+08
        \\  -----------------------------------
    ;
    
    const result = try mock.parseSmsOutput(output, "89860123456789012345");
    defer {
        testing.allocator.free(result.modem_id);
        testing.allocator.free(result.sms_id);
        testing.allocator.free(result.message.phone_iccid);
        testing.allocator.free(result.message.phone_number);
        testing.allocator.free(result.message.content);
        testing.allocator.free(result.message.timestamp);
    }
    
    try testing.expectEqualStrings("+1234567890", result.message.phone_number);
    // Should exclude all formatting lines (=, -, *, _)
    try testing.expectEqualStrings("Real content\nMore real content\nFinal line", result.message.content);
    try testing.expectEqualStrings("2025-07-30T02:00:00.000Z", result.message.timestamp);
}

test "mmcli parse SMS with Chinese text and formatting line" {
    var mock = MockModemManager.init(testing.allocator);
    defer mock.deinit();
    
    const output =
        \\SMS/22 (received)
        \\  -----------------------------------
        \\  Content    |              number: +6592401051
        \\             |                text: 午餐
        \\             |                      -----------------------
        \\             |           timestamp: 2025-07-30T20:32:14
        \\  -----------------------------------
    ;
    
    const result = try mock.parseSmsOutput(output, "8965030124051507919");
    defer {
        testing.allocator.free(result.modem_id);
        testing.allocator.free(result.sms_id);
        testing.allocator.free(result.message.phone_iccid);
        testing.allocator.free(result.message.phone_number);
        testing.allocator.free(result.message.content);
        testing.allocator.free(result.message.timestamp);
    }
    
    try testing.expectEqualStrings("+6592401051", result.message.phone_number);
    // Should exclude the formatting line
    try testing.expectEqualStrings("午餐", result.message.content);
    // Beijing time 20:32:14 should become UTC 12:32:14
    try testing.expectEqualStrings("2025-07-30T12:32:14.000Z", result.message.timestamp);
}

test "mmcli parse SMS with pipe prefix in content lines" {
    var mock = MockModemManager.init(testing.allocator);
    defer mock.deinit();
    
    const output =
        \\SMS/23 (received)
        \\  -----------------------------------
        \\  Content    |              number: +6592401051
        \\             |                text: 饭饭
        \\             |                      吃吃
        \\             |                      666
        \\             |           timestamp: 2025-07-30T21:03:16+08
        \\  -----------------------------------
    ;
    
    const result = try mock.parseSmsOutput(output, "8965030124051507919");
    defer {
        testing.allocator.free(result.modem_id);
        testing.allocator.free(result.sms_id);
        testing.allocator.free(result.message.phone_iccid);
        testing.allocator.free(result.message.phone_number);
        testing.allocator.free(result.message.content);
        testing.allocator.free(result.message.timestamp);
    }
    
    try testing.expectEqualStrings("+6592401051", result.message.phone_number);
    // Should clean up the pipe prefix and spaces
    try testing.expectEqualStrings("饭饭\n吃吃\n666", result.message.content);
    // Beijing time 21:03:16+08 should become UTC 13:03:16
    try testing.expectEqualStrings("2025-07-30T13:03:16.000Z", result.message.timestamp);
}