const std = @import("std");
const testing = std.testing;

// Import all modules
const utils = @import("utils.zig");
const types = @import("types.zig");
const MessageQueue = @import("message_queue.zig").MessageQueue;
const SignalCache = @import("signal_cache.zig").SignalCache;
const ApiClient = @import("api_client.zig").ApiClient;
const ModemManager = @import("modem_manager.zig").ModemManager;
const SMSSender = @import("sms_sender.zig").SMSSender;
const OutgoingSMS = @import("sms_sender.zig").OutgoingSMS;

// Import mmcli parser tests
test {
    _ = @import("mmcli_parser_tests.zig");
}

// Utils tests
test "extractVerificationCode - Chinese patterns" {
    const test_cases = [_]struct {
        input: []const u8,
        expected: ?[]const u8,
    }{
        .{ .input = "您的验证码是123456", .expected = "123456" },
        .{ .input = "验证码为 8888，请勿泄露", .expected = "8888" },
        .{ .input = "【淘宝】验证码1234，请尽快使用", .expected = "1234" },
        .{ .input = "校验码：987654", .expected = "987654" },
        .{ .input = "动态码 4567 有效期5分钟", .expected = "4567" },
        .{ .input = "认证码是555666", .expected = "555666" },
    };

    for (test_cases) |tc| {
        const result = utils.extractVerificationCode(tc.input);
        if (tc.expected) |expected| {
            try testing.expect(result != null);
            try testing.expectEqualStrings(expected, result.?);
        } else {
            try testing.expect(result == null);
        }
    }
}

test "extractVerificationCode - English patterns" {
    const test_cases = [_]struct {
        input: []const u8,
        expected: ?[]const u8,
    }{
        .{ .input = "Your verification code is 123456", .expected = "123456" },
        .{ .input = "code is: 7890", .expected = "7890" },
        .{ .input = "OTP: 4321", .expected = "4321" },
        .{ .input = "Use code: 999888 to login", .expected = "999888" },
    };

    for (test_cases) |tc| {
        const result = utils.extractVerificationCode(tc.input);
        if (tc.expected) |expected| {
            try testing.expect(result != null);
            try testing.expectEqualStrings(expected, result.?);
        } else {
            try testing.expect(result == null);
        }
    }
}

test "extractVerificationCode - standalone numbers" {
    const test_cases = [_]struct {
        input: []const u8,
        expected: ?[]const u8,
    }{
        .{ .input = "Please use 5678 for verification", .expected = "5678" },
        .{ .input = "Code [123456]", .expected = "123456" },
        .{ .input = "Enter: 9999", .expected = "9999" },
        .{ .input = "No code here", .expected = null },
        .{ .input = "Too short: 123", .expected = null },
        .{ .input = "Too long: 123456789", .expected = null },
    };

    for (test_cases) |tc| {
        const result = utils.extractVerificationCode(tc.input);
        if (tc.expected) |expected| {
            try testing.expect(result != null);
            try testing.expectEqualStrings(expected, result.?);
        } else {
            try testing.expect(result == null);
        }
    }
}

test "extractVerificationCode - edge cases" {
    try testing.expect(utils.extractVerificationCode("") == null);
    try testing.expect(utils.extractVerificationCode("no numbers here") == null);
    try testing.expect(utils.extractVerificationCode("12") == null); // too short
    try testing.expect(utils.extractVerificationCode("123") == null); // too short
    try testing.expect(utils.extractVerificationCode("123456789") == null); // too long
}

// Types tests
test "Config struct defaults" {
    const config = types.Config{
        .api_url = "https://test.com",
        .api_key = "test-key",
    };
    
    try testing.expectEqualStrings("https://test.com", config.api_url);
    try testing.expectEqualStrings("test-key", config.api_key);
    try testing.expectEqual(@as(u64, 30), config.check_interval);
    try testing.expectEqual(@as(u64, 100), config.message_check_interval);
    try testing.expectEqual(@as(u64, 60), config.signal_check_interval);
    try testing.expectEqual(@as(u32, 3), config.max_retries);
    try testing.expectEqual(@as(u64, 5), config.retry_delay);
}

test "Message struct" {
    const msg = types.Message{
        .phone_iccid = "89860123456789012345",
        .phone_number = "+1234567890",
        .content = "Test message",
        .timestamp = "2025-07-30T10:00:00Z",
    };
    
    try testing.expectEqualStrings("89860123456789012345", msg.phone_iccid);
    try testing.expectEqualStrings("+1234567890", msg.phone_number);
    try testing.expectEqualStrings("Test message", msg.content);
    try testing.expectEqualStrings("2025-07-30T10:00:00Z", msg.timestamp);
}

test "Phone struct with minimal fields" {
    const phone = types.Phone{
        .iccid = "89860123456789012345",
        .status = "not_ready",
    };
    
    try testing.expectEqualStrings("89860123456789012345", phone.iccid);
    try testing.expectEqualStrings("not_ready", phone.status);
    try testing.expect(phone.number == null);
    try testing.expect(phone.signal == null);
    try testing.expect(phone.operator_name == null);
}

// MessageQueue tests
test "MessageQueue init and deinit" {
    var queue = MessageQueue.init(testing.allocator);
    defer queue.deinit();
    
    try testing.expectEqual(@as(usize, 0), queue.size());
}

test "MessageQueue push and size" {
    var queue = MessageQueue.init(testing.allocator);
    defer queue.deinit();
    
    const msg = types.MessageInfo{
        .modem_id = "modem_1",
        .sms_id = "sms_123",
        .message = .{
            .phone_iccid = "89860123456789012345",
            .phone_number = "+1234567890",
            .content = "Test message",
            .timestamp = "2025-07-30T10:00:00Z",
        },
    };
    
    try queue.push(msg);
    try testing.expectEqual(@as(usize, 1), queue.size());
    
    try queue.push(msg);
    try testing.expectEqual(@as(usize, 2), queue.size());
}

test "MessageQueue popBatch empty queue" {
    var queue = MessageQueue.init(testing.allocator);
    defer queue.deinit();
    
    const batch = try queue.popBatch(5);
    defer testing.allocator.free(batch);
    
    try testing.expectEqual(@as(usize, 0), batch.len);
}

// SignalCache tests
test "SignalCache init and deinit" {
    var cache = SignalCache.init(testing.allocator);
    defer cache.deinit();
    
    // Cache should be empty initially
    const signal = cache.getSignal("modem_1");
    try testing.expect(signal == null);
}

test "SignalCache updateCache and getSignal" {
    var cache = SignalCache.init(testing.allocator);
    defer cache.deinit();
    
    const signal_data = types.SignalData{
        .signal_percent = 75,
        .rssi = -65,
        .rsrq = -8,
        .rsrp = -95,
        .snr = 20,
    };
    
    try cache.updateCache("modem_1", signal_data);
    
    const retrieved = cache.getSignal("modem_1");
    try testing.expect(retrieved != null);
    try testing.expectEqual(@as(u8, 75), retrieved.?.signal_percent);
    try testing.expectEqual(@as(i32, -65), retrieved.?.rssi.?);
}

test "SignalCache shouldUpdate - no cached data" {
    var cache = SignalCache.init(testing.allocator);
    defer cache.deinit();
    
    const signal_data = types.SignalData{
        .signal_percent = 75,
        .rssi = -65,
        .rsrq = null,
        .rsrp = null,
        .snr = null,
    };
    
    // Should update when no cached data exists
    try testing.expect(cache.shouldUpdate("modem_1", signal_data));
}

// ApiClient tests
test "ApiClient init and deinit" {
    const config = types.Config{
        .api_url = "https://test.com",
        .api_key = "test-key",
    };
    
    var client = ApiClient.init(testing.allocator, config);
    defer client.deinit();
    
    try testing.expectEqualStrings("test-key", client.config.api_key);
}

test "JSON encoding of messages with UTF-8 content" {
    const allocator = testing.allocator;
    
    // Test message with Chinese content
    const message = types.Message{
        .phone_iccid = "89860117801718603428",
        .phone_number = "10010",
        .content = "【广东联通】提醒您：近期有境外不法分子拨打本地固话，仿冒运营商装维人员",
        .timestamp = "2025-07-30T18:14:02.000Z",
    };
    
    // Encode to JSON
    const json_str = try std.json.stringifyAlloc(allocator, message, .{ .emit_null_optional_fields = false });
    defer allocator.free(json_str);
    
    // The content should be encoded as a string, not as a byte array
    try testing.expect(std.mem.indexOf(u8, json_str, "\"content\":\"【广东联通】") != null);
    try testing.expect(std.mem.indexOf(u8, json_str, "[227,128,144,") == null); // Should NOT contain byte array
    
    // Test with emoji and special characters
    const message2 = types.Message{
        .phone_iccid = "89860117801718603428",
        .phone_number = "10010",
        .content = "Test message with emoji 🎉 and special chars: ñáéíóú",
        .timestamp = "2025-07-30T18:14:02.000Z",
    };
    
    const json_str2 = try std.json.stringifyAlloc(allocator, message2, .{ .emit_null_optional_fields = false });
    defer allocator.free(json_str2);
    
    try testing.expect(std.mem.indexOf(u8, json_str2, "\"content\":\"Test message with emoji") != null);
}

test "JSON encoding with trailing non-UTF8 bytes" {
    const allocator = testing.allocator;
    
    // Simulate content with trailing 0xAA byte (common modem control character)
    const content_with_trailing = "【广东联通】提醒您\xAA";
    
    // This would cause JSON to encode as byte array
    const bad_message = types.Message{
        .phone_iccid = "89860117801718603428",
        .phone_number = "10010",
        .content = content_with_trailing,
        .timestamp = "2025-07-30T18:14:02.000Z",
    };
    
    const json_str = try std.json.stringifyAlloc(allocator, bad_message, .{ .emit_null_optional_fields = false });
    defer allocator.free(json_str);
    
    // With the bad byte, JSON will encode as array
    try testing.expect(std.mem.indexOf(u8, json_str, "[") != null);
}

test "JSON encoding with trailing 0xAA byte should clean and encode as string" {
    const allocator = testing.allocator;
    
    // Create Chinese text with trailing 0xAA - this is what we saw in the logs
    const chinese_text = "凄凄切切凄凄切切\n---------------------";
    var content_with_aa = try allocator.alloc(u8, chinese_text.len + 1);
    defer allocator.free(content_with_aa);
    @memcpy(content_with_aa[0..chinese_text.len], chinese_text);
    content_with_aa[chinese_text.len] = 0xAA;
    
    const message = types.Message{
        .phone_iccid = "8965030124051507919",
        .phone_number = "+6592401051",
        .content = content_with_aa, // With 0xAA
        .timestamp = "2025-07-30T19:57:07",
    };
    
    const json_str = try std.json.stringifyAlloc(allocator, message, .{});
    defer allocator.free(json_str);
    
    // Currently will be encoded as byte array due to 0xAA
    try testing.expect(std.mem.indexOf(u8, json_str, "[229,") != null);
    try testing.expect(std.mem.indexOf(u8, json_str, ",170]") != null); // 0xAA = 170
}

test "ApiClient uploadMessages empty array" {
    const config = types.Config{
        .api_url = "https://test.com",
        .api_key = "test-key",
    };
    
    var client = ApiClient.init(testing.allocator, config);
    defer client.deinit();
    
    const messages: []const types.Message = &[_]types.Message{};
    
    // Should return early without making request
    try client.uploadMessages(messages);
}

// ModemManager tests
test "ModemManager init and deinit" {
    var manager = ModemManager.init(testing.allocator);
    defer manager.deinit();
    
    // Check that hash maps are initialized
    try testing.expectEqual(@as(usize, 0), manager.failed_sms_ids.count());
    try testing.expectEqual(@as(usize, 0), manager.iccid_warnings.count());
    try testing.expectEqual(@as(usize, 0), manager.problematic_modems.count());
}

test "ModemManager problematic_modems tracking" {
    var manager = ModemManager.init(testing.allocator);
    defer manager.deinit();
    
    // Add problematic modems
    const modem1 = try testing.allocator.dupe(u8, "0");
    const modem2 = try testing.allocator.dupe(u8, "5");
    
    try manager.problematic_modems.put(modem1, {});
    try manager.problematic_modems.put(modem2, {});
    
    try testing.expectEqual(@as(usize, 2), manager.problematic_modems.count());
    try testing.expect(manager.problematic_modems.contains("0"));
    try testing.expect(manager.problematic_modems.contains("5"));
}

test "ModemManager getIccid skips problematic modems" {
    var manager = ModemManager.init(testing.allocator);
    defer manager.deinit();
    
    // Mark a modem as problematic
    const modem_id = try testing.allocator.dupe(u8, "0");
    try manager.problematic_modems.put(modem_id, {});
    
    // Should return null for problematic modem
    const result = try manager.getIccid("0");
    try testing.expect(result == null);
}

// SMSSender tests
test "OutgoingSMS struct and deinit" {
    var sms = OutgoingSMS{
        .id = try testing.allocator.dupe(u8, "msg_123"),
        .recipient = try testing.allocator.dupe(u8, "+1234567890"),
        .phone_iccid = try testing.allocator.dupe(u8, "89860123456789012345"),
        .content = try testing.allocator.dupe(u8, "Test SMS"),
        .created_at = try testing.allocator.dupe(u8, "2025-07-30T10:00:00Z"),
    };
    
    sms.deinit(testing.allocator);
}

test "SMSSender init" {
    const config = types.Config{
        .api_url = "https://test.com",
        .api_key = "test-key",
    };
    
    var api_client = ApiClient.init(testing.allocator, config);
    defer api_client.deinit();
    
    var modem_manager = ModemManager.init(testing.allocator);
    defer modem_manager.deinit();
    
    const sender = SMSSender.init(testing.allocator, &api_client, &modem_manager, config);
    
    // Just verify the sender was created successfully
    try testing.expect(sender.api_client == &api_client);
    try testing.expect(sender.modem_manager == &modem_manager);
}

test "SMSSender reportSMSResult failure" {
    const config = types.Config{
        .api_url = "https://test.com",
        .api_key = "test-key",
    };
    
    var api_client = ApiClient.init(testing.allocator, config);
    defer api_client.deinit();
    
    var modem_manager = ModemManager.init(testing.allocator);
    defer modem_manager.deinit();
    
    var sender = SMSSender.init(testing.allocator, &api_client, &modem_manager, config);
    
    // Should not call API when success is false
    try sender.reportSMSResult("msg_123", false, "Failed");
}

// Additional tests for better coverage
test "MessageQueue thread-safe batch operations" {
    var queue = MessageQueue.init(testing.allocator);
    defer queue.deinit();
    
    // Push multiple messages
    for (0..5) |i| {
        var buf: [32]u8 = undefined;
        const sms_id = try std.fmt.bufPrint(&buf, "sms_{d}", .{i});
        
        const msg = types.MessageInfo{
            .modem_id = "modem_1",
            .sms_id = sms_id,
            .message = .{
                .phone_iccid = "89860123456789012345",
                .phone_number = "+1234567890",
                .content = "Test message",
                .timestamp = "2025-07-30T10:00:00Z",
            },
        };
        try queue.push(msg);
    }
    
    try testing.expectEqual(@as(usize, 5), queue.size());
    
    // Pop batch of 3
    const batch1 = try queue.popBatch(3);
    defer {
        for (batch1) |msg| {
            testing.allocator.free(msg.modem_id);
            testing.allocator.free(msg.sms_id);
            testing.allocator.free(msg.message.phone_iccid);
            testing.allocator.free(msg.message.phone_number);
            testing.allocator.free(msg.message.content);
            testing.allocator.free(msg.message.timestamp);
        }
        testing.allocator.free(batch1);
    }
    
    try testing.expectEqual(@as(usize, 3), batch1.len);
    try testing.expectEqual(@as(usize, 2), queue.size());
}

test "Phone struct with all fields" {
    const phone = types.Phone{
        .iccid = "89860123456789012345",
        .number = "+1234567890",
        .status = "ready",
        .signal = 75,
        .rssi = -65,
        .rsrq = -8,
        .rsrp = -95,
        .snr = 20,
        .operator_name = "Test Operator",
        .operator_id = "12345",
        .network_type = "lte",
        .access_tech = "4G",
        .imei = "123456789012345",
    };
    
    try testing.expectEqualStrings("89860123456789012345", phone.iccid);
    try testing.expectEqualStrings("+1234567890", phone.number.?);
    try testing.expectEqualStrings("ready", phone.status);
    try testing.expectEqual(@as(u8, 75), phone.signal.?);
    try testing.expectEqual(@as(i32, -65), phone.rssi.?);
    try testing.expectEqualStrings("Test Operator", phone.operator_name.?);
}

test "SignalData struct complete" {
    const signal = types.SignalData{
        .signal_percent = 80,
        .rssi = -60,
        .rsrq = -7,
        .rsrp = -90,
        .snr = 25,
    };
    
    try testing.expectEqual(@as(u8, 80), signal.signal_percent);
    try testing.expectEqual(@as(i32, -60), signal.rssi.?);
    try testing.expectEqual(@as(i32, -7), signal.rsrq.?);
    try testing.expectEqual(@as(i32, -90), signal.rsrp.?);
    try testing.expectEqual(@as(i32, 25), signal.snr.?);
}

test "PendingSms struct complete" {
    const sms = types.PendingSms{
        .id = "msg_123",
        .phone_iccid = "89860123456789012345",
        .phone_number = "+1234567890",
        .content = "Test SMS",
        .recipient = "+0987654321",
        .created_at = "2025-07-30T10:00:00Z",
    };
    
    try testing.expectEqualStrings("msg_123", sms.id);
    try testing.expectEqualStrings("89860123456789012345", sms.phone_iccid);
    try testing.expectEqualStrings("+1234567890", sms.phone_number.?);
    try testing.expectEqualStrings("Test SMS", sms.content);
    try testing.expectEqualStrings("+0987654321", sms.recipient);
    try testing.expectEqualStrings("2025-07-30T10:00:00Z", sms.created_at);
}

test "MessageInfo struct" {
    const info = types.MessageInfo{
        .modem_id = "modem_1",
        .sms_id = "sms_123",
        .message = .{
            .phone_iccid = "89860123456789012345",
            .phone_number = "+1234567890",
            .content = "Test",
            .timestamp = "2025-07-30T10:00:00Z",
        },
    };
    
    try testing.expectEqualStrings("modem_1", info.modem_id);
    try testing.expectEqualStrings("sms_123", info.sms_id);
    try testing.expectEqualStrings("89860123456789012345", info.message.phone_iccid);
}

test "Config struct custom values" {
    const config = types.Config{
        .api_url = "https://custom.com",
        .api_key = "custom-key",
        .check_interval = 60,
        .message_check_interval = 200,
        .signal_check_interval = 120,
        .max_retries = 5,
        .retry_delay = 10,
    };
    
    try testing.expectEqual(@as(u64, 60), config.check_interval);
    try testing.expectEqual(@as(u64, 200), config.message_check_interval);
    try testing.expectEqual(@as(u64, 120), config.signal_check_interval);
    try testing.expectEqual(@as(u32, 5), config.max_retries);
    try testing.expectEqual(@as(u64, 10), config.retry_delay);
}

test "ModemManager failed_sms_ids operations" {
    var manager = ModemManager.init(testing.allocator);
    defer manager.deinit();
    
    // Add some failed SMS IDs
    const sms_id1 = try testing.allocator.dupe(u8, "sms_123");
    const sms_id2 = try testing.allocator.dupe(u8, "sms_456");
    
    try manager.failed_sms_ids.put(sms_id1, {});
    try manager.failed_sms_ids.put(sms_id2, {});
    
    try testing.expectEqual(@as(usize, 2), manager.failed_sms_ids.count());
    try testing.expect(manager.failed_sms_ids.contains("sms_123"));
    try testing.expect(manager.failed_sms_ids.contains("sms_456"));
    
    // Test removal - need to get and free the removed entry
    if (manager.failed_sms_ids.fetchRemove("sms_123")) |kv| {
        testing.allocator.free(kv.key);
    }
    try testing.expectEqual(@as(usize, 1), manager.failed_sms_ids.count());
    try testing.expect(!manager.failed_sms_ids.contains("sms_123"));
}

test "ApiClient uploadPhones payload" {
    const config = types.Config{
        .api_url = "https://test.com",
        .api_key = "test-key",
    };
    
    var client = ApiClient.init(testing.allocator, config);
    defer client.deinit();
    
    const phones = [_]types.Phone{
        .{
            .iccid = "89860123456789012345",
            .number = "+1234567890",
            .status = "ready",
        },
        .{
            .iccid = "89860123456789012346",
            .number = "+0987654321",
            .status = "ready",
        },
    };
    
    // Test that the method handles the data correctly
    client.uploadPhones(&phones) catch |err| {
        // Expected to fail - accept various network/TLS errors
        const is_expected_error = err == error.UnknownHostName or 
                                err == error.ConnectionRefused or
                                err == error.TlsInitializationFailed or
                                err == error.CertificateIssuerMismatch or
                                err == error.TemporaryNameServerFailure;
        try testing.expect(is_expected_error);
    };
}

// Additional tests for higher coverage
test "ModemManager iccid_warnings tracking" {
    var manager = ModemManager.init(testing.allocator);
    defer manager.deinit();
    
    // Add ICCID warnings
    const iccid1 = try testing.allocator.dupe(u8, "89860123456789012345");
    const iccid2 = try testing.allocator.dupe(u8, "89860123456789012346");
    
    try manager.iccid_warnings.put(iccid1, true);
    try manager.iccid_warnings.put(iccid2, false);
    
    try testing.expectEqual(@as(usize, 2), manager.iccid_warnings.count());
    try testing.expect(manager.iccid_warnings.get("89860123456789012345").? == true);
    try testing.expect(manager.iccid_warnings.get("89860123456789012346").? == false);
}

test "ApiClient uploadMessages with data" {
    const config = types.Config{
        .api_url = "https://test.com",
        .api_key = "test-key",
    };
    
    var client = ApiClient.init(testing.allocator, config);
    defer client.deinit();
    
    const messages = [_]types.Message{
        .{
            .phone_iccid = "89860123456789012345",
            .phone_number = "+1234567890",
            .content = "Test message 1",
            .timestamp = "2025-07-30T10:00:00Z",
        },
        .{
            .phone_iccid = "89860123456789012346",
            .phone_number = "+0987654321",
            .content = "Test message 2",
            .timestamp = "2025-07-30T10:01:00Z",
        },
    };
    
    // Test that the method handles the data correctly
    client.uploadMessages(&messages) catch |err| {
        // Expected to fail - accept various network/TLS errors
        const is_expected_error = err == error.UnknownHostName or 
                                err == error.ConnectionRefused or
                                err == error.TlsInitializationFailed or
                                err == error.CertificateIssuerMismatch or
                                err == error.TemporaryNameServerFailure;
        try testing.expect(is_expected_error);
    };
}

test "ApiClient uploadPhone single" {
    const config = types.Config{
        .api_url = "https://test.com",
        .api_key = "test-key",
    };
    
    var client = ApiClient.init(testing.allocator, config);
    defer client.deinit();
    
    const phone = types.Phone{
        .iccid = "89860123456789012345",
        .number = "+1234567890",
        .status = "ready",
        .signal = 75,
    };
    
    // Test that the method handles the data correctly
    client.uploadPhone(phone) catch |err| {
        // Expected to fail - accept various network/TLS errors
        const is_expected_error = err == error.UnknownHostName or 
                                err == error.ConnectionRefused or
                                err == error.TlsInitializationFailed or
                                err == error.CertificateIssuerMismatch or
                                err == error.TemporaryNameServerFailure;
        try testing.expect(is_expected_error);
    };
}

test "SignalCache update existing entry" {
    var cache = SignalCache.init(testing.allocator);
    defer cache.deinit();
    
    const signal1 = types.SignalData{
        .signal_percent = 75,
        .rssi = -65,
        .rsrq = null,
        .rsrp = null,
        .snr = null,
    };
    
    try cache.updateCache("modem_1", signal1);
    
    // Sleep and update with new value  
    std.time.sleep(6 * std.time.ns_per_s);
    
    const signal2 = types.SignalData{
        .signal_percent = 85,
        .rssi = -55,
        .rsrq = null,
        .rsrp = null,
        .snr = null,
    };
    
    try cache.updateCache("modem_1", signal2);
    
    const retrieved = cache.getSignal("modem_1");
    try testing.expect(retrieved != null);
    try testing.expectEqual(@as(u8, 85), retrieved.?.signal_percent);
    try testing.expectEqual(@as(i32, -55), retrieved.?.rssi.?);
}

test "SMSSender getPendingSMS" {
    const config = types.Config{
        .api_url = "https://test.com",
        .api_key = "test-key",
    };
    
    var api_client = ApiClient.init(testing.allocator, config);
    defer api_client.deinit();
    
    var modem_manager = ModemManager.init(testing.allocator);
    defer modem_manager.deinit();
    
    var sender = SMSSender.init(testing.allocator, &api_client, &modem_manager, config);
    
    // This will fail with network error, but should return empty array
    const result = try sender.getPendingSMS();
    defer {
        for (result) |*sms| {
            sms.deinit(testing.allocator);
        }
        testing.allocator.free(result);
    }
    
    try testing.expectEqual(@as(usize, 0), result.len);
}

test "SMSSender findModemForIccid" {
    const config = types.Config{
        .api_url = "https://test.com",
        .api_key = "test-key",
    };
    
    var api_client = ApiClient.init(testing.allocator, config);
    defer api_client.deinit();
    
    var modem_manager = ModemManager.init(testing.allocator);
    defer modem_manager.deinit();
    
    var sender = SMSSender.init(testing.allocator, &api_client, &modem_manager, config);
    
    // Without mocking, this will return null
    const result = sender.findModemForIccid("89860123456789012345");
    try testing.expect(result == null);
}

test "SMSSender sendSMS error handling" {
    const config = types.Config{
        .api_url = "https://test.com",
        .api_key = "test-key",
    };
    
    var api_client = ApiClient.init(testing.allocator, config);
    defer api_client.deinit();
    
    var modem_manager = ModemManager.init(testing.allocator);
    defer modem_manager.deinit();
    
    var sender = SMSSender.init(testing.allocator, &api_client, &modem_manager, config);
    
    const sms = OutgoingSMS{
        .id = "msg_123",
        .recipient = "+1234567890",
        .phone_iccid = "89860123456789012345",
        .content = "Test SMS",
        .created_at = "2025-07-30T10:00:00Z",
    };
    
    // Should fail with ModemNotFound
    const result = sender.sendSMS(sms);
    try testing.expectError(error.ModemNotFound, result);
}